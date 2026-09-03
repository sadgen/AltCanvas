import fs from 'node:fs';
import path from 'node:path';
import {
  TRASH_DIR_NAME,
  NativePathError,
  normalizeRelativePath,
  normalizeFilename,
  resolveInsideRoot,
  resolveRootRealPath,
  hashFileInsideRoot
} from './native-fs.mjs';

// M4 explicit file operations. Every mutation is journaled into
// file_operations before touching the disk and compensated on failure, so a
// crash between filesystem and database can always be repaired by the next
// scan (hash-based move detection) or by startup recovery.

export class FileOpError extends Error {
  constructor(message, code = 'file_operation_failed', status = 409) {
    super(message);
    this.name = 'FileOpError';
    this.code = code;
    this.status = status;
  }
}

function dirname(relativePath) {
  const idx = relativePath.lastIndexOf('/');
  return idx === -1 ? '' : relativePath.slice(0, idx);
}

function joinRelative(dir, filename) {
  return dir ? `${dir}/${filename}` : filename;
}

// Classifies a target path against the disk: null when free, duplicate_content
// when a file with identical content exists there, filename_conflict otherwise.
export async function probeTargetPath(store, actorKey, root, targetRelativePath, contentSha256) {
  const absolute = resolveInsideRoot(root.absolutePath, targetRelativePath);
  let stat = null;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    throw new FileOpError('target path is an existing directory', 'filename_conflict', 409);
  }
  if (stat.isSymbolicLink()) {
    throw new FileOpError('target path is a symbolic link', 'symlink_rejected', 400);
  }
  const diskSha = (await hashFileInsideRoot(root.absolutePath, targetRelativePath)).sha256;
  if (contentSha256 && diskSha === contentSha256) {
    return { type: 'duplicate_content', sha256: diskSha };
  }
  return { type: 'filename_conflict', sha256: diskSha };
}

