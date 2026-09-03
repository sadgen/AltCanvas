import fs from 'node:fs';
import path from 'node:path';
import { hashFileInsideRoot, resolveRootRealPath, ensureVerifiedDirectory } from './native-fs.mjs';
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
export function recoverInterruptedFileOperations(store) {
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
          summary[reconcileMoveLike(store, op)] += 1;
          break;
        case 'file.trash':
          summary[reconcileTrash(store, op)] += 1;
          break;
        case 'file.restore':
          summary[reconcileRestore(store, op)] += 1;
          break;
        case 'file.import':
          summary[reconcileImport(store, op)] += 1;
          break;
        case 'file.delete_permanent':
          summary[reconcilePermanentDelete(store, op)] += 1;
          break;
        case 'file.mkdir':
          summary[reconcileMkdir(store, op)] += 1;
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
function reconcileMoveLike(store, op) {
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
  const sourceOnDisk = op.sourcePath ? fs.existsSync(path.join(root.absolute_path, op.sourcePath)) : false;
  const targetOnDisk = op.targetPath ? fs.existsSync(path.join(root.absolute_path, op.targetPath)) : false;

  if (targetOnDisk && !sourceOnDisk) {
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
      // DB moved but FS did not: roll the DB back to the source path.
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

function reconcileTrash(store, op) {
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
  const trashOnDisk = op.targetPath ? fs.existsSync(path.join(root.absolute_path, op.targetPath)) : false;
  const sourceOnDisk = op.sourcePath ? fs.existsSync(path.join(root.absolute_path, op.sourcePath)) : false;

  if (trashOnDisk && !sourceOnDisk) {
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

function reconcileRestore(store, op) {
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
  const trashOnDisk = op.sourcePath ? fs.existsSync(path.join(root.absolute_path, op.sourcePath)) : false;
  const targetOnDisk = op.targetPath ? fs.existsSync(path.join(root.absolute_path, op.targetPath)) : false;

  if (targetOnDisk && !trashOnDisk) {
    store.db.prepare(`
      UPDATE source_files SET status = 'active', trashed_at = NULL, relative_path = ?, filename = ?,
        version = version + 1, updated_at = ?
      WHERE id = ? AND owner_key = ?
    `).run(op.targetPath, basenameOf(op.targetPath), nowIso(), row.id, row.owner_key);
    store.completeFileOperation(op.id);
    return 'completed';
  }
  if (trashOnDisk && !targetOnDisk) {
    store.markFileOperationRolledBack(op.id);
    return 'rolledBack';
  }
  store.failFileOperation(op.id, trashOnDisk || targetOnDisk ? 'ambiguous_disk_state' : 'file_missing');
  return 'failed';
}

function reconcileImport(store, op) {
  const rootId = op.payload?.rootId;
  const targetDir = op.payload?.targetDir || '';
  const filename = op.payload?.filename;
  const root = rootId ? store.db.prepare('SELECT * FROM library_roots WHERE id = ? AND deleted_at IS NULL').get(rootId) : null;
  if (!root || !filename) {
    store.failFileOperation(op.id, 'root_or_payload_missing');
    return 'failed';
  }
  const relativePath = targetDir ? `${targetDir}/${filename}` : filename;
  const targetOnDisk = fs.existsSync(path.join(root.absolute_path, relativePath));
  const dbRow = store.getSourceFileByPath(root.owner_key, root.id, relativePath);

  if (targetOnDisk && !dbRow) {
    // FS placed the file, the DB write never happened: compensate by
    // removing the placed file so no unmanaged content leaks outside the DB.
    try { fs.unlinkSync(path.join(root.absolute_path, relativePath)); } catch {}
    store.markFileOperationRolledBack(op.id);
    return 'rolledBack';
  }
  if (dbRow) {
    store.completeFileOperation(op.id);
    return 'completed';
  }
  store.markFileOperationRolledBack(op.id);
  return 'rolledBack';
}

function reconcilePermanentDelete(store, op) {
  const row = op.sourceFileId ? store.db.prepare('SELECT * FROM source_files WHERE id = ?').get(op.sourceFileId) : null;
  if (!row) {
    store.completeFileOperation(op.id); // purge already finished
    return 'completed';
  }
  const root = store.db.prepare('SELECT * FROM library_roots WHERE id = ? AND deleted_at IS NULL').get(row.root_id);
  if (root) {
    const trashAbs = path.join(root.absolute_path, '.altcanvas-trash', `${row.id}.pdf`);
    if (fs.existsSync(trashAbs)) {
      try { fs.unlinkSync(trashAbs); } catch {}
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
  ensureVerifiedDirectory(root.absolute_path, relativeDir, { create: true });
  store.completeFileOperation(op.id);
  return 'completed';
}

export async function scanLibraryRoot(store, actorKey, rootId, {
  hashFn = hashFileInsideRoot,
  batchDelayMs = 0,
  scanSignal = null
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
    const report = await performScan(store, actorKey, root, hashFn, batchDelayMs, scanSignal);
    store.completeFileOperation(operation.id);
    store.setLibraryRootScanState(actorKey, rootId, { status: 'ok', at: new Date().toISOString() });
    return { operationId: operation.id, state: 'completed', alreadyRunning: false, report };
  } catch (err) {
    store.failFileOperation(operation.id, err.code || 'library_scan_failed');
    store.setLibraryRootScanState(actorKey, rootId, { status: 'failed', at: new Date().toISOString() });
    throw err;
  }
}

async function performScan(store, actorKey, root, hashFn, batchDelayMs, scanSignal) {
  const startedAt = new Date().toISOString();
  const rootId = root.id;

  // Availability gate before any DB mutation: an offline root must not touch rows.
  resolveRootRealPath(root.absolutePath);

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

  const inventoryRows = store.listRootSourceFilesForScan(actorKey, rootId);
  const inventory = new Map(inventoryRows.map(row => [row.relativePath, row]));

  // diskState: authoritative post-walk content map (path -> facts).
  const diskState = new Map();
  const unreadablePaths = new Set();
  const toTouch = [];

  // --- Phase A: classify and hash in lazy bounded batches; the directory
  // listing itself is never aggregated (generator + batchesOf).
  const entryBatches = batchesOf(iteratePdfEntries(root.absolutePath), SCAN_BATCH_SIZE);
  for (const batch of entryBatches) {
    if (scanSignal?.aborted) throw new LibraryScanError('scan aborted', 'scan_aborted');
    report.scannedFiles += batch.length;
    const hashedInBatch = [];
    for (const entry of batch) {
      const row = inventory.get(entry.relativePath);
      if (row && row.sha256 && row.sizeBytes === entry.sizeBytes && row.modifiedAt === entry.mtimeMs) {
        // Unchanged by size+mtime: no rehash, bulk last_seen refresh only.
        diskState.set(entry.relativePath, {
          sha256: row.sha256,
          sizeBytes: entry.sizeBytes,
          mtimeMs: entry.mtimeMs
        });
        toTouch.push(row.id);
        report.unchangedFiles += 1;
        continue;
      }
      report.hashedFiles += 1;
      try {
        const hashed = await hashFn(root.absolutePath, entry.relativePath);
        diskState.set(entry.relativePath, {
          sha256: hashed.sha256,
          sizeBytes: hashed.sizeBytes,
          mtimeMs: Math.round(hashed.mtimeMs)
        });
        hashedInBatch.push(entry.relativePath);
      } catch (err) {
        if (err?.code === 'file_not_found' || err?.code === 'ENOENT') continue; // vanished; phase B marks missing
        report.unreadable += 1;
        unreadablePaths.add(entry.relativePath); // physically present; phase B must not call it missing
        markUnreadable(store, actorKey, rootId, inventory.get(entry.relativePath), entry, startedAt);
        continue;
      }
    }
    store.transaction(() => {
      for (const relativePath of hashedInBatch) {
        const row = inventory.get(relativePath);
        const facts = diskState.get(relativePath);
        if (!row) continue;
        if (row.sha256 !== facts.sha256) {
          // Content actually changed on disk. applySourceContentChange bumps
          // the attachment version, refreshes attachment info, marks bound
          // topic analyses stale, and demotes the row to duplicate when the
          // new hash already belongs to another enrolled document (never a
          // second library identity).
          store.applySourceContentChange(actorKey, row.id, {
            sha256: facts.sha256,
            sizeBytes: facts.sizeBytes,
            modifiedAt: facts.mtimeMs,
            lastSeenAt: startedAt
          });
          report.changed += 1;
        } else if (row.sizeBytes !== facts.sizeBytes || row.modifiedAt !== facts.mtimeMs) {
          // Same content, drifted stat facts: refresh quietly. Content was just
          // re-read successfully, so missing/unreadable rows recover here;
          // duplicate stays duplicate (library identity, not readability).
          const nextStatus = row.status === 'missing' || row.status === 'unreadable' ? 'active' : row.status;
          store.updateSourceFile(actorKey, row.id, {
            sizeBytes: facts.sizeBytes,
            modifiedAt: facts.mtimeMs,
            lastSeenAt: startedAt,
            status: nextStatus,
            missingAt: nextStatus === 'active' ? null : undefined
          });
          if (nextStatus === 'active' && row.status !== 'active') report.restored += 1;
        } else if (row.status === 'missing' || row.status === 'unreadable') {
          // Identical stat facts but readable again (content hash matches): recover.
          store.updateSourceFile(actorKey, row.id, { status: 'active', missingAt: null, lastSeenAt: startedAt });
        } else {
          toTouch.push(row.id);
        }
      }
      // Genuinely new paths are not inserted here: enrollment decisions
      // (unique content vs duplicate) require move-detection to finish, and
      // inserting early could collide with a row that is about to move onto
      // this path. Phase C owns new-row creation.
    });
    if (toTouch.length) {
      store.touchSourceFiles(actorKey, rootId, toTouch, startedAt);
      toTouch.length = 0;
    }
    if (batchDelayMs) await sleep(batchDelayMs);
  }
  if (toTouch.length) store.touchSourceFiles(actorKey, rootId, toTouch, startedAt);

  // --- Phase B: reconcile only after a complete, error-free walk.
  const refreshedRows = store.listRootSourceFilesForScan(actorKey, rootId);
  const shaToDiskPaths = new Map();
  for (const [p, facts] of diskState) {
    if (!shaToDiskPaths.has(facts.sha256)) shaToDiskPaths.set(facts.sha256, []);
    shaToDiskPaths.get(facts.sha256).push(p);
  }

  const claimedPaths = new Set(refreshedRows.map(row => row.relativePath));
  for (let i = 0; i < refreshedRows.length; i += SCAN_BATCH_SIZE) {
    if (scanSignal?.aborted) throw new LibraryScanError('scan aborted', 'scan_aborted');
    const batch = refreshedRows.slice(i, i + SCAN_BATCH_SIZE);
    store.transaction(() => {
      for (const row of batch) {
        if (diskState.has(row.relativePath) || unreadablePaths.has(row.relativePath)) {
          claimedPaths.add(row.relativePath);
          if (row.status === 'missing') {
            store.updateSourceFile(actorKey, row.id, { status: 'active', missingAt: null, lastSeenAt: startedAt });
            report.restored += 1;
          }
          continue;
        }
        // Path disappeared: same content elsewhere means move/external rename.
        const candidates = (shaToDiskPaths.get(row.sha256) || []).filter(p => !claimedPaths.has(p));
        if (row.sha256 && candidates.length > 0) {
          const newPath = candidates[0];
          claimedPaths.add(newPath);
          store.updateSourceFile(actorKey, row.id, {
            relativePath: newPath,
            filename: basename(newPath),
            sizeBytes: diskState.get(newPath).sizeBytes,
            modifiedAt: diskState.get(newPath).mtimeMs,
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
    if (batchDelayMs) await sleep(batchDelayMs);
  }

  // --- Phase C: enroll genuinely new content; duplicates get rows without documents.
  const unclaimed = [...diskState.keys()].filter(p => !claimedPaths.has(p));
  for (let i = 0; i < unclaimed.length; i += SCAN_BATCH_SIZE) {
    if (scanSignal?.aborted) throw new LibraryScanError('scan aborted', 'scan_aborted');
    const batch = unclaimed.slice(i, i + SCAN_BATCH_SIZE);
    store.transaction(() => {
      for (const relativePath of batch) {
        const facts = diskState.get(relativePath);
        const canonical = store.listSourceFilesBySha(actorKey, facts.sha256)
          .find(row => row.status === 'active' && row.documentId && row.rootId !== rootId)
          || store.listSourceFilesBySha(actorKey, facts.sha256)
            .find(row => row.status === 'active' && row.documentId);
        if (canonical) {
          store.createSourceFile(actorKey, rootId, {
            relativePath,
            filename: basename(relativePath),
            sha256: facts.sha256,
            sizeBytes: facts.sizeBytes,
            modifiedAt: facts.mtimeMs,
            lastSeenAt: startedAt,
            status: 'duplicate'
          });
          report.duplicates += 1;
          continue;
        }
        const entry = {
          relativePath,
          filename: basename(relativePath),
          sha256: facts.sha256,
          sizeBytes: facts.sizeBytes,
          mtimeMs: facts.mtimeMs
        };
        enrollScannedFile(store, actorKey, rootId, entry);
        report.newDocuments += 1;
      }
    });
    if (batchDelayMs) await sleep(batchDelayMs);
  }

  return report;
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
