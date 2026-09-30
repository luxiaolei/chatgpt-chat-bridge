/** Native single-action primitives; existing main.js owns route, model and upload.
 * This module does not open a Space, install an observer, poll generation, read
 * cookies, retry Enter after a click timeout or extract an output URL.
 */
export function createEgoImageUi({page,inspectNative,assertOwnedRoute,selectResources,uploadImage} = {}) {
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
