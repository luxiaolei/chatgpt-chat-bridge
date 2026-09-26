import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const source=await readFile(path.resolve("src/main.js"),"utf8");

test("terminal RESULT_RECORDED task detaches only safe inactive agent page after grace", async()=>{
  const begin=source.indexOf("async function detachTerminalTaskPages");
  const end=source.indexOf("\nasync function watchOnce",begin);
  assert.ok(begin>=0&&end>begin);
  const code=source.slice(begin,end);
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  let saved=0,closed=0;
  const chat={id:"worker",project:"P",account:"a",status:"active",spaceName:"managed",spaceId:7,page:"p1",attachmentEpoch:1};
  const reg={chats:{worker:chat},projects:{P:{activeAccount:"a",bindings:{a:{spaceName:"managed",spaceId:7}}}},defaultAccount:"a"};
  const runtime={tasks:{t1:{taskId:"t1",project:"P",account:"a",sessionId:"worker",status:"RESULT_RECORDED",updatedAt:"2020-01-01T00:00:00Z"}}};
  const page={close:async()=>{closed++}};
  const task={spaceId:7,page:label=>{assert.equal(label,"p1");return page},tabs:async()=>[{label:"p1",active:false,openedBy:"agent"}]};
  const detach=await new AsyncFunction("process","loadRuntime","activeTaskStatus","openBoundTask","state","saveRegistry",
    code+";return detachTerminalTaskPages;")(
      {env:{CHAT_BRIDGE_TERMINAL_TAB_GRACE_SEC:"30"}},
      async()=>runtime,
      status=>!["COMPLETE","FAILED","CANCELLED","BLOCKED","RESULT_RECORDED"].includes(String(status).toUpperCase()),
      async()=>({task,binding:{spaceName:"managed",spaceId:7}}),
      async()=>({generating:false,composerText:""}),
      async()=>{saved++}
    );
  const out=await detach(reg,"P","a");
  assert.equal(out.length,1);assert.equal(closed,1);assert.equal(saved,1);
  assert.equal(chat.page,null);assert.equal(chat.attachmentEpoch,2);
});

test("terminal detach preserves active tab, user/unmanaged page, draft and generating page", async()=>{
  const begin=source.indexOf("async function detachTerminalTaskPages");
  const end=source.indexOf("\nasync function watchOnce",begin);
  const code=source.slice(begin,end);
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  for(const scenario of [
    {tab:{label:"p1",active:true,openedBy:"agent"},snap:{generating:false,composerText:""}},
    {tab:{label:"p1",active:false,openedBy:"user"},snap:{generating:false,composerText:""}},
    {tab:{label:"p1",active:false,openedBy:"agent"},snap:{generating:true,composerText:""}},
    {tab:{label:"p1",active:false,openedBy:"agent"},snap:{generating:false,composerText:"draft"}},
  ]){
    let closed=0;
    const chat={id:"worker",project:"P",account:"a",status:"active",spaceName:"managed",spaceId:7,page:"p1"};
    const reg={chats:{worker:chat},projects:{P:{activeAccount:"a",bindings:{a:{spaceName:"managed",spaceId:7}}}},defaultAccount:"a"};
    const runtime={tasks:{t1:{taskId:"t1",project:"P",account:"a",sessionId:"worker",status:"RESULT_RECORDED",updatedAt:"2020-01-01T00:00:00Z"}}};
    const page={close:async()=>{closed++}};
    const task={spaceId:7,page:()=>page,tabs:async()=>[scenario.tab]};
    const detach=await new AsyncFunction("process","loadRuntime","activeTaskStatus","openBoundTask","state","saveRegistry",
      code+";return detachTerminalTaskPages;")(
        {env:{CHAT_BRIDGE_TERMINAL_TAB_GRACE_SEC:"30"}},async()=>runtime,
        status=>!["COMPLETE","FAILED","CANCELLED","BLOCKED","RESULT_RECORDED"].includes(String(status).toUpperCase()),
        async()=>({task,binding:{spaceName:"managed",spaceId:7}}),async()=>scenario.snap,async()=>{}
      );
    assert.deepEqual(await detach(reg,"P","a"),[]);assert.equal(closed,0);assert.equal(chat.page,"p1");
  }
});

test("background send does not clear user-control pause and requests hard Space protection", ()=>{
  assert.match(source,/const background=args\.includes\("--background"\)/);
  assert.match(source,/&& !background\) await clearUserControlPause\(chat\)/);
  assert.match(source,/ensurePage\(reg,chat,\{pauseOnUserControl:background\}\)/);
});
