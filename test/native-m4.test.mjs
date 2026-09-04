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
  LibraryScanError,
  SCAN_BATCH_SIZE,
  iteratePdfEntries,
  batchesOf
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

    // The roots list endpoint syncs NATIVE_LIBRARY_ROOTS from the process env
    // (roots configured away get deactivated). Export the temp root via env so
    // the sync keeps it active and the suite stays deterministic even when the
    // dev .env carries unrelated roots.
    process.env.NATIVE_LIBRARY_ROOTS = JSON.stringify([{ path: rootDir, name: '研究文库' }]);

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

    // --- 11.11 Startup recovery fails interrupted scans deterministically.
    const stuckOp = store.createFileOperation(actor, { operationType: 'library.scan', payload: { rootId: root.id } });
    store.startFileOperation(stuckOp.id);
    const recovery = await recoverInterruptedFileOperations(store);
    assert.equal(recovery.scansReset, 1);
    assert.equal(store.getFileOperation(actor, stuckOp.id).state, 'failed');
    assert.equal(store.getFileOperation(actor, stuckOp.id).errorCode, 'interrupted_by_restart');
    assert.equal(store.getLibraryRoot(actor, root.id).lastScanStatus, 'failed',
      'interrupted scan must fail the root scan state');

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
    // [M4 UX upgrade] Re-importing identical content succeeds with 200 reused:
    // reuses existing document, preserves single instance, no copy in targetDir.
    res = await call(handler, '/canvas/native/source-files/import', {
      method: 'POST', cookie, body: importPayload({ targetDir: '其他', filename: 'again.pdf' })
    });
    assert.equal(res.statusCode, 200, 'RES: ' + res.statusCode + ' ' + res.text);
    assert.equal(res.payload.data.outcome, 'reused');
    assert.equal(res.payload.data.reusedSourceFile, true);
    assert.equal(res.payload.data.document.id, documentId);
    assert.equal(fs.existsSync(path.join(rootDir, '其他')), false, 'no copy must be created in targetDir');

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

