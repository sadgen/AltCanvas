import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

// Shared filesystem primitives for M4 native library management.
// Every path that reaches the disk must flow through this module so that
// absolute paths, ".." segments, NUL bytes, separator smuggling, symlink
// escapes and TOCTOU swaps are rejected in one audited place.

export const TRASH_DIR_NAME = '.altcanvas-trash';
export const SCAN_EXCLUDED_DIR_NAMES = new Set([TRASH_DIR_NAME]);

export class NativePathError extends Error {
  constructor(message, code = 'invalid_path') {
    super(message);
    this.name = 'NativePathError';
    this.code = code;
  }
}

export function isNativePathError(err) {
  return err instanceof NativePathError;
}

// Normalizes and validates a relative path supplied by a user. Returns a
// POSIX-style relative path. User-supplied paths cannot address hidden
// entries (dot segments), which keeps the trash area and editor temp files
// out of reach; the scanner bypasses this for real directories via
// normalizeDiscoveredPath below.
export function normalizeRelativePath(input, { allowHidden = false } = {}) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 1024) {
    throw new NativePathError('relative path must be a string of 1-1024 characters');
  }
  if (input.includes('\0')) throw new NativePathError('relative path must not contain NUL bytes');
  if (input.includes('\\')) throw new NativePathError('relative path must not contain backslashes');
  if (input.startsWith('/') || input.endsWith('/')) {
    throw new NativePathError('relative path must not start or end with a separator');
  }
  if (/^[a-zA-Z]:/.test(input)) throw new NativePathError('drive-qualified paths are not allowed');
  const segments = input.split('/');
  for (const segment of segments) {
    if (segment.length === 0) throw new NativePathError('relative path contains an empty segment');
    if (segment === '.' || segment === '..') {
      throw new NativePathError('relative path must not contain "." or ".." segments');
    }
    if (!allowHidden && segment.startsWith('.')) {
      throw new NativePathError('hidden files and directories are not addressable');
    }
  }
  return segments.join('/');
}

// Validates a single filename segment (rename/import targets).
export function normalizeFilename(input, { requirePdf = false } = {}) {
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > 255) {
    throw new NativePathError('filename must be a string of 1-255 characters');
  }
  const name = input.trim();
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) {
    throw new NativePathError('filename must not contain separators or NUL bytes');
  }
  if (name === '.' || name === '..' || name.startsWith('.')) {
    throw new NativePathError('hidden filenames are not allowed');
  }
  if (requirePdf && name.toLowerCase().endsWith('.pdf') === false) {
    throw new NativePathError('filename must keep the .pdf extension');
  }
  return name;
}

// Lexical containment: resolves relativePath against rootPath and refuses
// anything that would land outside the root. No filesystem access.
export function resolveInsideRoot(rootPath, relativePath) {
  const rootAbs = path.resolve(rootPath);
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new NativePathError('relative path must be a non-empty string');
  }
  const target = path.resolve(rootAbs, relativePath);
  if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
    throw new NativePathError('resolved path escapes the library root', 'path_escape');
  }
  return target;
}

// Returns the realpath of an existing directory root.
export function resolveRootRealPath(rootPath) {
  const rootAbs = path.resolve(rootPath);
  let real;
  try {
    real = fs.realpathSync(rootAbs);
  } catch {
    throw new NativePathError('library root is not available', 'library_root_unavailable');
  }
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new NativePathError('library root is not available', 'library_root_unavailable');
  }
  if (!stat.isDirectory()) {
    throw new NativePathError('library root is not a directory', 'library_root_unavailable');
  }
  return real;
}

// Opens a regular file inside root. The final path component may not be a
// symlink (O_NOFOLLOW); symlinked parents are accepted only when their
// realpath still resolves inside the root. The returned fd is the TOCTOU
// anchor: callers should fstat/read through it instead of reopening by path.
export function openFileInsideRoot(rootPath, relativePath) {
  const rootReal = resolveRootRealPath(rootPath);
  const target = resolveInsideRoot(rootReal, relativePath);
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ELOOP') {
      throw new NativePathError('symbolic link targets are not addressable', 'symlink_rejected');
    }
    if (err.code === 'ENOENT') throw new NativePathError('file not found', 'file_not_found');
    if (err.code === 'EACCES') throw new NativePathError('file is not readable', 'file_unreadable');
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new NativePathError('not a regular file', 'file_not_found');
    const real = fs.realpathSync(target);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      throw new NativePathError('resolved path escapes the library root', 'path_escape');
    }
    return { fd, absolutePath: target, realpath: real, stat };
  } catch (err) {
    try { fs.closeSync(fd); } catch {}
    throw err;
  }
}

