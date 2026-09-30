import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectEgoImagePage} from '../src/capabilities/image/chatgpt-ego.ui.js';
import {imagePromptHash} from '../src/capabilities/image/chatgpt-ego.js';

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
    getAttribute:name=>attrs[name]??null,getClientRects:()=>[{}],
    querySelectorAll:selector=>descendants(node).filter(child=>matches(child,selector)),
    querySelector:selector=>node.querySelectorAll(selector)[0]||null,
    closest:selector=>{let n=node;while(n && !matches(n,selector))n=n.parentElement;return n;},
    contains:other=>{let n=other;while(n && n!==node)n=n.parentElement;return n===node;},
  };
  for(const child of children)child.parentElement=node;
  return node;
}

async function observe(messages) {
  const root=element({},'',messages),values={
    document:{body:root,querySelector:selector=>selector==='main, [role="main"]'?root:null,querySelectorAll:()=>[]},
    location:{href:'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111'},
    navigator:{onLine:true},getComputedStyle:()=>({display:'block',visibility:'visible'}),
  };
  const prior=new Map(Object.keys(values).map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  try {
    for(const [k,value] of Object.entries(values))Object.defineProperty(globalThis,k,{value,configurable:true});
    return await inspectEgoImagePage({evaluate:async(fn,args)=>fn(args)});
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
