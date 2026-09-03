import assert from 'assert/strict';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { CanvasNotFoundError, CanvasStore, canvasActorKey } from '../server/canvas-store.mjs';
import { createCanvasHandler, parseNativeLibraryRootsConfig } from '../server/canvas-api.mjs';
import { createSession } from '../server/session.mjs';
import {
  NativePathError,
  normalizeRelativePath,
  normalizeFilename,
  resolveInsideRoot,
  openFileInsideRoot,
  hashFileInsideRoot,
  walkDirectory,
  listDirectoryLevel
} from '../server/native-fs.mjs';

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = new Map();
    this.chunks = [];
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    return this;
  }

  write(chunk) {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
    this.emit('finish');
    this.emit('close');
  }

  get buffer() {
    return Buffer.concat(this.chunks);
  }

  get text() {
    return this.buffer.toString('utf8');
  }

  get payload() {
    return this.text ? JSON.parse(this.text) : null;
  }
}

function request({ method = 'GET', cookie, headers = {}, body } = {}) {
  let chunks = [];
  if (Buffer.isBuffer(body)) chunks = [body];
  else if (typeof body === 'string') chunks = [Buffer.from(body)];
  else if (body !== undefined && body !== null) chunks = [Buffer.from(JSON.stringify(body))];

  return {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    socket: { encrypted: false, remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    }
  };
}

async function call(handler, pathname, options = {}) {
  const response = new MockResponse();
  await handler(request(options), response, new URL(pathname, 'http://127.0.0.1:8088'));
  await new Promise(resolve => setTimeout(resolve, 50));
  return response;
}

function makePdfBytes(text) {
  const content = `BT /F1 12 Tf (${text}) Tj ET`;
  const header = Buffer.from('%PDF-1.4\n');
  const body = Buffer.from(`1 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\ntrailer\n<< /Size 1 /Root 1 0 R >>\n%%EOF\n`);
  return Buffer.concat([header, body]);
}