// Streaming SHA-256 + size for a file inside root, hashed through a verified
// fd. Memory stays constant regardless of file size.
export async function hashFileInsideRoot(rootPath, relativePath) {
  const { fd, stat } = openFileInsideRoot(rootPath, relativePath);
  try {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream('', { fd, autoClose: false }), hash);
    return { sha256: hash.digest('hex'), sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// Recursively lists directory entries inside root without following symlinks,
// invoking onEntry({relativePath, absolutePath, stat}) for every regular file
// and onDirectory({relativePath, absolutePath, stat}) for every real
// subdirectory. Symbolic links (files and directories) are reported through
// onSymlink and never traversed. Batched: caller decides when to pause via the
// return value of onEntry (`false` stops the walk, e.g. between DB batches).
export function walkDirectory(rootPath, relativeDir = '', { onEntry, onDirectory, onSymlink } = {}) {
  const rootReal = resolveRootRealPath(rootPath);
  const dirAbs = relativeDir ? resolveInsideRoot(rootReal, relativeDir) : rootReal;

  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'EACCES') return; // unreadable subtree: skip, do not fabricate state
    throw err;
  }

  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const absolutePath = path.join(dirAbs, entry.name);
    if (entry.isSymbolicLink()) {
      onSymlink?.({ relativePath, absolutePath, name: entry.name });
      continue;
    }
    let stat;
    try {
      stat = entry.isDirectory() ? fs.statSync(absolutePath) : fs.lstatSync(absolutePath);
    } catch {
      continue; // vanished between readdir and stat; next scan will classify it
    }
    if (stat.isDirectory()) {
      if (SCAN_EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      const descend = onDirectory?.({ relativePath, absolutePath, name: entry.name, stat });
      if (descend === false) continue;
      walkDirectory(rootPath, relativePath, { onEntry, onDirectory, onSymlink });
    } else if (stat.isFile()) {
      if (onEntry?.({ relativePath, absolutePath, name: entry.name, stat }) === false) return;
    }
  }
}

// Ensures a directory exists inside root with safe permissions. Refuses
// hidden segments so callers cannot create entries inside the trash area.
export function ensureDirectoryInsideRoot(rootPath, relativeDir) {
  const normalized = normalizeRelativePath(relativeDir);
  const rootReal = resolveRootRealPath(rootPath);
  return ensureVerifiedDirectory(rootReal, normalized);
}

// Per-component directory resolution used by every WRITE path. Starting from
// the verified root realpath, each segment is lstat-ed in turn: a symlink at
// ANY level is rejected before anything is written, missing segments are
// created one at a time when `create` is set, and the final result is
// re-resolved through realpath to assert containment. This closes the
// parent-directory symlink escape that lexical resolution cannot see.
export function ensureVerifiedDirectory(rootReal, relativeDir, { create = false } = {}) {
  let current = rootReal;
  const segments = relativeDir ? relativeDir.split('/') : [];
  for (const segment of segments) {
    const candidate = current + path.sep + segment;
    let stat = null;
    try {
      stat = fs.lstatSync(candidate);
    } catch (err) {
      if (err.code === 'ENOENT' && create) {
        try {
          fs.mkdirSync(candidate, { mode: 0o755 });
        } catch (mkdirErr) {
          if (mkdirErr.code === 'EEXIST') {
            // Lost a race (or a symlink just appeared): re-inspect below.
          } else {
            throw mkdirErr;
          }
        }
        try {
          stat = fs.lstatSync(candidate);
        } catch {
          throw new NativePathError(`directory segment is not addressable: ${segment}`, 'invalid_path');
        }
      } else if (err.code === 'ENOENT') {
        throw new NativePathError(`directory does not exist: ${relativeDir}`, 'directory_not_found');
      } else {
        throw err;
      }
    }
    if (stat.isSymbolicLink()) {
      throw new NativePathError(`symbolic link in path is not addressable: ${segment}`, 'symlink_rejected');
    }
    if (!stat.isDirectory()) {
      throw new NativePathError(`path segment is not a directory: ${segment}`, 'invalid_path');
    }
    current = candidate;
  }
  const real = fs.realpathSync(current);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new NativePathError('resolved path escapes the library root', 'path_escape');
  }
  return { dirPath: current, realpath: real };
}

