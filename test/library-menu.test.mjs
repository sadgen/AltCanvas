import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const listeners = {};
const document = { activeElement: null, addEventListener: (type, fn) => { listeners[type] = fn; } };
class Element {
  children = []; attributes = {}; style = {}; className = ''; isConnected = true;
  classList = { add: value => { this.className += ` ${value}`; } };
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getBoundingClientRect() { return { right: 310, bottom: 790, width: 260, height: 160 }; }
  focus() { document.activeElement = this; }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); this.isConnected = false; }
}
document.createElement = () => new Element(); document.body = new Element();
const context = vm.createContext({ document, innerWidth: 320, innerHeight: 800, addEventListener() {} });
vm.runInContext(fs.readFileSync(new URL('../assets/library-menu.js', import.meta.url), 'utf8'), context);
const anchor = new Element();
let ran = 0;
context.AltCanvasLibraryMenu.open(anchor, { title: '操作', details: ['<img src=x>'], actions: [
  { label: '暂不可用', disabled: true, run() { assert.fail('disabled action'); } },
  { label: '重命名', run() { ran++; } }, { label: '移动', run() { ran++; } }
] });
const popup = document.body.children[0];
assert.equal(popup.style.top, '632px', 'menu must fit below viewport edge');
assert.equal(popup.style.left, '50px');
assert.equal(popup.children[0].children[0].textContent, '<img src=x>', 'file metadata must remain text');
assert.equal(document.activeElement.textContent, '重命名');
listeners.keydown({ key: 'ArrowDown', preventDefault() {} });
assert.equal(document.activeElement.textContent, '移动');
await document.activeElement.onclick({ stopPropagation() {} });
assert.equal(ran, 1); assert.equal(document.body.children.length, 0); assert.equal(document.activeElement, anchor);
context.AltCanvasLibraryMenu.open(anchor, { actions: [{ label: '操作', run() {} }] });
listeners.keydown({ key: 'Escape', preventDefault() {} });
assert.equal(document.body.children.length, 0); assert.equal(anchor.attributes['aria-expanded'], 'false');

// Run the actual article-menu wiring: rename must call the supported action, not rename-original.
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const helper = html.slice(html.indexOf('    function openArticleMenu('), html.indexOf('    function openSourceEntryMenu('));
const subtitleContext=vm.createContext({});
vm.runInContext(html.slice(html.indexOf('    function compactArticleSubtitle('),html.indexOf('    function openLibraryMenu(')),subtitleContext);
assert.equal(subtitleContext.compactArticleSubtitle({institution:'机构',year:'2025'},'【机构】文章（2025）'),'', 'do not repeat metadata already visible in the title');
assert.equal(subtitleContext.compactArticleSubtitle({institution:'机构',year:'2025'},'文章'),'机构 · 2025');

let config, action;
const wiring = vm.createContext({ AltCanvasLibraryMenu: { open(_trigger, value) { config = value; } },
  openDocMetaModal() {}, openAddToTopicModal() {}, handleSourceFileAction: value => { action = value; },
  showToast() {}, errorMessage: error => error.message });
vm.runInContext(helper, wiring);
wiring.openArticleMenu({ isNative: true, key: 'doc-1', data: { title: '文章' }, sourceFile: { filename: 'original.pdf', relativePath: 'original.pdf', status: 'active' } }, anchor);
await config.actions.find(entry => entry.label === '重命名原始文件').run();
assert.equal(action, 'rename');
assert.ok(config.details.includes('original.pdf'), 'raw filename belongs in the menu');
assert.ok(config.actions.some(entry => entry.label === '加入研究主题'));
const pathHelper = html.slice(html.indexOf('    async function openFilePathMenu('), html.indexOf('    function openArticleMenu('));
let copied, requested;
const locations = [{ label: '服务器原文路径', path: '/mnt/reports/report.pdf', onDemand: false },
  { label: '5.233（Z盘）', path: 'Z:\\hermesagent_shares\\金融研究_paper\\report.pdf', onDemand: false }];
const pathWiring = vm.createContext({ window: { location: { hostname: '192.168.5.237' } },
  m4Fetch: async endpoint => { requested = endpoint; return { data: { filename: 'report.pdf', locations } }; },
  AltCanvasLibraryMenu: { open(_trigger, value) { config = value; } },
  AltCanvasFilePathCopy: { copy: async value => { copied = value; } }, showToast() {}, errorMessage: err => err.message });
vm.runInContext(pathHelper, pathWiring);
await pathWiring.openFilePathMenu('/native/documents/doc-1/file-location', anchor);
assert.equal(requested, '/native/documents/doc-1/file-location');
await config.actions[1].run();
assert.equal(copied, locations[1].path, 'selected agent must receive its own exact path');
pathWiring.AltCanvasFilePathCopy.copy = async () => { throw new Error('clipboard blocked'); };
await config.actions[0].run();
assert.equal(config.title, '手动复制原文路径');
assert.ok(config.details.includes(locations[0].path), 'blocked clipboard must expose a selectable path');
console.log('✅ Library menu positioning, keyboard, safe text, article actions and agent path selection passed');
