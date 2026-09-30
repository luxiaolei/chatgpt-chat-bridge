import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const adapter = path.resolve('src/github-project.py');
const bridge = path.resolve('bin/chat-bridge');

function source({id='I_1', number=1, updatedAt='2026-09-30T00:00:00Z', labels=[]}={}) {
  return {
    __typename: 'Issue',
    id,
    url: `https://github.com/o/r/issues/${number}`,
    number,
    title: `Issue ${number}`,
    state: 'OPEN',
    stateReason: null,
    updatedAt,
    repository: {nameWithOwner: 'o/r'},
    labels: {totalCount: labels.length, nodes: labels.map(name => ({name}))},
  };
}

const fakeGhSource = `#!/usr/bin/env python3
import json, os, pathlib, sys

scenario=os.environ.get("FAKE_GH_SCENARIO","basic")
state_path=pathlib.Path(os.environ["FAKE_GH_STATE"])
try:
    state=json.loads(state_path.read_text())
except FileNotFoundError:
    state={"adds":0,"statusWrites":0}
args=sys.argv[1:]

def emit(value):
    print(json.dumps(value,separators=(",",":")))

def save():
    state_path.write_text(json.dumps(state))

def src(i=1, updated="2026-09-30T00:00:00Z", labels=None):
    labels=labels or []
    return {
      "__typename":"Issue","id":f"I_{i}","url":f"https://github.com/o/r/issues/{i}",
      "number":i,"title":f"Issue {i}","state":"OPEN","stateReason":None,
      "updatedAt":updated,"repository":{"nameWithOwner":"o/r"},
      "labels":{"totalCount":len(labels),"nodes":[{"name":x} for x in labels]},
    }

def item(i=1, updated="2026-09-30T00:00:00Z", labels=None, status="Backlog"):
    return {
      "id":f"PVTI_{i}","isArchived":False,"content":src(i,updated,labels),
      "fieldValues":{"pageInfo":{"hasNextPage":False,"endCursor":None},
        "nodes":[{"name":status,"optionId":"OPT_"+status.upper(),
          "field":{"id":"SF","name":"Status"}}]},
    }

if args[:2]==["project","view"]:
    if scenario=="unavailable":
        print("not found",file=sys.stderr); raise SystemExit(1)
    emit({"id":"PVT_TEST","number":8,"title":"Test Board","url":"https://github.com/users/o/projects/8","closed":False,"public":False})
    raise SystemExit(0)

if args and args[0]=="api" and "graphql" in args:
    payload=json.load(sys.stdin)
    query=payload.get("query","")
    variables=payload.get("variables",{})
    if "addProjectV2ItemById" in query:
        state["adds"]=state.get("adds",0)+1; save()
        emit({"data":{"addProjectV2ItemById":{"item":{"id":"PVTI_ADDED"}}}})
        raise SystemExit(0)
    if "updateProjectV2ItemFieldValue" in query:
        state["statusWrites"]=state.get("statusWrites",0)+1; save()
        emit({"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":variables.get("item")}}}})
        raise SystemExit(0)
    if "workflows(first:100)" in query and "fields(first:100)" in query:
        emit({"data":{"node":{"id":"PVT_TEST","title":"Test Board","url":"https://github.com/users/o/projects/8",
          "closed":False,"public":False,
          "workflows":{"pageInfo":{"hasNextPage":False,"endCursor":None},"nodes":[]},
          "fields":{"pageInfo":{"hasNextPage":False,"endCursor":None},"nodes":[
            {"__typename":"ProjectV2SingleSelectField","id":"SF","name":"Status",
             "options":[{"id":"OPT_BACKLOG","name":"Backlog"},{"id":"OPT_READY","name":"Ready"}]}
          ]}}}})
        raise SystemExit(0)
    if "items(first:100" in query:
        cursor=variables.get("cursor")
        if scenario=="pagination":
            if cursor is None:
                connection={"pageInfo":{"hasNextPage":True,"endCursor":"C1"},"nodes":[item(1)]}
            elif cursor=="C1":
                connection={"pageInfo":{"hasNextPage":False,"endCursor":None},"nodes":[item(2)]}
            else:
                print("bad cursor",file=sys.stderr); raise SystemExit(2)
        elif scenario=="concurrent":
            connection={"pageInfo":{"hasNextPage":False,"endCursor":None},
                        "nodes":[item(1,labels=["status:ready"],status="")]}
        else:
            connection={"pageInfo":{"hasNextPage":False,"endCursor":None},"nodes":[item(1)]}
        emit({"data":{"node":{"items":connection}}})
        raise SystemExit(0)
    if "...ItemFields" in query:
        if scenario=="concurrent":
            value=item(1,labels=["status:ready"],status="")
        else:
            value=item(1)
        emit({"data":{"node":value}})
        raise SystemExit(0)
    if "__typename" in query and "SourceFields" in query:
        if scenario=="concurrent":
            value=src(1,updated="2026-09-30T00:01:00Z",labels=["status:ready"])
        else:
            value=src(1)
        emit({"data":{"node":value}})
        raise SystemExit(0)
    print("unexpected graphql",query,file=sys.stderr); raise SystemExit(2)

if args[:3]==["api","-X","GET"] and "search/issues" in args:
    values={}
    for i,v in enumerate(args):
        if v=="-f" and i+1<len(args):
            k,_,val=args[i+1].partition("="); values[k]=val
    page=int(values.get("page","1"))
    if page!=1:
        emit({"total_count":1,"incomplete_results":False,"items":[]}); raise SystemExit(0)
    candidate={"node_id":"I_1","html_url":"https://github.com/o/r/issues/1","number":1,
      "updated_at":"2026-09-30T00:00:00Z","state":"open",
      "repository_url":"https://api.github.com/repos/o/r",
      "labels":[]}
    emit({"total_count":1,"incomplete_results":False,"items":[candidate]})
    raise SystemExit(0)

print("unexpected gh args: "+repr(args),file=sys.stderr)
raise SystemExit(2)
`;