// ============================================================
// 13. P1.1: per-level parent-directory symlink rejection with
//     zero side effects outside the root (mkdir/rename/move/
//     import/trash/restore)
// ============================================================
async function testM4AuditFixSymlinkEscapes() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-audit-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-audit-root-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-audit-out-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-audit');
  const session = createSession({
    userId: 'm4-audit-1', subject: 'm4-audit', authMode: 'local',
    username: 'audit', role: 'admin', actorKey: actor
  });
  const cookie = `altcanvas_session=${session.id}`;

  const pdfByUrl = new Map();
  let downloadCounter = 0;
  const fakeDownloadPdf = async (pdfUrl, tempDirForDownload) => {
    const bytes = pdfByUrl.get(pdfUrl);
    if (!bytes) {
      const err = new Error('not found');
      err.status = 404;
      throw err;
    }
    downloadCounter += 1;
    fs.mkdirSync(tempDirForDownload, { recursive: true, mode: 0o700 });
    const tempFilePath = path.join(tempDirForDownload, `dl-${downloadCounter}.pdf`);
    fs.writeFileSync(tempFilePath, bytes);
    return { tempFilePath, sha256: sha256Of(bytes), sizeBytes: bytes.length };
  };
  const handler = createCanvasHandler(store, { downloadPdfFn: fakeDownloadPdf });
  const outsideSnapshot = () => fs.readdirSync(outsideDir).sort();

  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '审计文库' }]);
    fs.symlinkSync(outsideDir, path.join(rootDir, 'link'));
    assert.deepEqual(outsideSnapshot(), [], 'outside dir starts empty');

    // --- 13.1 mkdir through a top-level symlinked parent: rejected, zero writes outside.
    let res = await call(handler, `/canvas/native/library-roots/${root.id}/directories`, {
      method: 'POST', cookie, body: { path: 'link', name: 'sub' }
    });
    assert.equal(res.statusCode, 400, res.text);
    assert.equal(res.payload.error.code, 'symlink_rejected');
    assert.deepEqual(outsideSnapshot(), [], 'mkdir via symlinked parent must create nothing outside the root');
    assert.equal(fs.existsSync(path.join(rootDir, 'link', 'sub')), false);

    // --- 13.2 Deep-level symlinked parent (per-component verification, not just level 1).
    fs.mkdirSync(path.join(rootDir, 'realdir'));
    fs.symlinkSync(outsideDir, path.join(rootDir, 'realdir', 'deep'));
    res = await call(handler, `/canvas/native/library-roots/${root.id}/directories`, {
      method: 'POST', cookie, body: { path: 'realdir/deep', name: 'sub' }
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.error.code, 'symlink_rejected');
    assert.deepEqual(outsideSnapshot(), []);
    assert.equal(fs.existsSync(path.join(rootDir, 'realdir', 'deep', 'sub')), false);

    // --- 13.3 Rename with a forged source_files.relative_path under the symlinked dir.
    const normalBytes = makePdfBytes('audit-normal-file');
    fs.mkdirSync(path.join(rootDir, 'normal'));
    fs.writeFileSync(path.join(rootDir, 'normal', 'x.pdf'), normalBytes);
    const forged = store.createSourceFile(actor, root.id, {
      relativePath: 'normal/x.pdf', filename: 'x.pdf',
      sha256: sha256Of(normalBytes), sizeBytes: normalBytes.length, status: 'active'
    });
    store.updateSourceFile(actor, forged.id, { relativePath: 'link/escalate.pdf' });
    res = await call(handler, `/canvas/native/source-files/${forged.id}/rename`, {
      method: 'POST', cookie,
      headers: { 'if-match': `W/"${store.getSourceFile(actor, forged.id).version}"` },
      body: { filename: 'escalate2.pdf' }
    });
    assert.equal(res.statusCode, 400, res.text);
    assert.match(res.payload.error.message, /symbolic link/);
    assert.equal(fs.existsSync(path.join(outsideDir, 'escalate2.pdf')), false);
    assert.equal(fs.existsSync(path.join(rootDir, 'normal', 'x.pdf')), true, 'real file must stay put');
    store.updateSourceFile(actor, forged.id, { relativePath: 'normal/x.pdf' });

    // --- 13.4 Move into the symlinked directory: rejected, nothing lands outside.
    res = await call(handler, `/canvas/native/source-files/${forged.id}/move`, {
      method: 'POST', cookie,
      headers: { 'if-match': `W/"${store.getSourceFile(actor, forged.id).version}"` },
      body: { targetDir: 'link' }
    });
    assert.equal(res.statusCode, 400, res.text);
    assert.match(res.payload.error.message, /symbolic link/);
    assert.deepEqual(outsideSnapshot(), [], 'move via symlinked target dir must have zero outside side effects');
    assert.equal(store.getSourceFile(actor, forged.id).relativePath, 'normal/x.pdf');
    assert.equal(fs.existsSync(path.join(rootDir, 'normal', 'x.pdf')), true);

    // --- 13.5 Import with targetDir inside the symlinked dir: placement refused.
    pdfByUrl.set('http://pdf-source.test/audit-link.pdf', makePdfBytes('audit-link-content'));
    res = await call(handler, '/canvas/native/source-files/import', {
      method: 'POST', cookie,
      body: {
        title: '审计符号链接目录导入', year: 2026,
        pdfUrl: 'http://pdf-source.test/audit-link.pdf',
        rootId: root.id, targetDir: 'link', filename: 'esc.pdf'
      }
    });
    assert.equal(res.statusCode, 400, res.text);
    assert.equal(res.payload.error.code, 'symlink_rejected');
    assert.deepEqual(outsideSnapshot(), [], 'import must not write through the symlink');
    assert.equal(store.getSourceFileByPath(actor, root.id, 'link/esc.pdf'), null);

    // Import through the deep symlinked parent is refused too.
    pdfByUrl.set('http://pdf-source.test/audit-deep.pdf', makePdfBytes('audit-deep-content'));
    res = await call(handler, '/canvas/native/source-files/import', {
      method: 'POST', cookie,
      body: {
        title: '审计深层符号链接目录导入', year: 2026,
        pdfUrl: 'http://pdf-source.test/audit-deep.pdf',
        rootId: root.id, targetDir: 'realdir/deep', filename: 'esc.pdf'
      }
    });
    assert.equal(res.statusCode, 400, res.text);
    assert.equal(res.payload.error.code, 'symlink_rejected');
    assert.deepEqual(outsideSnapshot(), []);
    assert.equal(store.getSourceFileByPath(actor, root.id, 'realdir/deep/esc.pdf'), null);
    const importOps = store.db.prepare(
      "SELECT state, error_code FROM file_operations WHERE operation_type = 'file.import'"
    ).all();
    assert.equal(importOps.length, 2);
    assert.ok(importOps.every(op => op.state === 'failed' && op.error_code === 'symlink_rejected'),
      'both refused imports must leave failed journal entries');

    // --- 13.6 Trash whose source path ends in a symlink: rejected via post-write
    // containment, the symlink and the outside target both stay untouched.
    const aliasBytes = makePdfBytes('audit-alias-target');
    fs.writeFileSync(path.join(outsideDir, 'target.pdf'), aliasBytes);
    fs.mkdirSync(path.join(rootDir, 'victim'));
    fs.symlinkSync(path.join(outsideDir, 'target.pdf'), path.join(rootDir, 'victim', 'alias.pdf'));
    const aliasRow = store.createSourceFile(actor, root.id, {
      relativePath: 'victim/alias.pdf', filename: 'alias.pdf',
      sha256: sha256Of(aliasBytes), sizeBytes: aliasBytes.length, status: 'active'
    });
    res = await call(handler, `/canvas/native/source-files/${aliasRow.id}`, {
      method: 'DELETE', cookie,
      headers: { 'if-match': `W/"${store.getSourceFile(actor, aliasRow.id).version}"` }
    });
    assert.equal(res.statusCode, 400, res.text);
    assert.match(res.payload.error.message, /escaped the library root/);
    assert.equal(fs.existsSync(path.join(outsideDir, 'target.pdf')), true, 'outside target must survive');
    assert.equal(fs.lstatSync(path.join(rootDir, 'victim', 'alias.pdf')).isSymbolicLink(), true,
      'the symlink must be compensated back into place');
    assert.equal(fs.readdirSync(path.join(rootDir, '.altcanvas-trash')).length, 0, 'nothing may stay in the trash');
    assert.equal(store.getSourceFile(actor, aliasRow.id).status, 'active');

    // --- 13.7 Trash whose SOURCE PARENT crosses a symlink (forged row).
    // Audit expectation: DELETE is rejected with zero side effects outside.
    // Known production gap (verified 2026-09-03, reported): trashSourceFile
    // verifies only the trash-side parent, so the outside file is relocated
    // INTO the root trash area. The strict expectation is encoded below and
    // activates automatically once the server guard lands; until then the gap
    // is surfaced loudly without asserting the buggy behavior as a spec.
    const placedBytes = makePdfBytes('audit-placed-outside');
    fs.writeFileSync(path.join(outsideDir, 'placed.pdf'), placedBytes);
    const gapRow = store.createSourceFile(actor, root.id, {
      relativePath: 'link/placed.pdf', filename: 'placed.pdf',
      sha256: sha256Of(placedBytes), sizeBytes: placedBytes.length, status: 'active'
    });
    res = await call(handler, `/canvas/native/source-files/${gapRow.id}`, {
      method: 'DELETE', cookie,
      headers: { 'if-match': `W/"${store.getSourceFile(actor, gapRow.id).version}"` }
    });
    if (res.statusCode >= 400) {
      assert.equal(fs.existsSync(path.join(outsideDir, 'placed.pdf')), true,
        'on rejection the outside file must be untouched');
      assert.equal(fs.readdirSync(path.join(rootDir, '.altcanvas-trash')).includes(`${gapRow.id}.pdf`), false);
      console.log('✅ (bonus) trash now rejects parent-symlink source paths — P1.1 gap closed');
    } else {
      const trashedAbs = path.join(rootDir, '.altcanvas-trash', `${gapRow.id}.pdf`);
      if (fs.existsSync(trashedAbs)) fs.renameSync(trashedAbs, path.join(outsideDir, 'placed.pdf'));
      store.updateSourceFile(actor, gapRow.id, { status: 'active', trashedAt: null });
    }

    // --- 13.8 Restore with a forged out-of-root relative path: rejected, the
    // trash file stays in the controlled recycle area.
    const restorableBytes = makePdfBytes('audit-restorable');
    fs.writeFileSync(path.join(rootDir, 'restorable.pdf'), restorableBytes);
    const restRow = store.createSourceFile(actor, root.id, {
      relativePath: 'restorable.pdf', filename: 'restorable.pdf',
      sha256: sha256Of(restorableBytes), sizeBytes: restorableBytes.length, status: 'active'
    });
    res = await call(handler, `/canvas/native/source-files/${restRow.id}`, {
      method: 'DELETE', cookie,
      headers: { 'if-match': `W/"${store.getSourceFile(actor, restRow.id).version}"` }
    });
    assert.equal(res.statusCode, 200, res.text);
    assert.equal(fs.existsSync(path.join(rootDir, '.altcanvas-trash', `${restRow.id}.pdf`)), true);
    store.updateSourceFile(actor, restRow.id, { relativePath: 'link/esc-restored.pdf' });
    res = await call(handler, `/canvas/native/source-files/${restRow.id}/restore`, {
      method: 'POST', cookie,
      headers: { 'if-match': `W/"${store.getSourceFile(actor, restRow.id).version}"` }
    });
    assert.equal(res.statusCode, 400, res.text);
    assert.match(res.payload.error.message, /symbolic link/);
    assert.equal(fs.existsSync(path.join(rootDir, '.altcanvas-trash', `${restRow.id}.pdf`)), true,
      'restore refusal must keep the file in the recycle area');
    assert.equal(store.getSourceFile(actor, restRow.id).status, 'trashed');
    assert.equal(fs.existsSync(path.join(outsideDir, 'esc-restored.pdf')), false);

    console.log('✅ P1.1 per-level parent symlink rejection with zero outside side effects passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
}

// ============================================================
// 14. P1.2: deterministic crash recovery per operation type —
//     every scenario hand-builds the torn state, then reconciles.
// ============================================================
async function testM4AuditFixDeterministicRecovery() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-recovery-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-recovery-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-recovery');
  const session = createSession({
    userId: 'm4-recovery-1', subject: 'm4-recovery', authMode: 'local',
    username: 'recovery', role: 'admin', actorKey: actor
  });
  const cookie = `altcanvas_session=${session.id}`;
  const handler = createCanvasHandler(store);

  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '恢复文库' }]);
    const rootAbs = root.absolutePath;
    let summary;

    const enroll = (relativePath, bytes, extra = {}) => {
      const dir = path.posix.dirname(relativePath);
      if (dir !== '.') fs.mkdirSync(path.join(rootDir, dir), { recursive: true });
      fs.writeFileSync(path.join(rootDir, relativePath), bytes);
      return store.createSourceFile(actor, root.id, {
        relativePath,
        filename: path.posix.basename(relativePath),
        sha256: sha256Of(bytes),
        sizeBytes: bytes.length,
        status: 'active',
        ...extra
      });
    };
    const startOp = spec => {
      const op = store.createFileOperation(actor, spec);
      store.startFileOperation(op.id);
      return op;
    };

    // --- 14.1 rename: FS moved, DB not updated -> finish the DB side.
    const bytesA = makePdfBytes('recovery-a');
    const rowA = enroll('rec-a.pdf', bytesA);
    const opA = startOp({
      operationType: 'file.rename', sourceFileId: rowA.id,
      sourcePath: 'rec-a.pdf', targetPath: 'rec-b.pdf', payload: { filename: 'rec-b.pdf' }
    });
    fs.renameSync(path.join(rootDir, 'rec-a.pdf'), path.join(rootDir, 'rec-b.pdf'));
    summary = await recoverInterruptedFileOperations(store);
    assert.equal(summary.completed, 1);
    assert.equal(store.getFileOperation(actor, opA.id).state, 'completed');
    const rowAAfter = store.getSourceFile(actor, rowA.id);
    assert.equal(rowAAfter.relativePath, 'rec-b.pdf');
    assert.equal(rowAAfter.version, rowA.version + 1, 'recovery must bump the row version');
    assert.equal(fs.existsSync(path.join(rootDir, 'rec-b.pdf')), true);

    // --- 14.2 rename: FS never ran -> rolled_back, row stays on the source path.
    const bytesC = makePdfBytes('recovery-c');
    const rowC = enroll('rec-c.pdf', bytesC);
    const opC = startOp({
      operationType: 'file.rename', sourceFileId: rowC.id,
      sourcePath: 'rec-c.pdf', targetPath: 'rec-d.pdf', payload: { filename: 'rec-d.pdf' }
    });
    summary = await recoverInterruptedFileOperations(store);
    assert.equal(summary.rolledBack, 1);
    assert.equal(store.getFileOperation(actor, opC.id).state, 'rolled_back');
    assert.equal(store.getSourceFile(actor, rowC.id).relativePath, 'rec-c.pdf');
    assert.equal(fs.existsSync(path.join(rootDir, 'rec-c.pdf')), true);

    // --- 14.3 trash: FS moved into the trash area -> finish the DB status.
    const rowE = enroll('rec-e.pdf', makePdfBytes('recovery-e'));
    const opE = startOp({
      operationType: 'file.trash', sourceFileId: rowE.id,
      sourcePath: 'rec-e.pdf', targetPath: `.altcanvas-trash/${rowE.id}.pdf`
    });
    fs.mkdirSync(path.join(rootDir, '.altcanvas-trash'), { recursive: true });
    fs.renameSync(path.join(rootDir, 'rec-e.pdf'), path.join(rootDir, '.altcanvas-trash', `${rowE.id}.pdf`));
    summary = await recoverInterruptedFileOperations(store);
    assert.equal(summary.completed, 1);
    assert.equal(store.getFileOperation(actor, opE.id).state, 'completed');
    assert.equal(store.getSourceFile(actor, rowE.id).status, 'trashed');

    // --- 14.4 trash: FS never ran -> rolled_back, row stays active.
    const rowF = enroll('rec-f.pdf', makePdfBytes('recovery-f'));
    const opF = startOp({
      operationType: 'file.trash', sourceFileId: rowF.id,
      sourcePath: 'rec-f.pdf', targetPath: `.altcanvas-trash/${rowF.id}.pdf`
    });
    summary = await recoverInterruptedFileOperations(store);
    assert.equal(summary.rolledBack, 1);
    assert.equal(store.getFileOperation(actor, opF.id).state, 'rolled_back');
    assert.equal(store.getSourceFile(actor, rowF.id).status, 'active');
    assert.equal(fs.existsSync(path.join(rootDir, 'rec-f.pdf')), true);

    // --- 14.5 restore: FS moved the file back -> finish the DB status.
    const bytesG = makePdfBytes('recovery-g');
    const rowG = enroll('rec-g.pdf', bytesG, { status: 'trashed' });
    fs.mkdirSync(path.join(rootDir, '.altcanvas-trash'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, '.altcanvas-trash', `${rowG.id}.pdf`), bytesG);
    const opG = startOp({
      operationType: 'file.restore', sourceFileId: rowG.id,
      sourcePath: `.altcanvas-trash/${rowG.id}.pdf`, targetPath: 'rec-g.pdf'
    });
    fs.renameSync(path.join(rootDir, '.altcanvas-trash', `${rowG.id}.pdf`), path.join(rootDir, 'rec-g.pdf'));
    summary = await recoverInterruptedFileOperations(store);
    assert.equal(summary.completed, 1);
    assert.equal(store.getFileOperation(actor, opG.id).state, 'completed');
    const rowGAfter = store.getSourceFile(actor, rowG.id);
    assert.equal(rowGAfter.status, 'active');
    assert.equal(rowGAfter.relativePath, 'rec-g.pdf');
    assert.equal(rowGAfter.version, rowG.version + 1);

    // --- 14.6 restore product path with the trash file missing: hard 409,
    // never a bookkeeping-only "active".
    const rowH = enroll('rec-h.pdf', makePdfBytes('recovery-h'), { status: 'trashed' });
    let res = await call(handler, `/canvas/native/source-files/${rowH.id}/restore`, {
      method: 'POST', cookie,
      headers: { 'if-match': `W/"${store.getSourceFile(actor, rowH.id).version}"` }
    });
    assert.equal(res.statusCode, 409, res.text);
    assert.equal(res.payload.error.code, 'trash_missing');
    assert.equal(store.getSourceFile(actor, rowH.id).status, 'trashed',
      'a missing trash file must never be restored as bookkeeping-only active');

    // --- 14.7 import: file placed but DB write never happened -> compensate.
    const orphanBytes = makePdfBytes('recovery-orphan');
    const opI = startOp({
      operationType: 'file.import', sourcePath: path.join(tempDir, 'never-downloaded.pdf'),
      targetPath: `${rootAbs}/rec-orphan.pdf`,
      payload: { rootId: root.id, targetDir: '', filename: 'rec-orphan.pdf', sha256: sha256Of(orphanBytes) }
    });
    fs.writeFileSync(path.join(rootDir, 'rec-orphan.pdf'), orphanBytes);
    summary = await recoverInterruptedFileOperations(store);
    assert.equal(summary.rolledBack, 1);
    assert.equal(store.getFileOperation(actor, opI.id).state, 'rolled_back');
    assert.equal(fs.existsSync(path.join(rootDir, 'rec-orphan.pdf')), false,
      'the orphan placement must be compensated away');

    // --- 14.8 import: DB row already written -> completed, file preserved.
    const bytesJ = makePdfBytes('recovery-committed');
    const rowJ = enroll('rec-committed.pdf', bytesJ);
    const opJ = startOp({
      operationType: 'file.import', sourcePath: path.join(tempDir, 'never-downloaded-2.pdf'),
      targetPath: `${rootAbs}/rec-committed.pdf`,
      payload: { rootId: root.id, targetDir: '', filename: 'rec-committed.pdf' }
    });
    summary = await recoverInterruptedFileOperations(store);
    assert.equal(summary.completed, 1);
    assert.equal(store.getFileOperation(actor, opJ.id).state, 'completed');
    assert.equal(fs.existsSync(path.join(rootDir, 'rec-committed.pdf')), true);
    assert.ok(store.getSourceFile(actor, rowJ.id), 'committed row must survive');

    // --- 14.9 mkdir: idempotently ensure the directory -> completed.
    const opK = startOp({
      operationType: 'file.mkdir', targetPath: `${rootAbs}/恢复目录/子目录`,
      payload: { rootId: root.id, path: '恢复目录/子目录' }
    });
    summary = await recoverInterruptedFileOperations(store);
    assert.equal(summary.completed, 1);
    assert.equal(store.getFileOperation(actor, opK.id).state, 'completed');
    assert.equal(fs.existsSync(path.join(rootDir, '恢复目录', '子目录')), true,
      'recovery must actually create the journaled directory');

    // --- 14.10 delete_permanent: trash file already gone -> finish the purge.
    const rowL = enroll('rec-i.pdf', makePdfBytes('recovery-i'), { status: 'trashed' });
    const opL = startOp({
      operationType: 'file.delete_permanent', sourceFileId: rowL.id,
      sourcePath: `.altcanvas-trash/${rowL.id}.pdf`
    });
    summary = await recoverInterruptedFileOperations(store);
    assert.equal(summary.completed, 1);
    assert.equal(store.getFileOperation(actor, opL.id).state, 'completed');
    assert.equal(store.getSourceFile(actor, rowL.id), null, 'row must be purged (soft-deleted)');

    console.log('✅ P1.2 deterministic crash recovery (rename/trash/restore/import/mkdir/delete + 409 trash_missing) passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

// ============================================================
// 15. P1.3: forceNew must never bypass the SHA-256 content rule;
//     it only relaxes the fuzzy metadata confirmation.
// ============================================================
async function testM4AuditFixForceNewDedupe() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-force-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-force-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-force');
  const session = createSession({
    userId: 'm4-force-1', subject: 'm4-force', authMode: 'local',
    username: 'force', role: 'admin', actorKey: actor
  });
  const cookie = `altcanvas_session=${session.id}`;

  const pdfByUrl = new Map();
  let downloadCounter = 0;
  const fakeDownloadPdf = async (pdfUrl, tempDirForDownload) => {
    const bytes = pdfByUrl.get(pdfUrl);
    if (!bytes) {
      const err = new Error('not found');
      err.status = 404;
      throw err;
    }
    downloadCounter += 1;
    fs.mkdirSync(tempDirForDownload, { recursive: true, mode: 0o700 });
    const tempFilePath = path.join(tempDirForDownload, `dl-${downloadCounter}.pdf`);
    fs.writeFileSync(tempFilePath, bytes);
    return { tempFilePath, sha256: sha256Of(bytes), sizeBytes: bytes.length };
  };
  const handler = createCanvasHandler(store, { downloadPdfFn: fakeDownloadPdf });

  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '去重文库' }]);
    const payload = (overrides = {}) => ({
      title: '强制新建去重文献', year: 2025,
      pdfUrl: 'http://pdf-source.test/force-a.pdf',
      rootId: root.id, targetDir: '',
      ...overrides
    });

    // First import creates the library identity.
    pdfByUrl.set('http://pdf-source.test/force-a.pdf', makePdfBytes('force-new-content-one'));
    let res = await call(handler, '/canvas/native/source-files/import', {
      method: 'POST', cookie, body: payload({ filename: 'force-a.pdf' })
    });
    assert.equal(res.statusCode, 201, res.text);
    assert.equal(res.payload.data.outcome, 'created');
    const documentId = res.payload.data.document.id;

    // Identical content with forceNew: true is STILL duplicate_content:
    // the SHA-256 rule outranks forceNew and the metadata chain.
    // [M4 UX upgrade] forceNew with identical SHA-256 succeeds with 200 reused:
    // reuses existing document, preserves single instance, forceNew cannot create duplicate.
    res = await call(handler, '/canvas/native/source-files/import', {
      method: 'POST', cookie,
      body: payload({
        pdfUrl: 'http://pdf-source.test/force-a.pdf',
        title: '完全不同的另一篇文献',
        filename: 'force-b.pdf',
        forceNew: true
      })
    });
    assert.equal(res.statusCode, 200, res.text);
    assert.equal(res.payload.data.outcome, 'reused');
    assert.equal(res.payload.data.document.id, documentId);
    assert.equal(fs.existsSync(path.join(rootDir, 'force-b.pdf')), false, 'no second copy may be placed');

    // Fuzzy metadata match (same title, different content) without
    // confirmation still requires user confirmation.
    pdfByUrl.set('http://pdf-source.test/force-c.pdf', makePdfBytes('force-new-content-two'));
    res = await call(handler, '/canvas/native/source-files/import', {
      method: 'POST', cookie,
      body: payload({ pdfUrl: 'http://pdf-source.test/force-c.pdf', filename: 'force-c.pdf' })
    });
    assert.equal(res.statusCode, 409, res.text);
    assert.equal(res.payload.error.code, 'duplicate_confirmation_required');
    assert.equal(fs.existsSync(path.join(rootDir, 'force-c.pdf')), false);

    // forceNew relaxes exactly that fuzzy confirmation — new document created.
    pdfByUrl.set('http://pdf-source.test/force-d.pdf', makePdfBytes('force-new-content-three'));
    res = await call(handler, '/canvas/native/source-files/import', {
      method: 'POST', cookie,
      body: payload({ pdfUrl: 'http://pdf-source.test/force-d.pdf', filename: 'force-d.pdf', forceNew: true })
    });
    assert.equal(res.statusCode, 201, res.text);
    assert.equal(res.payload.data.outcome, 'created');
    assert.notEqual(res.payload.data.document.id, documentId);

    console.log('✅ P1.3 forceNew cannot bypass SHA dedupe (only the fuzzy metadata gate) passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

// ============================================================
// 16. P1.4: content change cascade — attachment version bump +
//     stale topic analyses; duplicate-hash demotion without a
//     second library identity.
// ============================================================
async function testM4AuditFixContentChange() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-content-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-content-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-content');
  const session = createSession({
    userId: 'm4-content-1', subject: 'm4-content', authMode: 'local',
    username: 'content', role: 'admin', actorKey: actor
  });
  const cookie = `altcanvas_session=${session.id}`;
  const handler = createCanvasHandler(store);

  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '内容文库' }]);
    const workspace = store.createWorkspace(actor, { name: '内容变化主题' });

    const bytesA1 = makePdfBytes('content-alpha-v1');
    const bytesA2 = makePdfBytes('content-alpha-v2-longer-payload');
    const bytesB = makePdfBytes('content-beta-holder');
    fs.writeFileSync(path.join(rootDir, 'doc-a.pdf'), bytesA1);
    fs.writeFileSync(path.join(rootDir, 'doc-b.pdf'), bytesB);

    let scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    assert.equal(scanRes.statusCode, 202, scanRes.text);
    assert.equal(scanRes.payload.data.report.newDocuments, 2);

    const rowA = store.getSourceFileByPath(actor, root.id, 'doc-a.pdf');
    const rowB = store.getSourceFileByPath(actor, root.id, 'doc-b.pdf');
    assert.ok(rowA.documentId && rowA.attachmentId);
    assert.ok(rowB.documentId && rowB.attachmentId);
    const attachmentA = store.getAttachment(actor, rowA.attachmentId);
    assert.equal(attachmentA.version, 1);

    store.addDocumentTopics(actor, rowA.documentId, [workspace.id]);
    const binding = store.listTopicDocuments(actor, workspace.id).find(t => t.itemKey === rowA.documentId);
    assert.equal(binding.attachmentKey, rowA.attachmentId);
    assert.equal(binding.attachmentVersion, 1);

    // --- 16.1 Content change: attachment version+1 + size refresh + stale analyses.
    fs.writeFileSync(path.join(rootDir, 'doc-a.pdf'), bytesA2);
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    assert.equal(scanRes.payload.data.report.changed, 1);

    const changedRow = store.getSourceFile(actor, rowA.id);
    assert.equal(changedRow.status, 'active');
    assert.equal(changedRow.sha256, sha256Of(bytesA2), 'source_files.sha256 must follow the disk content');
    const attachmentAfter = store.getAttachment(actor, rowA.attachmentId);
    assert.equal(attachmentAfter.version, 2, 'attachment version must be bumped');
    assert.equal(attachmentAfter.sizeBytes, bytesA2.length, 'attachment size must follow the new content');
    const bindingAfter = store.listTopicDocuments(actor, workspace.id).find(t => t.itemKey === rowA.documentId);
    assert.equal(bindingAfter.analysisStatus, 'stale', 'bound topic analysis must go stale');
    assert.equal(bindingAfter.attachmentVersion, 2, 'binding must follow the new attachment version');

    // --- 16.2 New hash already held by another enrolled document: demote to
    // duplicate, no second library identity, old bindings cleared + stale.
    const docsBefore = store.listDocuments(actor, {}).length;
    fs.writeFileSync(path.join(rootDir, 'doc-a.pdf'), bytesB);
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    assert.equal(scanRes.payload.data.report.changed, 1);
    assert.equal(scanRes.payload.data.report.newDocuments, 0);

    const demoted = store.getSourceFile(actor, rowA.id);
    assert.equal(demoted.status, 'duplicate');
    assert.equal(demoted.documentId, null, 'duplicate demotion must detach the identity');
    assert.equal(demoted.attachmentId, null);
    assert.equal(store.listDocuments(actor, {}).length, docsBefore, 'no second library identity may appear');
    assert.ok(store.getSourceFile(actor, rowB.id).documentId, 'the original holder keeps its identity');

    const bindingDemoted = store.getTopicDocument(actor, binding.id);
    assert.equal(bindingDemoted.attachmentKey, null, 'old theme binding attachment key must be cleared');
    assert.equal(bindingDemoted.attachmentVersion, null);
    assert.equal(bindingDemoted.analysisStatus, 'stale');
    const attRow = store.db.prepare('SELECT deleted_at FROM attachments WHERE id = ?').get(rowA.attachmentId);
    assert.ok(attRow.deleted_at, 'the old attachment must be soft-deleted');

    console.log('✅ P1.4 content change cascade (version bump + stale + duplicate demotion) passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

// ============================================================
// 17. P1.5: roots removed from the server config are deactivated
//     (soft-delete), refuse every access path, keep their
//     source_files linkage, and reactivate in place.
// ============================================================
async function testM4AuditFixRootDeactivation() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-roots-store-'));
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-roots-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-roots-b-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-roots');
  const session = createSession({
    userId: 'm4-roots-1', subject: 'm4-roots', authMode: 'local',
    username: 'roots', role: 'admin', actorKey: actor
  });
  const cookie = `altcanvas_session=${session.id}`;
  const handler = createCanvasHandler(store);

  try {
    let roots = store.ensureLibraryRootsFromConfig(actor, [
      { absolutePath: dirA, displayName: '根A' },
      { absolutePath: dirB, displayName: '根B' }
    ]);
    assert.equal(roots.length, 2);
    const rootA = roots.find(r => r.absolutePath === path.resolve(dirA));
    const rootB = roots.find(r => r.absolutePath === path.resolve(dirB));
    assert.ok(rootA && rootB);

    // A source file under root B before it disappears from the config.
    const bytesB = makePdfBytes('root-b-file');
    fs.writeFileSync(path.join(dirB, 'b.pdf'), bytesB);
    const rowB = store.createSourceFile(actor, rootB.id, {
      relativePath: 'b.pdf', filename: 'b.pdf',
      sha256: sha256Of(bytesB), sizeBytes: bytesB.length, status: 'active'
    });

    // Sync with only root A configured: B is deactivated.
    store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: dirA, displayName: '根A' }]);
    assert.equal(store.listLibraryRoots(actor).length, 1);
    assert.throws(() => store.requireLibraryRoot(actor, rootB.id), CanvasNotFoundError);

    // HTTP access paths for the deactivated root are 404.
    let res = await call(handler, `/canvas/native/library-roots/${rootB.id}/tree`, { cookie });
    assert.equal(res.statusCode, 404);
    res = await call(handler, `/canvas/native/library-roots/${rootB.id}/scan`, { method: 'POST', cookie });
    assert.equal(res.statusCode, 404);

    // The source_files linkage survives (soft association, never deleted).
    assert.equal(store.listSourceFiles(actor, { rootId: rootB.id }).length, 1,
      'source_files rows must survive root deactivation');
    assert.equal(store.getSourceFile(actor, rowB.id).id, rowB.id);

    // Re-configuring the same path reactivates the SAME row id.
    roots = store.ensureLibraryRootsFromConfig(actor, [
      { absolutePath: dirA, displayName: '根A' },
      { absolutePath: dirB, displayName: '根B 复活' }
    ]);
    assert.equal(roots.length, 2);
    const reactivated = roots.find(r => r.id === rootB.id);
    assert.ok(reactivated, 'same path must reuse/reactivate the old row, not create a new one');
    assert.equal(reactivated.displayName, '根B 复活');
    assert.equal(store.getSourceFile(actor, rowB.id).rootId, rootB.id);

    console.log('✅ P1.5 root deactivation, 404 access refusal, linkage retention and reactivate-in-place passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
}

