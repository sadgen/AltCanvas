import fs from 'node:fs';
import path from 'node:path';
import {
  resolveRootRealPath,
  resolveInsideRoot,
  ensureVerifiedDirectory,
  ensureParentInsideRoot,
  assertWrittenInsideRoot,
  safeProbeInsideRoot,
  openFileInsideRoot,
  safeUnlinkWithExpectedSha,
  hashFileInsideRoot
} from './native-fs.mjs';

// M4 one-shot archival migration: existing blob-only web-import PDFs move
// into the configured library roots (default 网页导入), the attachment flips
// IN PLACE to source_file storage (preserving attachment ID, annotations,
// and topic bindings), and the managed blob is left to the existing
// reference-counted cleanup.
//
// Key invariants:
//   1. Attachment identity continuity: promoteBlobAttachmentToSourceFile is
//      used in place, keeping the SAME attachment ID so annotations and
//      topic_documents remain 100% continuous.
//   2. Compensation safety: safeUnlinkWithExpectedSha REQUIRES a valid SHA-256
//      identity and refuses removal on any mismatch; a refused or failed
//      compensation is surfaced as compensation_failed — never swallowed and
//      never reported as a generic placement failure.
//   3. Concurrent promotion divergence: when the attachment was concurrently
//      archived under a different target (promotion_target_diverged), this
//      migration's own placement is removed with verified identity and the
//      authoritative location is reported as a reuse.
//   4. Loop pagination: runBlobOnlyWebImportMigration loops in batches until
//      the pending count reaches 0 or only unresolvable conflicts remain.
//   5. Crash-safe placement journaling: every real disk placement in the
//      vacant-path branch is journaled as a file.import operation (payload
//      kind 'blob_migration') BEFORE the link, so a crash between placement
//      and the DB promotion commit is compensated at startup by
//      reconcileImport (verified SHA unlink) instead of leaking bytes that
//      the scanner would enroll as a second library identity.

const DEFAULT_ARCHIVE_DIR = '网页导入';
const BATCH_SIZE = 100;

function sanitizeArchiveFilename(raw, fallbackStem) {
  let candidate = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  if (!candidate) candidate = fallbackStem;
  if (!candidate.toLowerCase().endsWith('.pdf')) candidate += '.pdf';
  return candidate;
}

function titleStem(title) {
  return String(title || '').replace(/\.pdf$/i, '').trim().slice(0, 80);
}

function archiveCandidateName(attachment, documentTitle) {
  const fromOriginal = sanitizeArchiveFilename(attachment.original_filename, '');
  if (fromOriginal && fromOriginal.toLowerCase() !== '.pdf') return fromOriginal;
  const fromTitle = sanitizeArchiveFilename(titleStem(documentTitle), '');
  if (fromTitle && fromTitle.toLowerCase() !== '.pdf') return fromTitle;
  return sanitizeArchiveFilename(`import-${String(attachment.blob_hash || '').slice(0, 16)}`, 'import');
}

// An already-enrolled source_file carrying the same content belonging to the
// SAME document.
function findReusableSourceFile(store, actorKey, sha256, documentId) {
  if (!sha256) return null;
  return store.db.prepare(`
    SELECT * FROM source_files
    WHERE owner_key = ? AND sha256 = ? AND status = 'active'
      AND document_id = ? AND deleted_at IS NULL
    ORDER BY created_at ASC LIMIT 1
  `).get(actorKey, sha256, documentId) || null;
}

function isPromotionTargetDiverged(err) {
  return Boolean(err) && err.code === 'promotion_target_diverged';
}

// The authoritative archive location after a concurrent promotion won.
function authoritativeRelativePath(store, actorKey, attachmentId) {
  const att = store.db.prepare(
    'SELECT source_file_id FROM attachments WHERE id = ? AND deleted_at IS NULL'
  ).get(attachmentId);
  if (!att || !att.source_file_id) return null;
  const row = store.getSourceFile(actorKey, att.source_file_id);
  return row ? row.relativePath : null;
}

