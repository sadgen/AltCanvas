import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const elements = Object.fromEntries(['ai-wait-status', 'ai-wait-text', 'btn-ai-cancel'].map(id => [id, { hidden: true }]));
const timers = new Map();
let sequence = 0;
let resolveFetch;
const context = vm.createContext({
  document: { getElementById: id => elements[id] },
  AbortController, Response, Date,
  setInterval: callback => { timers.set(++sequence, callback); return sequence; },
  setTimeout: callback => { timers.set(++sequence, callback); return sequence; },
  clearInterval: id => timers.delete(id), clearTimeout: id => timers.delete(id),
  fetch: (_url, { signal }) => new Promise((resolve, reject) => {
    resolveFetch = resolve;
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  })
});
vm.runInContext(fs.readFileSync(new URL('../assets/ai-wait.js', import.meta.url), 'utf8'), context);
const request = context.AltCanvasAiWait.fetch;
let pending = request('/canvas/boards/test/ai/document-map');
assert.equal(elements['ai-wait-status'].hidden, false);
assert.match(elements['ai-wait-text'].textContent, /阅读全文.*0 秒/);
await assert.rejects(request('/canvas/documents/extract-metadata'), e => e.code === 'ai_busy');
elements['btn-ai-cancel'].onclick();
await assert.rejects(pending, e => e.code === 'ai_cancelled');
assert.equal(elements['ai-wait-status'].hidden, true);
assert.equal(timers.size, 0);
pending = request('/canvas/documents/extract-metadata');
[...timers.values()][1]();
await assert.rejects(pending, e => e.code === 'ai_timeout');
assert.equal(timers.size, 0);
pending = request('/canvas/documents/extract-metadata');
resolveFetch(new Response('{"data":{"ok":true}}', { status: 200 }));
assert.deepEqual(await (await pending).json(), { data: { ok: true } });
assert.equal(timers.size, 0);
assert.equal(elements['btn-ai-cancel'].onclick, null);
console.log('✅ AI waiting, duplicate prevention, cancellation, deadline and cleanup passed');