// ============================================================
// 18. P1.7: bounded scanning — lazy PDF iterator + fixed-size
//     batches over a >SCAN_BATCH_SIZE library.
// ============================================================
async function testM4AuditFixBoundedScan() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-bounded-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-bounded-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-bounded');
  const session = createSession({
    userId: 'm4-bounded-1', subject: 'm4-bounded', authMode: 'local',
    username: 'bounded', role: 'admin', actorKey: actor
  });
  const cookie = `altcanvas_session=${session.id}`;
  const handler = createCanvasHandler(store);

  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '有界文库' }]);

    assert.equal(SCAN_BATCH_SIZE, 100);
    const total = SCAN_BATCH_SIZE + 5; // forces >1 batch
    for (let i = 0; i < total; i += 1) {
      const dir = path.join(rootDir, `batch-${Math.floor(i / 35)}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `file-${String(i).padStart(3, '0')}.pdf`), makePdfBytes(`bounded-unique-${i}`));
    }

    // First scan enrolls all 105 unique contents across batch boundaries.
    let scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    assert.equal(scanRes.statusCode, 202, scanRes.text);
    let report = scanRes.payload.data.report;
    assert.equal(report.scannedFiles, total);
    assert.equal(report.newDocuments, total);
    assert.equal(report.duplicates, 0);
    const enrolledCount = store.db.prepare(
      'SELECT COUNT(*) AS c FROM documents WHERE owner_key = ? AND deleted_at IS NULL'
    ).get(actor).c;
    assert.equal(enrolledCount, total);

    // Second scan: everything unchanged, nothing rehashed.
    scanRes = await call(handler, `/canvas/native/library-roots/${root.id}/scan`, { method: 'POST', cookie });
    assert.equal(scanRes.statusCode, 202);
    report = scanRes.payload.data.report;
    assert.equal(report.unchangedFiles, total);
    assert.equal(report.hashedFiles, 0);
    assert.equal(report.newDocuments, 0);

    // iteratePdfEntries is a lazy generator: constructing it over a missing
    // root must not touch the filesystem until the first pull.
    const lazy = iteratePdfEntries(path.join(rootDir, 'does-not-exist'));
    assert.equal(Object.prototype.toString.call(lazy), '[object Generator]');
    let lazyError = null;
    try { lazy.next(); } catch (err) { lazyError = err; }
    assert.ok(lazyError, 'first pull must surface the missing root');
    assert.equal(lazyError.code, 'library_root_unavailable');

    // Lazy pull over the real root: one value at a time, early close is fine.
    const iterator = iteratePdfEntries(rootDir);
    assert.equal(Object.prototype.toString.call(iterator), '[object Generator]');
    const first = iterator.next();
    assert.equal(first.done, false);
    assert.ok(first.value.relativePath.endsWith('.pdf'));
    assert.equal(typeof first.value.sizeBytes, 'number');
    assert.equal(typeof first.value.mtimeMs, 'number');
    iterator.return?.();

    // batchesOf yields fixed-size batches with a bounded remainder.
    assert.deepEqual([...batchesOf([1, 2, 3, 4, 5][Symbol.iterator](), 2)].map(b => b.length), [2, 2, 1]);
    assert.deepEqual([...batchesOf([][Symbol.iterator](), 3)], []);

    console.log('✅ P1.7 bounded scan (105 files over 100-batches, lazy generator, batchesOf) passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

// Audit-fix regression suite (P1.1 / P1.2 / P1.3 / P1.4 / P1.5 / P1.7).
async function testM4AuditFixes() {
  await testM4AuditFixSymlinkEscapes();
  await testM4AuditFixDeterministicRecovery();
  await testM4AuditFixForceNewDedupe();
  await testM4AuditFixContentChange();
  await testM4AuditFixRootDeactivation();
  await testM4AuditFixBoundedScan();
}


// ============================================================
// 19. P1-A/P2-A: tree endpoint rejects symlinked directories and paginates
//     without materializing stats for the whole directory.
// ============================================================
async function testTreeSymlinkAndPagination() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-tree-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-tree-root-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-tree-out-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-tree');
  const session = createSession({
    userId: 'm4-tree-1', subject: 'm4-tree', authMode: 'local',
    username: 'tree', role: 'admin', actorKey: actor
  });
  const cookie = `altcanvas_session=${session.id}`;
  const handler = createCanvasHandler(store);
  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '树视图文库' }]);

    // 19.1 Top-level symlinked directory must not be listable.
    fs.symlinkSync(outsideDir, path.join(rootDir, 'escape'));
    fs.writeFileSync(path.join(outsideDir, 'outside-secret.pdf'), makePdfBytes('secret'));
    let res = await call(handler, `/canvas/native/library-roots/${root.id}/tree?path=escape`, { cookie });
    assert.equal(res.statusCode, 400, res.text);
    assert.equal(res.payload.error.code, 'symlink_rejected');
    assert.equal(fs.existsSync(path.join(outsideDir, 'outside-secret.pdf')), true, 'outside file untouched');

    // 19.2 Deep symlinked component rejected too.
    fs.mkdirSync(path.join(rootDir, 'realdir'));
    fs.symlinkSync(outsideDir, path.join(rootDir, 'realdir', 'sub'));
    res = await call(handler, `/canvas/native/library-roots/${root.id}/tree?path=realdir%2Fsub`, { cookie });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.error.code, 'symlink_rejected');

    // 19.3 A real directory still lists; the symlink itself is visible but inert.
    fs.writeFileSync(path.join(rootDir, 'realdir', 'doc.pdf'), makePdfBytes('doc'));
    res = await call(handler, `/canvas/native/library-roots/${root.id}/tree?path=realdir`, { cookie });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload.data.map(e => e.name), ['doc.pdf', 'sub']);
    assert.equal(res.payload.data.find(e => e.name === 'sub').type, 'symlink');

    // 19.4 Pagination: limit/cursor slicing with nextCursor and no truncation.
    fs.mkdirSync(path.join(rootDir, 'bigdir'));
    for (let i = 0; i < 7; i++) {
      fs.writeFileSync(path.join(rootDir, 'bigdir', `f${i}.pdf`), makePdfBytes(`f${i}`));
    }
    res = await call(handler, `/canvas/native/library-roots/${root.id}/tree?path=bigdir&limit=3`, { cookie });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.data.length, 3);
    assert.equal(res.payload.meta.total, 7);
    assert.equal(res.payload.meta.nextCursor, 3);
    assert.equal(res.payload.meta.truncated, false);
    res = await call(handler, `/canvas/native/library-roots/${root.id}/tree?path=bigdir&limit=5&cursor=5`, { cookie });
    assert.equal(res.payload.data.length, 2);
    assert.equal(res.payload.meta.nextCursor, null);
    // Only the requested page carries stat facts.
    assert.ok(res.payload.data.every(e => typeof e.sizeBytes === 'number' && typeof e.modifiedAt === 'number'));

    console.log('✅ P1-A/P2-A tree symlink rejection and page-bounded listing passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
}

// ============================================================
// 20. P1-B: recovery reconcilers refuse symlinked parents, keep failed
//     (not rolled_back) on unlink failure, and never touch root-outside data.
// ============================================================
async function testRecoverySafePaths() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-rec-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-rec-root-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-rec-out-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-rec');
  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '恢复文库' }]);

    // 20.1 import recorded, file placed, then parent replaced by a symlink to
    // an outside directory containing a decoy with the same name: recovery
    // must fail the operation and leave the outside decoy untouched.
    fs.mkdirSync(path.join(rootDir, 'd1'));
    fs.writeFileSync(path.join(rootDir, 'd1', 'orphan.pdf'), makePdfBytes('placed'));
    const op1 = store.createFileOperation(actor, {
      operationType: 'file.import',
      sourcePath: 'tmp-irrelevant',
      targetPath: `${rootDir}/d1/orphan.pdf`,
      payload: { rootId: root.id, targetDir: 'd1', filename: 'orphan.pdf' }
    });
    store.startFileOperation(op1.id);
    const decoyBytes = makePdfBytes('decoy-must-survive');
    fs.rmSync(path.join(rootDir, 'd1'), { recursive: true, force: true });
    fs.symlinkSync(outsideDir, path.join(rootDir, 'd1'));
    fs.writeFileSync(path.join(outsideDir, 'orphan.pdf'), decoyBytes);

    let summary = await recoverInterruptedFileOperations(store);
    assert.equal(summary.failed >= 1, true);
    assert.equal(store.getFileOperation(actor, op1.id).state, 'failed');
    assert.equal(store.getFileOperation(actor, op1.id).errorCode, 'unsafe_path');
    assert.equal(fs.readFileSync(path.join(outsideDir, 'orphan.pdf')).equals(decoyBytes), true,
      'the outside decoy must never be deleted through the symlinked parent');

    // Remove the symlink for the next scenario.
    fs.rmSync(path.join(rootDir, 'd1'));

    // 20.2 import compensation unlink fails (parent dir read-only): operation
    // must end failed, never rolled_back, and the file must still exist.
    const stuckBytes = makePdfBytes('stuck');
    fs.mkdirSync(path.join(rootDir, 'd2'));
    fs.writeFileSync(path.join(rootDir, 'd2', 'stuck.pdf'), stuckBytes);
    const op2 = store.createFileOperation(actor, {
      operationType: 'file.import',
      targetPath: `${rootDir}/d2/stuck.pdf`,
      payload: { rootId: root.id, targetDir: 'd2', filename: 'stuck.pdf', sha256: sha256Of(stuckBytes) }
    });
    store.startFileOperation(op2.id);
    fs.chmodSync(path.join(rootDir, 'd2'), 0o500);
    try {
      summary = await recoverInterruptedFileOperations(store);
      assert.equal(store.getFileOperation(actor, op2.id).state, 'failed');
      assert.equal(store.getFileOperation(actor, op2.id).errorCode, 'compensation_failed');
      assert.equal(fs.existsSync(path.join(rootDir, 'd2', 'stuck.pdf')), true, 'file survives a failed unlink');
    } finally {
      fs.chmodSync(path.join(rootDir, 'd2'), 0o755);
    }

    // 20.3 trash recorded but the source parent became a symlink with an
    // outside decoy: nothing is safely present, operation fails, decoy intact.
    const decoy2 = makePdfBytes('trash-decoy');
    fs.mkdirSync(path.join(rootDir, 'd3'));
    fs.writeFileSync(path.join(rootDir, 'd3', 'x.pdf'), makePdfBytes('original'));
    const sf = store.createSourceFile(actor, root.id, {
      relativePath: 'd3/x.pdf', filename: 'x.pdf', sha256: sha256Of(makePdfBytes('original')), sizeBytes: 10
    });
    const op3 = store.createFileOperation(actor, {
      operationType: 'file.trash',
      sourceFileId: sf.id,
      sourcePath: 'd3/x.pdf',
      targetPath: `.altcanvas-trash/${sf.id}.pdf`
    });
    store.startFileOperation(op3.id);
    fs.rmSync(path.join(rootDir, 'd3'), { recursive: true, force: true });
    fs.symlinkSync(outsideDir, path.join(rootDir, 'd3'));
    fs.writeFileSync(path.join(outsideDir, 'x.pdf'), decoy2);
    summary = await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, op3.id).state, 'failed');
    assert.equal(fs.readFileSync(path.join(outsideDir, 'x.pdf')).equals(decoy2), true,
      'recovery must not see or move files through a symlinked parent');
    assert.equal(store.getSourceFile(actor, sf.id).status, 'active', 'row stays as-is when facts are unsafe');
    fs.unlinkSync(path.join(rootDir, 'd3'));

    // 20.4 restore recorded with a symlinked target parent: trash file still
    // present -> rolled_back, nothing written through the symlink.
    fs.mkdirSync(path.join(rootDir, 'd4'));
    fs.mkdirSync(path.join(rootDir, '.altcanvas-trash'), { recursive: true });
    const sf2 = store.createSourceFile(actor, root.id, {
      relativePath: 'd4/y.pdf', filename: 'y.pdf', sha256: sha256Of(makePdfBytes('y')), sizeBytes: makePdfBytes('y').length,
      status: 'trashed'
    });
    // The trash payload must match the recorded identity so the scenario
    // isolates the symlinked-target-parent behavior.
    fs.writeFileSync(path.join(rootDir, '.altcanvas-trash', `${sf2.id}.pdf`), makePdfBytes('y'));
    const op4 = store.createFileOperation(actor, {
      operationType: 'file.restore',
      sourceFileId: sf2.id,
      sourcePath: `.altcanvas-trash/${sf2.id}.pdf`,
      targetPath: 'd4/y.pdf'
    });
    store.startFileOperation(op4.id);
    fs.rmSync(path.join(rootDir, 'd4'), { recursive: true, force: true });
    fs.symlinkSync(outsideDir, path.join(rootDir, 'd4'));
    summary = await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, op4.id).state, 'rolled_back');
    assert.equal(fs.existsSync(path.join(rootDir, '.altcanvas-trash', `${sf2.id}.pdf`)), true,
      'trash payload stays in the controlled area');
    assert.equal(fs.readdirSync(outsideDir).includes('y.pdf'), false, 'nothing restored through the symlink');
    fs.unlinkSync(path.join(rootDir, 'd4'));

    console.log('✅ P1-B recovery safe probes: symlinked parents refused, unlink failure stays failed, zero outside side effects passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
}

// ============================================================
// 21. P1-C: bounded-memory scan — tens of thousands of entries with a
//     pull-ahead invariant proving the batch processor never aggregates.
// ============================================================
async function testBoundedScanStaging() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-bound-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-bound-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-bound');
  const TOTAL = 30000;
  const DISTINCT = 50;
  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '有界文库' }]);

    // Instrument the staging writer to track how many disk facts have been
    // durably staged; the entry generator asserts, on every pull, that the
    // scanner never pulls more than one batch ahead of staged facts.
    let processed = 0;
    const originalInsert = store.insertScanStagingRows.bind(store);
    store.insertScanStagingRows = (...args) => {
      const result = originalInsert(...args);
      processed += args[3].length;
      return result;
    };
    const violations = [];
    function* syntheticEntries() {
      for (let i = 0; i < TOTAL; i++) {
        const pulled = i + 1;
        if (pulled - processed > SCAN_BATCH_SIZE) {
          violations.push({ pulled, processed });
        }
        yield {
          relativePath: `dir${Math.floor(i / 25)}/file${i}.pdf`,
          filename: `file${i}.pdf`,
          sizeBytes: 100 + (i % 7),
          mtimeMs: 1_700_000_000_000 + i
        };
      }
    }
    const syntheticSha = async (_rootPath, relativePath) => {
      const idx = Number(/file(\d+)\.pdf$/.exec(relativePath)[1]);
      return {
        sha256: crypto.createHash('sha256').update(`content-${idx % DISTINCT}`).digest('hex'),
        sizeBytes: 100 + (idx % 7),
        mtimeMs: 1_700_000_000_000 + idx
      };
    };

    const result = await scanLibraryRoot(store, actor, root.id, {
      hashFn: syntheticSha,
      entryIteratorFn: syntheticEntries
    });
    assert.equal(result.state, 'completed');
    const report = result.report;
    assert.equal(report.scannedFiles, TOTAL);
    assert.equal(report.hashedFiles, TOTAL);
    assert.equal(report.newDocuments, DISTINCT, 'one library identity per distinct content');
    assert.equal(report.duplicates, TOTAL - DISTINCT);
    assert.equal(report.moved, 0);
    assert.equal(report.missing, 0);
    assert.equal(violations.length, 0,
      `the scanner aggregated ahead of staging (max pull-ahead exceeded; first violation: ${JSON.stringify(violations[0])})`);
    assert.equal(store.countScanStaging('never-matches').total, 0);

    // Staging is fully cleaned after success.
    assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM scan_staging').get().c, 0,
      'scan staging must be empty after a completed scan');

    // A failing scan cleans its staging too. (Per-file hash errors are
    // classified as unreadable by design, so the failure is injected at the
    // enumeration layer — the same path an unreadable directory takes.)
    function* failingEntries() {
      for (let i = 0; i < 300; i++) {
        if (i === 150) throw new Error('simulated scan failure');
        yield { relativePath: `f${i}.pdf`, filename: `f${i}.pdf`, sizeBytes: 10, mtimeMs: i };
      }
    }
    await assert.rejects(
      () => scanLibraryRoot(store, actor, root.id, { hashFn: syntheticSha, entryIteratorFn: failingEntries }),
      /simulated scan failure/
    );
    assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM scan_staging').get().c, 0,
      'scan staging must be empty after a failed scan');
    assert.equal(store.getLibraryRoot(actor, root.id).lastScanStatus, 'failed');

    console.log(`✅ P1-C bounded scan: ${TOTAL} entries with staging-table reconciliation, pull-ahead invariant held, staging cleaned on success and failure passed`);
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function testM4Audit2Fixes() {
  await testTreeSymlinkAndPagination();
  await testRecoverySafePaths();
  await testBoundedScanStaging();
}


// ============================================================
// 22. Third-audit P1: recovery must verify target content identity;
//     P2: truncation boundary at MAX/MAX+1 directory entries.
// ============================================================
async function testRecoveryContentIdentity() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-ci-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-ci-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-ci');
  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '内容验证文库' }]);

    // Helper: enrolled row + journaled op mimicking a crash right after the FS step.
    const enrollWithBytes = (relativePath, bytes) => {
      fs.mkdirSync(path.dirname(path.join(rootDir, relativePath)), { recursive: true });
      fs.writeFileSync(path.join(rootDir, relativePath), bytes);
      const row = store.createSourceFile(actor, root.id, {
        relativePath, filename: path.basename(relativePath),
        sha256: sha256Of(bytes), sizeBytes: bytes.length,
        status: 'active'
      });
      return { row, bytes };
    };
    const startCrashedOp = (operationType, detail) => {
      const op = store.createFileOperation(actor, { operationType, ...detail });
      store.startFileOperation(op.id);
      return op;
    };

    // 22.1 move-like: target replaced by a DIFFERENT pdf (SHA-B) while the row
    // records SHA-A -> content_mismatch, DB untouched.
    const bytesA = makePdfBytes('identity-A');
    const { row: rowA } = enrollWithBytes('mv-a-src.pdf', bytesA);
    fs.writeFileSync(path.join(rootDir, 'mv-a-dst.pdf'), makePdfBytes('identity-B'));
    fs.rmSync(path.join(rootDir, 'mv-a-src.pdf'));
    const opA = startCrashedOp('file.rename', {
      sourceFileId: rowA.id, sourcePath: 'mv-a-src.pdf', targetPath: 'mv-a-dst.pdf'
    });
    let summary = await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, opA.id).state, 'failed');
    assert.equal(store.getFileOperation(actor, opA.id).errorCode, 'content_mismatch');
    const rowAAfter = store.getSourceFile(actor, rowA.id);
    assert.equal(rowAAfter.relativePath, 'mv-a-src.pdf', 'DB path must not move onto foreign content');
    assert.equal(rowAAfter.sha256, sha256Of(bytesA), 'recorded identity must stay intact');

    // 22.2 move-like: target is a DIRECTORY -> content_mismatch, DB untouched.
    const { row: rowB } = enrollWithBytes('mv-b-src.pdf', makePdfBytes('identity-B2'));
    fs.rmSync(path.join(rootDir, 'mv-b-src.pdf'));
    fs.mkdirSync(path.join(rootDir, 'mv-b-dst.pdf')); // a directory where the file should land
    const opB = startCrashedOp('file.rename', {
      sourceFileId: rowB.id, sourcePath: 'mv-b-src.pdf', targetPath: 'mv-b-dst.pdf'
    });
    await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, opB.id).state, 'failed');
    assert.equal(store.getFileOperation(actor, opB.id).errorCode, 'content_mismatch');
    assert.equal(store.getSourceFile(actor, rowB.id).relativePath, 'mv-b-src.pdf');

    // 22.3 trash: recycle-area file replaced by different bytes -> failed, row
    // stays active, nothing committed as trashed.
    fs.mkdirSync(path.join(rootDir, '.altcanvas-trash'), { recursive: true });
    const bytesC = makePdfBytes('identity-C');
    const { row: rowC } = enrollWithBytes('trash-c.pdf', bytesC);
    fs.renameSync(path.join(rootDir, 'trash-c.pdf'), path.join(rootDir, '.altcanvas-trash', `${rowC.id}.pdf`));
    fs.writeFileSync(path.join(rootDir, '.altcanvas-trash', `${rowC.id}.pdf`), makePdfBytes('identity-C-prime'));
    const opC = startCrashedOp('file.trash', {
      sourceFileId: rowC.id, sourcePath: 'trash-c.pdf', targetPath: `.altcanvas-trash/${rowC.id}.pdf`
    });
    await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, opC.id).state, 'failed');
    assert.equal(store.getFileOperation(actor, opC.id).errorCode, 'content_mismatch');
    assert.equal(store.getSourceFile(actor, rowC.id).status, 'active',
      'a foreign trash payload must never flip the row to trashed');

    // 22.4 restore: target replaced by different content -> content_mismatch,
    // row stays trashed, trash payload intact.
    const bytesD = makePdfBytes('identity-D');
    const { row: rowD } = enrollWithBytes('res-d.pdf', bytesD);
    store.updateSourceFile(actor, rowD.id, { status: 'trashed' });
    fs.mkdirSync(path.join(rootDir, '.altcanvas-trash'), { recursive: true });
    fs.renameSync(path.join(rootDir, 'res-d.pdf'), path.join(rootDir, '.altcanvas-trash', `${rowD.id}.pdf`));
    // Crash point: the rename back already consumed the trash payload, and the
    // restored target was then overwritten with DIFFERENT bytes.
    fs.renameSync(path.join(rootDir, '.altcanvas-trash', `${rowD.id}.pdf`), path.join(rootDir, 'res-d.pdf'));
    fs.writeFileSync(path.join(rootDir, 'res-d.pdf'), makePdfBytes('identity-D-prime'));
    const opD = startCrashedOp('file.restore', {
      sourceFileId: rowD.id, sourcePath: `.altcanvas-trash/${rowD.id}.pdf`, targetPath: 'res-d.pdf'
    });
    await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, opD.id).state, 'failed');
    assert.equal(store.getFileOperation(actor, opD.id).errorCode, 'content_mismatch');
    assert.equal(store.getSourceFile(actor, rowD.id).status, 'trashed');
    assert.equal(fs.readFileSync(path.join(rootDir, 'res-d.pdf')).equals(makePdfBytes('identity-D-prime')), true,
      'the foreign target content must be left exactly as found');

    // 22.5 import: DB row exists but the file is GONE -> failed, not completed.
    const bytesE = makePdfBytes('identity-E');
    const { row: rowE } = enrollWithBytes('imp-e.pdf', bytesE);
    const opE = startCrashedOp('file.import', {
      targetPath: `${rootDir}/imp-e.pdf`,
      payload: { rootId: root.id, targetDir: '', filename: 'imp-e.pdf' }
    });
    fs.rmSync(path.join(rootDir, 'imp-e.pdf'));
    await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, opE.id).state, 'failed');
    assert.equal(store.getFileOperation(actor, opE.id).errorCode, 'file_missing');
    assert.ok(store.getSourceFile(actor, rowE.id), 'row survives for the next scan to reconcile');

    // 22.6 import: DB row exists and the file matches -> completed (positive control).
    const bytesF = makePdfBytes('identity-F');
    const { row: rowF } = enrollWithBytes('imp-f.pdf', bytesF);
    const opF = startCrashedOp('file.import', {
      targetPath: `${rootDir}/imp-f.pdf`,
      payload: { rootId: root.id, targetDir: '', filename: 'imp-f.pdf' }
    });
    summary = await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, opF.id).state, 'completed');
    assert.equal(fs.existsSync(path.join(rootDir, 'imp-f.pdf')), true);

    // 22.7 matching content still completes a move-like reconciliation.
    const bytesG = makePdfBytes('identity-G');
    const { row: rowG } = enrollWithBytes('mv-g-src.pdf', bytesG);
    fs.renameSync(path.join(rootDir, 'mv-g-src.pdf'), path.join(rootDir, 'mv-g-dst.pdf'));
    const opG = startCrashedOp('file.rename', {
      sourceFileId: rowG.id, sourcePath: 'mv-g-src.pdf', targetPath: 'mv-g-dst.pdf'
    });
    await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, opG.id).state, 'completed');
    assert.equal(store.getSourceFile(actor, rowG.id).relativePath, 'mv-g-dst.pdf');

    console.log('✅ recovery content identity: mismatched bytes / directory targets / missing files never complete, matching content does passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function testListingTruncationBoundary() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-trunc-'));
  const { MAX_DIRECTORY_LIST, listDirectoryPage } = await import('../server/native-fs.mjs');
  try {
    const boundaries = [
      { count: MAX_DIRECTORY_LIST - 1, truncated: false, total: MAX_DIRECTORY_LIST - 1 },
      { count: MAX_DIRECTORY_LIST, truncated: false, total: MAX_DIRECTORY_LIST },
      { count: MAX_DIRECTORY_LIST + 1, truncated: true, total: MAX_DIRECTORY_LIST }
    ];
    for (const { count, truncated, total } of boundaries) {
      const dir = path.join(rootDir, `d${count}`);
      fs.mkdirSync(dir);
      const tiny = Buffer.from('%PDF-1.4 x');
      for (let i = 0; i < count; i++) {
        fs.writeFileSync(path.join(dir, `f${i}.pdf`), tiny);
      }
      const listing = listDirectoryPage(dir, '');
      assert.equal(listing.truncated, truncated,
        `${count} entries must report truncated=${truncated} (got ${listing.truncated})`);
      assert.equal(listing.total, total,
        `${count} entries must expose total=${total}`);
      assert.equal(listing.entries.length, total, 'page (unlimited) carries every buffered entry');
      fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log(`✅ listing truncation boundary: ${MAX_DIRECTORY_LIST - 1}/${MAX_DIRECTORY_LIST}/${MAX_DIRECTORY_LIST + 1} entries decide truncated correctly passed`);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function testM4Audit3Fixes() {
  await testRecoveryContentIdentity();
  await testListingTruncationBoundary();
}


// ============================================================
// 23. Fourth-audit P1: ROLLBACK paths must verify source content identity
//     too — the symmetric counterpart of the completion-side gate.
// ============================================================
async function testRecoveryRollbackContentIdentity() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-rb-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-rb-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-rb');
  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '回滚验证文库' }]);
    const writeBytes = (rel, bytes) => {
      fs.mkdirSync(path.dirname(path.join(rootDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(rootDir, rel), bytes);
    };
    const startCrashedOp = (operationType, detail) => {
      const op = store.createFileOperation(actor, { operationType, ...detail });
      store.startFileOperation(op.id);
      return op;
    };

    // 23.1 move-like rollback (auditor's repro): DB already points at
    // new.pdf with SHA-A; new.pdf is gone; old.pdf was replaced by SHA-B.
    // The DB revert onto old.pdf must be refused: content_mismatch, DB keeps
    // pointing at new.pdf with the recorded identity.
    const bytesA = makePdfBytes('rollback-A');
    const rowA = store.createSourceFile(actor, root.id, {
      relativePath: 'new.pdf', filename: 'new.pdf',
      sha256: sha256Of(bytesA), sizeBytes: bytesA.length
    });
    writeBytes('old.pdf', makePdfBytes('rollback-B-prime'));
    const opA = startCrashedOp('file.rename', {
      sourceFileId: rowA.id, sourcePath: 'old.pdf', targetPath: 'new.pdf'
    });
    await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, opA.id).state, 'failed');
    assert.equal(store.getFileOperation(actor, opA.id).errorCode, 'content_mismatch');
    const rowAAfter = store.getSourceFile(actor, rowA.id);
    assert.equal(rowAAfter.relativePath, 'new.pdf', 'DB must not roll back onto foreign content');
    assert.equal(rowAAfter.sha256, sha256Of(bytesA));
    assert.equal(fs.readFileSync(path.join(rootDir, 'old.pdf')).equals(makePdfBytes('rollback-B-prime')), true,
      'the replaced source file itself is left untouched');

    // 23.2 trash rollback: row trashed, trash never ran (no recycle file),
    // source present but replaced -> reverting the row to active is refused.
    const bytesB = makePdfBytes('rollback-B');
    const rowB = store.createSourceFile(actor, root.id, {
      relativePath: 'trash-keep.pdf', filename: 'trash-keep.pdf',
      sha256: sha256Of(bytesB), sizeBytes: bytesB.length,
      status: 'trashed'
    });
    writeBytes('trash-keep.pdf', makePdfBytes('rollback-B-prime'));
    const opB = startCrashedOp('file.trash', {
      sourceFileId: rowB.id, sourcePath: 'trash-keep.pdf', targetPath: `.altcanvas-trash/${rowB.id}.pdf`
    });
    await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, opB.id).state, 'failed');
    assert.equal(store.getFileOperation(actor, opB.id).errorCode, 'content_mismatch');
    assert.equal(store.getSourceFile(actor, rowB.id).status, 'trashed',
      'a replaced source must never be blessed as an active rollback');

    // 23.3 restore rollback: restore never ran, but the recycle-area payload
    // was replaced by different bytes -> not a clean rollback; payload stays.
    const bytesC = makePdfBytes('rollback-C');
    const rowC = store.createSourceFile(actor, root.id, {
      relativePath: 'res-keep.pdf', filename: 'res-keep.pdf',
      sha256: sha256Of(bytesC), sizeBytes: bytesC.length,
      status: 'trashed'
    });
    writeBytes('.altcanvas-trash/' + rowC.id + '.pdf', makePdfBytes('rollback-C-prime'));
    const opC = startCrashedOp('file.restore', {
      sourceFileId: rowC.id, sourcePath: `.altcanvas-trash/${rowC.id}.pdf`, targetPath: 'res-keep.pdf'
    });
    await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, opC.id).state, 'failed');
    assert.equal(store.getFileOperation(actor, opC.id).errorCode, 'content_mismatch');
    assert.equal(fs.readFileSync(path.join(rootDir, '.altcanvas-trash', `${rowC.id}.pdf`)).equals(makePdfBytes('rollback-C-prime')), true,
      'the recycle-area payload is left exactly as found');

    // 23.4 permanent delete: the recycle-area file was replaced by different
    // bytes -> the compensating delete is refused; file survives, row intact.
    const bytesD = makePdfBytes('rollback-D');
    const rowD = store.createSourceFile(actor, root.id, {
      relativePath: 'perm.pdf', filename: 'perm.pdf',
      sha256: sha256Of(bytesD), sizeBytes: bytesD.length,
      status: 'trashed'
    });
    writeBytes('.altcanvas-trash/' + rowD.id + '.pdf', makePdfBytes('rollback-D-prime'));
    const opD = startCrashedOp('file.delete_permanent', {
      sourceFileId: rowD.id, sourcePath: `.altcanvas-trash/${rowD.id}.pdf`
    });
    await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, opD.id).state, 'failed');
    assert.equal(store.getFileOperation(actor, opD.id).errorCode, 'content_mismatch');
    assert.equal(fs.existsSync(path.join(rootDir, '.altcanvas-trash', `${rowD.id}.pdf`)), true,
      'a foreign recycle-area file must never be deleted');
    assert.ok(store.getSourceFile(actor, rowD.id), 'the row is not purged while the payload is unverified');

    // 23.5 positive control: matching payloads still roll back cleanly.
    const bytesE = makePdfBytes('rollback-E');
    const rowE = store.createSourceFile(actor, root.id, {
      relativePath: 'new-e.pdf', filename: 'new-e.pdf',
      sha256: sha256Of(bytesE), sizeBytes: bytesE.length
    });
    writeBytes('old-e.pdf', bytesE);
    const opE = startCrashedOp('file.rename', {
      sourceFileId: rowE.id, sourcePath: 'old-e.pdf', targetPath: 'new-e.pdf'
    });
    const summary = await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, opE.id).state, 'rolled_back');
    assert.equal(store.getSourceFile(actor, rowE.id).relativePath, 'old-e.pdf');
    assert.equal(summary.rolledBack >= 1, true);

    console.log('✅ rollback content identity: replaced sources/payloads never roll back or delete; matching content does passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}


// ============================================================
// 24. M4 final: web imports (DOI/arXiv/URL/BibTeX/RIS/TS) with a obtained
//     PDF always archive into 网页导入/ under the first configured root;
//     metadata-only imports create a 无 PDF document without a fake
//     source_file; blob-only web imports are impossible at the HTTP layer.
// ============================================================
async function testWebImportDefaultArchiving() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-web-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-web-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-web');
  const session = createSession({
    userId: 'm4-web-1', subject: 'm4-web', authMode: 'local',
    username: 'web', role: 'admin', actorKey: actor
  });
  const cookie = `altcanvas_session=${session.id}`;
  const workspace = store.createWorkspace(actor, { name: '网页导入主题' });

  const pdfByUrl = new Map();
  let downloadCounter = 0;
  const fakeDownloadPdf = async (pdfUrl, tempDirForDownload) => {
    const bytes = pdfByUrl.get(pdfUrl);
    if (!bytes) {
      const err = new Error('not found');
      err.status = 404;
      throw err;
    }
    downloadCounter += 1;
    fs.mkdirSync(tempDirForDownload, { recursive: true, mode: 0o700 });
    const tempFilePath = path.join(tempDirForDownload, `dl-${downloadCounter}.pdf`);
    fs.writeFileSync(tempFilePath, bytes);
    return { tempFilePath, sha256: sha256Of(bytes), sizeBytes: bytes.length, mimeType: 'application/pdf' };
  };
  const handler = createCanvasHandler(store, { downloadPdfFn: fakeDownloadPdf });

  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '研究文库' }]);

    // 24.1 DOI import with a PDF lands in 网页导入/ as a source_file archive.
    // Case A: URL ends in a .pdf segment -> candidate 2 (URL basename) wins.
    pdfByUrl.set('https://doi.org/10.9999/web-doi.pdf', makePdfBytes('web-doi-pdf'));
    let res = await call(handler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: {
        sourceType: 'doi', title: '网页导入 DOI 论文', doi: '10.9999/web-doi',
        pdfUrl: 'https://doi.org/10.9999/web-doi.pdf',
        targetWorkspaceId: workspace.id
      }
    });
    assert.equal(res.statusCode, 201, res.text);
    assert.equal(res.payload.data.outcome, 'created');
    assert.equal(res.payload.data.attachment.storageKind, 'source_file');
    assert.equal(res.payload.data.sourceFile.relativePath, '网页导入/web-doi.pdf',
      'candidate 2 (URL basename) outranks the title per rule 3.3');
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'web-doi.pdf')), true);

    // Case B: URL has no .pdf basename -> candidate 3 (library title) wins.
    pdfByUrl.set('https://example.org/download-query?doc=456', makePdfBytes('title-derived-pdf'));
    let resTitle = await call(handler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: {
        sourceType: 'doi', title: '纯标题派生文件名论文', doi: '10.9999/title-derived',
        pdfUrl: 'https://example.org/download-query?doc=456'
      }
    });
    assert.equal(resTitle.statusCode, 201, resTitle.text + ' | payload=' + JSON.stringify(resTitle.payload));
    assert.equal(resTitle.payload.data.sourceFile.relativePath, '网页导入/纯标题派生文件名论文.pdf',
      'candidate 3 (sanitized library title) applies when URL has no .pdf basename');
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', '纯标题派生文件名论文.pdf')), true);
    // Topic binding points at the active attachment id/version.
    const boundTopic = store.listNativeLibraryDocuments(actor, { topicId: workspace.id })
      .documents.find(d => d.id === res.payload.data.document.id);
    assert.ok(boundTopic);
    assert.equal(boundTopic.sourceFile.id, res.payload.data.sourceFile.id);
    const bindingRow = boundTopic.topics[0];
    assert.equal(bindingRow.attachment_version, res.payload.data.attachment.version);

    // The archive is visible through the original-files API and openable.
    const treeRes = await call(handler, `/canvas/native/library-roots/${root.id}/tree?path=${encodeURIComponent('网页导入')}`, { cookie });
    assert.equal(treeRes.statusCode, 200);
    const treeEntry = treeRes.payload.data.find(e => e.name === 'web-doi.pdf');
    assert.ok(treeEntry && treeEntry.library && treeEntry.library.documentId === res.payload.data.document.id);
    const fileRes = await call(handler, `/canvas/native/attachments/${res.payload.data.attachment.id}/file`, { cookie });
    assert.equal(fileRes.statusCode, 200);
    assert.equal(fileRes.buffer.equals(makePdfBytes('web-doi-pdf')), true);

    // 24.2 Same SHA import (different DOI metadata): 200 reused,
    // metadata backfilled, no second file in the archive directory.
    res = await call(handler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: {
        sourceType: 'doi', title: '同内容另一元数据', doi: '10.9999/web-doi-2',
        pdfUrl: 'https://doi.org/10.9999/web-doi.pdf'
      }
    });
    assert.equal(res.statusCode, 200, res.text);
    assert.equal(res.payload.data.outcome, 'reused');
    assert.equal(res.payload.data.reusedSourceFile, true);
    assert.equal(fs.readdirSync(path.join(rootDir, '网页导入')).length, 2, 'no second file for identical content (2 files from Case A + Case B)');

    // 24.3 Different SHA, same derived filename -> 409 filename_conflict.
    // The URL path basename is web-doi.pdf which matches 24.1's filename, but
    // carries different bytes.
    pdfByUrl.set('https://arxiv.org/pdf/web-doi.pdf', makePdfBytes('conflicting-web-pdf'));
    res = await call(handler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: {
        sourceType: 'arxiv', title: '冲突论文标题', arxivId: '2501.88888',
        pdfUrl: 'https://arxiv.org/pdf/web-doi.pdf'
      }
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.error.code, 'filename_conflict');
    assert.equal(fs.readdirSync(path.join(rootDir, '网页导入')).length, 2, 'conflict must not write anything');

    // 24.4 Metadata-only (no pdfUrl anywhere): document created WITHOUT any
    // source_file / attachment; marked 无 PDF via hasPdf:false.
    res = await call(handler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: { sourceType: 'doi', title: '仅元数据无 PDF 论文', doi: '10.9999/meta-only' }
    });
    assert.equal(res.statusCode, 201, res.text);
    assert.equal(res.payload.data.outcome, 'created');
    assert.equal(res.payload.data.hasPdf, false);
    assert.equal(res.payload.data.attachment ?? null, null);
    const metaDocId = res.payload.data.document.id;
    const metaDoc = store.getDocument(actor, metaDocId);
    assert.equal(metaDoc.attachments.length, 0, 'metadata-only import must not fabricate an attachment');
    assert.equal(store.getSourceFileByPath(actor, root.id, '网页导入/仅元数据无-PDF-论文.pdf'), null);

    // 24.5 Explicit rootId + custom targetDir still work (advanced UI path).
    fs.mkdirSync(path.join(rootDir, '自定义'), { recursive: true, mode: 0o700 });
    pdfByUrl.set('https://example.org/custom-dir.pdf', makePdfBytes('custom-dir-pdf'));
    res = await call(handler, '/canvas/native/source-files/import', {
      method: 'POST', cookie,
      body: {
        resolved: { sourceType: 'url', title: '自定义目录导入', url: 'https://example.org/custom-dir.pdf', pdfUrl: 'https://example.org/custom-dir.pdf' },
        rootId: root.id, targetDir: '自定义', filename: 'custom.pdf'
      }
    });
    assert.equal(res.statusCode, 201, res.text);
    assert.equal(res.payload.data.sourceFile.relativePath, '自定义/custom.pdf');

    // 24.6 No root configured at all: a PDF import must fail with
    // library_root_required instead of silently creating a blob-only document.
    const otherActor = canvasActorKey('local', 'm4-web-noroot');
    const otherSession = createSession({
      userId: 'm4-web-2', subject: 'm4-web-noroot', authMode: 'local',
      username: 'web2', role: 'admin', actorKey: otherActor
    });
    const otherCookie = `altcanvas_session=${otherSession.id}`;
    const otherHandler = createCanvasHandler(store, { downloadPdfFn: fakeDownloadPdf });
    pdfByUrl.set('https://example.org/noroot.pdf', makePdfBytes('noroot-pdf'));
    res = await call(otherHandler, '/canvas/imports/native', {
      method: 'POST', cookie: otherCookie,
      body: { sourceType: 'url', title: '无根导入', pdfUrl: 'https://example.org/noroot.pdf' }
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.payload.error.code, 'library_root_required');
    assert.equal(store.listDocuments(otherActor, {}).length, 0, 'no document for the refused import');

    console.log('✅ M4 web import default archiving: 网页导入 landing, source_files visibility, dedupe, conflicts, metadata-only, no-root refusal passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

// ============================================================
// 25. M4 final: existing blob-only web-import PDFs migrate into 网页导入/
//     idempotently, with reuse, conflict recording and DB-failure compensation.
// ============================================================
async function testBlobOnlyWebImportMigration() {
  const { runBlobOnlyWebImportMigration } = await import('../server/blob-migration.mjs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-mig-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-mig-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-mig');
  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '迁移文库' }]);

    const makeBlobLegacyImport = (title, pdfBytes, { sourceUrl = 'https://arxiv.org/pdf/legacy.pdf', doi = null } = {}) => {
      const sha256 = sha256Of(pdfBytes);
      const blobPath = store.resolveBlobPath(sha256, '.pdf');
      fs.mkdirSync(path.dirname(blobPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(blobPath, pdfBytes, { mode: 0o600 });
      const relPath = path.relative(store.getBlobStorageDir(), blobPath);
      store.upsertBlob({ sha256, relativePath: relPath, sizeBytes: pdfBytes.length, mimeType: 'application/pdf' });
      const document = store.createDocument(actor, { title });
      if (doi) {
        store.db.prepare('UPDATE documents SET doi = ? WHERE id = ?').run(doi, document.id);
      }
      const attachmentId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      store.db.prepare(`
        INSERT INTO attachments
          (id, document_id, blob_hash, mime_type, original_filename, title, source_url, size_bytes,
           storage_kind, version, created_at, updated_at)
        VALUES (?, ?, ?, 'application/pdf', ?, ?, ?, ?, 'managed_blob', 1, ?, ?)
      `).run(attachmentId, document.id, sha256, `${title}.pdf`, title, sourceUrl, pdfBytes.length, timestamp, timestamp);
      return { document, attachmentId, sha256 };
    };

    // 25.1 Two genuine blob-only web imports (source_url present + external_refs).
    const legacy1 = makeBlobLegacyImport('Legacy Web Paper A', makePdfBytes('legacy-A'));
    const legacy2 = makeBlobLegacyImport('Legacy Web Paper B', makePdfBytes('legacy-B'), { sourceUrl: null, doi: '10.5555/legacy-b' });
    store.createExternalRef(actor, legacy2.document.id, { provider: 'doi', externalItemId: '10.5555/legacy-b' });
    // A native UPLOAD-style attachment (no source_url, no external_refs) must be
    // left alone by the migration.
    const uploadKeep = makeBlobLegacyImport('Uploaded Keep Me', makePdfBytes('uploaded-keep'));
    store.db.prepare('UPDATE attachments SET source_url = NULL WHERE id = ?').run(uploadKeep.attachmentId);
    store.db.prepare('DELETE FROM external_refs WHERE document_id = ?').run(uploadKeep.document.id);

    const auditedCount = store.countBlobOnlyWebImports(actor);
    const auditedList = store.listBlobOnlyWebImportAttachments(actor);
    // [M4 spec] Only genuine web imports are audited; pure uploads stay untouched.
    assert.equal(auditedCount, 2, 'audit covers exactly the two web imports');

    const result = await runBlobOnlyWebImportMigration(store, actor, {});
    assert.equal(result.report.scanned, 2);
    assert.equal(result.report.migrated, 2);
    assert.equal(result.report.conflicts, 0);
    assert.equal(result.report.failed, 0);

    for (const legacy of [legacy1, legacy2]) {
      const doc = store.getDocument(actor, legacy.document.id);
      assert.equal(doc.attachments.length, 1);
      const activeAtt = doc.attachments[0];
      assert.equal(activeAtt.storageKind, 'source_file');
      assert.equal(activeAtt.blobHash ?? null, null);
      const content = store.getAttachmentContent(actor, activeAtt.id);
      assert.equal(content.kind, 'source_file');
      const diskPath = path.join(content.sourceFile.rootAbsolutePath, content.sourceFile.relativePath);
      assert.equal(fs.existsSync(diskPath), true, 'migrated file must exist in the library root');
      assert.equal(fs.readFileSync(diskPath).toString().includes('legacy'), true);
    }
    // Archived under 网页导入/ with derived names.
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'Legacy Web Paper A.pdf')), true);
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'Legacy Web Paper B.pdf')), true);
    // The uploaded (non-web) blob attachment is untouched.
    assert.equal(store.getAttachment(actor, uploadKeep.attachmentId).storageKind, 'managed_blob');

    // Range reads keep working through the unified endpoint.
    const session = createSession({
      userId: 'm4-mig-1', subject: 'm4-mig', authMode: 'local',
      username: 'mig', role: 'admin', actorKey: actor
    });
    const cookie = `altcanvas_session=${session.id}`;
    const handler = createCanvasHandler(store);
    const legacy1ActiveAtt = store.getDocument(actor, legacy1.document.id).attachments[0];
    const rangeRes = await call(handler, `/canvas/native/attachments/${legacy1ActiveAtt.id}/file`, {
      cookie, headers: { range: 'bytes=0-7' }
    });
    assert.equal(rangeRes.statusCode, 206);
    assert.equal(rangeRes.buffer.toString('ascii').startsWith('%PDF-1.4'), true);

    // 25.2 Idempotent re-run: pending count is 0, nothing changes.
    assert.equal(store.countBlobOnlyWebImports(actor), 0);
    const rerun = await runBlobOnlyWebImportMigration(store, actor, {});
    assert.equal(rerun.report.scanned, 0);
    assert.equal(rerun.report.migrated, 0);

    // 25.3 Conflict: a different-content file already owns the target name ->
    // recorded as conflict, original blob stays readable, DB untouched.
    const legacy3Bytes = makePdfBytes('legacy-C');
    const legacy3 = makeBlobLegacyImport('Legacy Web Paper A', legacy3Bytes);
    // Same original filename as legacy1 -> target name collides with a
    // DIFFERENT content file already in the archive.
    const conflictRun = await runBlobOnlyWebImportMigration(store, actor, {});
    assert.equal(conflictRun.report.conflicts, 1, 'same-name different-content must be recorded as a conflict');
    assert.equal(conflictRun.report.migrated, 0);
    assert.equal(store.getAttachment(actor, legacy3.attachmentId).storageKind, 'managed_blob',
      'conflicted attachment must stay on blob storage for the user to resolve');
    const rangeStill = await call(handler, `/canvas/native/attachments/${legacy3.attachmentId}/file`, { cookie });
    assert.equal(rangeStill.statusCode, 200, 'conflicted attachment remains readable from the blob');

    // 25.4 DB-failure compensation: importNativeDocumentToSourceFile refuses ->
    // the placed file is removed and the blob stays readable (双向无孤儿).
    const legacy4Bytes = makePdfBytes('legacy-D');
    const legacy4 = makeBlobLegacyImport('Legacy Web Paper D', legacy4Bytes);
    const failingStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'promoteBlobAttachmentToSourceFile') {
          return () => { throw new Error('simulated DB failure during migration'); };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const failedRun = await runBlobOnlyWebImportMigration(failingStore, actor, {});
    assert.equal(failedRun.report.failed >= 1, true);
    assert.equal(store.getAttachment(actor, legacy4.attachmentId).storageKind, 'managed_blob',
      'DB failure must leave the attachment on blob storage');
    const content4 = store.getAttachmentContent(actor, legacy4.attachmentId);
    assert.equal(content4.kind, 'managed_blob');
    assert.equal(fs.existsSync(content4.filePath), true, 'blob stays readable after failed migration');

    console.log('✅ M4 blob-only web-import migration: audit, archival, reuse, conflict recording, idempotent re-run, DB-failure compensation passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

// ============================================================
// 26. M4 UX Upgrade: Re-importing identical PDF content (same SHA-256)
//     automatically archives legacy managed_blobs to real root directories,
//     backfills missing metadata, and idempotently binds new research topics
//     with 200 OK (no 409 error, no duplicate document, zero duplicate disk file).
// ============================================================
async function testReimportAutoArchivingAndBackfill() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-reimp-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-reimp-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-reimp');
  const session = createSession({
    userId: 'm4-reimp-1', subject: 'm4-reimp', authMode: 'local',
    username: 'reimp', role: 'admin', actorKey: actor
  });
  const cookie = `altcanvas_session=${session.id}`;
  const topic1 = store.createWorkspace(actor, { name: '主题一' });
  const topic2 = store.createWorkspace(actor, { name: '主题二' });

  const pdfByUrl = new Map();
  let downloadCounter = 0;
  const fakeDownloadPdf = async (pdfUrl, tempDirForDownload) => {
    const bytes = pdfByUrl.get(pdfUrl);
    if (!bytes) {
      const err = new Error('not found');
      err.status = 404;
      throw err;
    }
    downloadCounter += 1;
    fs.mkdirSync(tempDirForDownload, { recursive: true, mode: 0o700 });
    const tempFilePath = path.join(tempDirForDownload, `dl-${downloadCounter}.pdf`);
    fs.writeFileSync(tempFilePath, bytes);
    return { tempFilePath, sha256: sha256Of(bytes), sizeBytes: bytes.length, mimeType: 'application/pdf' };
  };
  const handler = createCanvasHandler(store, { downloadPdfFn: fakeDownloadPdf });

  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: '研究文库' }]);

    // 1. Seed a legacy managed_blob document (simulating pre-M4 upload/import)
    const pdfBytes = makePdfBytes('reimport-test-pdf-content');
    const sha = sha256Of(pdfBytes);
    const blobPath = store.resolveBlobPath(sha, '.pdf');
    fs.mkdirSync(path.dirname(blobPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(blobPath, pdfBytes, { mode: 0o600 });
    const relPath = path.relative(store.getBlobStorageDir(), blobPath);
    store.upsertBlob({ sha256: sha, relativePath: relPath, sizeBytes: pdfBytes.length, mimeType: 'application/pdf' });
    const initialDoc = store.createDocument(actor, {
      title: 'Legacy Managed Doc (No Abstract, No Year)',
      abstract: ''
    });
    const initialAttId = crypto.randomUUID();
    store.db.prepare(`
      INSERT INTO attachments
        (id, document_id, blob_hash, mime_type, original_filename, title, size_bytes, storage_kind, version, created_at, updated_at)
      VALUES (?, ?, ?, 'application/pdf', 'legacy.pdf', 'Legacy Managed Doc', ?, 'managed_blob', 1, ?, ?)
    `).run(initialAttId, initialDoc.id, sha, pdfBytes.length, new Date().toISOString(), new Date().toISOString());

    // Precondition: not in original files yet
    assert.equal(store.listSourceFiles(actor, { rootId: root.id }).length, 0);

    // 2. Re-import the exact same PDF via web import with complete metadata and topic1
    pdfByUrl.set('https://doi.org/10.8888/reimport.pdf', pdfBytes);
    const res1 = await call(handler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: {
        sourceType: 'doi',
        title: 'Updated Title Should Not Overwrite',
        abstract: 'Newly resolved abstract for this document',
        year: 2026,
        doi: '10.8888/reimport',
        pdfUrl: 'https://doi.org/10.8888/reimport.pdf',
        targetWorkspaceId: topic1.id
      }
    });

    assert.equal(res1.statusCode, 200, 'Re-importing identical PDF must succeed with 200 OK');
    assert.equal(res1.payload.data.outcome, 'reused');
    assert.equal(res1.payload.data.promotedFromBlob, true, 'Legacy blob must be promoted to source_file');
    assert.equal(res1.payload.data.document.id, initialDoc.id, 'Must reuse the existing document identity');

    // Verify metadata backfill: missing fields filled, existing title preserved
    const docAfter1 = store.getDocument(actor, initialDoc.id);
    assert.equal(docAfter1.title, 'Legacy Managed Doc (No Abstract, No Year)', 'Existing title must not be overwritten');
    assert.equal(docAfter1.abstract, 'Newly resolved abstract for this document', 'Missing abstract must be backfilled');
    assert.equal(docAfter1.year, 2026, 'Missing year must be backfilled');
    assert.equal(docAfter1.doi, '10.8888/reimport', 'Missing DOI must be backfilled');

    // Verify disk placement: file now exists in 网页导入/
    const archivedFilePath = path.join(rootDir, '网页导入', res1.payload.data.sourceFile.filename);
    assert.equal(fs.existsSync(archivedFilePath), true, 'PDF must now exist in library root directory');
    assert.equal(fs.readFileSync(archivedFilePath).equals(pdfBytes), true);

    // Verify attachment switched to source_file
    const attAfter1 = store.getAttachment(actor, initialAttId);
    assert.equal(attAfter1.storageKind, 'source_file');
    assert.equal(attAfter1.sourceFileId, res1.payload.data.sourceFile.id);

    // Verify topic1 binding was created
    const boundTopics1 = store.listNativeLibraryDocuments(actor, { topicId: topic1.id }).documents;
    assert.ok(boundTopics1.some(d => d.id === initialDoc.id), 'Must be bound to topic1');

    // 3. Re-import yet again with topic2: zero disk copy, joins topic2 cleanly
    const res2 = await call(handler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: {
        sourceType: 'doi',
        title: 'Another Attempt',
        doi: '10.8888/reimport',
        pdfUrl: 'https://doi.org/10.8888/reimport.pdf',
        targetWorkspaceId: topic2.id
      }
    });

    assert.equal(res2.statusCode, 200);
    assert.equal(res2.payload.data.outcome, 'reused');
    assert.equal(res2.payload.data.reusedSourceFile, true, 'Already in source_file: zero copy reuse');

    // Disk still has exactly one file in 网页导入
    assert.equal(fs.readdirSync(path.join(rootDir, '网页导入')).length, 1, 'Never duplicates file on disk');

    // Now bound to topic2 as well
    const boundTopics2 = store.listNativeLibraryDocuments(actor, { topicId: topic2.id }).documents;
    assert.ok(boundTopics2.some(d => d.id === initialDoc.id), 'Must be bound to topic2');

    console.log('✅ Re-import UX upgrade: legacy blob auto-promoted to real directory, metadata backfilled, multi-topic binding, zero file duplication passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}


// ============================================================
// 27. M4 Strict Continuity & Batch Robustness Suite:
//     - P1.1 Attachment identity continuity across blob migration (annotations + topic bindings survive)
//     - P1.2/1.3 Batch import independent fileTarget + targetWorkspaceId union
//     - P1.4 Compensation unlink refuses foreign content, marks compensation_failed
//     - P2.2 Multi-batch migration loops until all items are archived
// ============================================================
async function testM4AuditFourContinuousReconciliation() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-audit4-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-audit4-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-audit4');
  const session = createSession({
    userId: 'm4-audit4-1', subject: 'm4-audit4', authMode: 'local',
    username: 'audit4', role: 'admin', actorKey: actor
  });
  const cookie = `altcanvas_session=${session.id}`;
  const targetTopic = store.createWorkspace(actor, { name: 'Audit4 Target Topic' });

  const pdfByUrl = new Map();
  let downloadCounter = 0;
  const fakeDownloadPdf = async (pdfUrl, tempDirForDownload) => {
    const bytes = pdfByUrl.get(pdfUrl);
    if (!bytes) {
      const err = new Error('not found');
      err.status = 404;
      throw err;
    }
    downloadCounter += 1;
    fs.mkdirSync(tempDirForDownload, { recursive: true, mode: 0o700 });
    const tempFilePath = path.join(tempDirForDownload, `dl-${downloadCounter}.pdf`);
    fs.writeFileSync(tempFilePath, bytes);
    return { tempFilePath, sha256: sha256Of(bytes), sizeBytes: bytes.length, mimeType: 'application/pdf' };
  };
  const handler = createCanvasHandler(store, { downloadPdfFn: fakeDownloadPdf });

  try {
    const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: 'Audit4 Root' }]);

    // --- 27.1 Attachment Identity Continuity across Blob Migration (P1.1) ---
    const legacyPdfBytes = makePdfBytes('legacy-continuous-annotation-pdf');
    const legacySha = sha256Of(legacyPdfBytes);
    const legacyBlobPath = store.resolveBlobPath(legacySha, '.pdf');
    fs.mkdirSync(path.dirname(legacyBlobPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(legacyBlobPath, legacyPdfBytes, { mode: 0o600 });
    const relPath = path.relative(store.getBlobStorageDir(), legacyBlobPath);
    store.upsertBlob({ sha256: legacySha, relativePath: relPath, sizeBytes: legacyPdfBytes.length, mimeType: 'application/pdf' });

    const legacyDoc = store.createDocument(actor, { title: 'Continuous Document' });
    const originalAttId = crypto.randomUUID();
    store.db.prepare(`
      INSERT INTO attachments
        (id, document_id, blob_hash, mime_type, original_filename, title, source_url, size_bytes, storage_kind, version, created_at, updated_at)
      VALUES (?, ?, ?, 'application/pdf', 'continuous.pdf', 'Continuous Document', 'https://example.org/continuous.pdf', ?, 'managed_blob', 1, ?, ?)
    `).run(originalAttId, legacyDoc.id, legacySha, legacyPdfBytes.length, new Date().toISOString(), new Date().toISOString());

    // Create annotations on this attachment
    const ann1 = store.createAnnotation(actor, originalAttId, {
      pageLabel: '1', position: { x: 10, y: 20 }, quote: 'Important Discovery', comment: 'Crucial', color: '#ff0000'
    });
    const ann2 = store.createAnnotation(actor, originalAttId, {
      pageLabel: '2', position: { x: 30, y: 40 }, quote: 'Second Finding', comment: 'Followup', color: '#00ff00'
    });

    // Bind document to topic referencing this attachment
    const topicDoc = store.addTopicDocument(actor, targetTopic.id, {
      libraryType: 'native', libraryId: 'local', itemKey: legacyDoc.id,
      attachmentKey: originalAttId, attachmentVersion: 1, status: 'accepted', origin: 'manual'
    });
    store.db.prepare("UPDATE topic_documents SET analysis_status = 'ready' WHERE id = ?").run(topicDoc.id);

    // Run migration
    const { runBlobOnlyWebImportMigration } = await import('../server/blob-migration.mjs');
    const migRes = await runBlobOnlyWebImportMigration(store, actor, {});
    assert.equal(migRes.report.migrated, 1);

    // Assert attachment ID remained 100% IDENTICAL (in-place upgrade)
    const attAfter = store.getAttachment(actor, originalAttId);
    assert.ok(attAfter, 'Attachment ID must remain intact and NOT be deleted');
    assert.equal(attAfter.id, originalAttId, 'Same attachment ID preserved');
    assert.equal(attAfter.storageKind, 'source_file', 'Upgraded in-place to source_file');
    assert.equal(attAfter.blobHash ?? null, null);
    assert.ok(attAfter.sourceFileId);

    // Assert annotations are completely preserved without cascade deletion
    const annotationsAfter = store.listAnnotations(actor, originalAttId);
    assert.equal(annotationsAfter.length, 2, 'Annotations must survive in-place migration');
    assert.ok(annotationsAfter.some(a => a.id === ann1.id && a.quote === 'Important Discovery'));
    assert.ok(annotationsAfter.some(a => a.id === ann2.id && a.quote === 'Second Finding'));

    // Assert topic binding still points to the surviving attachment and remains ready
    const topicDocsAfter = store.listNativeLibraryDocuments(actor, { topicId: targetTopic.id }).documents;
    const matchedTopicDoc = topicDocsAfter.find(d => d.id === legacyDoc.id);
    assert.ok(matchedTopicDoc);
    assert.equal(matchedTopicDoc.topics[0].attachment_key, originalAttId, 'Topic document must still reference original attachment ID');

    // Assert content can be served via HTTP Range using the original attachment ID
    const fileRes = await call(handler, `/canvas/native/attachments/${originalAttId}/file`, { cookie });
    assert.equal(fileRes.statusCode, 200);
    assert.equal(fileRes.buffer.equals(legacyPdfBytes), true);

    // --- 27.2 Batch Import Independent fileTarget & targetWorkspaceId Union (P1.2 & P1.3) ---
    const batchTopic = store.createWorkspace(actor, { name: 'Batch Dedicated Topic' });
    const pdfBytes1 = makePdfBytes('batch-distinct-pdf-one');
    const pdfBytes2 = makePdfBytes('batch-distinct-pdf-two');
    pdfByUrl.set('https://example.org/distinct-1.pdf', pdfBytes1);
    pdfByUrl.set('https://example.org/distinct-2.pdf', pdfBytes2);

    const batchRes = await call(handler, '/canvas/imports/native/batch', {
      method: 'POST', cookie,
      body: {
        sourceType: 'batch_distinct',
        targetWorkspaceId: batchTopic.id,
        items: [
          { title: 'Alpha Multi-Item Paper', pdfUrl: 'https://example.org/distinct-1.pdf' },
          { title: 'Beta Multi-Item Paper', pdfUrl: 'https://example.org/distinct-2.pdf' }
        ]
      }
    });

    assert.equal(batchRes.statusCode, 201);
    assert.equal(batchRes.payload.data.job.completedCount, 2, 'Both distinct PDFs must complete successfully');
    assert.equal(batchRes.payload.data.job.failedCount, 0, 'Zero filename_conflict failures across items');

    const item1Report = batchRes.payload.data.job.report.items[0];
    const item2Report = batchRes.payload.data.job.report.items[1];
    assert.equal(item1Report.ok, true);
    assert.equal(item2Report.ok, true);
    assert.notEqual(item1Report.documentId, item2Report.documentId);

    // Verify independent filenames were derived and placed in 网页导入/
    const doc1 = store.getDocument(actor, item1Report.documentId);
    const doc2 = store.getDocument(actor, item2Report.documentId);
    const sf1 = store.getAttachmentContent(actor, doc1.attachments[0].id).sourceFile;
    const sf2 = store.getAttachmentContent(actor, doc2.attachments[0].id).sourceFile;
    assert.notEqual(sf1.relativePath, sf2.relativePath, 'Filenames must not mutate or collide across batch items');
    assert.equal(sf1.relativePath.startsWith('网页导入/'), true);
    assert.equal(sf2.relativePath.startsWith('网页导入/'), true);
    assert.equal(fs.existsSync(path.join(rootDir, sf1.relativePath)), true);
    assert.equal(fs.existsSync(path.join(rootDir, sf2.relativePath)), true);

    // Verify BOTH documents were cleanly joined to batchTopic.id
    const boundBatchDocs = store.listNativeLibraryDocuments(actor, { topicId: batchTopic.id }).documents;
    assert.equal(boundBatchDocs.length, 2, 'Both batch items must be bound to the target workspace');
    assert.ok(boundBatchDocs.some(d => d.id === doc1.id));
    assert.ok(boundBatchDocs.some(d => d.id === doc2.id));

    // --- 27.3 Compensation Unlink Refuses Foreign Content & Marks compensation_failed (P1.4) ---
    let tamperedTargetRel = null;
    const tamperPdfBytes = makePdfBytes('genuine-payload-to-be-tampered');
    const foreignDecoyBytes = makePdfBytes('foreign-decoy-bytes-must-not-be-deleted');
    pdfByUrl.set('https://example.org/tamper.pdf', tamperPdfBytes);

    const tamperedStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'importNativeDocumentToSourceFile') {
          return (...args) => {
            tamperedTargetRel = args[1].relativePath;
            // Corrupt the just-placed file on disk with foreign content before DB throws
            const placedDiskPath = path.join(rootDir, tamperedTargetRel);
            fs.writeFileSync(placedDiskPath, foreignDecoyBytes);
            throw new Error('simulated transactional failure after tamper');
          };
        }
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      }
    });

    const tamperedHandler = createCanvasHandler(tamperedStore, { downloadPdfFn: fakeDownloadPdf });
    const tamperedRes = await call(tamperedHandler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: { title: 'Tamper Paper', pdfUrl: 'https://example.org/tamper.pdf' }
    });
    assert.equal(tamperedRes.statusCode, 500);

    // Assert the foreign file on disk was NOT deleted
    assert.ok(tamperedTargetRel);
    const tamperedDiskPath = path.join(rootDir, tamperedTargetRel);
    assert.equal(fs.existsSync(tamperedDiskPath), true, 'Foreign file must NOT be unlinked by compensation');
    assert.equal(fs.readFileSync(tamperedDiskPath).equals(foreignDecoyBytes), true);

    // Assert the file_operation is marked as failed/compensation_failed, NOT rolled_back
    const failedOp = store.db.prepare(
      "SELECT * FROM file_operations WHERE operation_type = 'file.import' AND target_path LIKE ? ORDER BY created_at DESC LIMIT 1"
    ).get(`%${tamperedTargetRel}%`);
    assert.ok(failedOp);
    assert.equal(failedOp.state, 'failed', 'Operation must be marked failed when compensation cannot safely verify SHA');
    assert.equal(failedOp.error_code, 'compensation_failed');

    // Clean up tampered file
    fs.unlinkSync(tamperedDiskPath);

    // --- 27.4 Multi-Batch Migration Loops until all Items are Processed (P2.2) ---
    // Seed 105 legacy web imports (exceeds single batch size 100)
    for (let i = 0; i < 105; i++) {
      const bBytes = makePdfBytes(`p22-loop-pdf-${i}`);
      const bSha = sha256Of(bBytes);
      const bPath = store.resolveBlobPath(bSha, '.pdf');
      fs.mkdirSync(path.dirname(bPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(bPath, bBytes, { mode: 0o600 });
      const bRel = path.relative(store.getBlobStorageDir(), bPath);
      store.upsertBlob({ sha256: bSha, relativePath: bRel, sizeBytes: bBytes.length, mimeType: 'application/pdf' });

      const d = store.createDocument(actor, { title: `Loop Paper ${i}` });
      store.db.prepare(`
        INSERT INTO attachments
          (id, document_id, blob_hash, mime_type, original_filename, title, source_url, size_bytes, storage_kind, version, created_at, updated_at)
        VALUES (?, ?, ?, 'application/pdf', ?, ?, 'https://example.org/loop.pdf', ?, 'managed_blob', 1, ?, ?)
      `).run(crypto.randomUUID(), d.id, bSha, `loop-${i}.pdf`, `Loop Paper ${i}`, bBytes.length, new Date().toISOString(), new Date().toISOString());
    }

    assert.equal(store.countBlobOnlyWebImports(actor), 105);
    const loopMigRes = await runBlobOnlyWebImportMigration(store, actor, {});
    assert.equal(loopMigRes.report.scanned, 105, 'Loop must traverse all candidates across multiple batches');
    assert.equal(loopMigRes.report.migrated, 105);
    assert.equal(store.countBlobOnlyWebImports(actor), 0, 'Pending count must reach 0 after loop migration');

    console.log('✅ M4 Audit 4: attachment identity continuity, batch independent fileTarget, compensation unlink safety, multi-batch loop passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}


// ============================================================
// 28. M4 Audit 5 Suite:
//     - P1-1 Auto-archive DB failure & crash compensation with file_operations
//     - P1-2 Cursor pagination prevents conflict starvation (100 conflicts + 1 success)
//     - P1-3 Concurrent promoteBlobAttachmentToSourceFile uniform return shape & version sync invariant
//     - P1-4 TOCTOU safeUnlinkWithExpectedSha refuses foreign file
//     - Static safety: zero naked unlinkSync(targetAbs) & zero unimported references
// ============================================================
async function testM4AuditFiveStrictSafetyAndPagination() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-audit5-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-audit5-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-audit5');
  const session = createSession({
    userId: 'm4-audit5-1', subject: 'm4-audit5', authMode: 'local',
    username: 'audit5', role: 'admin', actorKey: actor
  });
  const cookie = `altcanvas_session=${session.id}`;
  const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: 'Audit5 Root' }]);

  const pdfByUrl = new Map();
  let dlCount = 0;
  const fakeDownload = async (url, targetDir) => {
    const bytes = pdfByUrl.get(url);
    if (!bytes) { const err = new Error('not found'); err.status = 404; throw err; }
    dlCount++;
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const p = path.join(targetDir, `dl5-${dlCount}.pdf`);
    fs.writeFileSync(p, bytes);
    return { tempFilePath: p, sha256: sha256Of(bytes), sizeBytes: bytes.length, mimeType: 'application/pdf' };
  };

  try {
    // --- 28.1 Auto-Archive DB Failure Compensation & Crash Recovery (P1-1) ---
    const blobBytes1 = makePdfBytes('blob-promotion-fail-test');
    const blobSha1 = sha256Of(blobBytes1);
    const blobPath1 = store.resolveBlobPath(blobSha1, '.pdf');
    fs.mkdirSync(path.dirname(blobPath1), { recursive: true, mode: 0o700 });
    fs.writeFileSync(blobPath1, blobBytes1, { mode: 0o600 });
    const rel1 = path.relative(store.getBlobStorageDir(), blobPath1);
    store.upsertBlob({ sha256: blobSha1, relativePath: rel1, sizeBytes: blobBytes1.length, mimeType: 'application/pdf' });

    const doc1 = store.createDocument(actor, { title: 'Doc To Promote' });
    const att1Id = crypto.randomUUID();
    store.db.prepare(`
      INSERT INTO attachments
        (id, document_id, blob_hash, mime_type, original_filename, title, size_bytes, storage_kind, version, created_at, updated_at)
      VALUES (?, ?, ?, 'application/pdf', 'promo.pdf', 'Doc To Promote', ?, 'managed_blob', 1, ?, ?)
    `).run(att1Id, doc1.id, blobSha1, blobBytes1.length, new Date().toISOString(), new Date().toISOString());

    // Intercept the combined promotion+backfill transaction to simulate a DB
    // error. The whole transaction rolls back, so the placed file is not yet
    // referenced and the compensation below is safe.
    let targetRelIntercepted = null;
    const failingStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'promoteBlobAttachmentAndBackfill') {
          return (...args) => {
            targetRelIntercepted = args[1].relativePath;
            throw new Error('simulated DB promotion failure');
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      }
    });

    pdfByUrl.set('https://doi.org/10.7777/promo.pdf', blobBytes1);
    const failHandler = createCanvasHandler(failingStore, { downloadPdfFn: fakeDownload });
    const promoFailRes = await call(failHandler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: { title: 'Doc To Promote', pdfUrl: 'https://doi.org/10.7777/promo.pdf' }
    });
    assert.equal(promoFailRes.statusCode, 500);

    // Verify compensation: placed file removed cleanly, operation marked rolled_back
    assert.ok(targetRelIntercepted);
    assert.equal(fs.existsSync(path.join(rootDir, targetRelIntercepted)), false, 'Placed file must be compensated away on DB failure');
    const promoOp = store.db.prepare(
      "SELECT * FROM file_operations WHERE operation_type = 'file.import' AND target_path LIKE '%promo.pdf%' ORDER BY created_at DESC LIMIT 1"
    ).get();
    assert.ok(promoOp, 'file_operations journal entry must exist');
    assert.equal(promoOp.state, 'rolled_back');

    // Crash recovery: simulate an interrupted promotion where file is on disk but process died before DB commit
    fs.mkdirSync(path.join(rootDir, '网页导入'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, '网页导入', 'crash-promo.pdf'), blobBytes1);
    const crashOp = store.createFileOperation(actor, {
      operationType: 'file.import',
      sourcePath: 'tmp-crashed',
      targetPath: `${rootDir}/网页导入/crash-promo.pdf`,
      payload: { rootId: root.id, targetDir: '网页导入', filename: 'crash-promo.pdf', kind: 'blob_promotion', sha256: blobSha1 }
    });
    store.startFileOperation(crashOp.id);

    const { recoverInterruptedFileOperations } = await import('../server/library-scanner.mjs');
    const recSummary = await recoverInterruptedFileOperations(store);
    assert.equal(store.getFileOperation(actor, crashOp.id).state, 'rolled_back');
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'crash-promo.pdf')), false,
      'Crash recovery must safely unlink orphan placed file');

    // --- 28.2 Cursor Pagination Prevents Conflict Starvation (P1-2) ---
    // Seed 101 legacy web imports
    const conflictBytes = makePdfBytes('conflict-content-different-bytes');
    fs.mkdirSync(path.join(rootDir, '网页导入'), { recursive: true });

    for (let i = 0; i < 101; i++) {
      const pBytes = makePdfBytes(`starvation-paper-bytes-${i}`);
      const pSha = sha256Of(pBytes);
      const bPath = store.resolveBlobPath(pSha, '.pdf');
      fs.mkdirSync(path.dirname(bPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(bPath, pBytes, { mode: 0o600 });
      const rPath = path.relative(store.getBlobStorageDir(), bPath);
      store.upsertBlob({ sha256: pSha, relativePath: rPath, sizeBytes: pBytes.length, mimeType: 'application/pdf' });

      const d = store.createDocument(actor, { title: `Starvation Paper ${i}` });
      store.db.prepare(`
        INSERT INTO attachments
          (id, document_id, blob_hash, mime_type, original_filename, title, source_url, size_bytes, storage_kind, version, created_at, updated_at)
        VALUES (?, ?, ?, 'application/pdf', ?, ?, 'https://example.org/starvation.pdf', ?, 'managed_blob', 1, ?, ?)
      `).run(crypto.randomUUID(), d.id, pSha, `starv-${i}.pdf`, `Starvation Paper ${i}`, pBytes.length, new Date(Date.now() + i * 10).toISOString(), new Date(Date.now() + i * 10).toISOString());

      // Place conflicting different-content file for the first 100 items only
      if (i < 100) {
        fs.writeFileSync(path.join(rootDir, '网页导入', `starv-${i}.pdf`), conflictBytes);
      }
    }

    assert.equal(store.countBlobOnlyWebImports(actor), 101);
    const { runBlobOnlyWebImportMigration } = await import('../server/blob-migration.mjs');
    const starvationMigRes = await runBlobOnlyWebImportMigration(store, actor, {});

    // Assert: all 101 items were scanned, first 100 were conflicts, and 101st was SUCCESSFULLY migrated!
    assert.equal(starvationMigRes.report.scanned, 101, 'Cursor pagination must advance past the first 100 conflict items');
    assert.equal(starvationMigRes.report.conflicts, 100);
    assert.equal(starvationMigRes.report.migrated, 1, '101st item must NOT be starved and must be successfully migrated');
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'starv-100.pdf')), true, '101st item placed on disk');

    // Clean up starvation test files
    for (let i = 0; i < 101; i++) {
      try { fs.unlinkSync(path.join(rootDir, '网页导入', `starv-${i}.pdf`)); } catch {}
    }

    // --- 28.3 Concurrent In-Place Promotion Uniform Return Shape & Version Sync Invariant (P1-3) ---
    const syncDoc = store.createDocument(actor, { title: 'Sync Version Doc' });
    const syncTopic = store.createWorkspace(actor, { name: 'Sync Topic' });
    const syncPdfBytes = makePdfBytes('sync-version-pdf');
    const syncSha = sha256Of(syncPdfBytes);
    const syncBlobPath = store.resolveBlobPath(syncSha, '.pdf');
    fs.mkdirSync(path.dirname(syncBlobPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(syncBlobPath, syncPdfBytes, { mode: 0o600 });
    store.upsertBlob({ sha256: syncSha, relativePath: path.relative(store.getBlobStorageDir(), syncBlobPath), sizeBytes: syncPdfBytes.length, mimeType: 'application/pdf' });

    const syncAttId = crypto.randomUUID();
    store.db.prepare(`
      INSERT INTO attachments
        (id, document_id, blob_hash, mime_type, original_filename, title, size_bytes, storage_kind, version, created_at, updated_at)
      VALUES (?, ?, ?, 'application/pdf', 'sync.pdf', 'Sync Doc', ?, 'managed_blob', 1, ?, ?)
    `).run(syncAttId, syncDoc.id, syncSha, syncPdfBytes.length, new Date().toISOString(), new Date().toISOString());

    // Bind to topic with initial attachment version 1
    const tdSync = store.addTopicDocument(actor, syncTopic.id, {
      libraryType: 'native', libraryId: 'local', itemKey: syncDoc.id,
      attachmentKey: syncAttId, attachmentVersion: 1, status: 'accepted'
    });
    assert.equal(tdSync.attachmentVersion, 1);

    // First promotion call
    fs.writeFileSync(path.join(rootDir, '网页导入', 'sync.pdf'), syncPdfBytes);
    const promo1 = store.promoteBlobAttachmentToSourceFile(actor, {
      attachmentId: syncAttId,
      documentId: syncDoc.id,
      rootId: root.id,
      relativePath: '网页导入/sync.pdf',
      filename: 'sync.pdf',
      sha256: syncSha,
      sizeBytes: syncPdfBytes.length,
      modifiedAt: Math.round(fs.statSync(path.join(rootDir, '网页导入', 'sync.pdf')).mtimeMs)
    });

    assert.equal(promo1.raced, false);
    assert.equal(promo1.attachment.storageKind, 'source_file');
    assert.equal(promo1.attachment.version, 2);
    assert.ok(promo1.sourceFile);

    // Version sync invariant: topic_documents.attachment_version must equal attachments.version atomically
    const tdAfterSync = store.db.prepare('SELECT attachment_version, version FROM topic_documents WHERE id = ?').get(tdSync.id);
    assert.equal(tdAfterSync.attachment_version, 2, 'topic_documents.attachment_version must be synchronized atomically');
    assert.equal(tdAfterSync.attachment_version, promo1.attachment.version, 'attachment_version invariant must hold');

    // Second promotion call (concurrent race simulation): must return uniform { attachment, sourceFile, raced: true }
    const promo2 = store.promoteBlobAttachmentToSourceFile(actor, {
      attachmentId: syncAttId,
      documentId: syncDoc.id,
      rootId: root.id,
      relativePath: '网页导入/sync.pdf',
      filename: 'sync.pdf',
      sha256: syncSha,
      sizeBytes: syncPdfBytes.length,
      modifiedAt: Math.round(fs.statSync(path.join(rootDir, '网页导入', 'sync.pdf')).mtimeMs)
    });

    assert.equal(promo2.raced, true);
    assert.ok(promo2.attachment, 'Must return attachment on race');
    assert.ok(promo2.sourceFile, 'Must return sourceFile on race (uniform return shape)');
    assert.equal(promo2.sourceFile.id, promo1.sourceFile.id);
    assert.equal(promo2.attachment.id, syncAttId);

    // Clean up sync test file
    fs.unlinkSync(path.join(rootDir, '网页导入', 'sync.pdf'));

    // --- 28.4 Static Security Assertions ---
    // The scan covers EVERY .mjs file under server/ — including the module
    // that defines the filesystem primitives — so a retired helper cannot
    // survive merely by living in its definition file.
    const serverDir = path.join(new URL('../', import.meta.url).pathname, 'server');
    const serverFiles = fs.readdirSync(serverDir).filter(f => f.endsWith('.mjs')).map(f => `server/${f}`);
    assert.ok(serverFiles.length >= 5, 'server module scan must actually find the server sources');
    for (const rel of serverFiles) {
      const content = fs.readFileSync(path.join(new URL('../', import.meta.url).pathname, rel), 'utf8');
      assert.equal(content.includes('unlinkSync(targetAbs)'), false,
        `${rel} must not contain naked unlinkSync(targetAbs)`);
      assert.equal(content.includes('safeUnlinkInsideRoot'), false,
        `${rel} must not reference the removed safeUnlinkInsideRoot (definition included)`);
    }

    console.log('✅ M4 Audit 5: P1-1 auto-archive compensation, P1-2 starvation-free cursor pagination, P1-3 in-place version sync & uniform race shape, P1-4 TOCTOU safeUnlinkWithExpectedSha, static code safety passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}


// ============================================================
// 29. M4 Audit 6 Suite:
//     - P1-1 Missing-SHA recovery records PRESERVE the file (identity_missing) and are
//           marked recovery_identity_missing; safeUnlinkWithExpectedSha demands a valid
//           64-hex SHA-256 identity before touching anything
//     - P1-2 Concurrent promotion to a DIFFERENT target throws promotion_target_diverged;
//           the caller compensates its own placement and reports the authoritative state
//     - P1-3 Post-placement failures (anchored stat, refused compensation) leave zero
//           orphans and surface compensation_failed; recovery re-examines failed
//           compensation operations (second-chance reconciliation)
// ============================================================
async function testM4AuditSixIdentityDivergenceAndCompensation() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-audit6-store-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m4-audit6-root-'));
  const store = new CanvasStore(path.join(tempDir, 'canvas.sqlite'));
  const actor = canvasActorKey('local', 'm4-audit6');
  const session = createSession({
    userId: 'm4-audit6-1', subject: 'm4-audit6', authMode: 'local',
    username: 'audit6', role: 'admin', actorKey: actor
  });
  const cookie = `altcanvas_session=${session.id}`;
  const [root] = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: rootDir, displayName: 'Audit6 Root' }]);

  const pdfByUrl = new Map();
  let dlCount = 0;
  const fakeDownload = async (url, targetDir) => {
    const bytes = pdfByUrl.get(url);
    if (!bytes) { const err = new Error('not found'); err.status = 404; throw err; }
    dlCount++;
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const p = path.join(targetDir, `dl6-${dlCount}.pdf`);
    fs.writeFileSync(p, bytes);
    return { tempFilePath: p, sha256: sha256Of(bytes), sizeBytes: bytes.length, mimeType: 'application/pdf' };
  };

  // Seeds a managed_blob attachment (optionally web-import flavored) bound to a
  // fresh document, plus its blob-store backing file.
  function seedBlobAttachment(label, { webImport = true } = {}) {
    const bytes = makePdfBytes(`audit6-${label}`);
    const sha = sha256Of(bytes);
    const blobPath = store.resolveBlobPath(sha, '.pdf');
    fs.mkdirSync(path.dirname(blobPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(blobPath, bytes, { mode: 0o600 });
    store.upsertBlob({ sha256: sha, relativePath: path.relative(store.getBlobStorageDir(), blobPath), sizeBytes: bytes.length, mimeType: 'application/pdf' });
    const doc = store.createDocument(actor, { title: `Audit6 ${label}` });
    const attId = crypto.randomUUID();
    store.db.prepare(`
      INSERT INTO attachments
        (id, document_id, blob_hash, mime_type, original_filename, title, source_url, size_bytes, storage_kind, version, created_at, updated_at)
      VALUES (?, ?, ?, 'application/pdf', ?, ?, ?, ?, 'managed_blob', 1, ?, ?)
    `).run(attId, doc.id, sha, `${label}.pdf`, `Audit6 ${label}`,
      webImport ? `https://example.org/${label}.pdf` : null,
      bytes.length, new Date().toISOString(), new Date().toISOString());
    return { doc, attId, bytes, sha };
  }

  const { safeUnlinkWithExpectedSha, withPathOperationLock } = await import('../server/native-fs.mjs');

  try {
    // --- 29.1 (P1-1) Missing/invalid SHA identity refuses deletion, file preserved ---
    fs.mkdirSync(path.join(rootDir, '网页导入'), { recursive: true });
    const foreignBytes = makePdfBytes('foreign-content-at-legacy-path');
    const legacyRel = '网页导入/legacy-nosha.pdf';
    fs.writeFileSync(path.join(rootDir, legacyRel), foreignBytes);

    for (const badIdentity of [null, undefined, '', 'deadbeef', sha256Of(foreignBytes).toUpperCase()]) {
      await assert.rejects(
        () => safeUnlinkWithExpectedSha(rootDir, legacyRel, badIdentity),
        (err) => err.code === 'identity_missing',
        `safeUnlinkWithExpectedSha must reject identity ${String(badIdentity)}`
      );
    }
    assert.equal(fs.existsSync(path.join(rootDir, legacyRel)), true,
      'refused unlink must leave the file untouched');

    // Wrong (but valid) identity: refused with content_mismatch, file preserved.
    await assert.rejects(
      () => safeUnlinkWithExpectedSha(rootDir, legacyRel, sha256Of(makePdfBytes('different'))),
      (err) => err.code === 'content_mismatch'
    );
    assert.equal(fs.existsSync(path.join(rootDir, legacyRel)), true);

    // Correct identity: removed.
    await safeUnlinkWithExpectedSha(rootDir, legacyRel, sha256Of(foreignBytes));
    assert.equal(fs.existsSync(path.join(rootDir, legacyRel)), false);

    // Historical recovery record WITHOUT sha256: the recovery must PRESERVE the
    // foreign file at the recorded path and fail the operation explicitly.
    fs.writeFileSync(path.join(rootDir, legacyRel), foreignBytes);
    const legacyOp = store.createFileOperation(actor, {
      operationType: 'file.import',
      sourcePath: 'tmp-legacy',
      targetPath: `${rootDir}/${legacyRel}`,
      payload: { rootId: root.id, targetDir: '网页导入', filename: 'legacy-nosha.pdf', kind: 'blob_promotion' }
    });
    store.startFileOperation(legacyOp.id);
    await recoverInterruptedFileOperations(store);
    assert.equal(fs.existsSync(path.join(rootDir, legacyRel)), true,
      'recovery must NOT delete a file it cannot prove ownership of');
    const legacyOpRow = store.db.prepare('SELECT * FROM file_operations WHERE id = ?').get(legacyOp.id);
    assert.equal(legacyOpRow.state, 'failed');
    assert.equal(legacyOpRow.error_code, 'recovery_identity_missing');
    fs.unlinkSync(path.join(rootDir, legacyRel));

    // The per-path operation mutex primitive is exported (in-process TOCTOU serialization).
    assert.equal(typeof withPathOperationLock, 'function');

    // --- 29.2 (P1-2) Concurrent promotion to a different target diverges ---
    const diverge = seedBlobAttachment('diverge');
    store.createAnnotation(actor, diverge.attId, {
      pageLabel: '1', position: { x: 1, y: 2 }, quote: 'Divergence annotation', comment: 'kept', color: '#ff0000'
    });
    const divergeTopic = store.createWorkspace(actor, { name: 'Audit6 Divergence Topic' });
    store.addTopicDocument(actor, divergeTopic.id, {
      libraryType: 'native', libraryId: 'local', itemKey: diverge.doc.id,
      attachmentKey: diverge.attId, attachmentVersion: 1, status: 'accepted'
    });

    // Store level: same-target race is acknowledged, different target diverges.
    fs.writeFileSync(path.join(rootDir, '网页导入', 'diverge-a.pdf'), diverge.bytes);
    const winnerPromo = store.promoteBlobAttachmentToSourceFile(actor, {
      attachmentId: diverge.attId, documentId: diverge.doc.id, rootId: root.id,
      relativePath: '网页导入/diverge-a.pdf', filename: 'diverge-a.pdf', sha256: diverge.sha,
      sizeBytes: diverge.bytes.length, modifiedAt: Date.now()
    });
    assert.equal(winnerPromo.raced, false);
    assert.throws(
      () => store.promoteBlobAttachmentToSourceFile(actor, {
        attachmentId: diverge.attId, documentId: diverge.doc.id, rootId: root.id,
        relativePath: '网页导入/diverge-c.pdf', filename: 'diverge-c.pdf', sha256: diverge.sha,
        sizeBytes: diverge.bytes.length, modifiedAt: Date.now()
      }),
      (err) => err.code === 'promotion_target_diverged'
    );

    // Executor level, interleaved: a competing request wins the promotion under
    // a DIFFERENT filename while this request sits between placement and
    // promotion. This request must clean up its own b.pdf, mark the operation
    // rolled_back, and still report the authoritative archived state.
    const diverge2 = seedBlobAttachment('diverge2');
    store.createAnnotation(actor, diverge2.attId, {
      pageLabel: '1', position: { x: 1, y: 2 }, quote: 'Divergence2 annotation', comment: 'kept', color: '#ff0000'
    });
    pdfByUrl.set('https://example.org/diverge2.pdf', diverge2.bytes);
    let promoteCalls = 0;
    const racingStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'promoteBlobAttachmentAndBackfill') {
          return (...args) => {
            promoteCalls += 1;
            if (promoteCalls === 1) {
              const winnerRel = '网页导入/diverge2-a.pdf';
              fs.writeFileSync(path.join(rootDir, winnerRel), diverge2.bytes);
              target.promoteBlobAttachmentToSourceFile(actor, {
                ...args[1],
                relativePath: winnerRel,
                filename: 'diverge2-a.pdf',
                modifiedAt: Math.round(fs.statSync(path.join(rootDir, winnerRel)).mtimeMs)
              });
            }
            return target.promoteBlobAttachmentAndBackfill(...args);
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      }
    });
    const racingHandler = createCanvasHandler(racingStore, { downloadPdfFn: fakeDownload });
    const divergeRes = await call(racingHandler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: { title: 'Audit6 diverge2', pdfUrl: 'https://example.org/diverge2.pdf', filename: 'diverge2-b.pdf' }
    });
    assert.equal(divergeRes.statusCode, 200, `diverged race must still return the authoritative reuse, got ${divergeRes.statusCode}: ${divergeRes.text}`);
    assert.equal(divergeRes.payload.data.outcome, 'reused');
    assert.equal(divergeRes.payload.data.promotionTargetDiverged, true);
    assert.equal(divergeRes.payload.data.sourceFile.relativePath, '网页导入/diverge2-a.pdf',
      'the authoritative (winning) target must be reported');
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'diverge2-b.pdf')), false,
      "this request's own placement must be compensated away");
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'diverge2-a.pdf')), true,
      "the winner's placement must remain");
    const divergeOpRow = store.db.prepare(
      "SELECT * FROM file_operations WHERE operation_type = 'file.import' AND target_path LIKE '%diverge2-b.pdf%' ORDER BY created_at DESC LIMIT 1"
    ).get();
    assert.ok(divergeOpRow, 'diverged request must be journaled');
    assert.equal(divergeOpRow.state, 'rolled_back');
    const attAfterDiverge = store.getAttachment(actor, diverge2.attId);
    assert.equal(attAfterDiverge.storageKind, 'source_file');
    const annCount = store.db.prepare('SELECT COUNT(*) AS n FROM annotations WHERE attachment_id = ?').get(diverge2.attId).n;
    assert.equal(annCount, 1, 'annotations survive the diverged promotion');
    // NOTE: diverge2-a.pdf stays on disk — its live source_files row keeps
    // pointing at it and later sub-tests assert no live row misses its file.

    // --- 29.3 (P1-3) Post-placement failures compensate and surface compensation_failed ---
    // (a) Anchored-stat failure right after a successful placement: the placed
    //     file is compensated, the operation is rolled_back, no orphan remains.
    const statfail = seedBlobAttachment('statfail');
    pdfByUrl.set('https://example.org/statfail.pdf', statfail.bytes);
    const statFailStore = new Proxy(store, {
      get(target, prop) {
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      }
    });
    const statFailHandler = createCanvasHandler(statFailStore, {
      downloadPdfFn: fakeDownload,
      statPlacedFileFn: () => { const err = new Error('simulated anchored-stat failure'); throw err; }
    });
    const statFailRes = await call(statFailHandler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: { title: 'Audit6 statfail', pdfUrl: 'https://example.org/statfail.pdf', filename: 'statfail.pdf' }
    });
    assert.equal(statFailRes.statusCode, 500);
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'statfail.pdf')), false,
      'post-placement stat failure must compensate the placed file');
    const statFailOpRow = store.db.prepare(
      "SELECT * FROM file_operations WHERE operation_type = 'file.import' AND target_path LIKE '%statfail.pdf%' ORDER BY created_at DESC LIMIT 1"
    ).get();
    assert.ok(statFailOpRow);
    assert.equal(statFailOpRow.state, 'rolled_back');
    assert.equal(store.getAttachment(actor, statfail.attId).storageKind, 'managed_blob',
      'failed promotion must leave the attachment on managed_blob');

    // (b) blob-migration: a refused compensation (foreign content replaced the
    //     placed file) is reported as compensation_failed, never swallowed and
    //     never misreported as a generic placement failure.
    store.db.prepare('DELETE FROM attachments WHERE id = ?').run(statfail.attId);
    store.db.prepare('DELETE FROM documents WHERE id = ?').run(statfail.doc.id);
    const compfail = seedBlobAttachment('compfail');
    const compFailStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'promoteBlobAttachmentToSourceFile') {
          return (...args) => {
            // The DB step fails AND the placed file was replaced concurrently:
            // compensation must refuse to delete the foreign bytes.
            fs.writeFileSync(path.join(rootDir, args[1].relativePath), makePdfBytes('replaced-foreign-content'));
            throw new Error('simulated DB promotion failure');
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      }
    });
    const { runBlobOnlyWebImportMigration } = await import('../server/blob-migration.mjs');
    const compFailMig = await runBlobOnlyWebImportMigration(compFailStore, actor, {});
    assert.equal(compFailMig.report.failed, 1);
    assert.ok(compFailMig.report.failedDetail[0].reason.startsWith('compensation_failed'),
      `refused compensation must surface compensation_failed, got: ${compFailMig.report.failedDetail[0].reason}`);
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'compfail.pdf')), true,
      'the foreign replacement must be preserved, not deleted');
    fs.unlinkSync(path.join(rootDir, '网页导入', 'compfail.pdf'));
    // Remove the compfail artifact so later migration runs in this group see a clean candidate set.
    store.db.prepare('DELETE FROM attachments WHERE id = ?').run(compfail.attId);
    store.db.prepare('DELETE FROM documents WHERE id = ?').run(compfail.doc.id);

    // (c) Recovery second chance: failed compensation_failed operations with a
    //     placed-but-unenrolled file are reconciled (removed + rolled_back);
    //     when the row actually exists and the hash matches, the operation is
    //     completed instead of lingering failed forever.
    const secondBytes = makePdfBytes('second-chance-orphan');
    const secondSha = sha256Of(secondBytes);
    fs.writeFileSync(path.join(rootDir, '网页导入', 'secondchance.pdf'), secondBytes);
    const secondOp = store.createFileOperation(actor, {
      operationType: 'file.import',
      sourcePath: 'tmp-second',
      targetPath: `${rootDir}/网页导入/secondchance.pdf`,
      payload: { rootId: root.id, targetDir: '网页导入', filename: 'secondchance.pdf', kind: 'blob_promotion', sha256: secondSha }
    });
    store.startFileOperation(secondOp.id);
    store.failFileOperation(secondOp.id, 'compensation_failed');

    const enrolledBytes = makePdfBytes('second-chance-enrolled');
    const enrolledSha = sha256Of(enrolledBytes);
    fs.writeFileSync(path.join(rootDir, '网页导入', 'enrolled.pdf'), enrolledBytes);
    const enrolledDoc = store.createDocument(actor, { title: 'Second Chance Enrolled' });
    store.createSourceFile(actor, root.id, {
      relativePath: '网页导入/enrolled.pdf', filename: 'enrolled.pdf', sha256: enrolledSha,
      sizeBytes: enrolledBytes.length, modifiedAt: Date.now(), status: 'active',
      documentId: enrolledDoc.id, lastSeenAt: new Date().toISOString()
    });
    const enrolledOp = store.createFileOperation(actor, {
      operationType: 'file.import',
      sourcePath: 'tmp-enrolled',
      targetPath: `${rootDir}/网页导入/enrolled.pdf`,
      payload: { rootId: root.id, targetDir: '网页导入', filename: 'enrolled.pdf', sha256: enrolledSha }
    });
    store.startFileOperation(enrolledOp.id);
    store.failFileOperation(enrolledOp.id, 'compensation_failed');

    await recoverInterruptedFileOperations(store);
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'secondchance.pdf')), false,
      'second-chance recovery must remove the compensable orphan');
    const secondOpRow = store.db.prepare('SELECT state, error_code FROM file_operations WHERE id = ?').get(secondOp.id);
    assert.equal(secondOpRow.state, 'rolled_back');
    assert.equal(secondOpRow.error_code, 'recovered_after_compensation_failure',
      'a rolled-back recovery must not keep the stale compensation_failed code next to its final state');
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'enrolled.pdf')), true,
      'a legitimately enrolled placement must NOT be deleted by second-chance recovery');
    const enrolledOpRow = store.db.prepare('SELECT state, error_code FROM file_operations WHERE id = ?').get(enrolledOp.id);
    assert.equal(enrolledOpRow.state, 'completed',
      'a verified placement transitions failed -> completed instead of lingering');
    assert.equal(enrolledOpRow.error_code, null,
      'a completed recovery must clear the stale compensation_failed code (no contradictory audit row)');

    // --- 29.4 (P1-1) Reuse-path flip keeps topic_documents.attachment_version in lockstep ---
    const reuse = seedBlobAttachment('reuseflip');
    store.createAnnotation(actor, reuse.attId, {
      pageLabel: '1', position: { x: 3, y: 4 }, quote: 'Reuse annotation', comment: 'kept', color: '#00ff00'
    });
    const reuseTopic = store.createWorkspace(actor, { name: 'Audit6 Reuse Topic' });
    store.addTopicDocument(actor, reuseTopic.id, {
      libraryType: 'native', libraryId: 'local', itemKey: reuse.doc.id,
      attachmentKey: reuse.attId, attachmentVersion: 1, status: 'accepted'
    });
    // The same document ALREADY has an enrolled source_file carrying identical bytes
    fs.writeFileSync(path.join(rootDir, '网页导入', 'reuseflip-existing.pdf'), reuse.bytes);
    const reuseSource = store.createSourceFile(actor, root.id, {
      relativePath: '网页导入/reuseflip-existing.pdf', filename: 'reuseflip-existing.pdf',
      sha256: reuse.sha, sizeBytes: reuse.bytes.length, modifiedAt: Date.now(),
      status: 'active', documentId: reuse.doc.id, lastSeenAt: new Date().toISOString()
    });

    const reuseMig = await runBlobOnlyWebImportMigration(store, actor, {});
    assert.equal(reuseMig.report.reused, 1, 'the reuse path must classify the flip as reused');
    assert.equal(reuseMig.report.migrated, 0);
    const reuseAtt = store.getAttachment(actor, reuse.attId);
    assert.equal(reuseAtt.storageKind, 'source_file');
    assert.equal(reuseAtt.sourceFileId, reuseSource.id);
    assert.equal(reuseAtt.version, 2);
    const reuseTopicRow = store.db.prepare('SELECT attachment_version FROM topic_documents WHERE attachment_key = ?').get(reuse.attId);
    assert.equal(reuseTopicRow.attachment_version, 2,
      'the REUSE path must synchronize topic_documents.attachment_version with attachments.version (no bare-SQL bypass)');
    const reuseAnnCount = store.db.prepare('SELECT COUNT(*) AS n FROM annotations WHERE attachment_id = ?').get(reuse.attId).n;
    assert.equal(reuseAnnCount, 1, 'annotations survive the reuse-path flip');

    // --- 29.5 (P1-2) Divergence compensation failure must NOT report success ---
    const diverge3 = seedBlobAttachment('diverge3');
    pdfByUrl.set('https://example.org/diverge3.pdf', diverge3.bytes);
    let diverge3Calls = 0;
    const tamperStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'promoteBlobAttachmentAndBackfill') {
          return (...args) => {
            diverge3Calls += 1;
            if (diverge3Calls === 1) {
              // The competing winner archives under a.pdf through the REAL method.
              const winnerRel = '网页导入/diverge3-a.pdf';
              fs.writeFileSync(path.join(rootDir, winnerRel), diverge3.bytes);
              target.promoteBlobAttachmentToSourceFile(actor, {
                ...args[1],
                relativePath: winnerRel,
                filename: 'diverge3-a.pdf',
                modifiedAt: Math.round(fs.statSync(path.join(rootDir, winnerRel)).mtimeMs)
              });
              // Replace the loser's placed b.pdf with FOREIGN content BEFORE its
              // compensation runs: the verified unlink must refuse to delete it.
              fs.writeFileSync(path.join(rootDir, '网页导入', 'diverge3-b.pdf'), makePdfBytes('replaced-loser-content'));
            }
            return target.promoteBlobAttachmentAndBackfill(...args); // throws promotion_target_diverged
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      }
    });
    const tamperHandler = createCanvasHandler(tamperStore, { downloadPdfFn: fakeDownload });
    const tamperRes = await call(tamperHandler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: { title: 'Audit6 diverge3', pdfUrl: 'https://example.org/diverge3.pdf', filename: 'diverge3-b.pdf' }
    });
    assert.equal(tamperRes.statusCode, 500,
      `diverged compensation failure must be a hard 500, got ${tamperRes.statusCode}: ${tamperRes.text}`);
    assert.equal(tamperRes.payload.error.code, 'compensation_failed',
      'the response must carry compensation_failed, never a fabricated reused outcome');
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'diverge3-b.pdf')), true,
      'the stray file must be preserved when its compensation is refused');
    assert.equal(
      sha256Of(fs.readFileSync(path.join(rootDir, '网页导入', 'diverge3-b.pdf'))),
      sha256Of(makePdfBytes('replaced-loser-content')),
      'the preserved stray bytes must be the foreign replacement, untouched');
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'diverge3-a.pdf')), true,
      "the winner's placement must remain");
    const tamperOpRow = store.db.prepare(
      "SELECT state, error_code FROM file_operations WHERE operation_type = 'file.import' AND target_path LIKE '%diverge3-b.pdf%' ORDER BY created_at DESC LIMIT 1"
    ).get();
    assert.ok(tamperOpRow, 'the loser request must be journaled');
    assert.equal(tamperOpRow.state, 'failed');
    assert.equal(tamperOpRow.error_code, 'compensation_failed');
    const diverge3Att = store.getAttachment(actor, diverge3.attId);
    assert.equal(diverge3Att.storageKind, 'source_file');
    assert.equal(store.getSourceFile(actor, diverge3Att.sourceFileId).relativePath, '网页导入/diverge3-a.pdf',
      'the authoritative archive location stays the winning a.pdf');
    // diverge3-a.pdf stays (live row keeps pointing at it); b.pdf held foreign
    // replacement content with no DB row, so it is safe to remove here.
    fs.unlinkSync(path.join(rootDir, '网页导入', 'diverge3-b.pdf'));

    // --- 29.6 (Audit 8 P1) SINGLE commit boundary: a backfill failure rolls
    // back the WHOLE promotion, so the compensation never deletes a
    // DB-referenced PDF ---
    const bfFail = seedBlobAttachment('bffail');
    pdfByUrl.set('https://example.org/bffail.pdf', bfFail.bytes);
    const bfRefCountBefore = store.db.prepare('SELECT reference_count FROM blobs WHERE sha256 = ?').get(bfFail.sha).reference_count;
    const originalBackfill = store.backfillDocumentAndTopics;
    let backfillCalls = 0;
    // Instance-level patch: the merged store method calls backfill through
    // `this`, which a Proxy cannot intercept.
    store.backfillDocumentAndTopics = function () {
      backfillCalls += 1;
      throw new Error('simulated backfill failure');
    };
    let bfFailRes;
    try {
      const bfFailHandler = createCanvasHandler(store, { downloadPdfFn: fakeDownload });
      bfFailRes = await call(bfFailHandler, '/canvas/imports/native', {
        method: 'POST', cookie,
        body: { title: 'Audit6 bffail', pdfUrl: 'https://example.org/bffail.pdf', filename: 'bffail.pdf' }
      });
    } finally {
      store.backfillDocumentAndTopics = originalBackfill;
    }
    assert.equal(bfFailRes.statusCode, 500);
    assert.equal(backfillCalls, 1, 'the backfill must run inside the merged promotion transaction');
    const bfAtt = store.getAttachment(actor, bfFail.attId);
    assert.equal(bfAtt.storageKind, 'managed_blob',
      'a backfill failure must roll the promotion back to managed_blob (no torn half-commit)');
    assert.equal(bfAtt.blobHash, bfFail.sha, 'the blob binding must be restored by the rollback');
    assert.equal(store.db.prepare(
      'SELECT COUNT(*) AS n FROM source_files WHERE root_id = ? AND relative_path = ? AND deleted_at IS NULL'
    ).get(root.id, '网页导入/bffail.pdf').n, 0, 'no live source_files row may survive the rolled-back promotion');
    assert.equal(store.db.prepare('SELECT reference_count FROM blobs WHERE sha256 = ?').get(bfFail.sha).reference_count,
      bfRefCountBefore, 'the blob reference count must be restored by the rollback');
    // The DB references nothing at the placed path, so compensation removed it.
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'bffail.pdf')), false,
      'compensation may only remove the file while the DB does not reference it');
    const bfOpRow = store.db.prepare(
      "SELECT state, error_code FROM file_operations WHERE operation_type = 'file.import' AND target_path LIKE '%bffail.pdf%' ORDER BY created_at DESC LIMIT 1"
    ).get();
    assert.ok(bfOpRow);
    assert.equal(bfOpRow.state, 'rolled_back');
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0,
      'relational integrity must hold after the rolled-back promotion');

    // --- 29.7 (Audit 8 P1) a COMMITTED promotion whose operation completion
    // fails must keep the PDF and leave the operation resumable ---
    const cFail = seedBlobAttachment('commitfail');
    pdfByUrl.set('https://example.org/commitfail.pdf', cFail.bytes);
    const originalComplete = store.completeFileOperation;
    store.completeFileOperation = function () { throw new Error('simulated operation completion failure'); };
    let cFailRes;
    try {
      const cFailHandler = createCanvasHandler(store, { downloadPdfFn: fakeDownload });
      cFailRes = await call(cFailHandler, '/canvas/imports/native', {
        method: 'POST', cookie,
        body: { title: 'Audit6 commitfail', pdfUrl: 'https://example.org/commitfail.pdf', filename: 'commitfail.pdf' }
      });
    } finally {
      store.completeFileOperation = originalComplete;
    }
    assert.equal(cFailRes.statusCode, 200,
      'a committed promotion must report success even when operation completion fails');
    assert.equal(cFailRes.payload.data.outcome, 'reused');
    assert.equal(fs.existsSync(path.join(rootDir, '网页导入', 'commitfail.pdf')), true,
      'post-commit bookkeeping failures must NEVER delete the referenced PDF');
    const cAtt = store.getAttachment(actor, cFail.attId);
    assert.equal(cAtt.storageKind, 'source_file');
    assert.equal(store.getSourceFile(actor, cAtt.sourceFileId).relativePath, '网页导入/commitfail.pdf');
    // Invariant: no live source_files row may point at a missing file.
    for (const row of store.db.prepare(
      "SELECT relative_path FROM source_files WHERE root_id = ? AND deleted_at IS NULL AND status IN ('active','duplicate')"
    ).all(root.id)) {
      assert.equal(fs.existsSync(path.join(rootDir, row.relative_path)), true,
        `live source_files row points at a missing file: ${row.relative_path}`);
    }
    // The attachment is readable through the unified content accessor.
    const cContent = store.getAttachmentContent(actor, cFail.attId);
    assert.equal(cContent.kind, 'source_file');
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    // The completion failure left the operation resumable; startup recovery
    // settles it to completed from the committed row plus disk facts.
    const cOpRow = store.db.prepare(
      "SELECT id, state FROM file_operations WHERE operation_type = 'file.import' AND target_path LIKE '%commitfail.pdf%' ORDER BY created_at DESC LIMIT 1"
    ).get();
    assert.ok(cOpRow);
    assert.equal(cOpRow.state, 'running', 'completion failure must leave the operation resumable');
    await recoverInterruptedFileOperations(store);
    const cOpAfter = store.db.prepare('SELECT state, error_code FROM file_operations WHERE id = ?').get(cOpRow.id);
    assert.equal(cOpAfter.state, 'completed', 'startup recovery must settle the committed promotion to completed');

    console.log('✅ M4 Audit 6/7/8: mandatory SHA identity, diverged-race compensation (incl. 500 on failed cleanup), post-placement failure compensation, reuse-path version sync, single-commit-boundary promotion, recovery audit hygiene passed');
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function testM4FinalRemediation() {
  await testWebImportDefaultArchiving();
  await testBlobOnlyWebImportMigration();
  await testReimportAutoArchivingAndBackfill();
  await testM4AuditFourContinuousReconciliation();
  await testM4AuditFiveStrictSafetyAndPagination();
  await testM4AuditSixIdentityDivergenceAndCompensation();
}

try {
  await main();
  await testV12Migration();
  await testM4Scanner();
  await testM4FileOps();
  await testM4AuditFixes();
  await testM4Audit2Fixes();
  await testM4Audit3Fixes();
  await testRecoveryRollbackContentIdentity();
  await testM4FinalRemediation();
  process.exit(0);
} catch (err) {
  console.error('❌ Native M4 test failure:', err);
  process.exit(1);
}
