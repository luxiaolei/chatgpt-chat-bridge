import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {inspectEgoImagePage} from '../src/capabilities/image/chatgpt-ego.ui.js';
import {imagePromptHash} from '../src/capabilities/image/chatgpt-ego.js';
const source=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
const state=new Function(source.slice(source.indexOf('async function state('),source.indexOf('\nfunction classifySnapshot'))+';return state;')();
const normalize=source.slice(source.indexOf('function normalizedEvidenceText('),source.indexOf('\nasync function expandEvidenceMessages'));
const evidenceAt=source.indexOf('const matches=(observed.userMessages||[]).filter(');
const evidenceMatches=new Function('observed','expected','crypto',normalize+'\n'+
  source.slice(evidenceAt,source.indexOf('\n    print({ok:true,project:chat.project',evidenceAt))+';return matches;');

// Synthetic rendering of the observed public bubble structure. Control labels
// and collapsed ellipsis are siblings of the full search-result content target.
function element(attrs={},text='',children=[]) {
  const matches=(node,selector)=>selector.split(',').some(part=>{
    const s=part.trim(),m=/^\[([^\s=$\]]+)(?:(\$?=)"([^"]*)")?\]$/.exec(s);
    if(!m)return node.tagName.toLowerCase()===s;
    const v=node.getAttribute(m[1]);return v!==null && (!m[2] || (m[2]==='$='?v.endsWith(m[3]):v===m[3]));
  });
  const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
  const node={tagName:attrs.tag||'DIV',children,parentElement:null,
    get innerText(){return [text,...children.map(child=>child.innerText)].filter(Boolean).join('\n');},
    get textContent(){return text+children.map(child=>child.textContent).join('');},
    getAttribute:name=>attrs[name]??null,getClientRects:()=>[{}],getBoundingClientRect:()=>({width:1,height:1}),
    querySelectorAll:selector=>descendants(node).filter(child=>matches(child,selector)),
    querySelector:selector=>node.querySelectorAll(selector)[0]||null,
    closest:selector=>{let n=node;while(n && !matches(n,selector))n=n.parentElement;return n;},
    contains:other=>{let n=other;while(n && n!==node)n=n.parentElement;return n===node;},
  };
  for(const child of children)child.parentElement=node;
  return node;
}

