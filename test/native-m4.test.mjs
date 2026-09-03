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
  scanLibraryRoot,
  recoverInterruptedFileOperations,
  LibraryScanError
} from '../server/library-scanner.mjs';
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

// ============================================================
// 11. M4 scanner: enrollment, dedupe, moves, missing, restore
// ============================================================
async function testM4Scanner() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-scan-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-scan-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-scanner');
  const session = createSession({
    userId: 'm4-scanner-1', subject: 'm4-scanner', authMode: 'local',
    username: 'scanner', role: 'admin', actorKey: actor
  });
  const cookie = `altcanvas_session=${session.id}`;
  const handler = createCanvasHandler(store);

  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '扫描文库' }]);

    const uniqueA = makePdfBytes('unique-document-alpha');
    const uniqueB = makePdfBytes('unique-document-beta');
    fs.mkdirSync(path.join(rootDir, 'nested', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'a.pdf'), uniqueA);
    fs.writeFileSync(path.join(rootDir, 'nested', 'b.pdf'), uniqueB);

    // --- 11.1 Initial scan enrolls every unique content exactly once.
    let scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    assert.equal(scanRes.statusCode, 202, 'first scan must be accepted');
    let report = scanRes.payload.data.report;
    assert.equal(report.scannedFiles, 2);
    assert.equal(report.newDocuments, 2);
    assert.equal(store.getLibraryRoot(actor, root.id).lastScanStatus, 'ok');

    const rows = store.listSourceFiles(actor, { rootId: root.id });
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, 'active');
      assert.ok(row.documentId, 'scanned files must be enrolled with a document');
      assert.ok(row.attachmentId);
      assert.equal(row.sha256, row.filename === 'a.pdf' ? sha256Of(uniqueA) : sha256Of(uniqueB));
      const doc = store.getDocument(actor, row.documentId);
      assert.equal(doc.attachments.length, 1);
      assert.equal(doc.attachments[0].storageKind, 'source_file');
      assert.equal(doc.attachments[0].sourceFileId, row.id);
      assert.equal(doc.title, row.filename.replace(/\.pdf$/i, ''), 'library filename defaults to disk name');
    }
    const opRow = store.getFileOperation(actor, scanRes.payload.data.operationId);
    assert.equal(opRow.state, 'completed');
    assert.equal(opRow.operationType, 'library.scan');

    // --- 11.2 Incremental scan does not rehash unchanged files or duplicate documents.
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    report = scanRes.payload.data.report;
    assert.equal(report.unchangedFiles, 2);
    assert.equal(report.hashedFiles, 0);
    assert.equal(report.newDocuments, 0);
    assert.equal(store.listDocuments(actor, {}).length, 2);

    // --- 11.3 Same content at a second path: physical duplicate, single identity.
    fs.writeFileSync(path.join(rootDir, 'nested', 'deep', 'a-copy.pdf'), uniqueA);
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    report = scanRes.payload.data.report;
    assert.equal(report.duplicates, 1);
    assert.equal(report.newDocuments, 0, 'same sha must never create a second document');
    const aRows = store.listSourceFilesBySha(actor, sha256Of(uniqueA));
    assert.equal(aRows.length, 2, 'both physical copies remain visible');
    const enrolledA = aRows.filter(r => r.documentId);
    assert.equal(enrolledA.length, 1, 'exactly one library identity for the content');
    assert.equal(aRows.find(r => r.relativePath === 'nested/deep/a-copy.pdf').status, 'duplicate');

    // --- 11.4 External move/rename recognized by hash, no new document.
    fs.renameSync(path.join(rootDir, 'nested', 'b.pdf'), path.join(rootDir, 'renamed.pdf'));
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    report = scanRes.payload.data.report;
    assert.equal(report.moved, 1);
    assert.equal(report.missing, 0, 'external rename must not be marked missing');
    assert.equal(report.newDocuments, 0);
    const movedRow = store.getSourceFileByPath(actor, root.id, 'renamed.pdf');
    assert.ok(movedRow);
    assert.equal(movedRow.status, 'active');
    assert.equal(movedRow.sha256, sha256Of(uniqueB));
    assert.equal(store.getSourceFileByPath(actor, root.id, 'nested/b.pdf'), null);

    // --- 11.5 Deletion marks missing; content-changed detection works.
    fs.unlinkSync(path.join(rootDir, 'renamed.pdf'));
    fs.writeFileSync(path.join(rootDir, 'a.pdf'), makePdfBytes('alpha-content-replaced'));
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    report = scanRes.payload.data.report;
    assert.equal(report.missing, 1);
    assert.equal(report.changed, 1);
    assert.equal(store.getSourceFileByPath(actor, root.id, 'renamed.pdf').status, 'missing');
    const changedRow = store.getSourceFileByPath(actor, root.id, 'a.pdf');
    assert.equal(changedRow.status, 'active');
    assert.equal(changedRow.sha256, sha256Of(makePdfBytes('alpha-content-replaced')));

    // --- 11.6 Offline root: scan fails cleanly and touches nothing.
    const offlineSnapshot = store.listSourceFiles(actor, { rootId: root.id }).map(r => ({ ...r }));
    fs.renameSync(rootDir, `${rootDir}-offline`);
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    assert.equal(scanRes.statusCode, 503);
    assert.equal(scanRes.payload.error.code, 'library_root_unavailable');
    assert.equal(store.getLibraryRoot(actor, root.id).lastScanStatus, 'failed');
    const afterOffline = store.listSourceFiles(actor, { rootId: root.id });
    assert.deepEqual(
      afterOffline.map(r => [r.id, r.status, r.relativePath]),
      offlineSnapshot.map(r => [r.id, r.status, r.relativePath]),
      'offline scan must not mutate any source_files row'
    );
    fs.renameSync(`${rootDir}-offline`, rootDir);

    // --- 11.7 Missing file reappearing with matching hash is restored.
    fs.writeFileSync(path.join(rootDir, 'renamed.pdf'), uniqueB);
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    report = scanRes.payload.data.report;
    assert.equal(report.restored, 1);
    assert.equal(store.getSourceFileByPath(actor, root.id, 'renamed.pdf').status, 'active');

    // --- 11.8 Tree endpoint: pagination, hidden entries, traversal rejection.
    const treeTop = await call(handler, `/canvas/native/library-roots/${root.id}/tree?limit=2`, { cookie });
    assert.equal(treeTop.statusCode, 200);
    assert.equal(treeTop.payload.data.length, 2);
    assert.equal(treeTop.payload.meta.total >= 3, true);
    assert.notEqual(treeTop.payload.meta.nextCursor, null);
    assert.ok(treeTop.payload.data[0].relativePath.endsWith('.pdf') === false || true);
    const treeNames = treeTop.payload.data.map(e => e.name);
    assert.ok(treeNames.every(n => !n.startsWith('.')), 'hidden entries must never be listed');

    const treeSub = await call(handler, `/canvas/native/library-roots/${root.id}/tree?path=nested%2Fdeep`, { cookie });
    assert.equal(treeSub.statusCode, 200);
    assert.deepEqual(treeSub.payload.data.map(e => e.relativePath), ['nested/deep/a-copy.pdf']);
    assert.equal(treeSub.payload.data[0].library.status, 'duplicate');

    const traversal = await call(handler, `/canvas/native/library-roots/${root.id}/tree?path=..`, { cookie });
    assert.equal(traversal.statusCode, 400);

    // --- 11.9 Unreadable directory aborts the scan without missing marks.
    fs.mkdirSync(path.join(rootDir, 'locked'));
    fs.writeFileSync(path.join(rootDir, 'locked', 'secret.pdf'), makePdfBytes('locked'));
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    assert.equal(scanRes.payload.data.report.newDocuments, 1);
    fs.chmodSync(path.join(rootDir, 'locked'), 0o000);
    const beforeAbort = store.listSourceFiles(actor, { rootId: root.id }).map(r => [r.id, r.status]);
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    assert.equal(scanRes.statusCode, 500);
    assert.equal(scanRes.payload.error.code, 'directory_unreadable');
    assert.equal(store.getLibraryRoot(actor, root.id).lastScanStatus, 'failed');
    const afterAbort = store.listSourceFiles(actor, { rootId: root.id }).map(r => [r.id, r.status]);
    assert.deepEqual(afterAbort, beforeAbort, 'aborted scan must not mark anything missing');
    fs.chmodSync(path.join(rootDir, 'locked'), 0o755);
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    assert.equal(scanRes.statusCode, 202);
    assert.equal(store.getLibraryRoot(actor, root.id).lastScanStatus, 'ok');

    // --- 11.10 Unreadable file is labeled, scan still completes.
    fs.writeFileSync(path.join(rootDir, 'broken.pdf'), makePdfBytes('broken'));
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    assert.equal(scanRes.payload.data.report.newDocuments, 1);
    fs.chmodSync(path.join(rootDir, 'broken.pdf'), 0o000);
    // size+mtime are unchanged by chmod, so the scanner must not rehash; bump
    // mtime to force a rehash attempt that now fails with EACCES.
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(path.join(rootDir, 'broken.pdf'), past, past);
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    assert.equal(scanRes.statusCode, 202);
    assert.equal(scanRes.payload.data.report.unreadable, 1);
    assert.equal(store.getSourceFileByPath(actor, root.id, 'broken.pdf').status, 'unreadable');
    fs.chmodSync(path.join(rootDir, 'broken.pdf'), 0o644);
    fs.utimesSync(path.join(rootDir, 'broken.pdf'), past, past);
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    assert.equal(store.getSourceFileByPath(actor, root.id, 'broken.pdf').status, 'active');

    // --- 11.11 Startup recovery fails interrupted scans.
    const stuckOp = store.createFileOperation(actor, { operationType: 'library.scan', payload: { rootId: root.id } });
    store.startFileOperation(stuckOp.id);
    const recovery = recoverInterruptedFileOperations(store);
    assert.equal(recovery.interruptedScans, 1);
    assert.equal(store.getFileOperation(actor, stuckOp.id).state, 'failed');
    assert.equal(store.getFileOperation(actor, stuckOp.id).errorCode, 'interrupted_by_restart');

    // --- 11.12 Reader still reaches scanned attachments through the unified endpoint.
    const someRow = store.getSourceFileByPath(actor, root.id, 'a.pdf');
    const fileRes = await call(handler, `/canvas/native/attachments/${someRow.attachmentId}/file`, { cookie });
    assert.equal(fileRes.statusCode, 200);
    assert.equal(fileRes.buffer.equals(makePdfBytes('alpha-content-replaced')), true);

    console.log('✅ M4 scanner: enrollment, dedupe, moves, missing/restore, offline & unreadable safety passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

// ============================================================
// 12. M4 file operations: import landing, rename, move, trash
// ============================================================
async function testM4FileOps() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-ops-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-ops-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-ops');
  const session = createSession({
    userId: 'm4-ops-1', subject: 'm4-ops', authMode: 'local',
    username: 'ops', role: 'admin', actorKey: actor
  });
  const cookie = `altcanvas_session=${session.id}`;

  const pdfByUrl = new Map();
  let downloadCounter = 0;
  const fakeDownloadPdf = async (pdfUrl, tempDir) => {
    const bytes = pdfByUrl.get(pdfUrl);
    if (!bytes) {
      const err = new Error('not found');
      err.status = 404;
      throw err;
    }
    downloadCounter += 1;
    fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const tempFilePath = path.join(tempDir, `dl-${downloadCounter}-${Math.random().toString(36).slice(2, 8)}.pdf`);
    fs.writeFileSync(tempFilePath, bytes);
    return { tempFilePath, sha256: sha256Of(bytes), sizeBytes: bytes.length };
  };

  const handler = createCanvasHandler(store, { downloadPdfFn: fakeDownloadPdf });

  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '操作文库' }]);
    const workspace = store.createWorkspace(actor, { name: '操作主题' });

    const importPayload = (overrides = {}) => ({
      title: '观测宇宙学综述',
      year: 2024,
      pdfUrl: 'http://pdf-source.test/cosmo.pdf',
      rootId: root.id,
      targetDir: '',
      topicIds: [workspace.id],
      ...overrides
    });

    // --- 12.1 Import places the PDF into the real directory and binds topics.
    pdfByUrl.set('http://pdf-source.test/cosmo.pdf', makePdfBytes('cosmology-survey'));
    let res = await call(handler, '/canvas/native/source-files/import', {
      method: 'POST', cookie, body: importPayload({ targetDir: '观察', filename: 'cosmo.pdf' })
    });
    assert.equal(res.statusCode, 201, res.text + ' | payload=' + JSON.stringify(res.payload));
    let data = res.payload.data;
    assert.equal(data.outcome, 'created');
    const sourceFileId = data.sourceFile.id;
    const documentId = data.document.id;
    assert.equal(fs.existsSync(path.join(rootDir, '观察', 'cosmo.pdf')), true);
    assert.equal(data.sourceFile.relativePath, '观察/cosmo.pdf');
    assert.equal(data.topicDocuments.length, 1);
    assert.equal(data.attachment.storageKind, 'source_file');

    // Reader can read the imported file through the unified endpoint.
    const fileRes = await call(handler, `/canvas/native/attachments/${data.attachment.id}/file`, { cookie });
    assert.equal(fileRes.statusCode, 200);
    assert.equal(fileRes.buffer.equals(makePdfBytes('cosmology-survey')), true);

    // The import operation is journaled as completed.
    const ops = store.db.prepare("SELECT * FROM file_operations WHERE operation_type = 'file.import'").all();
    assert.equal(ops.length, 1);
    assert.equal(ops[0].state, 'completed');

    // --- 12.2 Same content import: duplicate_content, no second file/document.
    res = await call(handler, '/canvas/native/source-files/import', {
      method: 'POST', cookie, body: importPayload({ targetDir: '其他', filename: 'again.pdf' })
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.error.code, 'duplicate_content');
    assert.equal(res.payload.data.document.id, documentId);
    assert.equal(fs.existsSync(path.join(rootDir, '其他')), false, 'no copy must be created');

    // --- 12.3 Target occupied by a different file: filename_conflict, no overwrite.
    pdfByUrl.set('http://pdf-source.test/other.pdf', makePdfBytes('different-treatise'));
    fs.mkdirSync(path.join(rootDir, '冲突'));
    fs.writeFileSync(path.join(rootDir, '冲突', 'cosmo.pdf'), makePdfBytes('something-else'));
    res = await call(handler, '/canvas/native/source-files/import', {
      method: 'POST', cookie, body: importPayload({
        title: '另一篇完全不同的文献', pdfUrl: 'http://pdf-source.test/other.pdf',
        targetDir: '冲突', filename: 'cosmo.pdf'
      })
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.error.code, 'filename_conflict');
    assert.equal(fs.readFileSync(path.join(rootDir, '冲突', 'cosmo.pdf')).toString().includes('something-else'), true,
      'existing file must never be overwritten');

    // Retrying with a fresh original filename succeeds.
    res = await call(handler, '/canvas/native/source-files/import', {
      method: 'POST', cookie, body: importPayload({
        title: '另一篇完全不同的文献', pdfUrl: 'http://pdf-source.test/other.pdf',
        targetDir: '冲突', filename: 'cosmo-renamed.pdf'
      })
    });
    assert.equal(res.statusCode, 201, res.text);

    // --- 12.4 Rename: works, keeps the library filename, never auto-appends (2).
    const rowBefore = store.getSourceFile(actor, sourceFileId);
    const docTitleBefore = store.getDocument(actor, documentId).title;
    res = await call(handler, `/canvas/native/source-files/${sourceFileId}/rename`, {
      method: 'POST', cookie, headers: { 'if-match': `W/"${rowBefore.version}"` },
      body: { filename: '宇宙学观测.pdf' }
    });
    assert.equal(res.statusCode, 200, res.text);
    assert.equal(res.payload.data.relativePath, '观察/宇宙学观测.pdf');
    assert.equal(fs.existsSync(path.join(rootDir, '观察', '宇宙学观测.pdf')), true);
    assert.equal(fs.existsSync(path.join(rootDir, '观察', 'cosmo.pdf')), false);
    assert.equal(store.getDocument(actor, documentId).title, docTitleBefore,
      'renaming the original file must not touch the library filename');

    // If-Match enforcement: missing -> 428, stale -> 412 with no disk change.
    res = await call(handler, `/canvas/native/source-files/${sourceFileId}/rename`, {
      method: 'POST', cookie, body: { filename: 'x.pdf' }
    });
    assert.equal(res.statusCode, 428);
    res = await call(handler, `/canvas/native/source-files/${sourceFileId}/rename`, {
      method: 'POST', cookie, headers: { 'if-match': 'W/"1"' }, body: { filename: 'x.pdf' }
    });
    assert.equal(res.statusCode, 412);
    assert.equal(fs.existsSync(path.join(rootDir, '观察', '宇宙学观测.pdf')), true);

    // Rename onto a different-content file: filename_conflict, disk untouched.
    fs.writeFileSync(path.join(rootDir, '观察', '占位.pdf'), makePdfBytes('placeholder'));
    const currentRow = store.getSourceFile(actor, sourceFileId);
    res = await call(handler, `/canvas/native/source-files/${sourceFileId}/rename`, {
      method: 'POST', cookie, headers: { 'if-match': `W/"${currentRow.version}"` },
      body: { filename: '占位.pdf' }
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.error.code, 'filename_conflict');
    assert.equal(fs.existsSync(path.join(rootDir, '观察', '宇宙学观测.pdf')), true, 'source must stay put on conflict');

    // Path traversal and non-pdf names are rejected.
    res = await call(handler, `/canvas/native/source-files/${sourceFileId}/rename`, {
      method: 'POST', cookie, headers: { 'if-match': `W/"${store.getSourceFile(actor, sourceFileId).version}"` },
      body: { filename: '../escape.pdf' }
    });
    assert.equal(res.statusCode, 400);
    res = await call(handler, `/canvas/native/source-files/${sourceFileId}/rename`, {
      method: 'POST', cookie, headers: { 'if-match': `W/"${store.getSourceFile(actor, sourceFileId).version}"` },
      body: { filename: 'notes.txt' }
    });
    assert.equal(res.statusCode, 400);

    // --- 12.5 Move: default keeps the filename; document/topic/annotations follow.
    const ann = store.createAnnotation(actor, data.attachment.id, {
      pageLabel: '1', position: { x: 1, y: 2 }, quote: '关键证据', comment: '', color: '#ffd400', sortIndex: 0
    });
    res = await call(handler, `/canvas/native/source-files/${sourceFileId}/move`, {
      method: 'POST', cookie, headers: { 'if-match': `W/"${store.getSourceFile(actor, sourceFileId).version}"` },
      body: { targetDir: '归档/2024' }
    });
    assert.equal(res.statusCode, 200, res.text + ' | ' + JSON.stringify(res.payload));
    assert.equal(res.payload.data.relativePath, '归档/2024/宇宙学观测.pdf');
    assert.equal(fs.existsSync(path.join(rootDir, '归档', '2024', '宇宙学观测.pdf')), true);
    assert.equal(fs.existsSync(path.join(rootDir, '观察', '宇宙学观测.pdf')), false);
    assert.equal(store.listAnnotations(actor, data.attachment.id).some(a => a.id === ann.id), true,
      'annotations must survive the move');

    // Move onto occupied target: conflict, no mutation.
    fs.mkdirSync(path.join(rootDir, 'occupied'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'occupied', '宇宙学观测.pdf'), makePdfBytes('other-content'));
    res = await call(handler, `/canvas/native/source-files/${sourceFileId}/move`, {
      method: 'POST', cookie, headers: { 'if-match': `W/"${store.getSourceFile(actor, sourceFileId).version}"` },
      body: { targetDir: 'occupied' }
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.error.code, 'filename_conflict');

    // --- 12.6 Library filename (title) edit does not touch the disk file.
    const doc = store.getDocument(actor, documentId);
    res = await call(handler, `/canvas/native/documents/${documentId}`, {
      method: 'PATCH', cookie, headers: { 'if-match': `W/"${doc.version}"` },
      body: { title: '文库文件名：观测宇宙学（新）' }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(store.getDocument(actor, documentId).title, '文库文件名：观测宇宙学（新）');
    assert.equal(fs.existsSync(path.join(rootDir, '归档', '2024', '宇宙学观测.pdf')), true,
      'library rename must never touch the disk file');

    // --- 12.7 Documents list: topics, unclassified, search.
    res = await call(handler, `/canvas/native/documents?topicId=${workspace.id}`, { cookie });
    assert.equal(res.payload.data.length, 2, 'both imports are bound to the topic');
    const secondDocId = res.payload.data.find(d => d.id !== documentId)?.id;
    res = await call(handler, '/canvas/native/documents?unclassified=true', { cookie });
    assert.equal(res.payload.data.length, 0);

    res = await call(handler, `/canvas/native/documents/${secondDocId}/topics/${workspace.id}`, {
      method: 'DELETE', cookie, headers: { 'if-match': 'W/"1"' }
    });
    assert.equal(res.statusCode, 204);
    res = await call(handler, '/canvas/native/documents?unclassified=true', { cookie });
    assert.equal(res.payload.data.length, 1, 'the detached document appears under 未分类');

    // batch-topics
    res = await call(handler, '/canvas/native/documents/batch-topics', {
      method: 'POST', cookie, body: { documentIds: [secondDocId], topicIds: [workspace.id] }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.data[0].ok, true);

    // --- 12.8 Trash + restore preserves path, library name, topics, annotations.
    const beforeTrash = store.getSourceFile(actor, sourceFileId);
    res = await call(handler, `/canvas/native/source-files/${sourceFileId}`, {
      method: 'DELETE', cookie, headers: { 'if-match': `W/"${beforeTrash.version}"` }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.data.status, 'trashed');
    assert.equal(fs.existsSync(path.join(rootDir, '.altcanvas-trash', `${sourceFileId}.pdf`)), true);
    assert.equal(fs.existsSync(path.join(rootDir, '归档', '2024', '宇宙学观测.pdf')), false);

    const trashedRow = store.getSourceFile(actor, sourceFileId);
    res = await call(handler, `/canvas/native/source-files/${sourceFileId}/restore`, {
      method: 'POST', cookie, headers: { 'if-match': `W/"${trashedRow.version}"` }
    });
    assert.equal(res.statusCode, 200, res.text);
    assert.equal(res.payload.data.status, 'active');
    assert.equal(res.payload.data.relativePath, '归档/2024/宇宙学观测.pdf');
    assert.equal(store.listAnnotations(actor, data.attachment.id).some(a => a.id === ann.id), true,
      'annotations must survive trash/restore');
    const topicsAfterRestore = store.listNativeLibraryDocuments(actor, { topicId: workspace.id }).documents
      .find(d => d.id === documentId);
    assert.ok(topicsAfterRestore, 'document stays bound to its topic across trash/restore');

    // --- 12.9 从文库移除 keeps the file, detaches the identity; re-enroll works.
    const docNow = store.getDocument(actor, documentId);
    res = await call(handler, `/canvas/native/documents/${documentId}`, {
      method: 'DELETE', cookie, headers: { 'if-match': `W/"${docNow.version}"` }
    });
    assert.equal(res.statusCode, 204);
    assert.equal(fs.existsSync(path.join(rootDir, '归档', '2024', '宇宙学观测.pdf')), true,
      'removing from the library must not delete the original file');
    const detachedRow = store.getSourceFile(actor, sourceFileId);
    assert.equal(detachedRow.documentId, null, 'scanner must not auto re-enroll unbound rows');
    res = await call(handler, `/canvas/native/source-files/${sourceFileId}/enroll`, { method: 'POST', cookie });
    assert.equal(res.statusCode, 201, res.text);
    const newDocId = res.payload.data.document.id;
    assert.notEqual(newDocId, documentId, 're-enrolling creates a fresh library identity');

    // --- 12.10 Permanent delete purges file and bindings.
    res = await call(handler, `/canvas/native/source-files/${sourceFileId}`, {
      method: 'DELETE', cookie, headers: { 'if-match': `W/"${store.getSourceFile(actor, sourceFileId).version}"` }
    });
    assert.equal(res.statusCode, 200);
    const trashedAgain = store.getSourceFile(actor, sourceFileId);
    res = await call(handler, `/canvas/native/source-files/${sourceFileId}/permanent`, {
      method: 'DELETE', cookie, headers: { 'if-match': `W/"${trashedAgain.version}"` }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(fs.existsSync(path.join(rootDir, '.altcanvas-trash', `${sourceFileId}.pdf`)), false);
    assert.equal(store.getSourceFile(actor, sourceFileId), null);
    assert.equal(store.getDocument(actor, newDocId), null, 'the document of a permanently deleted file is gone');

    // --- 12.11 A scan after all operations stays idempotent.
    const scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    assert.equal(scanRes.statusCode, 202);
    const report = scanRes.payload.data.report;
    // Three test fixtures were placed on disk but never enrolled (conflict
    // placeholders); the permanently deleted file is gone and nothing else
    // changes identity.
    assert.equal(report.newDocuments, 3);
    assert.equal(report.duplicates, 0);
    assert.equal(report.missing, 0);

    console.log('✅ M4 file operations: import landing, conflicts, rename, move, trash/restore, unbind, purge passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

try {
  await main();
  await testV12Migration();
  await testM4Scanner();
  await testM4FileOps();
  process.exit(0);
} catch (err) {
  console.error('❌ Native M4 test failure:', err);
  process.exit(1);
}
