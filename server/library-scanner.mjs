import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashFileInsideRoot, resolveRootRealPath, ensureVerifiedDirectory, safeProbeInsideRoot, safeUnlinkWithExpectedSha } from './native-fs.mjs';
import { nowIso } from './canvas-store.mjs';

// M4 incremental library scanner. A scan is a full directory inventory whose
// DB mutations are applied in batches; missing/duplicate/move reconciliation
// happens only after the walk has completed without errors, so an offline
// root or a mid-scan failure can never mass-mark files as missing.

export const SCAN_BATCH_SIZE = 100;

export class LibraryScanError extends Error {
  constructor(message, code = 'library_scan_failed') {
    super(message);
    this.name = 'LibraryScanError';
    this.code = code;
  }
}

// Strict recursive PDF inventory. Unlike the permissive native-fs walker this
// refuses to skip unreadable subtrees silently: an unreadable directory aborts
// the scan so its files can never be mislabeled as missing. Symlinks (files
// and directories) are never followed. Implemented as a lazy generator so the
// full directory listing is never aggregated in memory; callers consume
// bounded batches via batchesOf below.
export function* iteratePdfEntries(rootPath) {
  const rootReal = resolveRootRealPath(rootPath);
  function* visit(relativeDir) {
    let dirents;
    try {
      dirents = fs.readdirSync(relativeDir ? path.join(rootReal, relativeDir) : rootReal, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        throw new LibraryScanError(`directory is not readable: ${relativeDir || '.'}`, 'directory_unreadable');
      }
      if (err.code === 'ENOENT') return; // vanished mid-scan; reconcile treats as missing
      throw new LibraryScanError(`directory listing failed: ${relativeDir || '.'}`, 'directory_unreadable');
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) continue;
      const relativePath = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        yield* visit(relativePath);
        continue;
      }
      if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith('.pdf')) continue;
      let stat = null;
      try {
        stat = fs.statSync(path.join(rootReal, relativePath));
      } catch {
        continue; // vanished between readdir and stat; next scan classifies
      }
      yield {
        relativePath,
        filename: dirent.name,
        sizeBytes: stat.size,
        mtimeMs: Math.round(stat.mtimeMs)
      };
    }
  }
  yield* visit('');
}

// Bounds memory: yields fixed-size batches pulled lazily from the generator.
export function* batchesOf(iterator, size) {
  let buffer = [];
  for (const item of iterator) {
    buffer.push(item);
    if (buffer.length >= size) {
      yield buffer;
      buffer = [];
    }
  }
  if (buffer.length) yield buffer;
}