// Migrates one attachment. Outcome: migrated | reused | conflict | failed.
async function migrateOneBlobOnlyAttachment(store, actorKey, root, attachment, targetDir) {
  const blobRow = store.getBlob(attachment.blob_hash);
  if (!blobRow) return { outcome: 'failed', reason: 'blob_row_missing' };
  const blobAbs = store.resolveBlobPath(attachment.blob_hash, '.pdf');
  if (!fs.existsSync(blobAbs)) return { outcome: 'failed', reason: 'blob_file_missing' };

  const sha256 = attachment.blob_hash;
  const documentTitle = store.getDocumentTitleById(actorKey, attachment.document_id);
  const finalName = archiveCandidateName(attachment, documentTitle);
  const relativePath = targetDir ? `${targetDir}/${finalName}` : finalName;
  const rootReal = resolveRootRealPath(root.absolutePath);

  // 1. Reuse this document's own enrolled source_file if one already exists.
  // The flip goes through the store's atomic transaction method so the
  // attachment version bump and the topic_documents.attachment_version sync
  // can never diverge (the raw-SQL shortcut that skipped the sync is gone).
  const reusable = findReusableSourceFile(store, actorKey, sha256, attachment.document_id);
  if (reusable) {
    try {
      store.promoteBlobAttachmentToExistingSourceFile(actorKey, {
        attachmentId: attachment.attachment_id,
        documentId: attachment.document_id,
        sourceFileId: reusable.id,
        sha256
      });
    } catch (reuseErr) {
      if (isPromotionTargetDiverged(reuseErr)) {
        return { outcome: 'reused', relativePath: authoritativeRelativePath(store, actorKey, attachment.attachment_id), raced: true };
      }
      return { outcome: 'failed', reason: `reuse_flip_failed:${reuseErr.message}`.slice(0, 120) };
    }
    return { outcome: 'reused', relativePath: reusable.relative_path };
  }

  // 2. Probe target path for safety and conflicts.
  const probe = safeProbeInsideRoot(rootReal, relativePath);
  if (probe.reason === 'symlink' || probe.reason === 'escape' || probe.reason === 'invalid_path') {
    return { outcome: 'conflict', reason: `unsafe_path:${probe.reason}` };
  }

  if (probe.present) {
    const existing = await hashFileInsideRoot(rootReal, relativePath);
    if (existing.sha256 !== sha256) {
      // Content differs: product rule requires recording a conflict without auto-renaming.
      return { outcome: 'conflict', reason: 'filename_conflict' };
    }
    // Identical content already at target path:
    // If an active source_file row already exists on this path for another document,
    // this document cannot steal that path -> conflict.
    const existingRow = store.getSourceFileByPath(actorKey, root.id, relativePath);
    if (existingRow && existingRow.documentId && existingRow.documentId !== attachment.document_id) {
      return { outcome: 'conflict', reason: 'filename_conflict' };
    }
    // Otherwise, adopt the file in-place with the SAME attachment ID.
    try {
      store.promoteBlobAttachmentToSourceFile(actorKey, {
        attachmentId: attachment.attachment_id,
        documentId: attachment.document_id,
        rootId: root.id,
        relativePath,
        filename: finalName,
        sha256,
        sizeBytes: existing.sizeBytes,
        modifiedAt: Math.round(existing.mtimeMs)
      });
      return { outcome: 'migrated', relativePath, adoptedExisting: true };
    } catch (err) {
      if (isPromotionTargetDiverged(err)) {
        // Archived concurrently under a different name; nothing of ours was
        // placed on disk (this file predates the call), so it stays for the
        // scanner to classify as duplicate content.
        return { outcome: 'reused', relativePath: authoritativeRelativePath(store, actorKey, attachment.attachment_id), raced: true };
      }
      return { outcome: 'failed', reason: `adopt_failed:${err.message}`.slice(0, 120) };
    }
  }

  // 3. Target path is vacant: perform atomic placement from verified blob.
  const targetAbs = resolveInsideRoot(rootReal, relativePath);
  // Journal the placement BEFORE touching the disk (same pattern as the
  // canvas-api file-target executor). A crash after linkSync but before the
  // DB promotion commit otherwise leaves anonymous bytes that the scanner's
  // Phase C would enroll as a SECOND library identity for content still owned
  // by a managed_blob attachment. With the journal, startup recovery
  // (reconcileImport) verifies payload.sha256 and removes exactly those
  // orphaned bytes.
  const placementOp = store.createFileOperation(actorKey, {
    operationType: 'file.import',
    sourcePath: blobAbs,
    targetPath: `${root.absolutePath}/${relativePath}`,
    payload: { rootId: root.id, targetDir, filename: finalName, kind: 'blob_migration', sha256 }
  });
  store.startFileOperation(placementOp.id);
  // The journal must reach exactly one terminal state; guards keep late catch
  // blocks from overwriting an already-settled outcome (failed → rolled_back
  // is a legal transition and would erase a compensation_failed marker).
  let opSettled = false;
  const settleOpCompleted = () => { opSettled = true; store.completeFileOperation(placementOp.id); };
  const settleOpRolledBack = () => { opSettled = true; store.markFileOperationRolledBack(placementOp.id); };
  const settleOpFailed = (code) => { opSettled = true; store.failFileOperation(placementOp.id, code); };
  try {
    ensureParentInsideRoot(rootReal, relativePath, { create: true });
    const staged = path.join(path.dirname(targetAbs),
      `.altcanvas-migrate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
    try {
      fs.copyFileSync(blobAbs, staged);
      const fd = fs.openSync(staged, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try {
        fs.linkSync(staged, targetAbs);
      } catch (linkErr) {
        try { fs.unlinkSync(staged); } catch {}
        if (linkErr.code === 'EEXIST') {
          // Raced placement: re-hash to confirm bytes match before concluding reused
          const racedHash = await hashFileInsideRoot(rootReal, relativePath);
          if (racedHash.sha256 !== sha256) {
            // The target belongs to a different content owner and nothing of
            // ours is on disk: rolled back, never compensated.
            settleOpRolledBack();
            return { outcome: 'conflict', reason: 'filename_conflict' };
          }
          // Same bytes were placed by the competitor; adopt in-place
          try {
            store.promoteBlobAttachmentToSourceFile(actorKey, {
              attachmentId: attachment.attachment_id,
              documentId: attachment.document_id,
              rootId: root.id,
              relativePath,
              filename: finalName,
              sha256,
              sizeBytes: racedHash.sizeBytes,
              modifiedAt: Math.round(racedHash.mtimeMs)
            });
            settleOpCompleted();
            return { outcome: 'reused', relativePath, raced: true };
          } catch (racedErr) {
            if (isPromotionTargetDiverged(racedErr)) {
              settleOpRolledBack();
              return { outcome: 'reused', relativePath: authoritativeRelativePath(store, actorKey, attachment.attachment_id), raced: true };
            }
            settleOpRolledBack();
            return { outcome: 'failed', reason: `adopt_failed:${racedErr.message}`.slice(0, 120) };
          }
        }
        throw linkErr;
      }
      try { fs.unlinkSync(staged); } catch {}
      assertWrittenInsideRoot(rootReal, targetAbs);
    } catch (innerErr) {
      try { fs.unlinkSync(staged); } catch {}
      // The staged temp is always ours to drop; the TARGET is only removed when
      // it carries exactly the expected bytes. A refused or failed removal MUST
      // surface: swallowing it would leave an orphan the journal cannot
      // describe and misreport it as a generic placement failure.
      try {
        await safeUnlinkWithExpectedSha(root.absolutePath, relativePath, sha256);
        settleOpRolledBack();
      } catch (compensationErr) {
        if (compensationErr.code !== 'file_not_found') {
          settleOpFailed('compensation_failed');
          const compensated = new Error(`placement compensation failed: ${compensationErr.message}`);
          compensated.code = 'compensation_failed';
          throw compensated;
        }
        // file_not_found: this attempt never created the target — nothing to remove.
        settleOpRolledBack();
      }
      throw innerErr;
    }
  } catch (placeErr) {
    if (placeErr && typeof placeErr.code === 'string' && placeErr.code.startsWith('unsafe_path')) {
      settleOpFailed(placeErr.code);
      return { outcome: 'conflict', reason: placeErr.code };
    }
    if (placeErr && placeErr.code === 'compensation_failed') {
      // The journal entry was already settled next to the failed compensation.
      return { outcome: 'failed', reason: `compensation_failed:${placeErr.message}`.slice(0, 120) };
    }
    if (!opSettled) settleOpFailed(placeErr?.code || 'placement_failed');
    return { outcome: 'failed', reason: `placement_failed:${placeErr?.code || placeErr?.message}`.slice(0, 120) };
  }

  // 4. In-place database upgrade preserving the SAME attachment ID. The stat
  // comes from the anchored fd path (O_NOFOLLOW + containment), never a raw
  // path stat; an unverifiable placement is compensated, not enrolled.
  let placedStat = null;
  try {
    const opened = openFileInsideRoot(rootReal, relativePath);
    try { placedStat = opened.stat; } finally { try { fs.closeSync(opened.fd); } catch {} }
  } catch (statErr) {
    try {
      await safeUnlinkWithExpectedSha(root.absolutePath, relativePath, sha256);
      settleOpRolledBack();
      return { outcome: 'failed', reason: `placement_verify_failed:${statErr.code || statErr.message}`.slice(0, 120) };
    } catch (compensationErr) {
      settleOpFailed('compensation_failed');
      return { outcome: 'failed', reason: `compensation_failed:${compensationErr.message}`.slice(0, 120) };
    }
  }
  try {
    store.promoteBlobAttachmentToSourceFile(actorKey, {
      attachmentId: attachment.attachment_id,
      documentId: attachment.document_id,
      rootId: root.id,
      relativePath,
      filename: finalName,
      sha256,
      sizeBytes: attachment.size_bytes || placedStat.size,
      modifiedAt: Math.round(placedStat.mtimeMs)
    });
    settleOpCompleted();
    return { outcome: 'migrated', relativePath };
  } catch (dbErr) {
    if (isPromotionTargetDiverged(dbErr)) {
      // Concurrently archived under a different name: remove OUR placement with
      // verified identity and report the authoritative location as a reuse.
      try {
        await safeUnlinkWithExpectedSha(root.absolutePath, relativePath, sha256);
        settleOpRolledBack();
      } catch (compensationErr) {
        settleOpFailed('compensation_failed');
        return { outcome: 'failed', reason: `compensation_failed:${compensationErr.message}`.slice(0, 120) };
      }
      return { outcome: 'reused', relativePath: authoritativeRelativePath(store, actorKey, attachment.attachment_id), raced: true };
    }
    // Compensation safety: unlink ONLY with verified expected SHA
    try {
      await safeUnlinkWithExpectedSha(root.absolutePath, relativePath, sha256);
      settleOpRolledBack();
    } catch (compensationErr) {
      settleOpFailed('compensation_failed');
      return { outcome: 'failed', reason: `compensation_failed:${compensationErr.message}`.slice(0, 120) };
    }
    return { outcome: 'failed', reason: `db_failed:${dbErr.message}`.slice(0, 120) };
  }
}

// Runs the migration in loops until all candidates are processed.
export async function runBlobOnlyWebImportMigration(store, actorKey, {
  rootId = null,
  targetDir = DEFAULT_ARCHIVE_DIR,
  batchDelayMs = 0
} = {}) {
  const root = rootId ? store.requireLibraryRoot(actorKey, rootId) : store.listLibraryRoots(actorKey)[0];
  if (!root) {
    const err = new Error('未配置可用的文库根目录，无法执行迁移');
    err.status = 422;
    err.code = 'library_root_required';
    throw err;
  }
  const rootReal = resolveRootRealPath(root.absolutePath);
  if (targetDir) {
    ensureVerifiedDirectory(rootReal, targetDir, { create: true });
  }

  const operation = store.createFileOperation(actorKey, {
    operationType: 'library.reconcile',
    sourcePath: root.absolutePath,
    payload: { kind: 'blob-only-web-import-migration', rootId: root.id, targetDir }
  });
  store.startFileOperation(operation.id);

  const report = {
    scanned: 0,
    migrated: 0,
    reused: 0,
    conflicts: 0,
    failed: 0,
    conflictsDetail: [],
    failedDetail: []
  };

  try {
    // [P1-2 Fix] Compound cursor pagination (created_at, attachment_id).
    // The loop advances monotonically through the database table, completely
    // immune to conflict or failure starvation: items in page 1 that fail or
    // encounter a filename conflict do NOT block page 2 from being read.
    let afterCreatedAt = null;
    let afterId = null;
    while (true) {
      const candidates = store.listBlobOnlyWebImportAttachments(actorKey, {
        afterCreatedAt,
        afterId,
        limit: BATCH_SIZE
      });
      if (!candidates.length) break;

      report.scanned += candidates.length;
      for (const attachment of candidates) {
        let result;
        try {
          result = await migrateOneBlobOnlyAttachment(store, actorKey, root, attachment, targetDir);
        } catch (err) {
          result = { outcome: 'failed', reason: err.message };
        }
        if (result.outcome === 'migrated') report.migrated += 1;
        else if (result.outcome === 'reused') report.reused += 1;
        else if (result.outcome === 'conflict') {
          report.conflicts += 1;
          report.conflictsDetail.push({
            attachmentId: attachment.attachment_id,
            documentId: attachment.document_id,
            filename: attachment.original_filename || null,
            reason: result.reason
          });
        } else {
          report.failed += 1;
          report.failedDetail.push({
            attachmentId: attachment.attachment_id,
            documentId: attachment.document_id,
            reason: result.reason
          });
        }
        if (batchDelayMs) await new Promise(r => setTimeout(r, batchDelayMs));
      }

      const last = candidates[candidates.length - 1];
      afterCreatedAt = last.created_at;
      afterId = last.attachment_id;
    }

    store.completeFileOperation(operation.id);
    store.db.prepare('UPDATE file_operations SET payload_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'blob-only-web-import-migration', report }), new Date().toISOString(), operation.id);
    return { operationId: operation.id, report };
  } catch (err) {
    store.failFileOperation(operation.id, 'migration_failed');
    throw err;
  }
}

export { DEFAULT_ARCHIVE_DIR };