async function fixture({binding=null}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'bridge-gh-project-'));
  const config=path.join(root,'config'), state=path.join(root,'state');
  await mkdir(config); await mkdir(state);
  const project={name:'P',activeAccount:'default',rootController:'conductor',bindings:{},lifecycle:{}};
  if(binding) project.githubProject=binding;
  await writeFile(path.join(config,'registry.json'),JSON.stringify({
    version:2,defaultProject:'P',defaultAccount:'default',
    accounts:{default:{name:'default'}},projects:{P:project},chats:{},spaces:{}
  }));
  const gh=path.join(root,'gh');
  await writeFile(gh,fakeGhSource); await chmod(gh,0o755);
  const ghState=path.join(root,'gh-state.json');
  await writeFile(ghState,JSON.stringify({adds:0,statusWrites:0}));
  return {root,config,state,gh,ghState};
}

function binding(extra={}) {
  return {
    owner:'o',number:8,id:'PVT_TEST',url:'https://github.com/users/o/projects/8',
    title:'Test Board',sourceQueries:[],statusField:'Status',statusFromLabels:{},...extra
  };
}

function call(f,args,scenario='basic') {
  return spawnSync('python3',[adapter,...args],{
    encoding:'utf8',
    env:{...process.env,CHAT_BRIDGE_GH_BIN:f.gh,FAKE_GH_STATE:f.ghState,FAKE_GH_SCENARIO:scenario},
  });
}

