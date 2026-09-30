import {spawnSync} from 'node:child_process';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {lstat, realpath} from 'node:fs/promises';
import {hostname} from 'node:os';
import {isAbsolute} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';

const fail = code => {throw new Error(code);};

// Connect only to an existing shared runtime. A fresh stdio server cannot prove
// ownership of a thread loaded by the desktop or another app-server.
export async function connectNative(target) {
  if (target.host !== hostname()) fail('NATIVE_HOST_MISMATCH');
  if (!isAbsolute(target.socket || '') || !isAbsolute(target.cwd || '')) fail('NATIVE_ABSOLUTE_PATH_REQUIRED');
  const entry = await lstat(target.socket).catch(() => fail('NATIVE_SHARED_RUNTIME_UNAVAILABLE'));
  const socket = entry.isSymbolicLink() ? await realpath(target.socket).then(lstat).catch(()=>fail('NATIVE_SHARED_RUNTIME_UNAVAILABLE')) : entry;
  // Codex publishes Unix listeners through an owner-created symlink.
  if (entry.uid !== process.getuid() || !socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o022)) fail('NATIVE_SOCKET_UNTRUSTED');
  if (typeof WebSocket !== 'function') fail('NATIVE_NODE_WEBSOCKET_UNAVAILABLE');
  // Node's native WebSocket has no Unix-socket option. Use a one-connection,
  // random-path loopback tunnel, so frame parsing remains the platform's job.
  const token = randomUUID(), sockets = new Set();
  const tunnel = net.createServer(local => {
    sockets.add(local); local.on('error',()=>local.destroy()); local.setTimeout(10000,()=>local.destroy());
    let header = Buffer.alloc(0);
    const accept = chunk => {
      header = Buffer.concat([header,chunk]);
      if (header.length > 16384) return local.destroy();
      if (!header.includes('\r\n\r\n')) return;
      local.removeListener('data',accept);
      if (!header.toString().startsWith('GET /'+token+' HTTP/1.1\r\n')) return local.destroy();
      tunnel.close(); local.setTimeout(0);
      const remote = net.createConnection(target.socket); sockets.add(remote);
      remote.on('error',()=>local.destroy()); local.on('close',()=>remote.destroy()); remote.on('close',()=>local.destroy());
      remote.on('connect',()=>{remote.write(header);local.pipe(remote);remote.pipe(local);});
    };
    local.on('data',accept);
  });
  tunnel.listen(0,'127.0.0.1'); await once(tunnel,'listening');
  const ws = new WebSocket('ws://127.0.0.1:'+tunnel.address().port+'/'+token);
  const pending = new Map(); let nextId = 0, closed = false;
  const rejectAll = () => {closed = true; for (const p of pending.values()) p.reject(new Error('NATIVE_CONNECTION_LOST')); pending.clear();};
  ws.addEventListener('error',rejectAll); ws.addEventListener('close',rejectAll);
  ws.addEventListener('message',event => {
    let value; try {value = JSON.parse(event.data);} catch {rejectAll(); return;}
    const p = pending.get(value.id);
    if (p) {pending.delete(value.id); value.error ? p.reject(new Error('NATIVE_RPC_REJECTED')) : p.resolve(value.result);}
    // Never answer runtime approval/tool requests on behalf of the target.
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('NATIVE_CONNECTION_LOST'));
    const id = ++nextId, timer = setTimeout(() => {pending.delete(id); reject(new Error('NATIVE_RPC_TIMEOUT'));}, 10000);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);}, reject:error=>{clearTimeout(timer);reject(error);}});
    try {ws.send(JSON.stringify({id,method,params}));} catch {rejectAll();}
  });
  const close = () => {ws.close();tunnel.close();for(const socket of sockets)socket.destroy();rejectAll();};
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('NATIVE_CONNECTION_TIMEOUT')),10000);
      ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('NATIVE_CONNECTION_LOST'));},{once:true});
    });
    const server = await rpc('initialize',{clientInfo:{name:'chat_bridge_native',version:'0.9.0'},capabilities:{experimentalApi:true}});
    ws.send(JSON.stringify({method:'initialized'}));
    return {rpc,close,server};
  } catch (error) {close(); throw error;}
}

export async function inspectNative(client, target, includeTurns = false) {
  const {thread} = await client.rpc('thread/read',{threadId:target.threadId,includeTurns});
  if (thread?.id !== target.threadId || await realpath(thread.cwd) !== await realpath(target.cwd)) fail('NATIVE_THREAD_BINDING_MISMATCH');
  // Only explicitly dedicated native workers are admitted. The public protocol
  // cannot atomically reject a user turn/draft race on arbitrary desktop threads.
  if (thread.originator !== 'chat_bridge_native') fail('NATIVE_OWNERSHIP_UNVERIFIED');
  return thread;
}

