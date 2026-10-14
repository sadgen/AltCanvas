import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CanvasStore, canvasActorKey } from '../server/canvas-store.mjs';
import { enrollResearchLibrary } from '../scripts/auto-enroll-library.mjs';
import { syncResearchLibrary } from '../scripts/auto-sync-research-library.mjs';
import { applyReportMetadata } from '../scripts/apply-report-metadata.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-agent-'));
const store = new CanvasStore(path.join(directory, 'canvas.sqlite'));
const user = store.createUser({ username: 'agent-test', password: 'StrongPass123!' });
const actor = canvasActorKey('local', user.id);
const library = path.join(directory, 'library'); fs.mkdirSync(library);
const root = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: library, displayName: '投研报告' }])[0];
const topic = store.createWorkspace(actor, { name: '统计方法' });
const options = { store, username: 'agent-test', logFn() {} };
let scans = 0;
const scan = async () => { scans++; return { report: {} }; };
function file(name, text) {
  fs.writeFileSync(path.join(library, name), text);
  return store.createSourceFile(actor, root.id, { relativePath: name, filename: name,
    sha256: crypto.createHash('sha256').update(text).digest('hex'), sizeBytes: Buffer.byteLength(text), status: 'active' });
}
try {
  file('report-one.txt', '统计方法研究'); file('report-two.txt', '另一篇文章');
  let result = await syncResearchLibrary({ ...options, scan, dryRun: true });
  assert.equal(scans, 0, 'dry-run must never invoke mutating scanner');
  assert.equal(result.pendingEnroll, 2);
  assert.equal(store.db.prepare('SELECT count(*) n FROM documents').get().n, 0);
  await assert.rejects(enrollResearchLibrary({ ...options, targetRootName: '不存在', scan }), /not found/);
  assert.equal(scans, 0, 'missing root must never silently choose the first folder');
  result = await enrollResearchLibrary({ ...options, scan });
  assert.equal(result.enrolled.length, 2);
  const docs = result.enrolled;
  assert.throws(() => applyReportMetadata([{ filename: 'report', cleanTitle: '错误标题' }], options), /ambiguous/);
  assert.equal(store.listDocumentMetas(actor, { libraryType: 'native', libraryId: 'local' }).length, 0);
  applyReportMetadata([{ documentId: docs[0].documentId, cleanTitle: '明确文章', topics: [] }], options);
  assert.equal(store.db.prepare('SELECT count(*) n FROM topic_documents WHERE item_key=? AND deleted_at IS NULL').get(docs[0].documentId).n, 0, 'no match must not insert the default topic');
  store.saveDocumentMeta(actor, { libraryType: 'native', libraryId: 'local', itemKey: docs[0].documentId, cleanTitle: '人工标题', institution: '人工来源', source: 'manual' });
  result = applyReportMetadata([{ documentId: docs[0].documentId, cleanTitle: '被覆盖', topic: topic.id }], options);
  assert.equal(result.skipped, 1);
  assert.equal(store.getDocumentMeta(actor, { libraryType: 'native', libraryId: 'local', itemKey: docs[0].documentId }).cleanTitle, '人工标题');
  result = await syncResearchLibrary({ ...options, scan, extractSnippet: () => '文章正文', aiCompletion: async () => 'invalid JSON' });
  assert.equal(result.failed, 1);
  assert.equal(store.getDocumentMeta(actor, { libraryType: 'native', libraryId: 'local', itemKey: docs[1].documentId }), null, 'bad AI output must stay pending, not be marked complete');
  result = await syncResearchLibrary({ ...options, scan, extractSnippet: () => '文章正文', aiCompletion: async () => JSON.stringify({
    classifications: { [docs[1].documentId]: [] }, documentMetadata: { [docs[1].documentId]: { cleanTitle: '识别标题' } }
  }) });
  assert.equal(result.classifiedCount, 1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM topic_documents WHERE item_key=? AND deleted_at IS NULL').get(docs[1].documentId).n, 0);
  const removed = store.getDocument(actor, docs[1].documentId);
  store.unbindDocumentFromLibrary(actor, removed.id, removed.version);
  result = await enrollResearchLibrary({ ...options, scan });
  assert.equal(result.enrolled.length, 0, 'daily enrollment must respect deliberate removal from library');
  file('bad.txt', '失败文件内容'); file('good.txt', '成功文件内容');
  const originalEnroll = store.enrollExistingSourceFile.bind(store);
  store.enrollExistingSourceFile = (owner, id) => {
    if (store.getSourceFile(owner, id).filename === 'bad.txt') return store.transaction(() => {
      store.createDocument(owner, { title: '必须回滚' }); throw new Error('simulated failure');
    });
    return originalEnroll(owner, id);
  };
  const countBefore = store.db.prepare('SELECT count(*) n FROM documents').get().n;
  result = await enrollResearchLibrary({ ...options, scan });
  assert.equal(result.failed, 1); assert.equal(result.enrolled.length, 1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM documents').get().n, countBefore + 1, 'failed enrollment must roll back while later files succeed');
  const good = result.enrolled[0].documentId;
  const secondTopic = store.createWorkspace(actor, { name: '投资研究' });
  result = await syncResearchLibrary({ ...options, scan, extractSnippet: () => '正文', aiCompletion: async () => JSON.stringify({
    classifications: { [good]: [{ workspaceId: topic.id, confidence: .9 }, { workspaceId: secondTopic.id, confidence: .8 }, { workspaceId: 'unowned-topic', confidence: .99 }] },
    documentMetadata: { [good]: { cleanTitle: '多主题文章' } }
  }) });
  assert.equal(result.classifiedCount, 1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM topic_documents WHERE item_key=? AND deleted_at IS NULL').get(good).n, 2, 'only real owned topics may be bound, preserving multiple matches');
  store.createUser({ username: 'second-admin', password: 'StrongPass456!' });
  await assert.rejects(enrollResearchLibrary({ store, scan, logFn() {} }), /Specify one administrator/);
  await assert.rejects(syncResearchLibrary({ ...options, maxEnrollLimit: NaN }), /limit/);
} finally { store.close(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
console.log('✅ Agent dry-run, root/account targeting, unambiguous metadata, manual preservation, retry and topic policy passed');