function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  console.log('🧪 Running AltCanvas Native M4 Library Manager Tests...');

  // ============================================================
  // 1. Path safety primitives
  // ============================================================
  {
    assert.throws(() => normalizeRelativePath(''), NativePathError);
    assert.throws(() => normalizeRelativePath('/etc/passwd'), NativePathError);
    assert.throws(() => normalizeRelativePath('a/../b'), NativePathError);
    assert.throws(() => normalizeRelativePath('..'), NativePathError);
    assert.throws(() => normalizeRelativePath('.'), NativePathError);
    assert.throws(() => normalizeRelativePath('a\\b.pdf'), NativePathError);
    assert.throws(() => normalizeRelativePath('a\0b'), NativePathError);
    assert.throws(() => normalizeRelativePath('.trash/x.pdf'), NativePathError);
    assert.throws(() => normalizeRelativePath('dir/'), NativePathError);
    assert.throws(() => normalizeRelativePath('dir//x.pdf'), NativePathError);
    assert.throws(() => normalizeRelativePath('C:/x.pdf'), NativePathError);
    assert.equal(normalizeRelativePath('sub/dir/report.pdf'), 'sub/dir/report.pdf');
    assert.throws(() => normalizeFilename('dir/x.pdf'), NativePathError);
    assert.throws(() => normalizeFilename('.'), NativePathError);
    assert.throws(() => normalizeFilename('.hidden.pdf'), NativePathError);
    assert.throws(() => normalizeFilename('report.epub', { requirePdf: true }), NativePathError);
    assert.equal(normalizeFilename('  Report.PDF ', { requirePdf: true }), 'Report.PDF');
    assert.throws(() => resolveInsideRoot('/tmp/root', '../outside.pdf'), err => err.code === 'path_escape');
    assert.equal(resolveInsideRoot('/tmp/root', 'sub/a.pdf'), path.resolve('/tmp/root', 'sub/a.pdf'));
    console.log('✅ Path validation primitives passed');
  }

  // ============================================================
  // 2. Symlink escape, fd-verified hashing, directory walking
  // ============================================================
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-fs-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-outside-'));
    try {
      const bytes = makePdfBytes('hello');
      fs.writeFileSync(path.join(tempDir, 'report.pdf'), bytes);
      fs.mkdirSync(path.join(tempDir, 'sub'));
      fs.writeFileSync(path.join(tempDir, 'sub', 'inner.pdf'), makePdfBytes('inner'));

      // Final-component symlink is rejected even when it points inside the root.
      fs.symlinkSync(path.join(tempDir, 'report.pdf'), path.join(tempDir, 'link-inside.pdf'));
      assert.throws(() => openFileInsideRoot(tempDir, 'link-inside.pdf'), err => err.code === 'symlink_rejected');

      // Symlinked directory pointing outside the root is rejected on open.
      fs.symlinkSync(outsideDir, path.join(tempDir, 'escape-dir'));
      fs.writeFileSync(path.join(outsideDir, 'secret.pdf'), makePdfBytes('secret'));
      assert.throws(() => openFileInsideRoot(tempDir, 'escape-dir/secret.pdf'), err => err.code === 'path_escape');

      const hashed = await hashFileInsideRoot(tempDir, 'report.pdf');
      assert.equal(hashed.sha256, sha256Of(bytes));
      assert.equal(hashed.sizeBytes, bytes.length);

      // Opening a real file returns a working fd anchored on a regular file.
      const opened = openFileInsideRoot(tempDir, 'sub/inner.pdf');
      assert.equal(opened.stat.isFile(), true);
      fs.closeSync(opened.fd);

      // Walk: symlinked dirs are reported but never traversed (the outside
      // secret must not appear), the trash directory is excluded.
      fs.mkdirSync(path.join(tempDir, '.altcanvas-trash'));
      fs.writeFileSync(path.join(tempDir, '.altcanvas-trash', 'dropped.pdf'), makePdfBytes('dropped'));
      const seenFiles = [];
      const seenSymlinks = [];
      walkDirectory(tempDir, '', {
        onEntry: entry => { seenFiles.push(entry.relativePath); },
        onSymlink: entry => { seenSymlinks.push(entry.relativePath); }
      });
      assert.deepEqual(seenFiles.sort(), ['report.pdf', 'sub/inner.pdf']);
      assert.deepEqual(seenSymlinks.sort(), ['escape-dir', 'link-inside.pdf']);

      const level = listDirectoryLevel(tempDir);
      assert.equal(level.some(e => e.name.startsWith('.')), false, 'hidden entries must not be listed');
      assert.equal(level[0].type, 'directory', 'directories sort before files');
      assert.equal(level.find(e => e.name === 'report.pdf').type, 'pdf');
      console.log('✅ Symlink escape rejection, fd hashing and directory walking passed');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  }

  // ============================================================
  // 3. parseNativeLibraryRootsConfig formats
  // ============================================================
  {
    assert.deepEqual(parseNativeLibraryRootsConfig({ NATIVE_LIBRARY_ROOTS: '' }), []);
    const jsonRoots = parseNativeLibraryRootsConfig({
      NATIVE_LIBRARY_ROOTS: JSON.stringify([{ path: '/data/library', name: '研究文库' }])
    });
    assert.deepEqual(jsonRoots, [{ absolutePath: '/data/library', displayName: '研究文库' }]);
    const semiRoots = parseNativeLibraryRootsConfig({
      NATIVE_LIBRARY_ROOTS: '/data/library|研究文库;/data/papers'
    });
    assert.deepEqual(semiRoots, [
      { absolutePath: '/data/library', displayName: '研究文库' },
      { absolutePath: '/data/papers', displayName: 'papers' }
    ]);
    assert.throws(() => parseNativeLibraryRootsConfig({ NATIVE_LIBRARY_ROOTS: '[{"path": "relative"}]' }), /absolute/);
    assert.throws(() => parseNativeLibraryRootsConfig({ NATIVE_LIBRARY_ROOTS: '[broken' }), /valid JSON/);
    console.log('✅ NATIVE_LIBRARY_ROOTS config parsing passed');
  }

  // ============================================================
  // 4. Schema v13: fresh database
  // ============================================================
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-store-'));
  const dbPath = path.join(tempDir, 'canvas.sqlite');
  const actor = canvasActorKey('local', 'm4-user');
  let store;
  try {
    store = new CanvasStore(dbPath);
    const version = store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    assert.equal(version, 13, 'fresh database must migrate straight to v13');
    const tables = new Set(
      store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    );
    for (const required of ['library_roots', 'source_files', 'file_operations']) {
      assert.equal(tables.has(required), true, `${required} table must exist`);
    }
    const attCols = new Map(
      store.db.prepare('PRAGMA table_info(attachments)').all().map(c => [c.name, c])
    );
    assert.equal(attCols.get('blob_hash').notnull, 0, 'blob_hash must be nullable in v13');
    assert.equal(attCols.has('storage_kind'), true);
    assert.equal(attCols.has('source_file_id'), true);
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);

    // Idempotent reopen: closing and opening again must not re-run or break.
    store.close();
    store = new CanvasStore(dbPath);
    assert.equal(store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 13);
    console.log('✅ Schema v13 fresh database migration and idempotent reopen passed');
  } catch (err) {
    try { store?.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }

  try {
    // ============================================================
    // 5. Library roots provisioning (server config only)
    // ============================================================
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-root-'));
    const otherUser = canvasActorKey('local', 'm4-other');

    let roots = store.ensureLibraryRootsFromConfig(actor, [
      { absolutePath: rootDir, displayName: '研究文库' }
    ]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].displayName, '研究文库');
    assert.equal(roots[0].absolutePath, path.resolve(rootDir));

    // Idempotent: same path does not duplicate, name updates in place.
    roots = store.ensureLibraryRootsFromConfig(actor, [
      { absolutePath: rootDir, displayName: ' renamed ' }
    ]);
    assert.equal(roots.length, 1, 'same root path must not duplicate');
    assert.equal(roots[0].displayName, 'renamed');

    // Owner isolation.
    assert.equal(store.ensureLibraryRootsFromConfig(otherUser, [{ absolutePath: rootDir, displayName: 'x' }]).length, 1);
    assert.equal(store.listLibraryRoots(actor).length, 1);
    assert.throws(() => store.requireLibraryRoot(otherUser, roots[0].id), CanvasNotFoundError);

    const root = store.requireLibraryRoot(actor, roots[0].id);
    store.setLibraryRootScanState(actor, root.id, { status: 'running' });
    assert.equal(store.getLibraryRoot(actor, root.id).lastScanStatus, 'running');
    store.setLibraryRootScanState(actor, root.id, { status: 'ok', at: new Date().toISOString() });
    assert.equal(store.getLibraryRoot(actor, root.id).lastScanStatus, 'ok');
    console.log('✅ Library root provisioning and ownership isolation passed');

    // ============================================================
    // 6. Source files + unified attachment content (source_file kind)
    // ============================================================
    const docBytes = makePdfBytes('native-source-file');
    const docSha = sha256Of(docBytes);
    fs.writeFileSync(path.join(rootDir, 'paper.pdf'), docBytes);

    const document = store.createDocument(actor, { title: '文库文件名：某研究报告' });
    const sourceFile = store.createSourceFile(actor, root.id, {
      relativePath: 'paper.pdf',
      filename: 'paper.pdf',
      sha256: docSha,
      sizeBytes: docBytes.length,
      modifiedAt: Math.round(fs.statSync(path.join(rootDir, 'paper.pdf')).mtimeMs)
    });

    // Attach the source file to the document with a source_file attachment.
    const timestamp = new Date().toISOString();
    const attachmentId = crypto.randomUUID();
    store.db.prepare(`
      INSERT INTO attachments
        (id, document_id, blob_hash, mime_type, original_filename, title, size_bytes,
         storage_kind, source_file_id, version, created_at, updated_at)
      VALUES (?, ?, NULL, 'application/pdf', 'paper.pdf', '文库文件名：某研究报告', ?, 'source_file', ?, 1, ?, ?)
    `).run(attachmentId, document.id, docBytes.length, sourceFile.id, timestamp, timestamp);

    const content = store.getAttachmentContent(actor, attachmentId);
    assert.equal(content.kind, 'source_file');
    assert.equal(content.sha256, docSha);
    assert.equal(content.fileName, 'paper.pdf');
    assert.equal(content.sourceFile.rootId, root.id);
    assert.equal(content.sourceFile.relativePath, 'paper.pdf');
    assert.equal(
      fs.readFileSync(content.sourceFile.rootAbsolutePath + '/' + content.sourceFile.relativePath).equals(docBytes),
      true
    );

    // Cross-owner reads must not resolve.
    assert.equal(store.getAttachmentContent(otherUser, attachmentId), null);
    console.log('✅ source_file attachment content abstraction passed');

    // ============================================================
    // 7. Unified file endpoint: managed blob regression + source_file Range
    // ============================================================
    const session = createSession({
      userId: 'm4-user-1', subject: 'm4-user', authMode: 'local',
      username: 'm4tester', role: 'admin', actorKey: actor
    });
    const cookie = `altcanvas_session=${session.id}`;
    const handler = createCanvasHandler(store);

    const rootsRes = await call(handler, '/canvas/native/library-roots', { cookie, headers: { origin: 'http://127.0.0.1:8088' } });
    assert.equal(rootsRes.statusCode, 200);
    assert.equal(rootsRes.payload.data.length, 1, 'config sync must expose the configured root');

    // 200 full content for the source_file attachment.
    const fullRes = await call(handler, `/canvas/native/attachments/${attachmentId}/file`, { cookie });
    assert.equal(fullRes.statusCode, 200);
    assert.equal(fullRes.buffer.equals(docBytes), true, 'full read must return the source file bytes');
    assert.equal(fullRes.getHeader('accept-ranges'), 'bytes');
    assert.match(String(fullRes.getHeader('etag')), new RegExp(docSha.slice(0, 8)));

    // 304 via If-None-Match.
    const notModifiedRes = await call(handler, `/canvas/native/attachments/${attachmentId}/file`, {
      cookie,
      headers: { 'if-none-match': `W/"${docSha}"` }
    });
    assert.equal(notModifiedRes.statusCode, 304);

    // 206 range + 416 out-of-bounds.
    const rangeRes = await call(handler, `/canvas/native/attachments/${attachmentId}/file`, {
      cookie,
      headers: { range: 'bytes=0-8' }
    });
    assert.equal(rangeRes.statusCode, 206);
    assert.equal(rangeRes.buffer.equals(docBytes.subarray(0, 9)), true);
    assert.equal(rangeRes.getHeader('content-range'), `bytes 0-8/${docBytes.length}`);

    const suffixRes = await call(handler, `/canvas/native/attachments/${attachmentId}/file`, {
      cookie,
      headers: { range: 'bytes=-5' }
    });
    assert.equal(suffixRes.statusCode, 206);
    assert.equal(suffixRes.buffer.equals(docBytes.subarray(-5)), true);

    const invalidRangeRes = await call(handler, `/canvas/native/attachments/${attachmentId}/file`, {
      cookie,
      headers: { range: `bytes=${docBytes.length}-` }
    });
    assert.equal(invalidRangeRes.statusCode, 416);

    // HEAD works and leaves no body.
    const headRes = await call(handler, `/canvas/native/attachments/${attachmentId}/file`, { method: 'HEAD', cookie });
    assert.equal(headRes.statusCode, 200);
    assert.equal(headRes.buffer.length, 0);

    // Missing backing file serves a clean 404.
    fs.renameSync(path.join(rootDir, 'paper.pdf'), path.join(rootDir, 'moved-away.pdf'));
    const missingRes = await call(handler, `/canvas/native/attachments/${attachmentId}/file`, { cookie });
    assert.equal(missingRes.statusCode, 404);
    fs.renameSync(path.join(rootDir, 'moved-away.pdf'), path.join(rootDir, 'paper.pdf'));
    console.log('✅ Unified attachment file endpoint (200/206/304/416/HEAD/404) passed');

    // ============================================================
    // 8. File operations log
    // ============================================================
    const op = store.createFileOperation(actor, {
      operationType: 'file.rename',
      sourceFileId: sourceFile.id,
      sourcePath: 'paper.pdf',
      targetPath: 'renamed.pdf',
      payload: { reason: 'test' }
    });
    assert.equal(op.state, 'queued');
    store.startFileOperation(op.id);
    assert.equal(store.getFileOperation(actor, op.id).state, 'running');
    assert.equal(store.listResumableFileOperations().some(o => o.id === op.id), true);
    store.completeFileOperation(op.id);
    assert.equal(store.getFileOperation(actor, op.id).state, 'completed');
    assert.equal(store.listResumableFileOperations().some(o => o.id === op.id), false);

    const failedOp = store.createFileOperation(actor, { operationType: 'file.move', sourcePath: 'a.pdf', targetPath: 'b.pdf' });
    store.failFileOperation(failedOp.id, 'filename_conflict');
    const failedRow = store.getFileOperation(actor, failedOp.id);
    assert.equal(failedRow.state, 'failed');
    assert.equal(failedRow.errorCode, 'filename_conflict');
    console.log('✅ File operation log lifecycle passed');

    // ============================================================
    // 9. Source file listing & sha lookup primitives
    // ============================================================
    assert.deepEqual(store.getSourceFileByPath(actor, root.id, 'paper.pdf').sha256, docSha);
    assert.equal(store.getSourceFileByPath(actor, root.id, 'missing.pdf'), null);
    assert.equal(store.listSourceFilesBySha(actor, docSha).length, 1);
    assert.equal(store.listSourceFilesBySha(actor, null).length, 0);
    const listed = store.listSourceFiles(actor, { rootId: root.id });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].filename, 'paper.pdf');
    const updated = store.updateSourceFile(actor, sourceFile.id, { status: 'missing', missingAt: timestamp });
    assert.equal(updated.status, 'missing');
    assert.equal(updated.version, sourceFile.version + 1);
    const restored = store.updateSourceFile(actor, sourceFile.id, { status: 'active', missingAt: null });
    assert.equal(restored.status, 'active');
    console.log('✅ Source file listing, sha lookup and status transitions passed');

    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
    console.log('🎉 All Native M4 Library Manager Tests Passed!');
  } catch (err) {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

// ============================================================
// 10. Real v12 → v13 migration fixture (attachments rebuild safety)
// ============================================================
async function testV12Migration() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-v12-'));
  const dbPath = path.join(tempDir, 'legacy.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec('PRAGMA foreign_keys = OFF');
  legacy.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'journalArticle',
      title TEXT NOT NULL,
      abstract TEXT NOT NULL DEFAULT '',
      publication_title TEXT NOT NULL DEFAULT '',
      publisher TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '',
      year INTEGER,
      doi TEXT,
      isbn TEXT,
      url TEXT,
      language TEXT NOT NULL DEFAULT '',
      rights TEXT NOT NULL DEFAULT '',
      extra_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    ) STRICT;

    CREATE TABLE blobs (
      sha256 TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reference_count INTEGER NOT NULL DEFAULT 1
    ) STRICT;

    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      blob_hash TEXT NOT NULL REFERENCES blobs(sha256),
      mime_type TEXT NOT NULL DEFAULT 'application/pdf',
      original_filename TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      source_url TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      page_count INTEGER,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    ) STRICT;

    CREATE TABLE annotations (
      id TEXT PRIMARY KEY,
      attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      annotation_type TEXT NOT NULL DEFAULT 'highlight',
      page_label TEXT NOT NULL DEFAULT '',
      position_json TEXT NOT NULL DEFAULT '{}',
      quote TEXT NOT NULL DEFAULT '',
      comment TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#ffd400',
      sort_index INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    ) STRICT;

    INSERT INTO schema_migrations(version, applied_at) VALUES (12, '2026-09-01T00:00:00.000Z');
  `);

  const docId = crypto.randomUUID();
  const blobSha = sha256Of(Buffer.from('legacy blob'));
  const attId = crypto.randomUUID();
  const annId = crypto.randomUUID();
  legacy.prepare(`
    INSERT INTO documents (id, owner_key, title, version, created_at, updated_at)
    VALUES (?, 'legacy-owner', '旧托管文档', 1, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
  `).run(docId);
  legacy.prepare(`
    INSERT INTO blobs (sha256, relative_path, size_bytes, mime_type, created_at, reference_count)
    VALUES (?, 'sha256/ab/cd/ef.pdf', 12, 'application/pdf', '2026-08-01T00:00:00.000Z', 1)
  `).run(blobSha);
  legacy.prepare(`
    INSERT INTO attachments (id, document_id, blob_hash, original_filename, size_bytes, version, created_at, updated_at)
    VALUES (?, ?, ?, 'legacy.pdf', 12, 1, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
  `).run(attId, docId, blobSha);
  legacy.prepare(`
    INSERT INTO annotations (id, attachment_id, quote, version, created_at, updated_at)
    VALUES (?, ?, '重要结论', 1, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
  `).run(annId, attId);
  legacy.close();

  const store = new CanvasStore(dbPath);
  try {
    const version = store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    assert.equal(version, 13, 'v12 database must upgrade to v13');

    // Attachment survived the rebuild with identical fields and mapped kind.
    const att = store.db.prepare('SELECT * FROM attachments WHERE id = ?').get(attId);
    assert.ok(att, 'attachment row must survive the v13 rebuild');
    assert.equal(att.blob_hash, blobSha);
    assert.equal(att.storage_kind, 'managed_blob');
    assert.equal(att.source_file_id, null);
    assert.equal(store.db.prepare('PRAGMA table_info(attachments)').all().find(c => c.name === 'blob_hash').notnull, 0);

    // The annotation referencing the attachment must NOT have been cascaded away.
    const ann = store.db.prepare('SELECT * FROM annotations WHERE id = ?').get(annId);
    assert.ok(ann, 'annotation must survive the attachments rebuild');
    assert.equal(ann.quote, '重要结论');
    assert.equal(store.db.prepare('SELECT * FROM documents WHERE id = ?').get(docId).title, '旧托管文档');
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);

    // Idempotent reopen after rebuild.
    store.close();
    const reopened = new CanvasStore(dbPath);
    assert.equal(reopened.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 13);
    assert.ok(reopened.db.prepare('SELECT * FROM attachments WHERE id = ?').get(attId));
    assert.ok(reopened.db.prepare('SELECT * FROM annotations WHERE id = ?').get(annId));
    reopened.close();
    console.log('✅ Real v12 → v13 migration (attachments rebuild, annotation survival, idempotent reopen) passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  await main();
  await testV12Migration();
  process.exit(0);
} catch (err) {
  console.error('❌ Native M4 test failure:', err);
  process.exit(1);
}
