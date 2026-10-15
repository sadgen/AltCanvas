import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = name => {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    \\}`));
  assert.ok(match, `${name} must exist`);
  return match[0];
};
class Element {
  children = []; handlers = {}; disabled = false; value = '';
  replaceChildren() { this.children = []; }
  appendChild(child) { this.children.push(child); }
  addEventListener(event, handler) { this.handlers[event] = handler; }
}
const select = new Element(), settings = new Element();
const chips = ['all', 'unclassified'].map(value => Object.assign(new Element(), { dataset: { libFilter: value } }));
const refreshed = [], snapshots = [], reports = [];
const ui = vm.createContext({
  document: {
    getElementById: id => id === 'select-topic-workspace' ? select : settings,
    createElement: () => new Element(), querySelectorAll: () => chips
  },
  userWorkspaces: [{ id: 'a', name: '分类 A' }, { id: 'b', name: '分类 B' }],
  libraryTopicFilter: '', libraryFilterState: 'all', libraryFilteredItems: null, currentLibraryView: 'all',
  canvasWorkspace: { id: 'previous' }, canvasBoard: { id: 'previous-board' }, topicWorkspaceSwitchToken: 0,
  canvasMaximized: false, mobileMedia: { matches: false },
  toggleCanvasMaximize: () => { ui.canvasMaximized = !ui.canvasMaximized; },
  setMobilePane: pane => { ui.mobilePane = pane; },
  config: { userId: 'user' },
  localStorage: { setItem() {} }, updateCanvasAiToolbar() {}, setCanvasSaveState() {},
  showToast: message => reports.push(message), errorMessage: error => error.message, reportApplicationError() {},
  loadTopicLibraryDocuments: async () => refreshed.push(ui.libraryTopicFilter),
  applyLibraryFilter: async filter => { ui.libraryFilterState = filter; refreshed.push(filter); },
  switchLibraryView: async view => { ui.currentLibraryView = view; await ui.refreshCurrentLibraryView(); },
  canvasFetch: async url => [{ id: `${url.includes('/a/') ? 'a' : 'b'}-board` }],
  loadCanvasSnapshot: async () => snapshots.push(ui.canvasBoard.id)
});
for (const name of ['renderTopicWorkspaceSelector', 'refreshCurrentLibraryView', 'switchTopicWorkspace', 'selectLibraryCategory']) {
  vm.runInContext(source(name), ui);
}
const binding = html.slice(html.indexOf("    document.getElementById('select-topic-workspace')?.addEventListener"),
  html.indexOf("    document.getElementById('btn-library-view-all')?.addEventListener"));
vm.runInContext(binding, ui);
const tick = () => new Promise(setImmediate);

ui.renderTopicWorkspaceSelector('previous');
assert.equal(select.children[0].textContent, '全部分类');
assert.equal(select.value, '', 'initial category must reflect the document filter, not a hidden board workspace');
assert.equal(settings.disabled, true);
select.handlers.change({ target: { value: 'a' } });
await tick();
assert.equal(ui.libraryTopicFilter, 'a', 'the actual top selector must change the library filter');
assert.equal(refreshed.at(-1), 'a');
assert.equal(ui.canvasWorkspace.id, 'a');
assert.equal(ui.canvasBoard.id, 'a-board');
assert.equal(settings.disabled, false);
assert.equal(select.value, 'a');
assert.deepEqual(snapshots, ['a-board']);

ui.currentLibraryView = 'files';
ui.canvasMaximized = true;
ui.mobileMedia.matches = true;
await ui.selectLibraryCategory('b');
assert.equal(ui.currentLibraryView, 'all', 'the global category must show its document list from the raw-files view');
assert.equal(ui.canvasMaximized, false, 'a category selection must reveal the library instead of keeping it behind a full-screen board');
assert.equal(ui.mobilePane, 'library');
assert.equal(refreshed.at(-1), 'b');
await ui.selectLibraryCategory('');
assert.equal(refreshed.at(-1), 'all');
assert.equal(select.value, '');
assert.equal(settings.disabled, true);
ui.renderTopicWorkspaceSelector('b');
assert.equal(select.value, '', 'rebuilding options must not silently reselect the active board workspace');

// Switching A→B while A's board request is delayed must keep B's list AND board.
let finishA;
ui.canvasFetch = async url => url.includes('/a/') ? new Promise(resolve => { finishA = resolve; }) : [{ id: 'b-board' }];
const pendingA = ui.selectLibraryCategory('a');
await tick();
await ui.selectLibraryCategory('b');
finishA([{ id: 'obsolete-a-board' }]);
await pendingA;
assert.equal(ui.canvasWorkspace.id, 'b');
assert.equal(ui.canvasBoard.id, 'b-board');
assert.equal(select.value, 'b');

// Returning to all categories invalidates an earlier board request too.
const pendingAgain = ui.selectLibraryCategory('a');
await tick();
await ui.selectLibraryCategory('');
finishA([{ id: 'obsolete-a-board' }]);
await pendingAgain;
assert.equal(ui.canvasBoard.id, 'b-board');
assert.equal(select.value, '');

// A board failure leaves the category's document filter usable and does not
// half-assign a new workspace with the previous workspace's board.
ui.canvasFetch = async () => { throw new Error('board unavailable'); };
await ui.selectLibraryCategory('a');
assert.equal(ui.libraryTopicFilter, 'a');
assert.equal(refreshed.at(-1), 'a');
assert.equal(ui.canvasWorkspace.id, 'b');
assert.ok(reports.some(message => message.includes('board unavailable')));

const chipBinding = html.slice(html.indexOf("    document.querySelectorAll('.lib-filter-chip').forEach(chip => {"),
  html.indexOf("    document.getElementById('select-library-sort')?.addEventListener"));
vm.runInContext(chipBinding, ui);
chips[1].handlers.click();
await tick();
assert.equal(select.value, '');
assert.equal(ui.libraryFilterState, 'unclassified');
assert.equal(settings.disabled, true);

for (const id of ['btn-open-topic-settings', 'btn-close-topic-settings', 'btn-save-topic-meta', 'btn-delete-topic']) {
  assert.equal(html.split(`document.getElementById('${id}')?.addEventListener`).length - 1, 1,
    `${id} must bind once, so one click cannot issue duplicate saves/deletes`);
}
for (const id of ['select-library-topic', 'btn-manage-library-topic', 'btn-toggle-canvas-max', 'btn-reading-view', 'btn-refresh-cards']) {
  assert.ok(!html.includes(`id="${id}"`), `redundant ${id} must be removed from the UI`);
}
assert.doesNotMatch(html, /Collection 绑定|currentTopicWorkspaceId/);

let menu, regenerated = false, refreshedBoard = false, maximized = false;
const reanalyze = { hidden: false, disabled: false };
const reading = vm.createContext({
  document: { getElementById: () => reanalyze }, readingGuideEnabled: true,
  canvasReady: true, mobileMedia: { matches: false }, canvasMaximized: false,
  AltCanvasLibraryMenu: { open(_trigger, config) { menu = config; } },
  setReadingView: guided => { reading.readingGuideEnabled = guided; },
  generateCurrentPdfUnderstandingCanvas: force => { regenerated = force; },
  loadCanvasSnapshot: () => { refreshedBoard = true; },
  toggleCanvasMaximize: () => { maximized = true; }, showToast() {}, errorMessage: error => error.message
});
vm.runInContext(source('openReadingMenu'), reading);
reading.openReadingMenu({});
menu.actions.find(action => action.label === '重新生成导读').run();
menu.actions.find(action => action.label === '刷新内容').run();
menu.actions.find(action => action.label === '全屏导读').run();
menu.actions.find(action => action.label === '打开高级画板').run();
assert.ok(regenerated && refreshedBoard && maximized);
assert.equal(reading.readingGuideEnabled, false);
reading.mobileMedia.matches = true;
reanalyze.hidden = true;
reading.openReadingMenu({});
assert.ok(menu.actions.some(action => action.label === '返回文章导读'));
assert.equal(menu.actions.find(action => action.label === '重新生成导读').disabled, true);
assert.ok(menu.actions.every(action => !/全屏|恢复三栏/.test(action.label)));

// One publication-date editor also carries legacy year-only metadata. Saving
// it derives the compatibility year instead of leaving two editable dates.
const fields = new Map();
for (const [id, value] of Object.entries({
  'doc-meta-item-key': 'doc',
  'input-doc-meta-clean-title': '人工标题', 'input-doc-meta-institution': '机构',
  'input-doc-meta-publication-date': '2026-10-16', 'input-doc-meta-report-title': '主标题',
  'input-doc-meta-subtitle': '', 'input-doc-meta-summary': ''
})) fields.set(id, { value });
let saved;
const metadata = vm.createContext({
  document: { getElementById: id => { assert.notEqual(id, 'input-doc-meta-year'); return fields.get(id); } },
  currentEditingMetaItem: { key: 'doc', isNative: true, libraryType: 'native', libraryId: 'local' }, currentItem: null, currentDocumentLibrary: null, config: {},
  documentMetas: new Map(), docMetaKey: () => 'doc',
  fetch: async (_url, options) => { saved = JSON.parse(options.body); return { ok: true, json: async () => ({ data: { ...saved } }) }; },
  refreshCurrentLibraryView() {}, closeDocMetaModal() {}, showToast() {}, errorMessage: error => error.message
});
vm.runInContext(source('saveDocMetaModal'), metadata);
await metadata.saveDocMetaModal();
assert.equal(saved.publicationDate, '2026-10-16');
assert.equal(saved.year, '2026');
fields.get('input-doc-meta-publication-date').value = '2025';
await metadata.saveDocMetaModal();
assert.equal(saved.publicationDate, '2025');
assert.equal(saved.year, '2025');
console.log('✅ Top category binding, unified selection, raw-files return, board-switch races, single settings events and reading menu actions passed');