// Resolves the parent directory of a target file path with per-component
// symlink rejection (optionally creating missing directories). Returns the
// verified parent realpath plus the lexical target path inside it.
export function ensureParentInsideRoot(rootPath, targetRelativePath, { create = false } = {}) {
  const rootReal = resolveRootRealPath(rootPath);
  const target = resolveInsideRoot(rootReal, targetRelativePath);
  const parentRelative = path.posix.dirname(targetRelativePath.split('\\').join('/'));
  const normalizedParent = parentRelative === '.' ? '' : parentRelative;
  const parent = ensureVerifiedDirectory(rootReal, normalizedParent, { create });
  return { parentReal: parent.realpath, parentPath: parent.dirPath, targetPath: target };
}

// Post-write containment assertion: verifies a freshly written entry still
// resolves inside the root. Callers MUST compensate (remove/rename back) when
// this throws, guaranteeing zero side effects outside the root.
export function assertWrittenInsideRoot(rootReal, absolutePath) {
  const real = fs.realpathSync(absolutePath);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new NativePathError('written path escaped the library root', 'path_escape');
  }
  return real;
}

// Lists a single directory level for the paginated tree view. Symlinks are
// reported with isSymlink: true and never followed.
// Hard bound on the number of directory entries a single listing will read:
// keeps pagination memory O(MAX_DIRECTORY_LIST) even for pathological
// directories, reporting `truncated` instead of scanning further.
export const MAX_DIRECTORY_LIST = 20000;

// Paginated directory listing used by the tree endpoint. The requested
// directory is verified per component (any symlinked ancestor is rejected
// before a single readdir happens) and the listing streams through opendir
// with a bounded name buffer; stat calls are deferred to the requested page
// only, so neither memory nor latency scales with the whole directory.
export function listDirectoryPage(rootPath, relativeDir = '', { cursor = 0, limit = Infinity } = {}) {
  const rootReal = resolveRootRealPath(rootPath);
  const normalized = relativeDir ? normalizeRelativePath(relativeDir, { allowHidden: false }) : '';
  const verified = ensureVerifiedDirectory(rootReal, normalized, { create: false });
  const dirAbs = verified.dirPath;

  const names = [];
  let truncated = false;
  let dir;
  try {
    dir = fs.opendirSync(dirAbs);
  } catch (err) {
    if (err.code === 'EACCES') throw new NativePathError('directory is not readable', 'directory_unreadable');
    if (err.code === 'ENOENT') throw new NativePathError('directory not found', 'directory_not_found');
    throw err;
  }
  try {
    let dirent;
    while ((dirent = dir.readSync()) !== null) {
      if (dirent.name.startsWith('.')) continue; // hidden entries (trash area, temp files) are not listed
      if (names.length >= MAX_DIRECTORY_LIST) {
        // An entry beyond the cap exists: the listing is genuinely incomplete.
        // A directory with EXACTLY MAX entries must not be reported truncated,
        // so the flag is decided by the (MAX+1)-th entry, never by reaching MAX.
        truncated = true;
        break;
      }
      names.push({
        name: dirent.name,
        isDir: dirent.isDirectory(),
        isSymlink: dirent.isSymbolicLink()
      });
    }
  } catch (err) {
    if (err.code === 'EACCES') throw new NativePathError('directory is not readable', 'directory_unreadable');
    throw err;
  } finally {
    try { dir.closeSync(); } catch {}
  }

  names.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  const total = names.length;
  const safeCursor = Math.max(0, Number.isFinite(cursor) ? cursor : 0);
  const pageNames = names.slice(safeCursor, safeCursor + limit);
  const entries = pageNames.map(e => {
    const childRelative = normalized ? `${normalized}/${e.name}` : e.name;
    if (e.isSymlink) return { name: e.name, relativePath: childRelative, type: 'symlink' };
    if (e.isDir) return { name: e.name, relativePath: childRelative, type: 'directory' };
    let stat = null;
    try { stat = fs.statSync(path.join(dirAbs, e.name)); } catch {}
    return {
      name: e.name,
      relativePath: childRelative,
      type: e.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'file',
      sizeBytes: stat?.size ?? null,
      modifiedAt: stat ? Math.round(stat.mtimeMs) : null
    };
  });
  const nextCursor = safeCursor + entries.length < total ? safeCursor + entries.length : null;
  return { entries, total, cursor: safeCursor, truncated, nextCursor };
}

