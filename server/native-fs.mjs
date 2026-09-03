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
  const target = resolveInsideRoot(rootReal, normalized);
  fs.mkdirSync(target, { recursive: true, mode: 0o755 });
  const real = fs.realpathSync(target);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new NativePathError('resolved path escapes the library root', 'path_escape');
  }
  return target;
}

// Lists a single directory level for the paginated tree view. Symlinks are
// reported with isSymlink: true and never followed.
export function listDirectoryLevel(rootPath, relativeDir = '') {
  const rootReal = resolveRootRealPath(rootPath);
  const normalized = relativeDir ? normalizeRelativePath(relativeDir, { allowHidden: false }) : '';
  const dirAbs = normalized ? resolveInsideRoot(rootReal, normalized) : rootReal;
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'EACCES') throw new NativePathError('directory is not readable', 'directory_unreadable');
    if (err.code === 'ENOENT') throw new NativePathError('directory not found', 'directory_not_found');
    throw err;
  }
  const result = [];
  for (const entry of entries) {
    const childRelative = normalized ? `${normalized}/${entry.name}` : entry.name;
    if (entry.name.startsWith('.')) continue; // hidden entries (trash area, temp files) are not listed
    if (entry.isSymbolicLink()) {
      result.push({ name: entry.name, relativePath: childRelative, type: 'symlink' });
      continue;
    }
    if (entry.isDirectory()) {
      result.push({ name: entry.name, relativePath: childRelative, type: 'directory' });
    } else if (entry.isFile()) {
      let stat = null;
      try { stat = fs.statSync(path.join(dirAbs, entry.name)); } catch {}
      result.push({
        name: entry.name,
        relativePath: childRelative,
        type: entry.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'file',
        sizeBytes: stat?.size ?? null,
        modifiedAt: stat ? Math.round(stat.mtimeMs) : null
      });
    }
  }
  result.sort((a, b) => {
    const typeOrder = a.type === 'directory' ? 0 : 1;
    const typeOrderB = b.type === 'directory' ? 0 : 1;
    if (typeOrder !== typeOrderB) return typeOrder - typeOrderB;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  return result;
}
