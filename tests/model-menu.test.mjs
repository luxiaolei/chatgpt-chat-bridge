import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function openModelMenu('), source.indexOf('\nasync function setModel('));
const openMenu = new Function('detectWebRateLimit', body + '; return openModelMenu;')(async () => {});

function fixture(stale = false) {
  let clicked = 0, marked = false, evaluations = 0;
  const button = {
    innerText: 'High', isConnected: true,
    getClientRects: () => button.isConnected ? [{}] : [],
    closest: () => null,
    getAttribute: name => name === 'aria-label' ? 'Select ChatGPT model' : null,
    setAttribute: () => { marked = true; }, removeAttribute: () => { marked = false; },
    click: () => { clicked++; },
  };
  const context = { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), document: {
    querySelectorAll: selector => selector === 'button' ? [button] : selector.includes('menuitemradio') ? (clicked ? [button] : []) : (marked ? [button] : []),
    querySelector: () => marked ? button : null,
  } };
  const evaluate = fn => vm.runInNewContext(`(${fn.toString()})()`, context);
  return { clicked: () => clicked, page: {
    evaluate: async fn => { if (++evaluations === 2 && stale) button.isConnected = false; return evaluate(fn); },
    click: async () => { throw Error('pointer intercepted by transient overlay'); },
    waitForFunction: async fn => { if (!evaluate(fn)) throw Error('condition not met'); },
    waitForTimeout: async () => {},
  } };
}

test('model menu opens through an overlay without a physical pointer click', async () => {
  const f = fixture();
  await openMenu(f.page);
  assert.equal(f.clicked(), 1);
});

test('a model button removed after marking is never clicked', async () => {
  const f = fixture(true);
  await assert.rejects(openMenu(f.page), /disappeared before menu open/);
  assert.equal(f.clicked(), 0);
});
