import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
for(const name of ["control-routing","page-pool","liveness-policy","task-policy","web-policy","model-policy","session-policy"]) await import(`../src/${name}.js`);
const source=await readFile(new URL("../src/main.js",import.meta.url),"utf8"),prefix=source.split('const cmd=args[0] || "help";')[0];
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const cid="11111111-1111-4111-8111-111111111111",home="https://chatgpt.com/g/g-p-"+"a".repeat(32)+"/project";
async function fixture(status="RESULT_RECORDED",tab={},snapshot={}) {
  const chat={id:cid,project:"P",account:"a",status:"active",spaceName:"managed",spaceId:7,profileId:"P1",page:"p1",attachmentEpoch:1,url:home.replace(/project$/,"c/"+cid)};
  const binding={spaceName:"managed",spaceId:7,profileId:"P1",projectUrl:home};
  const f={chat,reg:{accounts:{a:{identity:"login-a"}},chats:{[cid]:chat},projects:{P:{bindings:{a:binding}}}},binding,saved:0,closed:0,
    runtime:{tasks:{t1:{taskId:"t1",project:"P",account:"a",sessionId:cid,status,updatedAt:"2020-01-01T00:00:00Z"}}},
    tab:{label:"p1",url:chat.url,active:false,openedBy:"agent",...tab},snapshot:{url:chat.url,inputReady:true,approvalRequired:false,generating:false,composerCount:1,composerAttachmentsEmpty:true,composerRawText:"",...snapshot}};
  const detach=await new AsyncFunction("f",prefix+`
    const reg=f.reg;
    loadRuntime=async()=>f.runtime;
    saveRegistry=async()=>{f.saved++;};
    imageSessionOccupancy=()=>({occupied:false});
    state=async()=>f.snapshot;
    listTaskSpaces=async()=>[{id:7,name:'managed',profileId:'P1',ownership:'agent',createdBy:'agent'}];
    coordinated=command=>{if(command!=='page-reclaim-context')throw Error(command);return {sessionRefs:[],unboundProjectIds:[],unboundAny:false};};
    openBoundTask=async()=>({binding:f.binding,task:{spaceId:7,tabs:async()=>f.closed?[]:[f.tab],page:()=>({url:async()=>f.tab.url,evaluate:async()=>"login-a",close:async()=>{f.closed++;}})}});
    return detachTerminalTaskPages;
  `)(f);
  f.out=await detach(f.reg,"P","a");return f;
}

test("terminal RESULT_RECORDED task detaches a safe agent page after grace regardless of selection",async()=>{
  for(const active of [false,true]){const f=await fixture("RESULT_RECORDED",{active});assert.equal(f.out.length,1);assert.equal(f.closed,1);assert.equal(f.saved,1);assert.equal(f.chat.page,null);assert.equal(f.chat.attachmentEpoch,2);}
});

test("BLOCKED task remains attached without a recorded terminal result",async()=>{
  const f=await fixture("BLOCKED");assert.deepEqual(f.out,[]);assert.equal(f.closed,0);assert.equal(f.saved,0);assert.equal(f.chat.page,"p1");
});

test("terminal detach preserves user/unmanaged page, draft and generating page",async()=>{
  for(const [tab,snapshot] of [
    [{openedBy:"user"},{}],[{openedBy:"unknown"},{}],[{},{generating:true}],[{},{composerRawText:"draft"}],
    ...[" ","\t","\n","\u00a0"].map(raw=>[{}, {composerRawText:raw}]),
    ...[{composerCount:undefined,composerRawText:undefined},{composerCount:0,composerRawText:null},{composerCount:2,composerRawText:null}].map(raw=>[{},raw])
  ]){const f=await fixture("RESULT_RECORDED",tab,snapshot);assert.deepEqual(f.out,[]);assert.equal(f.closed,0);assert.equal(f.chat.page,"p1");}
});

test("background send does not clear user-control pause and requests hard Space protection",()=>{
  assert.match(source,/const background=args\.includes\("--background"\)/);
  assert.match(source,/&& !background\)\s+globalThis\.__CHAT_BRIDGE_INPUT_RESUMED_USER_CONTROL__=await clearUserControlPause\(chat\)/);
  assert.match(source,/ensurePage\(reg,chat,\{pauseOnUserControl:background,allowOverflow:\["send","ask","stream"\]\.includes\(cmd\)\}\)/);
});