test('missing GitHub Project binding is explicit and does not call gh', async()=>{
  const f=await fixture();
  try {
    await writeFile(f.gh,'#!/bin/sh\necho should-not-run >&2\nexit 99\n'); await chmod(f.gh,0o755);
    const r=call(f,['inspect',f.config,f.state,'--project','P']);
    assert.equal(r.status,2,r.stderr);
    const value=JSON.parse(r.stdout);
    assert.equal(value.status,'INVALID_CONFIG');
    assert.match(value.reason,/no GitHub Project binding/);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test('inaccessible bound board is UNAVAILABLE rather than an empty project', async()=>{
  const f=await fixture({binding:binding()});
  try {
    const r=call(f,['inspect',f.config,f.state,'--project','P'],'unavailable');
    assert.equal(r.status,5,r.stderr);
    const value=JSON.parse(r.stdout);
    assert.equal(value.status,'UNAVAILABLE');
    assert.equal(value.remoteBusinessActionAttempted,false);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test('Project item pagination is complete across multiple pages', async()=>{
  const f=await fixture({binding:binding()});
  try {
    const r=call(f,['inspect',f.config,f.state,'--project','P'],'pagination');
    assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
    const value=JSON.parse(r.stdout);
    assert.equal(value.status,'READ_COMPLETE');
    assert.equal(value.itemCount,2);
    assert.equal(value.activeItemCount,2);
    assert.deepEqual(value.items.map(item => item.source.url), [
      'https://github.com/o/r/issues/1', 'https://github.com/o/r/issues/2'
    ]);
    assert.equal(value.items[0].source.title, 'Issue 1');
    assert.equal(value.items[0].status, 'Backlog');
    assert.equal(value.items[0].fieldValues[0].field.name, 'Status');
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test('refresh apply is idempotent when source query item already exists', async()=>{
  const f=await fixture({binding:binding({sourceQueries:['repo:o/r is:open']})});
  try {
    const r=call(f,['refresh',f.config,f.state,'--project','P','--apply']);
    assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
    const value=JSON.parse(r.stdout);
    assert.equal(value.writes,0);
    assert.deepEqual(value.remainingMissingSourceUrls,[]);
    const state=JSON.parse(await readFile(f.ghState,'utf8'));
    assert.equal(state.adds,0);
    assert.equal(state.statusWrites,0);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test('concurrent source change blocks a configured Project Status write', async()=>{
  const f=await fixture({binding:binding({statusFromLabels:{'status:ready':'Ready'}})});
  try {
    const r=call(f,['refresh',f.config,f.state,'--project','P','--apply'],'concurrent');
    assert.equal(r.status,4,r.stderr+'\n'+r.stdout);
    const value=JSON.parse(r.stdout);
    assert.equal(value.status,'CONFLICT');
    assert.match(value.reason,/source changed before status write/);
    const state=JSON.parse(await readFile(f.ghState,'utf8'));
    assert.equal(state.statusWrites,0);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test('terminal or acceptance-like mappings are refused before binding is persisted', async()=>{
  const f=await fixture();
  try {
    const r=call(f,[
      'bind',f.config,f.state,'--project','P','--owner','o','--number','8',
      '--map-status','status:done=Done'
    ]);
    assert.equal(r.status,3,r.stderr+'\n'+r.stdout);
    const value=JSON.parse(r.stdout);
    assert.equal(value.status,'REFUSED');
    assert.match(value.reason,/terminal\/acceptance-like/);
    const registry=JSON.parse(await readFile(path.join(f.config,'registry.json'),'utf8'));
    assert.equal(registry.projects.P.githubProject,undefined);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test('github-project CLI stays local and never starts ego-browser', async()=>{
  const f=await fixture({binding:binding()});
  const marker=path.join(f.root,'ego-called');
  const ego=path.join(f.root,'ego-browser');
  await writeFile(ego,`#!/bin/sh\necho called > "${marker}"\nexit 99\n`); await chmod(ego,0o755);
  try {
    const r=spawnSync(bridge,['github-project','show','--project','P'],{
      encoding:'utf8',
      env:{...process.env,CHAT_BRIDGE_CONFIG_DIR:f.config,CHAT_BRIDGE_STATE_DIR:f.state,
        CHAT_BRIDGE_GH_BIN:f.gh,FAKE_GH_STATE:f.ghState,EGO_BROWSER_BIN:ego}
    });
    assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
    assert.equal(JSON.parse(r.stdout).status,'BOUND');
    await assert.rejects(access(marker));
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test('source scope, manual statuses and latest-snapshot guards fail closed', ()=>{
  const r=spawnSync('python3',['-c',String.raw`
import copy, importlib.util, sys
spec=importlib.util.spec_from_file_location('adapter',sys.argv[1])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def refuses(fn, error):
    try: fn()
    except error: return
    raise AssertionError('expected '+error.__name__)
for query in ['-repo:o/r is:open', 'repo:o/r -is:open', '"repo:o/r" is:open',
              'repo:o/r is:open OR repo:else/where', 'repo:o/r is:open bare',
              'repo:o/r "is:open"', 'repo:o/r is:open is:closed']:
    refuses(lambda: m.validate_source_query(query), m.InvalidConfig)
assert m.query_repositories('repo:O/R repo:x/y is:open label:status:ready') == {'o/r','x/y'}
class Search:
    def rest(self, *args, **kwargs):
        return {'total_count':1,'items':[{'node_id':'I','state':'open',
            'repository_url':'https://api.github.com/repos/else/where'}]}
refuses(lambda: m.search_sources(Search(), ['repo:o/r is:open']), m.Conflict)
source={'id':'I','__typename':'Issue','state':'OPEN','updatedAt':'v1',
        'url':'https://github.com/o/r/issues/1','repository':{'nameWithOwner':'o/r'},
        'labels':{'totalCount':1,'nodes':[{'name':'status:ready'}]}}
field={'id':'F','name':'Status','__typename':'ProjectV2SingleSelectField',
       'options':[{'id':'R','name':'Ready'}]}
item={'id':'ITEM','isArchived':False,'content':source,
      'fieldValues':{'nodes':[], 'pageInfo':{'hasNextPage':False}}}
board={'project':{},'fields':[field],'items':[item]}
binding={'id':'P','statusFromLabels':{'status:ready':'Ready'}}
for status in ['Done','Blocked','Backlog','Ready','Custom']:
    manual=copy.deepcopy(board)
    manual['items'][0]['fieldValues']['nodes']=[{'field':{'name':'Status'},'name':status}]
    assert m.status_plan(manual,binding)==[], status
change=m.status_plan(board,binding)[0]
class Gh:
    def __init__(self): self.writes=0
    def graphql(self, *args, **kwargs):
        self.writes+=1
        return {'updateProjectV2ItemFieldValue':{'projectV2Item':{'id':'ITEM'}}}
gh=Gh()
m.get_source=lambda *_: copy.deepcopy(source)
candidate={'id':'I','url':source['url'],'query':'repo:x/y is:open'}
refuses(lambda: m.candidate_guard(gh,candidate),m.Conflict)
for kind in ['status','archive','source','identity','removed']:
    fresh=copy.deepcopy(board)
    if kind=='status': fresh['items'][0]['fieldValues']['nodes']=[{'field':{'name':'Status'},'name':'Blocked'}]
    if kind=='archive': fresh['items'][0]['isArchived']=True
    if kind=='source': fresh['items'][0]['content']['id']='OTHER'
    if kind=='identity': fresh['items'][0]['id']='OTHER'
    if kind=='removed': fresh['items']=[]
    m.project_snapshot=lambda *_: fresh
    refuses(lambda: m.guarded_status_write(gh,binding,change),m.Conflict)
    assert gh.writes==0
m.project_snapshot=lambda *_: board
assert m.guarded_status_write(gh,binding,change) is True
assert gh.writes==1
for typename, key, value in [('Text','text','research'),('Number','number',3),
                             ('Date','date','2026-10-01'),('Iteration','title','Sprint 1')]:
    item['fieldValues']['nodes'].append({'__typename':'ProjectV2ItemField'+typename+'Value',
        'field':{'id':typename,'name':typename},key:value})
summary=m.snapshot_summary(board,binding)
assert summary['items'][0]['fieldValues']==item['fieldValues']['nodes']
assert summary['items'][0]['source']['url']==source['url']
item['fieldValues']['pageInfo']['hasNextPage']=True
refuses(lambda: m.snapshot_summary(board,binding),m.IncompleteRead)
`,adapter],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
});
