import {imagePromptHash} from './chatgpt-ego.js';

/** Public DOM only. This reports visible facts, never turns a preview, alt text,
 * model prose or an uncharacterized tool widget into generated-original proof.
 * Parent/asset lineage remains unknown until a native characterization proves it.
 */
export async function inspectEgoImagePage(page) {
  const snapshot=await page.evaluate(()=>{
    const root=document.querySelector('main, [role="main"]') || document.body;
    const visible=node=>!node.closest('[hidden], [aria-hidden="true"], [inert]') &&
      getComputedStyle(node).display!=='none' && getComputedStyle(node).visibility!=='hidden' && node.getClientRects().length>0;
    const legacy=[...root.querySelectorAll('[data-message-author-role]')].filter(visible);
    const nodes=legacy.length?legacy:[...root.querySelectorAll('[data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"]')].filter(visible);
    const fallback=nodes.length?nodes:[...root.querySelectorAll('[data-content-search-unit-key$=":user"], [data-content-search-unit-key$=":assistant"]')].filter(visible);
    const messages=[],seen=new Set();let ambiguous=false;
    for(const node of fallback) {
      const key=node.getAttribute('data-chatgpt-search-unit-key')||node.getAttribute('data-content-search-unit-key')||'';
      const role=node.getAttribute('data-message-author-role')||/:(user|assistant)$/.exec(key)?.[1];
      if(!['user','assistant'].includes(role)) continue;
      const ids=(node.getAttribute('data-chatgpt-search-message-ids')||'').trim().split(/\s+/).filter(Boolean);
      const id=node.getAttribute('data-message-id')|| (ids.length===1?ids[0]:null) ||
        node.querySelector('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id');
      if(!id || ids.length>1) {ambiguous=true;continue;}
      if(seen.has(id)) {ambiguous=true;continue;} seen.add(id);
      if(role==='user') {
        const content=node.querySelector('[data-user-message-bubble="true"]')||node;
        messages.push({id,role,text:(content.innerText||content.textContent||'').trim().replace(/^You said:\s*/i,'')});
      } else {
        const facts=[...node.querySelectorAll('[data-testid], [data-message-id], [data-parent-message-id], button, img')].filter(visible).slice(0,128).map(element=>({
          tag:element.tagName.toLowerCase(),testId:element.getAttribute('data-testid'),
          messageId:element.getAttribute('data-message-id'),parentMessageId:element.getAttribute('data-parent-message-id'),
          control:element.tagName==='BUTTON'?element.getAttribute('aria-label'):null,
          ...(element.tagName==='IMG'?{previewWidth:element.naturalWidth,previewHeight:element.naturalHeight,loaded:element.complete}:{}),
        }));
        messages.push({id,role,parentUserId:node.getAttribute('data-parent-message-id')||null,
          images:[],settled:null,nativeProvenanceVerified:false,characterization:facts});
      }
    }
    const buttons=[...document.querySelectorAll('button')].filter(visible);
    const enabled=button=>!button.disabled && button.getAttribute('aria-disabled')!=='true';
    const stop=buttons.some(button=>enabled(button) && !button.closest('[data-message-author-role], [data-chatgpt-search-unit-key], [data-content-search-unit-key]') &&
      (/(?:^|-)stop(?:-|$)/i.test(button.getAttribute('data-testid')||'') || /^(?:Stop(?: generating| generation| streaming)?|停止(?:生成|回答|输出)?)$/i.test(button.getAttribute('aria-label')||'')));
    const composer=document.querySelector('div#prompt-textarea[contenteditable="true"], [data-testid="prompt-textarea"][contenteditable="true"], form [role="textbox"][contenteditable="true"], form .ProseMirror[contenteditable="true"]');
    const form=composer?.closest('form');
    const attachments=[...(form?.querySelectorAll('button[aria-label^="Remove "]')||[])].filter(visible).map(button=>({accepted:enabled(button)}));
    const alerts=[...document.querySelectorAll('[role="alert"], [data-testid*="error" i]')].filter(visible).map(node=>(node.innerText||'').trim());
    const loginRequired=!!document.querySelector('a[href*="/auth/login"], button[data-testid="login-button"]');
    const challengeRequired=!!document.querySelector('iframe[src*="challenges.cloudflare.com"], [name="cf-turnstile-response"]');
    return {url:location.href,online:navigator.onLine,loginRequired,challengeRequired,
      conversationMode:/\/c\/[0-9a-f-]+(?:[/?#]|$)/i.test(location.href)?'normal':'unknown',
      messagesComplete:!ambiguous && fallback.length>0,messages,generating:stop,
      inputReady:!!composer && !stop,composerText:(composer?.innerText||composer?.textContent||'').trim(),
      sendAvailable:buttons.some(button=>button.getAttribute('data-testid')==='send-button'&&enabled(button)),attachments,alerts};
  });
  snapshot.messages=snapshot.messages.map(message=>{
    if(message.role!=='user') return message;
    const {text,...facts}=message;return {...facts,promptHash:imagePromptHash(text)};
  });
  return snapshot;
}

/** Native single-action primitives; existing main.js owns route, model and upload.
 * This module does not open a Space, install an observer, poll generation, read
 * cookies, retry Enter after a click timeout or extract an output URL.
 */
export function createEgoImageUi({page,inspectNative,assertOwnedRoute,selectResources,uploadImage,onSendAttempt=()=>{}} = {}) {
  const need = (condition,code) => { if (!condition) { const error=new Error(code);error.code=code;throw error; } };
  need(page && typeof page.fill === 'function' && typeof page.click === 'function','IMAGE_NATIVE_PAGE_REQUIRED');
  need(typeof inspectNative === 'function','IMAGE_NATIVE_OBSERVER_UNVERIFIED');
  need(typeof assertOwnedRoute === 'function','IMAGE_NATIVE_OWNERSHIP_GATE_REQUIRED');
  need(typeof selectResources === 'function','IMAGE_NATIVE_MODEL_GATE_REQUIRED');
  const composer='div#prompt-textarea[contenteditable="true"], [data-testid="prompt-textarea"][contenteditable="true"], form [role="textbox"][contenteditable="true"], form .ProseMirror[contenteditable="true"]';
  async function inspect() { await assertOwnedRoute(); return inspectNative(page); }
  return Object.freeze({
    inspect,
    async selectResources(selection) { await assertOwnedRoute();return selectResources(page,selection); },
    async fill(text) { await assertOwnedRoute();await page.fill(composer,text,{timeout:3000}); },
    async sendOnce() {
      const observed=await inspect();
      need(observed.sendAvailable === true && observed.generating === false,'IMAGE_SEND_CONTROL_UNAVAILABLE');
      onSendAttempt();
      await page.click('button[data-testid="send-button"]',{timeout:3000,label:'submit one image request'});
    },
    async upload(source) {
      need(typeof uploadImage === 'function','IMAGE_NATIVE_UPLOAD_REQUIRED');
      await assertOwnedRoute();
      await uploadImage(page,source.path,source.mimeType);
      const observed=await inspect();
      return {accepted:Array.isArray(observed.attachments) && observed.attachments.length===1 &&
        observed.attachments[0].accepted===true && observed.inputReady===true && observed.generating===false};
    },
  });
}
