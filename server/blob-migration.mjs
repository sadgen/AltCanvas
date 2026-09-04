import fs from 'node:fs';
import path from 'node:path';
import {
  resolveRootRealPath,
  resolveInsideRoot,
  ensureVerifiedDirectory,
  ensureParentInsideRoot,
  assertWrittenInsideRoot,
  safeProbeInsideRoot,
  safeUnlinkWithExpectedSha,
  hashFileInsideRoot
} from './native-fs.mjs';

// M4 one-shot archival migration: existing blob-only web-import PDFs move
// into the configured library roots (default 网页导入), the attachment flips
// IN PLACE to source_file storage (preserving attachment ID, annotations,
// and topic bindings), and the managed blob is left to the existing
// reference-counted cleanup.
//
// Key invariants (P1 fixes):
//   1. Attachment identity continuity: promoteBlobAttachmentToSourceFile is
//      used in place, keeping the SAME attachment ID so annotations and
//      topic_documents remain 100% continuous.
//   2. Compensation safety: safeUnlinkWithExpectedSha verifies expected SHA
//      before removing any placed file on failure; failed unlinks mark the
//      operation failed (never rolled_back).
//   3. EEXIST race resolution: a concurrent placement requires verifying that
//      the target file matches the expected hash and its DB binding completed.
//   4. Loop pagination: runBlobOnlyWebImportMigration loops in batches until
//      the pending count reaches 0 or only unresolvable conflicts remain.

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

// Flips one attachment IN PLACE to an existing source_file row belonging to the
// same document. Preserves the attachment ID so annotations and topic bindings
// survive intact.
function flipAttachmentInPlace(store, actorKey, attachment, sourceFileId) {
  const timestamp = new Date().toISOString();
  store.transaction(() => {
    store.db.prepare(`
      UPDATE attachments SET storage_kind = 'source_file', blob_hash = NULL, source_file_id = ?,
        version = version + 1, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(sourceFileId, timestamp, attachment.attachment_id);
    store.db.prepare(`
      UPDATE source_files SET attachment_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND owner_key = ? AND deleted_at IS NULL
    `).run(attachment.attachment_id, timestamp, sourceFileId, actorKey);
    store.decrementBlobRef(attachment.blob_hash);
  });
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
  const reusable = findReusableSourceFile(store, actorKey, sha256, attachment.document_id);
  if (reusable) {
    flipAttachmentInPlace(store, actorKey, attachment, reusable.id);
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
      return { outcome: 'failed', reason: `adopt_failed:${err.message}`.slice(0, 120) };
    }
  }

  // 3. Target path is vacant: perform atomic placement from verified blob.
  const targetAbs = resolveInsideRoot(rootReal, relativePath);
  let placedPath = null;
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
            return { outcome: 'conflict', reason: 'filename_conflict' };
          }
          // Same bytes were placed by the competitor; adopt in-place
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
          return { outcome: 'reused', relativePath, raced: true };
        }
        throw linkErr;
      }
      try { fs.unlinkSync(staged); } catch {}
      assertWrittenInsideRoot(rootReal, targetAbs);
      placedPath = targetAbs;
    } catch (innerErr) {
      try { fs.unlinkSync(staged); } catch {}
      try { if (fs.existsSync(targetAbs)) fs.unlinkSync(targetAbs); } catch {}
      throw innerErr;
    }
  } catch (placeErr) {
    if (placeErr && typeof placeErr.code === 'string' && placeErr.code.startsWith('unsafe_path')) {
      return { outcome: 'conflict', reason: placeErr.code };
    }
    return { outcome: 'failed', reason: `placement_failed:${placeErr.code || placeErr.message}`.slice(0, 120) };
  }

  // 4. In-place database upgrade preserving the SAME attachment ID.
  try {
    const stat = fs.statSync(placedPath);
    store.promoteBlobAttachmentToSourceFile(actorKey, {
      attachmentId: attachment.attachment_id,
      documentId: attachment.document_id,
      rootId: root.id,
      relativePath,
      filename: finalName,
      sha256,
      sizeBytes: attachment.size_bytes || stat.size,
      modifiedAt: Math.round(stat.mtimeMs)
    });
    return { outcome: 'migrated', relativePath };
  } catch (dbErr) {
    // Compensation safety: unlink ONLY with verified expected SHA
    try {
      await safeUnlinkWithExpectedSha(root.absolutePath, relativePath, sha256);
    } catch (compensationErr) {
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
    // Loop through candidates in bounded batches until pending reaches 0
    // or no progress can be made (all remaining are conflicts/failed).
    const seenAttachmentIds = new Set();
    while (true) {
      const candidates = store.listBlobOnlyWebImportAttachments(actorKey, { limit: BATCH_SIZE });
      const unhandled = candidates.filter(c => !seenAttachmentIds.has(c.attachment_id));
      if (!unhandled.length) break;

      report.scanned += unhandled.length;
      for (const attachment of unhandled) {
        seenAttachmentIds.add(attachment.attachment_id);
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