// Exclusive atomic placement of a temp file into a library root. The temp
// name is hidden (dot prefix) so concurrent scans never see it; the final
// hard-link is exclusive (EEXIST loses), with an EXDEV-safe fallback.
export function placeFileIntoRoot(rootPath, targetRelativePath, tempFilePath) {
  const rootReal = resolveRootRealPath(rootPath);
  const target = resolveInsideRoot(rootReal, targetRelativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  const staged = path.join(path.dirname(target), `.${TRASH_DIR_NAME}-staging-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const cleanupStaged = () => { try { fs.unlinkSync(staged); } catch {} };
  try {
    fs.copyFileSync(tempFilePath, staged);
    const fd = fs.openSync(staged, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      fs.linkSync(staged, target);
    } catch (err) {
      if (err.code === 'EEXIST') {
        cleanupStaged();
        throw new FileOpError('target file appeared concurrently', 'filename_conflict', 409);
      }
      if (err.code !== 'EXDEV') throw err;
      // Same-directory link cannot EXDEV; kept for completeness on odd mounts.
      fs.copyFileSync(staged, target, fs.constants.COPYFILE_EXCL);
    }
    cleanupStaged();
    const dirFd = fs.openSync(path.dirname(target), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    return target;
  } catch (err) {
    cleanupStaged();
    throw err;
  }
}

function journal(store, actorKey, operationType, detail, payload = {}) {
  const op = store.createFileOperation(actorKey, {
    operationType,
    sourceFileId: detail.sourceFileId || null,
    sourcePath: detail.sourcePath || null,
    targetPath: detail.targetPath || null,
    payload
  });
  store.startFileOperation(op.id);
  return op;
}

function requireOperableRow(store, actorKey, sourceFileId, expectedVersion, { allowStatuses = ['active', 'duplicate'] } = {}) {
  const row = store.requireSourceFile(actorKey, sourceFileId);
  if (expectedVersion === null || expectedVersion === undefined) {
    throw new FileOpError('A valid If-Match header is required', 'precondition_required', 428);
  }
  if (row.version !== expectedVersion) {
    throw new FileOpError('source file version conflict', 'version_conflict', 412);
  }
  if (!allowStatuses.includes(row.status)) {
    throw new FileOpError(`source file in status ${row.status} cannot be modified this way`, 'invalid_source_file_status', 409);
  }
  return row;
}

function requireRootForRow(store, actorKey, row) {
  const root = store.requireLibraryRoot(actorKey, row.rootId);
  resolveRootRealPath(root.absolutePath); // offline gate before any filesystem action
  return root;
}

// Explicit rename inside the same directory. Never touches the library
// filename (document title). FS first, guarded DB update second, compensation
// rename back if the DB update loses a race.
export async function renameSourceFile(store, actorKey, sourceFileId, expectedVersion, rawFilename) {
  const filename = normalizeFilename(rawFilename, { requirePdf: true });
  const row = requireOperableRow(store, actorKey, sourceFileId, expectedVersion);
  const root = requireRootForRow(store, actorKey, row);
  const dir = dirname(row.relativePath);
  const targetRel = joinRelative(dir, filename);
  if (targetRel === row.relativePath) {
    return { sourceFile: row, operation: null, unchanged: true };
  }

  const conflict = await probeTargetPath(store, actorKey, root, targetRel, row.sha256);
  if (conflict) {
    throw new FileOpError(
      conflict.type === 'duplicate_content'
        ? 'a file with identical content already exists at the target name'
        : 'a different file already exists at the target name; choose a new original filename',
      conflict.type,
      409
    );
  }

  const operation = journal(store, actorKey, 'file.rename', {
    sourceFileId: row.id,
    sourcePath: row.relativePath,
    targetPath: targetRel
  }, { filename });

  const sourceAbs = resolveInsideRoot(root.absolutePath, row.relativePath);
  const targetAbs = resolveInsideRoot(root.absolutePath, targetRel);
  try {
    fs.renameSync(sourceAbs, targetAbs);
  } catch (err) {
    store.failFileOperation(operation.id, 'filesystem_rename_failed');
    throw new FileOpError(`rename failed: ${err.message}`, 'filesystem_rename_failed', 500);
  }

  try {
    const updated = store.updateSourceFileGuarded(actorKey, row.id, expectedVersion, {
      relativePath: targetRel,
      filename,
      lastSeenAt: new Date().toISOString()
    });
    store.completeFileOperation(operation.id);
    return { sourceFile: updated, operation, unchanged: false };
  } catch (dbErr) {
    try {
      fs.renameSync(targetAbs, sourceAbs); // compensation: rename back
      store.markFileOperationRolledBack(operation.id);
    } catch {
      store.failFileOperation(operation.id, 'compensation_failed');
    }
    if (dbErr instanceof FileOpError) throw dbErr;
    throw new FileOpError(`rename not applied: ${dbErr.message}`, 'version_conflict', 412);
  }
}

// Move to another directory of the same root, keeping the filename by default.
// Same filesystem uses atomic rename; cross-filesystem falls back to
// copy + fsync + hash re-verify + atomic placement + source removal.
export async function moveSourceFile(store, actorKey, sourceFileId, expectedVersion, rawTargetDir, rawFilename = null) {
  const targetDir = rawTargetDir ? normalizeRelativePath(rawTargetDir) : '';
  const row = requireOperableRow(store, actorKey, sourceFileId, expectedVersion);
  const root = requireRootForRow(store, actorKey, row);
  const filename = rawFilename ? normalizeFilename(rawFilename, { requirePdf: true }) : row.filename;
  const targetRel = joinRelative(targetDir, filename);
  if (targetRel === row.relativePath) {
    return { sourceFile: row, operation: null, unchanged: true };
  }

  const conflict = await probeTargetPath(store, actorKey, root, targetRel, row.sha256);
  if (conflict) {
    throw new FileOpError(
      conflict.type === 'duplicate_content'
        ? 'a file with identical content already exists at the target location'
        : 'a different file already exists at the target location; choose a new original filename',
      conflict.type,
      409
    );
  }

  const operation = journal(store, actorKey, 'file.move', {
    sourceFileId: row.id,
    sourcePath: row.relativePath,
    targetPath: targetRel
  }, { targetDir, filename });

  const sourceAbs = resolveInsideRoot(root.absolutePath, row.relativePath);
  const targetAbs = resolveInsideRoot(root.absolutePath, targetRel);

  const persist = () => store.updateSourceFileGuarded(actorKey, row.id, expectedVersion, {
    relativePath: targetRel,
    filename,
    lastSeenAt: new Date().toISOString()
  });

  try {
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true, mode: 0o755 });
    try {
      fs.renameSync(sourceAbs, targetAbs);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      // Cross-filesystem: copy, fsync, hash-verify, atomic placement, then remove source.
      const placed = placeFileIntoRoot(root.absolutePath, targetRel, sourceAbs);
      const verified = await hashFileInsideRoot(root.absolutePath, targetRel);
      if (row.sha256 && verified.sha256 !== row.sha256) {
        try { fs.unlinkSync(placed); } catch {}
        throw new Error('copy hash verification failed');
      }
      fs.unlinkSync(sourceAbs);
    }
  } catch (err) {
    store.failFileOperation(operation.id, 'filesystem_move_failed');
    throw new FileOpError(`move failed: ${err.message}`, 'filesystem_move_failed', 500);
  }

  try {
    const updated = persist();
    store.completeFileOperation(operation.id);
    return { sourceFile: updated, operation, unchanged: false };
  } catch (dbErr) {
    try {
      fs.renameSync(targetAbs, sourceAbs); // compensation: move back
      store.markFileOperationRolledBack(operation.id);
    } catch {
      store.failFileOperation(operation.id, 'compensation_failed');
    }
    if (dbErr instanceof FileOpError) throw dbErr;
    throw new FileOpError(`move not applied: ${dbErr.message}`, 'version_conflict', 412);
  }
}

// 删除原始文件: move into the controlled per-root trash directory. The library
// identity, topics, annotations and analyses all stay bound to the row.
export async function trashSourceFile(store, actorKey, sourceFileId, expectedVersion) {
  const row = requireOperableRow(store, actorKey, sourceFileId, expectedVersion,
    { allowStatuses: ['active', 'duplicate', 'unreadable'] });
  const root = requireRootForRow(store, actorKey, row);
  const trashRel = `${TRASH_DIR_NAME}/${row.id}.pdf`;
  const trashAbs = resolveInsideRoot(root.absolutePath, trashRel);

  const operation = journal(store, actorKey, 'file.trash', {
    sourceFileId: row.id,
    sourcePath: row.relativePath,
    targetPath: trashRel
  }, {});

  fs.mkdirSync(path.dirname(trashAbs), { recursive: true, mode: 0o700 });

  const sourceAbs = resolveInsideRoot(root.absolutePath, row.relativePath);
  const fileOnDisk = fs.existsSync(sourceAbs);
  let moved = false;
  try {
    if (fileOnDisk) {
      try {
        fs.unlinkSync(trashAbs); // replace stale trash copies of the same row id
      } catch {}
      fs.renameSync(resolveInsideRoot(root.absolutePath, row.relativePath), trashAbs);
      moved = true;
    }
  } catch (err) {
    store.failFileOperation(operation.id, 'filesystem_trash_failed');
    throw new FileOpError(`trash failed: ${err.message}`, 'filesystem_trash_failed', 500);
  }

  try {
    const updated = store.updateSourceFileGuarded(actorKey, row.id, expectedVersion, {
      status: 'trashed',
      trashedAt: new Date().toISOString()
    });
    store.completeFileOperation(operation.id);
    return { sourceFile: updated, operation, moved };
  } catch (dbErr) {
    if (moved) {
      try {
        fs.renameSync(trashAbs, resolveInsideRoot(root.absolutePath, row.relativePath));
        store.markFileOperationRolledBack(operation.id);
      } catch {
        store.failFileOperation(operation.id, 'compensation_failed');
      }
    } else {
      store.failFileOperation(operation.id, 'version_conflict');
    }
    if (dbErr instanceof FileOpError) throw dbErr;
    throw new FileOpError(`trash not applied: ${dbErr.message}`, 'version_conflict', 412);
  }
}

// Restore from trash back to the recorded original path. Content conflicts at
// the original path follow the standard two-name rules.
export async function restoreSourceFile(store, actorKey, sourceFileId, expectedVersion, alternativeFilename = null) {
  const row = requireOperableRow(store, actorKey, sourceFileId, expectedVersion,
    { allowStatuses: ['trashed'] });
  const root = requireRootForRow(store, actorKey, row);
  const trashAbs = resolveInsideRoot(root.absolutePath, `${TRASH_DIR_NAME}/${row.id}.pdf`);

  let targetRel = row.relativePath;
  if (alternativeFilename) {
    const filename = normalizeFilename(alternativeFilename, { requirePdf: true });
    targetRel = joinRelative(dirname(row.relativePath), filename);
  }

  if (!fs.existsSync(trashAbs)) {
    // Trash file was removed externally: restore by bookkeeping only.
    const updated = store.updateSourceFileGuarded(actorKey, row.id, expectedVersion, {
      status: 'active',
      trashedAt: null,
      relativePath: targetRel,
      filename: path.posix.basename(targetRel)
    });
    return { sourceFile: updated, operation: null, moved: false };
  }

  if (fs.existsSync(resolveInsideRoot(root.absolutePath, targetRel))) {
    const diskSha = (await hashFileInsideRoot(root.absolutePath, targetRel)).sha256;
    throw new FileOpError(
      diskSha === row.sha256
        ? 'a file with identical content already exists at the original path'
        : 'a different file exists at the original path; provide a new filename',
      diskSha === row.sha256 ? 'duplicate_content' : 'filename_conflict',
      409
    );
  }

  const operation = journal(store, actorKey, 'file.restore', {
    sourceFileId: row.id,
    sourcePath: `${TRASH_DIR_NAME}/${row.id}.pdf`,
    targetPath: targetRel
  }, { filename: path.posix.basename(targetRel) });

  try {
    fs.mkdirSync(path.dirname(resolveInsideRoot(root.absolutePath, targetRel)), { recursive: true, mode: 0o755 });
    fs.renameSync(trashAbs, resolveInsideRoot(root.absolutePath, targetRel));
  } catch (err) {
    store.failFileOperation(operation.id, 'filesystem_restore_failed');
    throw new FileOpError(`restore failed: ${err.message}`, 'filesystem_restore_failed', 500);
  }

  try {
    const updated = store.updateSourceFileGuarded(actorKey, row.id, expectedVersion, {
      status: 'active',
      trashedAt: null,
      relativePath: targetRel,
      filename: path.posix.basename(targetRel)
    });
    store.completeFileOperation(operation.id);
    return { sourceFile: updated, operation, moved: true };
  } catch (dbErr) {
    try {
      fs.renameSync(resolveInsideRoot(root.absolutePath, targetRel), trashAbs);
      store.markFileOperationRolledBack(operation.id);
    } catch {
      store.failFileOperation(operation.id, 'compensation_failed');
    }
    if (dbErr instanceof FileOpError) throw dbErr;
    throw new FileOpError(`restore not applied: ${dbErr.message}`, 'version_conflict', 412);
  }
}

// 永久删除: drop the trashed file on disk and purge every binding.
export async function deleteSourceFilePermanent(store, actorKey, sourceFileId, expectedVersion) {
  const row = requireOperableRow(store, actorKey, sourceFileId, expectedVersion,
    { allowStatuses: ['trashed'] });
  const root = requireRootForRow(store, actorKey, row);
  const trashAbs = resolveInsideRoot(root.absolutePath, `${TRASH_DIR_NAME}/${row.id}.pdf`);

  const operation = journal(store, actorKey, 'file.delete_permanent', {
    sourceFileId: row.id,
    sourcePath: `${TRASH_DIR_NAME}/${row.id}.pdf`
  }, { documentId: row.documentId });

  try {
    if (fs.existsSync(trashAbs)) fs.unlinkSync(trashAbs);
  } catch (err) {
    store.failFileOperation(operation.id, 'filesystem_delete_failed');
    throw new FileOpError(`permanent delete failed: ${err.message}`, 'filesystem_delete_failed', 500);
  }

  try {
    store.purgeTrashedSourceFile(actorKey, row.id);
    store.completeFileOperation(operation.id);
    return { operation, deleted: true };
  } catch (dbErr) {
    store.failFileOperation(operation.id, 'purge_failed');
    throw new FileOpError(`permanent delete not applied: ${dbErr.message}`, 'purge_failed', 500);
  }
}
