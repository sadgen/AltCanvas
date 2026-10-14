import fs from 'node:fs';
import path from 'node:path';
import { CanvasNotFoundError } from './canvas-store.mjs';
import { normalizeRelativePath, openFileInsideRoot } from './native-fs.mjs';

export function mappedFileLocations(actorKey, rootId, relativePath, config = process.env.AGENT_FILE_PATH_MAPPINGS || '[]') {
  let mappings;
  try { mappings = JSON.parse(config); } catch { throw new Error('Agent path mapping configuration is invalid'); }
  if (!Array.isArray(mappings)) throw new Error('Agent path mappings must be an array');
  const relative = normalizeRelativePath(relativePath);
  const locations = [];
  let cloudUnavailable = false;
  for (const mapping of mappings) {
    if (mapping.ownerKey !== actorKey || mapping.rootId !== rootId) continue;
    // An optional metadata-only inventory prevents offering nonexistent cloud files.
    if (Array.isArray(mapping.verifiedRelativePaths) && !mapping.verifiedRelativePaths.includes(relative)) {
      cloudUnavailable = true; continue;
    }
    const base = String(mapping.targetRoot || '');
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(base);
    const api = windows ? path.win32 : path.posix;
    if (!api.isAbsolute(base)) continue;
    const pieces = relative.split('/');
    if (windows && pieces.some(piece => /[<>:"|?*\x00-\x1f]/.test(piece) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(piece))) continue;
    const mapped = api.resolve(base, ...pieces);
    const inside = api.relative(api.resolve(base), mapped);
    if (inside.startsWith('..') || api.isAbsolute(inside)) continue;
    locations.push({ label: String(mapping.label || '共享目录').slice(0,80), path: mapped, onDemand: mapping.onDemand === true });
  }
  return { locations, cloudUnavailable };
}

export function getFileLocation(store, actorKey, { documentId, sourceFileId, mappings } = {}) {
  let rootId, relativePath, rootPath, filename;
  if (sourceFileId) {
    const source = store.requireSourceFile(actorKey, sourceFileId);
    const root = store.requireLibraryRoot(actorKey, source.rootId);
    if (!['active', 'duplicate'].includes(source.status)) throw new CanvasNotFoundError('Original file is unavailable');
    ({ rootId, relativePath } = source); rootPath = root.absolutePath; filename = source.filename;
  } else {
    const document = store.requireDocument(actorKey, documentId);
    const attachment = document.attachments.find(item => item.storageKind === 'source_file') || document.attachments[0];
    const content = attachment && store.getAttachmentContent(actorKey, attachment.id);
    if (!content) throw new CanvasNotFoundError('Original file is unavailable');
    filename = content.fileName;
    if (content.kind === 'source_file') {
      if (!['active', 'duplicate'].includes(content.sourceFile.status)) throw new CanvasNotFoundError('Original file is unavailable');
      store.requireLibraryRoot(actorKey, content.sourceFile.rootId);
      rootId = content.sourceFile.rootId; rootPath = content.sourceFile.rootAbsolutePath; relativePath = content.sourceFile.relativePath;
    } else {
      rootPath = store.getBlobStorageDir(); relativePath = path.relative(rootPath, content.filePath).split(path.sep).join('/');
    }
  }
  // Opening/fstat verifies existence and containment; no file contents are read.
  const opened = openFileInsideRoot(rootPath, relativePath);
  let originalPath;
  try { originalPath = opened.realpath; } finally { fs.closeSync(opened.fd); }
  const mapped = rootId ? mappedFileLocations(actorKey, rootId, relativePath, mappings) : { locations: [], cloudUnavailable: false };
  return { filename, locations: [{ label: '服务器原文路径', path: originalPath, onDemand: false }, ...mapped.locations], cloudUnavailable: mapped.cloudUnavailable };
}