// Full-level listing kept for existing callers; bounded by MAX_DIRECTORY_LIST.
export function listDirectoryLevel(rootPath, relativeDir = '') {
  return listDirectoryPage(rootPath, relativeDir).entries;
}

// Recovery-safe existence probe: walks every component with lstat from the
// root realpath. Never follows a symlink at ANY level (returns
// reason 'symlink' instead), distinguishes "absent" from "unsafe", and only
// reports present=true when the final component is a real, non-symlink entry
// whose realpath stays inside the root. The controlled trash area is the one
// permitted hidden location.
export function safeProbeInsideRoot(rootPath, relativePath) {
  let rootReal;
  try {
    rootReal = resolveRootRealPath(rootPath);
  } catch (err) {
    return { present: false, reason: 'root_unavailable' };
  }
  if (typeof relativePath !== 'string' || relativePath.length === 0
    || relativePath.includes('\0') || relativePath.includes('\\')
    || relativePath.startsWith('/') || relativePath.endsWith('/')) {
    return { present: false, reason: 'invalid_path' };
  }
  const segments = relativePath.split('/');
  let current = rootReal;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.length === 0 || segment === '.' || segment === '..') {
      return { present: false, reason: 'invalid_path' };
    }
    if (segment.startsWith('.') && !(i === 0 && segment === TRASH_DIR_NAME)) {
      return { present: false, reason: 'invalid_path' };
    }
    const candidate = current + path.sep + segment;
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (err) {
      if (err.code === 'ENOENT') return { present: false, reason: 'absent' };
      return { present: false, reason: 'invalid_path' };
    }
    if (stat.isSymbolicLink()) return { present: false, reason: 'symlink' };
    const isLast = i === segments.length - 1;
    if (!isLast && !stat.isDirectory()) return { present: false, reason: 'invalid_path' };
    current = candidate;
  }
  const real = fs.realpathSync(current);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    return { present: false, reason: 'escape' };
  }
  return { present: true, absPath: current, realpath: real };
}

// Recovery-safe removal: the target must be a real non-symlink file whose
// verified parent chain stays inside the root. Errors propagate so callers
// can mark the operation failed instead of silently claiming a rollback.
export function safeUnlinkInsideRoot(rootPath, relativePath) {
  const probe = safeProbeInsideRoot(rootPath, relativePath);
  if (!probe.present) {
    const err = new NativePathError(
      probe.reason === 'absent' ? 'path does not exist inside the root' : `path is not safely addressable (${probe.reason})`,
      probe.reason === 'absent' ? 'file_not_found' : probe.reason
    );
    err.probeReason = probe.reason;
    throw err;
  }
  const stat = fs.lstatSync(probe.absPath);
  if (!stat.isFile()) {
    const err = new NativePathError('only regular files can be removed', 'invalid_path');
    err.probeReason = 'not_a_file';
    throw err;
  }
  fs.unlinkSync(probe.absPath);
  return true;
}

// Safe removal with content verification: verifies the target exists safely
// inside root (no symlink component), is a regular file, and its SHA-256
// hash matches expectedSha256 before unlinking. If the file was replaced
// concurrently by different content, unlinking is refused to prevent deleting
// foreign data during error compensation.
export async function safeUnlinkWithExpectedSha(rootPath, relativePath, expectedSha256) {
  const probe = safeProbeInsideRoot(rootPath, relativePath);
  if (!probe.present) {
    const err = new NativePathError(
      probe.reason === 'absent' ? 'path does not exist inside the root' : `path is not safely addressable (${probe.reason})`,
      probe.reason === 'absent' ? 'file_not_found' : probe.reason
    );
    err.probeReason = probe.reason;
    throw err;
  }
  const stat = fs.lstatSync(probe.absPath);
  if (!stat.isFile()) {
    const err = new NativePathError('only regular files can be removed', 'invalid_path');
    err.probeReason = 'not_a_file';
    throw err;
  }
  if (expectedSha256) {
    const hashed = await hashFileInsideRoot(rootPath, relativePath);
    if (hashed.sha256 !== expectedSha256) {
      const err = new NativePathError(
        'file content does not match expected SHA-256 for compensation removal',
        'content_mismatch'
      );
      err.probeReason = 'content_mismatch';
      throw err;
    }
  }
  fs.unlinkSync(probe.absPath);
  return true;
}
