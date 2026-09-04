import fs from 'node:fs';
import path from 'node:path';
import {
  resolveRootRealPath,
  resolveInsideRoot,
  ensureVerifiedDirectory,
  ensureParentInsideRoot,
  assertWrittenInsideRoot,
  safeProbeInsideRoot,
  safeUnlinkInsideRoot,
  hashFileInsideRoot
} from './native-fs.mjs';

// M4 one-shot archival migration: existing blob-only web-import PDFs move
// into the configured library roots (default 网页导入), the attachment flips
// to source_file storage, and the managed blob is left to the existing
// reference-counted cleanup. Required properties:
//   - explicit, idempotent, re-runnable (migrated rows are skipped);
//   - the DB commits before anything blob-side is released (the migration
//     itself never deletes a blob — recoverBlobConsistency owns reaping);
//   - a DB failure compensates by removing the freshly placed file;
//   - same-content reuse instead of duplication; different-content filename
//     conflicts are recorded, never renamed and never overwritten;
//   - each run is journaled through file_operations and returns a report.

const DEFAULT_ARCHIVE_DIR = '网页导入';

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

// Deterministic per-attachment candidate: original filename recorded at
// import time, then the library title, then the blob hash prefix.
function archiveCandidateName(attachment, documentTitle) {
  const fromOriginal = sanitizeArchiveFilename(attachment.original_filename, '');
  if (fromOriginal && fromOriginal.toLowerCase() !== '.pdf') return fromOriginal;
  const fromTitle = sanitizeArchiveFilename(titleStem(documentTitle), '');
  if (fromTitle && fromTitle.toLowerCase() !== '.pdf') return fromTitle;
  return sanitizeArchiveFilename(`import-${String(attachment.blob_hash || '').slice(0, 16)}`, 'import');
}

// An already-enrolled source_file carrying the same content. Only reusable
// when it belongs to the SAME document — claiming another document's file
// would break the source_files.document_id ↔ attachment identity invariant.
function findReusableSourceFile(store, actorKey, sha256, documentId) {
  if (!sha256) return null;
  return store.db.prepare(`
    SELECT * FROM source_files
    WHERE owner_key = ? AND sha256 = ? AND status = 'active'
      AND document_id = ? AND deleted_at IS NULL
    ORDER BY created_at ASC LIMIT 1
  `).get(actorKey, sha256, documentId) || null;
}

function flipAttachmentToSourceFile(store, actorKey, attachment, sourceFileId) {
  const timestamp = new Date().toISOString();
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
}

