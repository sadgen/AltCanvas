import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasStore, canvasActorKey } from '../server/canvas-store.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function openAgentStore() {
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  const dataDir = path.resolve(projectRoot, process.env.DATA_DIR || 'data');
  process.env.DATA_DIR = dataDir;
  return new CanvasStore(path.resolve(projectRoot, process.env.CANVAS_DB_PATH || path.join(dataDir, 'altcanvas-canvas.sqlite')));
}
export function resolveAgentActor(store, username = process.env.ALTCANVAS_AGENT_USER) {
  const users = username
    ? store.db.prepare('SELECT id FROM users WHERE username=? AND role=?').all(username, 'admin')
    : store.db.prepare('SELECT id FROM users WHERE role=?').all('admin');
  if (users.length !== 1) throw new Error('Specify one administrator using ALTCANVAS_AGENT_USER or username');
  return canvasActorKey('local', users[0].id);
}
export function resolveAgentRoot(store, actor, name) {
  const matches = store.listLibraryRoots(actor).filter(root => root.displayName === name);
  if (matches.length !== 1 || !matches[0].scanEnabled) throw new Error(`Active library root not found or ambiguous: ${name}`);
  return matches[0];
}
export function boundedLimit(value, fallback = 20) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > 1000) throw new TypeError('limit must be an integer between 1 and 1000');
  return result;
}
export function isMain(url) {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url));
}
export function metadataKey(id) { return { libraryType: 'native', libraryId: 'local', itemKey: id }; }