export async function dispatchNative(input, connect = connectNative) {
  let client, createdTarget, attempted = false;
  try {
    if (![undefined,'send','create','inspect','read','cancel'].includes(input.action)) fail('NATIVE_ACTION_UNSUPPORTED');
    const target = input.nativeTarget;
    client = await connect(target);
    let thread = input.action === 'create' ? {} : await inspectNative(client,target);
    if (['read','cancel'].includes(input.action)) {
      const matches = []; let cursor = null;
      // ponytail: bounded history scan; use an indexed native receipt lookup if
      // dedicated workers exceed 1,000 turns. Missing evidence stays unknown.
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        const page = await client.rpc('thread/turns/list',{threadId:target.threadId,cursor,limit:100,itemsView:'full'});
        for (const turn of page.data) {
          const messages = (turn.items || []).filter(item=>item.type==='userMessage' && item.clientId===input.operationId);
          if (messages.length === 1 && messages[0].content?.filter(item=>item.type==='text').map(item=>item.text).join('') === input.message) matches.push(turn);
        }
        cursor = page.nextCursor; if (!cursor) break;
      }
      if (cursor || matches.length !== 1 || (input.turnId && matches[0].id !== input.turnId)) fail('NATIVE_TURN_NOT_PROVEN');
      const turn = matches[0];
      if (input.action === 'cancel') {
        if (turn.status === 'interrupted') return {ok:true,runtime:'codex',nativeTarget:target,turnId:turn.id,cancelled:true};
        if (turn.status !== 'inProgress') fail('NATIVE_TURN_NOT_ACTIVE');
        attempted = true;
        await client.rpc('turn/interrupt',{threadId:target.threadId,turnId:turn.id});
        return {ok:true,runtime:'codex',nativeTarget:target,turnId:turn.id,interruptRequested:true,cancelled:false};
      }
      return {ok:true,delivered:true,runtime:'codex',nativeTarget:target,turnId:turn.id,clientUserMessageId:input.operationId,
        turnStatus:turn.status,assistantText:(turn.items||[]).filter(item=>item.type==='agentMessage').map(item=>item.text).join('\n'),observedAt:new Date().toISOString()};
    }
    if (input.action !== 'create' && !['idle','notLoaded'].includes(thread.status?.type)) fail('NATIVE_TARGET_BUSY');
    const models = []; let cursor = null;
    do {const page = await client.rpc('model/list',{cursor,limit:100}); models.push(...page.data); cursor = page.nextCursor;} while(cursor);
    const model = input.model || thread.model, effort = input.effort || thread.reasoningEffort;
    const available = models.find(item => item.model === model && !item.hidden);
    if (!available) fail('NATIVE_MODEL_UNAVAILABLE');
    if (!effort || !available.supportedReasoningEfforts.some(item=>item.reasoningEffort===effort)) fail('NATIVE_EFFORT_UNAVAILABLE');
    if (input.action === 'create') {
      attempted = true;
      const created = await client.rpc('thread/start',{cwd:target.cwd,model,config:{model_reasoning_effort:effort},ephemeral:false,allowProviderModelFallback:false});
      const bound = {...target,threadId:created.thread?.id};
      createdTarget = bound;
      // Naming saves metadata; a loaded full read also materializes paginated history.
      const name = 'ChatBridge · Native worker';
      await client.rpc('thread/name/set',{threadId:bound.threadId,name});
      const persisted = await inspectNative(client,bound,true);
      if (persisted.name !== name) fail('NATIVE_THREAD_NAME_NOT_CONFIRMED');
      if (!Array.isArray(persisted.turns) || persisted.turns.length !== 0) fail('NATIVE_EMPTY_THREAD_NOT_CONFIRMED');
      return {ok:true,runtime:'codex',nativeTarget:bound,model,effort,name,
        modelSelection:{requestedModel:input.model||null,requestedEffort:input.effort||null,
          observedModel:created.model,observedEffort:created.reasoningEffort,executionObserved:false}};
    }
    if (input.action === 'inspect') return {ok:true,nativeTarget:target,model,effort,status:thread.status.type,server:client.server};
    if (thread.status.type === 'notLoaded') {
      // Preserve settings/permissions. The turn carries only requested model overrides.
      const resumed = await client.rpc('thread/resume',{threadId:target.threadId,excludeTurns:true});
      if (resumed.thread?.id !== target.threadId) fail('NATIVE_THREAD_BINDING_MISMATCH');
    }
    thread = await inspectNative(client,target);
    if (thread.status?.type !== 'idle' || thread.canAcceptDirectInput !== true) fail('NATIVE_TARGET_BUSY');
    if (input.admission) {
      const gate = spawnSync('python3',[fileURLToPath(new URL('./coordinator.py',import.meta.url)), 'native-admission', '', input.admission.state, input.admission.operationId],{encoding:'utf8'});
      if (gate.status !== 0) {
        let detail; try {detail=JSON.parse(gate.stderr);} catch {}
        fail(detail?.error==='TARGET_SESSION_BUSY'?'NATIVE_TARGET_RESERVED':'NATIVE_ADMISSION_BLOCKED');
      }
    }
    attempted = true;
    const {turn} = await client.rpc('turn/start',{threadId:target.threadId,input:[{type:'text',text:input.message}],clientUserMessageId:input.operationId,model,effort});
    if (!turn?.id) fail('NATIVE_TURN_NOT_CONFIRMED');
    return {ok:true,delivered:true,runtime:'codex',nativeTarget:target,turnId:turn.id,clientUserMessageId:input.operationId,
      modelSelection:{requestedModel:input.model||null,requestedEffort:input.effort||null,model,effort,source:'validated-catalog-and-turn-request',executionObserved:false}};
  } catch(error) {
    return {ok:false,code:error.message,deliveryStage:attempted?'SEND_ATTEMPTED':'PRE_SEND',...(createdTarget?{nativeTarget:createdTarget}:{})};
  } finally {client?.close();}
}

const entryPath = process.argv[1] && await realpath(process.argv[1]).catch(()=>null);
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const receipt = await dispatchNative(JSON.parse(process.argv[2]));
  console.log(JSON.stringify(receipt)); process.exitCode = receipt.ok ? 0 : 2;
}