// Migrates one attachment. Outcome: migrated | reused | conflict | failed.
async function migrateOneBlobOnlyAttachment(store, actorKey, root, attachment, targetDir) {
  const blobRow = store.getBlob(attachment.blob_hash);
  if (!blobRow) return { outcome: 'failed', reason: 'blob_row_missing' };
  const blobAbs = store.resolveBlobPath(attachment.blob_hash, '.pdf');
  if (!fs.existsSync(blobAbs)) return { outcome: 'failed', reason: 'blob_file_missing' };

  const sha256 = attachment.blob_hash;
  const documentTitle = store.getDocumentTitleById(actorKey, attachment.document_id);
  const candidateName = archiveCandidateName(attachment, documentTitle);
  const relativePathFor = name => (targetDir ? `${targetDir}/${name}` : name);
  const rootReal = resolveRootRealPath(root.absolutePath);

  // 1. Reuse this document's own enrolled source_file when one exists.
  const reusable = findReusableSourceFile(store, actorKey, sha256, attachment.document_id);
  if (reusable) {
    store.transaction(() => {
      flipAttachmentToSourceFile(store, actorKey, attachment, reusable.id);
    });
    return { outcome: 'reused', relativePath: reusable.relative_path };
  }

  // 2. Target path facts through the safe probe: conflict check.
  // Product rule: different-content filename conflict must NEVER auto-rename,
  // never overwrite, and be recorded as a conflict for the user to resolve.
  const finalName = candidateName;
  const relativePath = relativePathFor(finalName);
  const probe = safeProbeInsideRoot(rootReal, relativePath);
  if (probe.reason === 'symlink' || probe.reason === 'escape' || probe.reason === 'invalid_path') {
    return { outcome: 'conflict', reason: `unsafe_path:${probe.reason}` };
  }

  let targetAbs = null;
  if (probe.present) {
    const existingRow = store.getSourceFileByPath(actorKey, root.id, relativePath);
    const existing = await hashFileInsideRoot(rootReal, relativePath);
    if (existing.sha256 === sha256 && !existingRow) {
      // Unclaimed identical file on disk: adopt it directly as this document's source file.
      store.transaction(() => {
        const sourceFile = store.createSourceFile(actorKey, root.id, {
          relativePath,
          filename: finalName,
          sha256,
          sizeBytes: existing.sizeBytes,
          modifiedAt: Math.round(existing.mtimeMs),
          status: 'active',
          documentId: attachment.document_id,
          lastSeenAt: new Date().toISOString()
        });
        const created = store.createSourceFileAttachment(actorKey, attachment.document_id, {
          sourceFileId: sourceFile.id,
          originalFilename: finalName,
          title: documentTitle || finalName,
          sizeBytes: existing.sizeBytes
        });
        store.updateSourceFile(actorKey, sourceFile.id, { attachmentId: created.id });
        store.db.prepare(`
          UPDATE attachments SET deleted_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(new Date().toISOString(), new Date().toISOString(), attachment.attachment_id);
        store.decrementBlobRef(sha256);
      });
      return { outcome: 'migrated', relativePath, adoptedExisting: true };
    }
    // Claimed row or different content at the same name: CONFLICT (no auto-rename).
    return { outcome: 'conflict', reason: 'filename_conflict' };
  }
  targetAbs = resolveInsideRoot(rootReal, relativePath);

  // 3. Fresh placement from the verified blob path into the verified parent.
  let placedPath = null;
  try {
    ensureParentInsideRoot(rootReal, relativePathFor(finalName), { create: true });
    const staged = path.join(path.dirname(targetAbs),
      `.altcanvas-migrate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
    try {
      fs.copyFileSync(blobAbs, staged);
      const fd = fs.openSync(staged, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try {
        fs.linkSync(staged, targetAbs);
      } catch (linkErr) {
        if (linkErr.code === 'EEXIST') {
          try { fs.unlinkSync(staged); } catch {}
          return { outcome: 'reused', raced: true }; // a concurrent run won; re-run re-evaluates
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
    if (placeErr instanceof (await import('./native-fs.mjs')).NativePathError) {
      return { outcome: 'conflict', reason: `unsafe_path:${placeErr.code}` };
    }
    return { outcome: 'failed', reason: `placement_failed:${placeErr.code || placeErr.message}`.slice(0, 120) };
  }

  // 4. Single committing transaction; DB failure compensates by removing the
  // just-placed file so a re-run starts clean.
  try {
    store.transaction(() => {
      const existingRow = store.getSourceFileByPath(actorKey, root.id, relativePathFor(finalName));
      if (existingRow) {
        const err = new Error('target claimed concurrently');
        err.code = 'raced';
        throw err;
      }
      const stat = fs.statSync(placedPath);
      const sourceFile = store.createSourceFile(actorKey, root.id, {
        relativePath: relativePathFor(finalName),
        filename: finalName,
        sha256,
        sizeBytes: attachment.size_bytes || stat.size,
        modifiedAt: Math.round(stat.mtimeMs),
        status: 'active',
        documentId: attachment.document_id,
        lastSeenAt: new Date().toISOString()
      });
      const created = store.createSourceFileAttachment(actorKey, attachment.document_id, {
        sourceFileId: sourceFile.id,
        originalFilename: finalName,
        title: documentTitle || finalName,
        sizeBytes: attachment.size_bytes || stat.size
      });
      store.updateSourceFile(actorKey, sourceFile.id, { attachmentId: created.id });
      store.db.prepare(`
        UPDATE attachments SET storage_kind = 'source_file', blob_hash = NULL, source_file_id = ?,
          deleted_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(sourceFile.id, new Date().toISOString(), new Date().toISOString(), attachment.attachment_id);
      store.decrementBlobRef(sha256);
    });
    return { outcome: 'migrated', relativePath: relativePathFor(finalName) };
  } catch (dbErr) {
    try { safeUnlinkInsideRoot(root.absolutePath, relativePathFor(finalName)); } catch {}
    if (dbErr.code === 'raced') return { outcome: 'reused', raced: true };
    return { outcome: 'failed', reason: `db_failed:${dbErr.message}`.slice(0, 120) };
  }
}

// Runs the full migration for one owner against one root (or the
// deterministic default). Explicit rather than startup-automatic per spec.
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

  const candidates = store.listBlobOnlyWebImportAttachments(actorKey);
  const report = {
    scanned: candidates.length,
    migrated: 0,
    reused: 0,
    conflicts: 0,
    failed: 0,
    conflictsDetail: [],
    failedDetail: []
  };

  try {
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
