import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { CanvasStore } from '../server/canvas-store.mjs';
import { normalizePublicationDate, titleWithPublicationDate } from '../server/document-metadata.mjs';

for (const [input, expected] of [
  ['2024年2月29日', '2024-02-29'], ['2025/6/8', '2025-06-08'],
  ['2025.6', '2025-06'], ['2025年', '2025'], ['2025-02-29', ''],
  ['2024-13-01', ''], ['2025-06-00', ''], ['未知', ''], ['', '']
]) assert.equal(normalizePublicationDate(input), expected);
assert.equal(titleWithPublicationDate('【机构】报告（2025）', '2025-06-18'), '【机构】报告（2025-06-18）');
assert.equal(titleWithPublicationDate('报告（2025-06-18）', '2025-06-18'), '报告（2025-06-18）');
assert.equal(titleWithPublicationDate('报告', ''), '报告');
assert.ok(titleWithPublicationDate('文'.repeat(500), '2025-06-18').length <= 500);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-publication-'));
const dbPath = path.join(dir, 'canvas.sqlite');
let store;
try {
  store = new CanvasStore(dbPath);
  const key = { libraryType: 'native', libraryId: 'local', itemKey: 'publication-doc' };
  const original = store.saveDocumentMeta('owner', { ...key, cleanTitle: '原有名称（2025）' });
  // Recreate the genuine v13 shape, including a previously saved metadata row.
  store.db.exec('ALTER TABLE document_metas DROP COLUMN publication_date; DELETE FROM schema_migrations WHERE version=14');
  store.close();
  store = new CanvasStore(dbPath);
  assert.equal(store.getDocumentMeta('owner', key).cleanTitle, original.cleanTitle);
  assert.equal(store.getDocumentMeta('owner', key).publicationDate, '');
  const updated = store.saveDocumentMeta('owner', { ...key, cleanTitle: original.cleanTitle, publicationDate: '2025年6月18日', source: 'ai_classification' });
  assert.equal(updated.publicationDate, '2025-06-18');
  assert.equal(updated.cleanTitle, '原有名称（2025-06-18）');
  assert.equal(store.getDocumentMeta('other-owner', key), null);
  // A manual title change keeps its explicit title and does not erase the date.
  store.saveDocumentMeta('owner', { ...key, cleanTitle: '人工名称', source: 'manual' });
  store.close();
  store = new CanvasStore(dbPath);
  assert.equal(store.getDocumentMeta('owner', key).publicationDate, '2025-06-18');
  assert.equal(store.getDocumentMeta('owner', key).cleanTitle, '人工名称');
} finally { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function source(name) {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    \\}`));
  assert.ok(match, `${name} must exist`);
  return match[0];
}
const escapeHTML = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const labels = vm.createContext({ escapeHTML });
vm.runInContext(source('articleTopicsMarkup'), labels);
assert.match(labels.articleTopicsMarkup({ topics: [{ workspace_name: '宏观' }, { name: '配置' }] }), /分类：宏观、配置/);
assert.match(labels.articleTopicsMarkup({}), /未分类/);
assert.ok(!labels.articleTopicsMarkup({ topics: [{ workspace_name: '<img src=x>' }] }).includes('<img'));
const css = fs.readFileSync(new URL('../assets/library-list.css', import.meta.url), 'utf8');
assert.doesNotMatch(css, /[^{}]*#btn-library-ai-classify[^{}]*\{[^}]*display\s*:\s*none/);

// The 201st document in a filter must remain visible, including category lists.
const requests = [];
const pagination = vm.createContext({ m4Fetch: async url => {
  requests.push(url);
  return { data: requests.length === 1 ? Array.from({ length: 200 }, (_, id) => ({ id })) : [{ id: 201 }] };
} });
vm.runInContext(source('fetchFilteredNativeDocuments'), pagination);
assert.equal((await pagination.fetchFilteredNativeDocuments('topicId=selected')).length, 201);
assert.match(requests[1], /offset=200/);

// A category must use the chosen filter even if the board still belongs to
// another workspace. Refresh replaces the cached item, title and topic labels.
const container = { innerHTML: '', rows: [], replaceChildren() { this.rows = []; }, appendChild(row) { this.rows.push(row); } };
const count = {};
let finishOld;
const ui = vm.createContext({
  document: {
    getElementById: id => id === 'items-container' ? container : count,
    createElement: () => ({ classList: { add() {} }, querySelector: () => ({ addEventListener() {} }) })
  },
  canvasWorkspace: { id: 'board-workspace' }, libraryTopicFilter: 'selected', topicLibraryLoadToken: 0,
  allItems: [{ key: 'doc', data: { title: '旧标题' } }], documentMetas: new Map(), selectedDocumentKeys: new Set(),
  fetchFilteredNativeDocuments: async query => {
    if (query === 'topicId=old') return new Promise(resolve => { finishOld = resolve; });
    assert.equal(query, 'topicId=selected');
    return [{ id: 'doc', title: '新标题', topics: [{ workspace_name: '新分类' }] }];
  },
  canvasFetch: async url => {
    assert.equal(url, '/documents/metadata?libraryType=native&libraryId=local');
    return [{ itemKey: 'doc', cleanTitle: '新名称（2026-10-15）' }];
  },
  rememberDocumentMetas(metas) { for (const meta of metas) ui.documentMetas.set(meta.itemKey, meta); },
  nativeDocumentToLibraryItem: doc => ({ key: doc.id, data: { title: doc.title }, topics: doc.topics }),
  normalizeLibraryContext: doc => doc, sortLibraryItems: items => items, docMetaKey: (_a, _b, key) => key,
  compactArticleSubtitle: () => '', escapeHTML, encodeURIComponent,
  updateLibrarySelectionUI() {}, openItem() {}, openArticleMenu() {},
  errorMessage: err => err.message, reportApplicationError() { assert.fail('unexpected category load failure'); }
});
vm.runInContext(source('articleTopicsMarkup') + '\n' + source('loadTopicLibraryDocuments'), ui);
await ui.loadTopicLibraryDocuments();
assert.equal(ui.allItems[0].data.title, '新标题');
assert.match(container.rows[0].innerHTML, /新名称（2026-10-15）/);
assert.match(container.rows[0].innerHTML, /分类：新分类/);
assert.equal(count.textContent, '1 篇');
ui.libraryTopicFilter = 'old';
const oldLoad = ui.loadTopicLibraryDocuments();
ui.libraryTopicFilter = 'selected';
await ui.loadTopicLibraryDocuments();
finishOld([{ id: 'obsolete', title: '过时响应' }]);
await oldLoad;
assert.equal(container.rows.length, 1);
assert.doesNotMatch(container.rows[0].innerHTML, /过时响应/);

// Execute the real recognition + binding loop. A 200 response with ok:false
// entries must surface failure, rather than claiming that classification saved.
for (const bindingOk of [true, false]) {
  const calls = [], remembered = [];
  const pipeline = vm.createContext({
    allItems: [{ key: 'doc', isNative: true, children: [{ key: 'attachment' }] }],
    AI_REFRESH_TEXT_MAX_DOCS: 50, AI_REFRESH_BATCH_SIZE: 4,
    isReadableAttachment: () => true, extractAttachmentPdfText: async () => '正文',
    rememberDocumentMetas: metas => remembered.push(...metas), showToast() {},
    setTimeout: callback => callback(),
    m4Fetch: async (url, options) => {
      if (url === '/native/classify/generate-topics') return { data: {
        documentMetas: [{ itemKey: 'doc', cleanTitle: '文章（2026-10-15）' }],
        classifications: { doc: [{ workspaceId: 'strong', confidence: .9 }, { workspaceId: 'weak', confidence: .4 }] }
      } };
      assert.equal(url, '/native/documents/batch-topics');
      calls.push(options.body);
      return { data: [{ documentId: 'doc', ok: bindingOk }] };
    }
  });
  vm.runInContext(source('refreshLibraryMetadataWithAi'), pipeline);
  const result = pipeline.refreshLibraryMetadataWithAi(['doc'], { force: true });
  if (bindingOk) {
    const totals = await result;
    assert.equal(totals.batches, 1);
    assert.equal(totals.applied, 1);
  } else await assert.rejects(result, /归类未保存/);
  assert.ok(calls.every(call => call.topicIds.length === 1 && call.topicIds[0] === 'strong'));
  assert.equal(remembered[0].cleanTitle, '文章（2026-10-15）');
}
console.log('✅ Publication date migration/persistence, visible category labels, pagination, refreshed names and category-switch races passed');