function basename(relativePath) {
  const idx = relativePath.lastIndexOf('/');
  return idx === -1 ? relativePath : relativePath.slice(idx + 1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Enrolls a freshly discovered unique PDF into the library: source_files row,
// native document and a source_file-backed attachment, all in one transaction.
export function enrollScannedFile(store, actorKey, rootId, entry) {
  const title = entry.filename.replace(/\.pdf$/i, '').trim() || '未命名文献';
  return store.transaction(() => {
    const document = store.createDocument(actorKey, { title });
    const sourceFile = store.createSourceFile(actorKey, rootId, {
      relativePath: entry.relativePath,
      filename: entry.filename,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.mtimeMs,
      lastSeenAt: new Date().toISOString()
    });
    const attachment = store.createSourceFileAttachment(actorKey, document.id, {
      sourceFileId: sourceFile.id,
      originalFilename: entry.filename,
      title,
      sizeBytes: entry.sizeBytes
    });
    store.updateSourceFile(actorKey, sourceFile.id, {
      documentId: document.id,
      attachmentId: attachment.id
    });
    return { sourceFile, document, attachment };
  });
}

// Startup recovery: scans that were queued/running when the process died are
// marked failed and their roots' scan state is reset, never silently resumed
// against a possibly-changed filesystem. Re-running a scan is always safe.
// Deterministic startup recovery. Every interrupted operation is reconciled
// against the actual disk facts and the database row, per operation type —
// never a blind "failed" stamp:
//   rename/move  target present + source gone  -> finish the DB update
//                source present + target gone  -> rolled_back (FS never ran)
//   trash        trash file present            -> finish the DB status
//                source still present          -> rolled_back
//   restore      original present + trash gone -> finish the DB status
//                trash still present           -> rolled_back
//   import       file placed but no DB row     -> compensate (unlink + rolled_back)
//                row exists                    -> completed
//   delete_permanent  file already gone        -> finish the DB purge
//   mkdir        idempotently ensure the directory
//   library.scan nothing to reconcile; the next scan redoes it safely
export async function recoverInterruptedFileOperations(store) {
  const resumable = store.listResumableFileOperations();
  const summary = { completed: 0, rolledBack: 0, failed: 0, scansReset: 0 };
  for (const op of resumable) {
    try {
      switch (op.operationType) {
        case 'library.scan':
          store.failFileOperation(op.id, 'interrupted_by_restart');
          resetRootScanState(store, op.payload?.rootId);
          summary.scansReset += 1;
          break;
        case 'file.rename':
        case 'file.move':
          summary[await reconcileMoveLike(store, op)] += 1;
          break;
        case 'file.trash':
          summary[await reconcileTrash(store, op)] += 1;
          break;
        case 'file.restore':
          summary[await reconcileRestore(store, op)] += 1;
          break;
        case 'file.import':
          summary[await reconcileImport(store, op)] += 1;
          break;
        case 'file.delete_permanent':
          summary[await reconcilePermanentDelete(store, op)] += 1;
          break;
        case 'file.mkdir':
          summary[await reconcileMkdir(store, op)] += 1;
          break;
        default:
          store.failFileOperation(op.id, 'unknown_operation_type');
          summary.failed += 1;
      }
    } catch (err) {
      store.failFileOperation(op.id, `recovery_failed: ${err.message}`.slice(0, 120));
      summary.failed += 1;
    }
  }
  return summary;
}

// Content-identity gate for recovery completion: the file at the recorded
// target is re-hashed through the safe fd path (O_NOFOLLOW + realpath
// containment + regular-file check). Completing a reconciliation requires the
// hash to equal source_files.sha256; anything else — different bytes, a
// directory in the target's place, an unreadable file, or a null recorded
// hash that cannot be verified — is a content_mismatch failure that leaves
// the database untouched (the next scan reconciles the real state).
async function verifyRecoveryTargetContent(rootAbsolutePath, relativePath, expectedSha256) {
  if (!expectedSha256) return { ok: false, reason: 'unverifiable_hash' };
  try {
    const hashed = await hashFileInsideRoot(rootAbsolutePath, relativePath);
    if (hashed.sha256 !== expectedSha256) return { ok: false, reason: 'content_mismatch' };
    return { ok: true };
  } catch (err) {
    if (err?.code === 'file_not_found' || err?.code === 'not_a_regular_file' || err?.code === 'symlink_rejected') {
      return { ok: false, reason: 'content_mismatch' };
    }
    throw err;
  }
}

function resetRootScanState(store, rootId) {
  if (!rootId) return;
  const root = store.db.prepare('SELECT id FROM library_roots WHERE id = ?').get(rootId);
  if (root) {
    store.db.prepare("UPDATE library_roots SET last_scan_status = 'failed', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), rootId);
  }
}

function basenameOf(relativePath) {
  const idx = relativePath.lastIndexOf('/');
  return idx === -1 ? relativePath : relativePath.slice(idx + 1);
}

// Renames and moves share the same facts: DB row is either still on
// source_path (FS ran but DB not updated -> finish it) or already on
// target_path (nothing to do).
async function reconcileMoveLike(store, op) {
  const row = op.sourceFileId ? store.db.prepare('SELECT * FROM source_files WHERE id = ?').get(op.sourceFileId) : null;
  if (!row || row.deleted_at) {
    store.failFileOperation(op.id, 'source_file_missing');
    return 'failed';
  }
  const root = store.db.prepare('SELECT * FROM library_roots WHERE id = ? AND deleted_at IS NULL').get(row.root_id);
  if (!root) {
    store.failFileOperation(op.id, 'library_root_missing');
    return 'failed';
  }
  // Disk facts come from the recovery-safe probe: a symlinked ancestor makes
  // the fact "not present" (never followed), so no root-outside content can
  // influence or receive a reconciliation mutation.
  const sourceProbe = op.sourcePath ? safeProbeInsideRoot(root.absolute_path, op.sourcePath) : { present: false, reason: 'absent' };
  const targetProbe = op.targetPath ? safeProbeInsideRoot(root.absolute_path, op.targetPath) : { present: false, reason: 'absent' };
  const sourceOnDisk = sourceProbe.present;
  const targetOnDisk = targetProbe.present;

  if (targetOnDisk && !sourceOnDisk) {
    // The target file must still be the SAME file: re-hash it through the
    // safe fd path and compare against the recorded identity before any DB
    // completion. A replaced file (or a directory in its place) is a
    // content_mismatch that leaves the database untouched.
    const verification = await verifyRecoveryTargetContent(root.absolute_path, op.targetPath, row.sha256);
    if (!verification.ok) {
      store.failFileOperation(op.id, verification.reason === 'unverifiable_hash' ? 'content_mismatch' : verification.reason);
      return 'failed';
    }
    if (row.relative_path === op.targetPath) {
      store.completeFileOperation(op.id);
      return 'completed';
    }
    // FS finished, DB never updated: apply the DB side deterministically.
    store.db.prepare(`
      UPDATE source_files SET relative_path = ?, filename = ?, status = 'active',
        missing_at = NULL, version = version + 1, updated_at = ?
      WHERE id = ? AND owner_key = ?
    `).run(op.targetPath, basenameOf(op.targetPath), nowIso(), row.id, row.owner_key);
    store.completeFileOperation(op.id);
    return 'completed';
  }
  if (sourceOnDisk && !targetOnDisk) {
    if (row.relative_path === op.targetPath) {
      // DB moved but FS did not: before reverting the DB onto the source
      // path, the source file must still carry the recorded identity — a
      // replaced source is a content_mismatch, never a clean rollback.
      const rollbackVerification = await verifyRecoveryTargetContent(root.absolute_path, op.sourcePath, row.sha256);
      if (!rollbackVerification.ok) {
        store.failFileOperation(op.id, rollbackVerification.reason === 'unverifiable_hash' ? 'content_mismatch' : rollbackVerification.reason);
        return 'failed';
      }
      store.db.prepare(`
        UPDATE source_files SET relative_path = ?, filename = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND owner_key = ?
      `).run(op.sourcePath, basenameOf(op.sourcePath), nowIso(), row.id, row.owner_key);
    }
    store.markFileOperationRolledBack(op.id);
    return 'rolledBack';
  }
  store.failFileOperation(op.id, sourceOnDisk || targetOnDisk ? 'ambiguous_disk_state' : 'file_missing');
  return 'failed';
}

async function reconcileTrash(store, op) {
  const row = op.sourceFileId ? store.db.prepare('SELECT * FROM source_files WHERE id = ?').get(op.sourceFileId) : null;
  if (!row || row.deleted_at) {
    store.failFileOperation(op.id, 'source_file_missing');
    return 'failed';
  }
  const root = store.db.prepare('SELECT * FROM library_roots WHERE id = ? AND deleted_at IS NULL').get(row.root_id);
  if (!root) {
    store.failFileOperation(op.id, 'library_root_missing');
    return 'failed';
  }
  const trashProbe = op.targetPath ? safeProbeInsideRoot(root.absolute_path, op.targetPath) : { present: false, reason: 'absent' };
  const sourceProbe = op.sourcePath ? safeProbeInsideRoot(root.absolute_path, op.sourcePath) : { present: false, reason: 'absent' };
  const trashOnDisk = trashProbe.present;
  const sourceOnDisk = sourceProbe.present;

  if (trashOnDisk && !sourceOnDisk) {
    const verification = await verifyRecoveryTargetContent(root.absolute_path, op.targetPath, row.sha256);
    if (!verification.ok) {
      store.failFileOperation(op.id, verification.reason === 'unverifiable_hash' ? 'content_mismatch' : verification.reason);
      return 'failed';
    }
    if (row.status !== 'trashed') {
      store.db.prepare(`
        UPDATE source_files SET status = 'trashed', trashed_at = COALESCE(trashed_at, ?),
          version = version + 1, updated_at = ?
        WHERE id = ? AND owner_key = ?
      `).run(nowIso(), nowIso(), row.id, row.owner_key);
    }
    store.completeFileOperation(op.id);
    return 'completed';
  }
  if (sourceOnDisk && !trashOnDisk) {
    if (row.status === 'trashed') {
      // The trash never ran and the row is being rolled back to active: the
      // source file must still match the recorded identity first.
      const rollbackVerification = await verifyRecoveryTargetContent(root.absolute_path, op.sourcePath, row.sha256);
      if (!rollbackVerification.ok) {
        store.failFileOperation(op.id, rollbackVerification.reason === 'unverifiable_hash' ? 'content_mismatch' : rollbackVerification.reason);
        return 'failed';
      }
      store.db.prepare(`
        UPDATE source_files SET status = 'active', trashed_at = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND owner_key = ?
      `).run(nowIso(), row.id, row.owner_key);
    }
    store.markFileOperationRolledBack(op.id);
    return 'rolledBack';
  }
  store.failFileOperation(op.id, sourceOnDisk || trashOnDisk ? 'ambiguous_disk_state' : 'file_missing');
  return 'failed';
}

async function reconcileRestore(store, op) {
  const row = op.sourceFileId ? store.db.prepare('SELECT * FROM source_files WHERE id = ?').get(op.sourceFileId) : null;
  if (!row || row.deleted_at) {
    store.failFileOperation(op.id, 'source_file_missing');
    return 'failed';
  }
  const root = store.db.prepare('SELECT * FROM library_roots WHERE id = ? AND deleted_at IS NULL').get(row.root_id);
  if (!root) {
    store.failFileOperation(op.id, 'library_root_missing');
    return 'failed';
  }
  const trashProbe = op.sourcePath ? safeProbeInsideRoot(root.absolute_path, op.sourcePath) : { present: false, reason: 'absent' };
  const targetProbe = op.targetPath ? safeProbeInsideRoot(root.absolute_path, op.targetPath) : { present: false, reason: 'absent' };
  const trashOnDisk = trashProbe.present;
  const targetOnDisk = targetProbe.present;

  if (targetOnDisk && !trashOnDisk) {
    const verification = await verifyRecoveryTargetContent(root.absolute_path, op.targetPath, row.sha256);
    if (!verification.ok) {
      store.failFileOperation(op.id, verification.reason === 'unverifiable_hash' ? 'content_mismatch' : verification.reason);
      return 'failed';
    }
    store.db.prepare(`
      UPDATE source_files SET status = 'active', trashed_at = NULL, relative_path = ?, filename = ?,
        version = version + 1, updated_at = ?
      WHERE id = ? AND owner_key = ?
    `).run(op.targetPath, basenameOf(op.targetPath), nowIso(), row.id, row.owner_key);
    store.completeFileOperation(op.id);
    return 'completed';
  }
  if (trashOnDisk && !targetOnDisk) {
    // The restore never ran and the row stays trashed: bless the rollback
    // only when the recycle-area payload still matches the recorded identity.
    const rollbackVerification = await verifyRecoveryTargetContent(root.absolute_path, op.sourcePath, row.sha256);
    if (!rollbackVerification.ok) {
      store.failFileOperation(op.id, rollbackVerification.reason === 'unverifiable_hash' ? 'content_mismatch' : rollbackVerification.reason);
      return 'failed';
    }
    store.markFileOperationRolledBack(op.id);
    return 'rolledBack';
  }
  store.failFileOperation(op.id, trashOnDisk || targetOnDisk ? 'ambiguous_disk_state' : 'file_missing');
  return 'failed';
}

async function reconcileImport(store, op) {
  const rootId = op.payload?.rootId;
  const targetDir = op.payload?.targetDir || '';
  const filename = op.payload?.filename;
  const root = rootId ? store.db.prepare('SELECT * FROM library_roots WHERE id = ? AND deleted_at IS NULL').get(rootId) : null;
  if (!root || !filename) {
    store.failFileOperation(op.id, 'root_or_payload_missing');
    return 'failed';
  }
  const relativePath = targetDir ? `${targetDir}/${filename}` : filename;
  const probe = safeProbeInsideRoot(root.absolute_path, relativePath);
  if (probe.reason === 'symlink' || probe.reason === 'escape' || probe.reason === 'invalid_path') {
    // The recorded target now resolves through a symlink or outside the root:
    // refuse to touch anything and leave the operation failed for inspection.
    store.failFileOperation(op.id, 'unsafe_path');
    return 'failed';
  }
  const dbRow = store.getSourceFileByPath(root.owner_key, root.id, relativePath);

  if (probe.present && !dbRow) {
    // FS placed the file, the DB write never happened: compensate by removing
    // the placed file so no unmanaged content leaks. A failed removal is a
    // failed operation — never a rolled-back one.
    try {
      // Re-hash to ensure the file is our orphan placement before deleting
      await safeUnlinkWithExpectedSha(root.absolute_path, relativePath, op.payload?.sha256 || null);
    } catch (unlinkErr) {
      store.failFileOperation(op.id, 'compensation_failed');
      return 'failed';
    }
    store.markFileOperationRolledBack(op.id);
    return 'rolledBack';
  }
  if (dbRow) {
    // A DB row alone is not proof the import landed: the file must exist and
    // still carry the recorded content identity. A missing file or different
    // bytes is a failure (the next scan reconciles the row), never completed.
    if (!probe.present) {
      store.failFileOperation(op.id, 'file_missing');
      return 'failed';
    }
    const verification = await verifyRecoveryTargetContent(root.absolute_path, relativePath, dbRow.sha256);
    if (!verification.ok) {
      store.failFileOperation(op.id, verification.reason === 'unverifiable_hash' ? 'content_mismatch' : verification.reason);
      return 'failed';
    }
    store.completeFileOperation(op.id);
    return 'completed';
  }
  store.markFileOperationRolledBack(op.id);
  return 'rolledBack';
}

async function reconcilePermanentDelete(store, op) {
  const row = op.sourceFileId ? store.db.prepare('SELECT * FROM source_files WHERE id = ?').get(op.sourceFileId) : null;
  if (!row) {
    store.completeFileOperation(op.id); // purge already finished
    return 'completed';
  }
  const root = store.db.prepare('SELECT * FROM library_roots WHERE id = ? AND deleted_at IS NULL').get(row.root_id);
  if (root) {
    const trashRel = `.altcanvas-trash/${row.id}.pdf`;
    const probe = safeProbeInsideRoot(root.absolute_path, trashRel);
    if (probe.reason === 'symlink' || probe.reason === 'escape' || probe.reason === 'invalid_path') {
      store.failFileOperation(op.id, 'unsafe_path');
      return 'failed';
    }
    if (probe.present) {
      // The compensating delete must only remove the row's OWN payload: a
      // recycle-area file that no longer matches the recorded identity is a
      // content_mismatch and stays on disk.
      const deleteVerification = await verifyRecoveryTargetContent(root.absolute_path, trashRel, row.sha256);
      if (!deleteVerification.ok) {
        store.failFileOperation(op.id, deleteVerification.reason === 'unverifiable_hash' ? 'content_mismatch' : deleteVerification.reason);
        return 'failed';
      }
      try {
        await safeUnlinkWithExpectedSha(root.absolute_path, trashRel, row.sha256);
      } catch (unlinkErr) {
        store.failFileOperation(op.id, 'compensation_failed');
        return 'failed';
      }
    }
  }
  if (row.status === 'trashed') {
    store.purgeTrashedSourceFile(row.owner_key, row.id);
    store.completeFileOperation(op.id);
    return 'completed';
  }
  store.failFileOperation(op.id, 'invalid_source_file_status');
  return 'failed';
}

function reconcileMkdir(store, op) {
  const rootId = op.payload?.rootId;
  const relativeDir = op.payload?.path;
  const root = rootId ? store.db.prepare('SELECT * FROM library_roots WHERE id = ? AND deleted_at IS NULL').get(rootId) : null;
  if (!root || typeof relativeDir !== 'string') {
    store.failFileOperation(op.id, 'root_or_payload_missing');
    return 'failed';
  }
  ensureVerifiedDirectory(resolveRootRealPath(root.absolute_path), relativeDir, { create: true });
  store.completeFileOperation(op.id);
  return 'completed';
}

export async function scanLibraryRoot(store, actorKey, rootId, {
  hashFn = hashFileInsideRoot,
  batchDelayMs = 0,
  scanSignal = null,
  entryIteratorFn = iteratePdfEntries
} = {}) {
  const root = store.requireLibraryRoot(actorKey, rootId);

  // Concurrent scan guard: one live scan per root.
  for (const op of store.listResumableFileOperations()) {
    if (op.operationType === 'library.scan' && op.payload?.rootId === rootId) {
      return { operationId: op.id, state: op.state, alreadyRunning: true };
    }
  }

  const operation = store.createFileOperation(actorKey, {
    operationType: 'library.scan',
    sourcePath: root.absolutePath,
    payload: { rootId }
  });
  store.startFileOperation(operation.id);
  store.setLibraryRootScanState(actorKey, rootId, { status: 'running' });

  try {
    const report = await performScan(store, actorKey, root, { hashFn, batchDelayMs, scanSignal, entryIteratorFn });
    store.completeFileOperation(operation.id);
    store.setLibraryRootScanState(actorKey, rootId, { status: 'ok', at: new Date().toISOString() });
    return { operationId: operation.id, state: 'completed', alreadyRunning: false, report };
  } catch (err) {
    store.failFileOperation(operation.id, err.code || 'library_scan_failed');
    store.setLibraryRootScanState(actorKey, rootId, { status: 'failed', at: new Date().toISOString() });
    throw err;
  }
}

// Bounded-memory incremental scan. Disk facts discovered per batch go
// straight into the per-scan staging table; reconciliation (missing/move/
// duplicate/enroll) runs as keyset-paginated SQL joins, so no phase ever
// holds the full directory or the full source_files inventory in memory.
async function performScan(store, actorKey, root, { hashFn, batchDelayMs, scanSignal, entryIteratorFn }) {
  const startedAt = new Date().toISOString();
  const rootId = root.id;

  // Availability gate before any DB mutation: an offline root must not touch rows.
  resolveRootRealPath(root.absolutePath);

  const scanId = crypto.randomUUID();
  store.prepareScanStaging();
  // Drop rows left by a crashed scan of the same root (TEMP table survives
  // with the connection even though the scan did not).
  store.purgeScanStagingForRoot(actorKey, rootId);

  const report = {
    scannedFiles: 0,
    hashedFiles: 0,
    unchangedFiles: 0,
    newDocuments: 0,
    duplicates: 0,
    moved: 0,
    missing: 0,
    restored: 0,
    changed: 0,
    unreadable: 0
  };

  try {
    await scanPhaseA(store, actorKey, root, scanId, report, { hashFn, batchDelayMs, scanSignal, entryIteratorFn, startedAt });
    await scanPhaseB(store, actorKey, root, scanId, report, { batchDelayMs, scanSignal, startedAt });
    await scanPhaseC(store, actorKey, root, scanId, report, { batchDelayMs, scanSignal, startedAt });

    const counts = store.countScanStaging(scanId);
    report.scannedFiles = counts.total;
    report.hashedFiles = counts.hashed;
    report.unchangedFiles = counts.cacheHit;
    report.unreadable = counts.unreadable;
    return report;
  } finally {
    store.deleteScanStaging(scanId);
  }
}

// Phase A: classify and hash in lazy bounded batches. Every batch's disk facts
// are inserted into staging inside one transaction together with the row
// updates they imply (content-change cascade, stat refresh, recovery).
async function scanPhaseA(store, actorKey, root, scanId, report, { hashFn, batchDelayMs, scanSignal, entryIteratorFn, startedAt }) {
  const rootId = root.id;
  for (const batch of batchesOf(entryIteratorFn(root.absolutePath), SCAN_BATCH_SIZE)) {
    if (scanSignal?.aborted) throw new LibraryScanError('scan aborted', 'scan_aborted');

    const stagedRows = [];
    for (const entry of batch) {
      const row = store.getSourceFileByPath(actorKey, rootId, entry.relativePath);
      if (row && row.sha256 && row.sizeBytes === entry.sizeBytes && row.modifiedAt === entry.mtimeMs) {
        // Unchanged by size+mtime: no rehash, cache-hit fact only.
        stagedRows.push({
          relativePath: entry.relativePath,
          filename: entry.filename,
          sha256: row.sha256,
          sizeBytes: entry.sizeBytes,
          modifiedAt: entry.mtimeMs,
          status: 'cache_hit'
        });
        continue;
      }
      try {
        const hashed = await hashFn(root.absolutePath, entry.relativePath);
        stagedRows.push({
          relativePath: entry.relativePath,
          filename: entry.filename,
          sha256: hashed.sha256,
          sizeBytes: hashed.sizeBytes,
          modifiedAt: Math.round(hashed.mtimeMs),
          status: 'hashed'
        });
      } catch (err) {
        if (err?.code === 'file_not_found' || err?.code === 'ENOENT') continue; // vanished; phase B marks missing
        stagedRows.push({
          relativePath: entry.relativePath,
          filename: entry.filename,
          sha256: null,
          sizeBytes: entry.sizeBytes,
          modifiedAt: entry.mtimeMs,
          status: 'unreadable'
        });
      }
    }

    const toTouch = [];
    store.transaction(() => {
      store.insertScanStagingRows(scanId, actorKey, rootId, stagedRows);
      for (const st of stagedRows) {
        const row = store.getSourceFileByPath(actorKey, rootId, st.relativePath);
        if (st.status === 'unreadable') {
          markUnreadable(store, actorKey, rootId, row, {
            relativePath: st.relativePath, filename: st.filename, sizeBytes: st.sizeBytes, mtimeMs: st.modifiedAt
          }, startedAt);
          continue;
        }
        if (!row) continue; // genuinely new path: enrollment decisions live in phase C
        if (row.sha256 && row.sha256 !== st.sha256) {
          // Content actually changed on disk: version cascade + stale analyses
          // + duplicate demotion when the new hash is already enrolled.
          store.applySourceContentChange(actorKey, row.id, {
            sha256: st.sha256, sizeBytes: st.sizeBytes, modifiedAt: st.modifiedAt, lastSeenAt: startedAt
          });
          report.changed += 1;
          continue;
        }
        if (row.sizeBytes !== st.sizeBytes || row.modifiedAt !== st.modifiedAt) {
          // Same content, drifted stat facts: refresh quietly; readable content
          // recovers missing/unreadable rows.
          const nextStatus = row.status === 'missing' || row.status === 'unreadable' ? 'active' : row.status;
          store.updateSourceFile(actorKey, row.id, {
            sizeBytes: st.sizeBytes,
            modifiedAt: st.modifiedAt,
            lastSeenAt: startedAt,
            status: nextStatus,
            missingAt: nextStatus === 'active' ? null : undefined
          });
          if (nextStatus === 'active' && row.status !== 'active') report.restored += 1;
          continue;
        }
        if (row.status === 'missing' || row.status === 'unreadable') {
          store.updateSourceFile(actorKey, row.id, { status: 'active', missingAt: null, lastSeenAt: startedAt });
          report.restored += 1;
        } else {
          toTouch.push(row.id);
        }
      }
    });
    if (toTouch.length) store.touchSourceFiles(actorKey, rootId, toTouch, startedAt);
    if (batchDelayMs) await sleep(batchDelayMs);
  }
}

// Phase B: reconcile existing rows against staged facts, in keyset pages.
// Only runs its state machine — move detection re-checks path claims in SQL
// at update time, so sequential moves inside a page never double-claim.
async function scanPhaseB(store, actorKey, root, scanId, report, { batchDelayMs, scanSignal, startedAt }) {
  const rootId = root.id;
  let afterPath = '';
  while (true) {
    if (scanSignal?.aborted) throw new LibraryScanError('scan aborted', 'scan_aborted');
    const rows = store.listSourceFilesForScanPage(actorKey, rootId, { afterPath, limit: SCAN_BATCH_SIZE });
    if (!rows.length) break;
    const touched = [];
    store.transaction(() => {
      for (const row of rows) {
        const staged = store.getScanStagingByPath(scanId, row.relativePath);
        if (staged) {
          if (row.status === 'missing') {
            store.updateSourceFile(actorKey, row.id, { status: 'active', missingAt: null, lastSeenAt: startedAt });
            report.restored += 1;
          } else if (row.status === 'unreadable' && staged.sha256 && staged.sha256 === row.sha256) {
            store.updateSourceFile(actorKey, row.id, { status: 'active', missingAt: null, lastSeenAt: startedAt });
            report.restored += 1;
          }
          touched.push(row.id);
          continue;
        }
        // Path absent from disk: same content staged elsewhere means a move.
        const candidate = row.sha256
          ? store.findMoveCandidateStaging(scanId, actorKey, rootId, row.sha256)
          : null;
        if (candidate) {
          store.updateSourceFile(actorKey, row.id, {
            relativePath: candidate.relative_path,
            filename: candidate.filename,
            sizeBytes: candidate.size_bytes,
            modifiedAt: candidate.modified_at,
            status: 'active',
            missingAt: null,
            lastSeenAt: startedAt
          });
          report.moved += 1;
          continue;
        }
        if (row.status !== 'missing') {
          store.updateSourceFile(actorKey, row.id, { status: 'missing', missingAt: startedAt });
          report.missing += 1;
        }
      }
    });
    if (touched.length) store.touchSourceFiles(actorKey, rootId, touched, startedAt);
    afterPath = rows[rows.length - 1].relativePath;
    if (rows.length < SCAN_BATCH_SIZE) break;
    if (batchDelayMs) await sleep(batchDelayMs);
  }
}

// Phase C: enroll staged content no live row claims — unique content becomes a
// document + source_file attachment; content already enrolled elsewhere stays a
// duplicate row without a second library identity. Keyset pagination again.
async function scanPhaseC(store, actorKey, root, scanId, report, { batchDelayMs, scanSignal, startedAt }) {
  const rootId = root.id;
  let afterPath = '';
  while (true) {
    if (scanSignal?.aborted) throw new LibraryScanError('scan aborted', 'scan_aborted');
    const staged = store.listUnclaimedScanStaging(scanId, actorKey, rootId, { afterPath, limit: SCAN_BATCH_SIZE });
    if (!staged.length) break;
    store.transaction(() => {
      for (const st of staged) {
        const canonical = store.findEnrolledSourceFileBySha(actorKey, st.sha256);
        if (canonical) {
          store.createSourceFile(actorKey, rootId, {
            relativePath: st.relative_path,
            filename: st.filename,
            sha256: st.sha256,
            sizeBytes: st.size_bytes,
            modifiedAt: st.modified_at,
            lastSeenAt: startedAt,
            status: 'duplicate'
          });
          report.duplicates += 1;
          continue;
        }
        enrollScannedFile(store, actorKey, rootId, {
          relativePath: st.relative_path,
          filename: st.filename,
          sha256: st.sha256,
          sizeBytes: st.size_bytes,
          mtimeMs: st.modified_at
        });
        report.newDocuments += 1;
      }
    });
    afterPath = staged[staged.length - 1].relative_path;
    if (staged.length < SCAN_BATCH_SIZE) break;
    if (batchDelayMs) await sleep(batchDelayMs);
  }
}

function markUnreadable(store, actorKey, rootId, existingRow, entry, timestamp) {
  store.transaction(() => {
    if (existingRow) {
      store.updateSourceFile(actorKey, existingRow.id, { status: 'unreadable', lastSeenAt: timestamp });
    } else {
      store.createSourceFile(actorKey, rootId, {
        relativePath: entry.relativePath,
        filename: entry.filename,
        sha256: null,
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.mtimeMs,
        lastSeenAt: timestamp,
        status: 'unreadable'
      });
    }
  });
}