async function observe(messages,reader=inspectEgoImagePage) {
  const root=element({},'',messages),values={
    document:{body:root,querySelector:selector=>selector==='main, [role="main"]'||selector==='main'?root:null,querySelectorAll:selector=>root.querySelectorAll(selector)},
    location:{href:'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111'},
    navigator:{onLine:true},getComputedStyle:()=>({display:'block',visibility:'visible'}),
    __CHAT_BRIDGE_WATCH:{root,seq:0,lastMutationAt:Date.now(),startedAt:Date.now()},
  };
  const prior=new Map(Object.keys(values).map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  try {
    for(const [k,value] of Object.entries(values))Object.defineProperty(globalThis,k,{value,configurable:true});
    return await reader({evaluate:async(fn,args)=>fn(args)});
  }finally{for(const [k,d] of prior){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
}
function user(body,{expanded=false,ambiguous=false,nested=false,duplicateBubble=false,clipped=false}={}) {
  const target=element({'data-search-result-target':''},'',[
    element({},'',[element({class:'text-size-chat whitespace-pre-wrap',dir:'auto'},body)])]);
  if(clipped)Object.defineProperty(target,'innerText',{value:body.slice(0,12)+'…'});
  if(nested){const child=target.children[0];child.getAttribute=name=>name==='data-search-result-target'?'':null;}
  const bubble=element({'data-user-message-bubble':'true'},'',[
    element({class:'flex flex-col items-end'},'',[
      element({class:'relative w-full'},'',[target,...(ambiguous?[element({'data-search-result-target':''},'unrelated')]:[]),
        ...(!expanded?[element({'data-thread-find-skip':'true'},'…')]:[])]),
      element({tag:'BUTTON','aria-expanded':String(expanded),'data-thread-find-skip':'true'},expanded?'Show less':'Show more'),
    ]),
  ]);
  return element({'data-chatgpt-search-unit-key':'fallback-turn-2:0:user','data-chatgpt-search-message-ids':'actual-user'},'',[
    element({'data-content-search-unit-key':'fallback-turn-2:0:user'},'',[bubble,
      ...(duplicateBubble?[element({'data-user-message-bubble':'true'},body)]:[]),
      element({tag:'BUTTON','aria-label':'Copy message'},'Copy message')]),
  ]);
}

test('full user prompt hash excludes collapsed ellipsis and expanded UI controls without deleting authored labels',async()=>{
  const body='You said: preserve this authored heading.\nShow more and Show less are exact words in my prompt.\nKeep my ellipsis … and final Show less';
  for(const expanded of [false,true]) {
    const result=await observe([user(body,{expanded,clipped:!expanded})]);
    assert.equal(result.messagesComplete,true);assert.equal(result.messages.length,1);
    assert.equal(result.messages[0].promptHash,imagePromptHash(body));
    assert.notEqual(result.messages[0].promptHash,imagePromptHash(body+(expanded?' Show less':' … Show more')));
    assert.equal(result.messages[0].text,undefined);
  }
});

test('ambiguous public content targets stay incomplete rather than choosing a prompt or matching its prefix',async()=>{
  for(const options of [{ambiguous:true},{nested:true},{duplicateBubble:true}]) {
    const result=await observe([user('real prompt',options)]);
    assert.equal(result.messagesComplete,false);assert.equal(result.messagesIncompleteReason,options.duplicateBubble?'IMAGE_DOM_USER_BUBBLE_AMBIGUOUS':'IMAGE_DOM_USER_CONTENT_AMBIGUOUS');
    assert.deepEqual(result.messages,[]);
  }
});

test('legacy plain user structure retains its exact prompt hash',async()=>{
  const body='You said: Show more\nShow less …';
  const result=await observe([element({'data-message-author-role':'user','data-message-id':'legacy-user'},body)]);
  assert.equal(result.messagesComplete,true);assert.equal(result.messages[0].promptHash,imagePromptHash(body));
});

test('a legacy bubble without a content target preserves its authored heading and control words',async()=>{
  const body='You said: Show more … Show less';
  const result=await observe([element({'data-message-author-role':'user','data-message-id':'legacy-user'},'',[
    element({'data-user-message-bubble':'true'},body)])]);
  assert.equal(result.messagesComplete,true);assert.equal(result.messages[0].promptHash,imagePromptHash(body));
});

const snapshot=messages=>observe(messages,page=>state(page,true));
test('shared send and evidence snapshots exclude disclosure controls and retain the exact authored body',async()=>{
  for(const suffix of ['Show less','Show more','收起','展开']) for(const expanded of [false,true]) for(const legacy of [false,true]) {
    const body='You said: authored heading.\nParagraph and footer '+suffix;
    const rich=user(body,{expanded});
    const message=legacy?element({'data-message-author-role':'user','data-message-id':'actual-user'},'',rich.children):rich;
    const result=await snapshot([message]);
    assert.equal(result.lastUser,body);
    assert.equal(result.lastUserId,'actual-user');
    assert.equal(result.userMessages[0].text,body);
    assert.equal(imagePromptHash(result.userMessages[0].text),imagePromptHash(body));
  }
});

test('nested inline links belong to the unique outer body and paragraph boundaries remain intact',async()=>{
  const message=user('First paragraph',{expanded:true});
  const target=message.querySelector('[data-search-result-target]');
  for(const text of ['linked reference','Last paragraph Show less']) {
    const child=element({'data-search-result-target':'',tag:'A'},text);
    child.parentElement=target;target.children.push(child);
  }
  const body='First paragraph\nlinked reference\nLast paragraph Show less';
  assert.notEqual(target.textContent,body);
  const result=await snapshot([message]);
  assert.equal(result.lastUser,body);
  assert.equal(result.userMessages[0].text,body);
  assert.notEqual(result.lastUser,'linked reference');
});

test('missing or ambiguous authored structures provide no full-text evidence; plain legacy bodies remain supported',async()=>{
  const body='bounded request Show more';
  const missing=element({'data-chatgpt-search-unit-key':'turn:user','data-chatgpt-search-message-ids':'actual-user'},body);
  const linkOnly=user(body,{expanded:true});linkOnly.querySelector('[data-search-result-target]').tagName='A';
  const controlledLegacy=element({'data-message-author-role':'user','data-message-id':'actual-user'},body,[element({tag:'BUTTON'},'Show less')]);
  const rootAndNested=element({'data-message-author-role':'user','data-message-id':'actual-user','data-user-message-bubble':'true'},'different outer body',[
    element({'data-user-message-bubble':'true'},body)]);
  for(const message of [missing,linkOnly,controlledLegacy,rootAndNested,user(body,{ambiguous:true}),user(body,{duplicateBubble:true})]) {
    const result=await snapshot([message]);
    assert.equal(result.lastUser,null);
    assert.equal(result.userMessages[0].text,null);
  }
  const legacy=await snapshot([element({'data-message-author-role':'user','data-message-id':'actual-user'},body)]);
  assert.equal(legacy.lastUser,body);
});

test('the CLI evidence caller hashes complete authored suffixes and rejects another shorter operation',async()=>{
  const hash=text=>crypto.createHash('sha256').update(text.replace(/\s+/g,' ').trim()).digest('hex');
  for(const legacy of [false,true]) for(const suffix of ['Show more','Show less','显示更多','收起']) {
    const body='bounded request '+suffix,rich=user(body,{expanded:true});
    const message=legacy?element({'data-message-author-role':'user','data-message-id':'actual-user'},'',rich.children):rich;
    const result=await snapshot([message]);
    assert.equal(evidenceMatches(result,hash(body),crypto).length,1);
    assert.equal(evidenceMatches(result,hash('bounded request'),crypto).length,0);
  }
});
