import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const NODE_TYPES = new Set([
  'annotation', 'manual_note', 'zotero_item', 'attachment', 'image', 'ai_output', 'group'
]);
const EDGE_RELATIONS = new Set([
  'related', 'supports', 'contradicts', 'causes', 'cites', 'custom'
]);

export class CanvasNotFoundError extends Error {}
export class CanvasConflictError extends Error {}

export function canvasActorKey(issuer, subject) {
  if (!issuer || !subject) return null;
  return crypto.createHash('sha256').update(`${issuer}\0${subject}`).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function id() {
  return crypto.randomUUID();
}

function loadOrCreateAiSettingsKey(dbPath) {
  const configuredSecret = String(process.env.AI_SETTINGS_SECRET || '').trim();
  if (configuredSecret) return crypto.createHash('sha256').update(configuredSecret).digest();
  const keyPath = path.resolve(process.env.AI_SETTINGS_KEY_FILE || path.join(path.dirname(dbPath), 'ai-settings.key'));
  const readKey = () => {
    const key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error('AI settings encryption key is invalid');
    return key;
  };
  if (fs.existsSync(keyPath)) return readKey();
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyPath, key.toString('base64'), { mode: 0o600, flag: 'wx' });
    return key;
  } catch (err) {
    if (err.code === 'EEXIST') return readKey();
    throw err;
  }
}

function encryptAiSecret(key, value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  });
}

function decryptAiSecret(key, value) {
  if (!value) return '';
  const payload = JSON.parse(value);
  if (payload.version !== 1) throw new Error('unsupported AI settings encryption version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function parseJson(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function workspaceRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function boardRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    viewport: {
      x: row.viewport_x,
      y: row.viewport_y,
      zoom: row.viewport_zoom
    },
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sourceRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    libraryType: row.library_type,
    libraryId: row.library_id,
    itemKey: row.item_key,
    attachmentKey: row.attachment_key,
    annotationKey: row.annotation_key,
    annotationVersion: row.annotation_version,
    pageLabel: row.page_label,
    position: parseJson(row.position_json),
    quoteSnapshot: row.quote_snapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function nodeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    boardId: row.board_id,
    type: row.node_type,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    zIndex: row.z_index,
    title: row.title,
    body: row.body,
    color: row.color,
    sourceRefId: row.source_ref_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function edgeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    boardId: row.board_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    relation: row.relation,
    label: row.label,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function provenanceRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    boardId: row.board_id,
    nodeId: row.node_id,
    actorKey: row.actor_key,
    type: row.event_type,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at
  };
}

export class CanvasStore {
  constructor(dbPath = process.env.CANVAS_DB_PATH
    || path.join(process.env.DATA_DIR || './data', 'altcanvas-canvas.sqlite')) {
    this.dbPath = path.resolve(dbPath);
    const dataDirectory = path.dirname(this.dbPath);
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDirectory, 0o700);
    if (!fs.existsSync(this.dbPath)) fs.closeSync(fs.openSync(this.dbPath, 'a', 0o600));
    fs.chmodSync(this.dbPath, 0o600);
    this.aiSettingsKey = loadOrCreateAiSettingsKey(this.dbPath);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
    for (const filePath of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const current = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;
    if (current < 1) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE workspaces (
            id TEXT PRIMARY KEY,
            owner_key TEXT NOT NULL,
            name TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
          ) STRICT;
          CREATE INDEX workspaces_owner_idx ON workspaces(owner_key, deleted_at, updated_at);

          CREATE TABLE boards (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id),
            name TEXT NOT NULL,
            viewport_x REAL NOT NULL DEFAULT 0,
            viewport_y REAL NOT NULL DEFAULT 0,
            viewport_zoom REAL NOT NULL DEFAULT 1,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
          ) STRICT;
          CREATE INDEX boards_workspace_idx ON boards(workspace_id, deleted_at, updated_at);

          CREATE TABLE source_refs (
            id TEXT PRIMARY KEY,
            owner_key TEXT NOT NULL,
            library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group')),
            library_id TEXT NOT NULL,
            item_key TEXT,
            attachment_key TEXT,
            annotation_key TEXT,
            annotation_version INTEGER,
            page_label TEXT,
            position_json TEXT,
            quote_snapshot TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX source_refs_owner_idx ON source_refs(owner_key, library_type, library_id);

          CREATE TABLE nodes (
            id TEXT PRIMARY KEY,
            board_id TEXT NOT NULL REFERENCES boards(id),
            node_type TEXT NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL,
            width REAL NOT NULL,
            height REAL NOT NULL,
            z_index INTEGER NOT NULL DEFAULT 0,
            title TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            color TEXT,
            source_ref_id TEXT REFERENCES source_refs(id),
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
          ) STRICT;
          CREATE INDEX nodes_board_idx ON nodes(board_id, deleted_at, z_index);

          CREATE TABLE edges (
            id TEXT PRIMARY KEY,
            board_id TEXT NOT NULL REFERENCES boards(id),
            source_node_id TEXT NOT NULL REFERENCES nodes(id),
            target_node_id TEXT NOT NULL REFERENCES nodes(id),
            relation TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            CHECK (source_node_id <> target_node_id)
          ) STRICT;
          CREATE INDEX edges_board_idx ON edges(board_id, deleted_at);

          CREATE TABLE provenance_events (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id),
            board_id TEXT REFERENCES boards(id),
            node_id TEXT REFERENCES nodes(id),
            actor_key TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX provenance_workspace_idx ON provenance_events(workspace_id, created_at);
        `);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(1, nowIso());
      });
    }
    if (current < 2) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE ai_settings (
            owner_key TEXT PRIMARY KEY,
            base_url TEXT NOT NULL,
            model TEXT NOT NULL,
            api_key_encrypted TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
        `);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(2, nowIso());
      });
    }
    if (current > 2) throw new Error(`Canvas database schema ${current} is newer than this server supports`);
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  recordEvent({ workspaceId, boardId = null, nodeId = null, actorKey, type, payload = {} }) {
    this.db.prepare(`
      INSERT INTO provenance_events
        (id, workspace_id, board_id, node_id, actor_key, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id(), workspaceId, boardId, nodeId, actorKey, type, JSON.stringify(payload), nowIso());
  }

  getAiSettings(actorKey) {
    const row = this.db.prepare('SELECT * FROM ai_settings WHERE owner_key = ?').get(actorKey);
    if (!row) return null;
    return {
      baseUrl: row.base_url,
      model: row.model,
      apiKey: decryptAiSecret(this.aiSettingsKey, row.api_key_encrypted),
      updatedAt: row.updated_at
    };
  }

  saveAiSettings(actorKey, { baseUrl, model, apiKey }) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO ai_settings(owner_key, base_url, model, api_key_encrypted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_key) DO UPDATE SET
        base_url = excluded.base_url,
        model = excluded.model,
        api_key_encrypted = excluded.api_key_encrypted,
        updated_at = excluded.updated_at
    `).run(actorKey, baseUrl, model, encryptAiSecret(this.aiSettingsKey, apiKey), timestamp, timestamp);
    return this.getAiSettings(actorKey);
  }

  clearAiSettings(actorKey) {
    return this.db.prepare('DELETE FROM ai_settings WHERE owner_key = ?').run(actorKey).changes > 0;
  }

  listWorkspaces(actorKey) {
    return this.db.prepare(`
      SELECT * FROM workspaces WHERE owner_key = ? AND deleted_at IS NULL ORDER BY updated_at DESC
    `).all(actorKey).map(workspaceRow);
  }

  getWorkspace(actorKey, workspaceId) {
    return workspaceRow(this.db.prepare(`
      SELECT * FROM workspaces WHERE id = ? AND owner_key = ? AND deleted_at IS NULL
    `).get(workspaceId, actorKey));
  }

  requireWorkspace(actorKey, workspaceId) {
    const workspace = this.getWorkspace(actorKey, workspaceId);
    if (!workspace) throw new CanvasNotFoundError('workspace not found');
    return workspace;
  }

  createWorkspace(actorKey, { name }) {
    const workspaceId = id();
    const timestamp = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO workspaces(id, owner_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      `).run(workspaceId, actorKey, name, timestamp, timestamp);
      this.recordEvent({ workspaceId, actorKey, type: 'workspace.created', payload: { name } });
    });
    return this.getWorkspace(actorKey, workspaceId);
  }

  updateWorkspace(actorKey, workspaceId, version, { name }) {
    this.requireWorkspace(actorKey, workspaceId);
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE workspaces SET name = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND owner_key = ? AND deleted_at IS NULL AND version = ?
      `).run(name, nowIso(), workspaceId, actorKey, version);
      if (!result.changes) throw new CanvasConflictError('workspace version conflict');
      this.recordEvent({ workspaceId, actorKey, type: 'workspace.updated', payload: { name } });
    });
    return this.getWorkspace(actorKey, workspaceId);
  }

  deleteWorkspace(actorKey, workspaceId, version) {
    this.requireWorkspace(actorKey, workspaceId);
    const timestamp = nowIso();
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE workspaces SET deleted_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND owner_key = ? AND deleted_at IS NULL AND version = ?
      `).run(timestamp, timestamp, workspaceId, actorKey, version);
      if (!result.changes) throw new CanvasConflictError('workspace version conflict');
      this.recordEvent({ workspaceId, actorKey, type: 'workspace.deleted' });
    });
  }

  listBoards(actorKey, workspaceId) {
    this.requireWorkspace(actorKey, workspaceId);
    return this.db.prepare(`
      SELECT b.* FROM boards b JOIN workspaces w ON w.id = b.workspace_id
      WHERE b.workspace_id = ? AND w.owner_key = ? AND b.deleted_at IS NULL AND w.deleted_at IS NULL
      ORDER BY b.updated_at DESC
    `).all(workspaceId, actorKey).map(boardRow);
  }

  getBoard(actorKey, boardId) {
    return boardRow(this.db.prepare(`
      SELECT b.* FROM boards b JOIN workspaces w ON w.id = b.workspace_id
      WHERE b.id = ? AND w.owner_key = ? AND b.deleted_at IS NULL AND w.deleted_at IS NULL
    `).get(boardId, actorKey));
  }

  requireBoard(actorKey, boardId) {
    const board = this.getBoard(actorKey, boardId);
    if (!board) throw new CanvasNotFoundError('board not found');
    return board;
  }

  createBoard(actorKey, workspaceId, { name }) {
    this.requireWorkspace(actorKey, workspaceId);
    const boardId = id();
    const timestamp = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO boards(id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      `).run(boardId, workspaceId, name, timestamp, timestamp);
      this.recordEvent({ workspaceId, boardId, actorKey, type: 'board.created', payload: { name } });
    });
    return this.getBoard(actorKey, boardId);
  }

  updateBoard(actorKey, boardId, version, changes) {
    const board = this.requireBoard(actorKey, boardId);
    const name = changes.name ?? board.name;
    const viewport = changes.viewport ?? board.viewport;
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE boards SET name = ?, viewport_x = ?, viewport_y = ?, viewport_zoom = ?,
          version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND deleted_at IS NULL
      `).run(name, viewport.x, viewport.y, viewport.zoom, nowIso(), boardId, version);
      if (!result.changes) throw new CanvasConflictError('board version conflict');
      this.recordEvent({ workspaceId: board.workspaceId, boardId, actorKey, type: 'board.updated', payload: changes });
    });
    return this.getBoard(actorKey, boardId);
  }

  deleteBoard(actorKey, boardId, version) {
    const board = this.requireBoard(actorKey, boardId);
    const timestamp = nowIso();
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE boards SET deleted_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND deleted_at IS NULL
      `).run(timestamp, timestamp, boardId, version);
      if (!result.changes) throw new CanvasConflictError('board version conflict');
      this.recordEvent({ workspaceId: board.workspaceId, boardId, actorKey, type: 'board.deleted' });
    });
  }

  createSourceRef(actorKey, source) {
    const sourceId = id();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO source_refs
        (id, owner_key, library_type, library_id, item_key, attachment_key, annotation_key,
         annotation_version, page_label, position_json, quote_snapshot, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sourceId, actorKey, source.libraryType, source.libraryId, source.itemKey || null,
      source.attachmentKey || null, source.annotationKey || null, source.annotationVersion ?? null,
      source.pageLabel || null, source.position ? JSON.stringify(source.position) : null,
      source.quoteSnapshot || null, timestamp, timestamp
    );
    return sourceId;
  }

  createNode(actorKey, boardId, input) {
    if (!NODE_TYPES.has(input.type)) throw new TypeError('invalid node type');
    const board = this.requireBoard(actorKey, boardId);
    const nodeId = id();
    const timestamp = nowIso();
    this.transaction(() => {
      const sourceRefId = input.source ? this.createSourceRef(actorKey, input.source) : null;
      this.db.prepare(`
        INSERT INTO nodes
          (id, board_id, node_type, x, y, width, height, z_index, title, body, color,
           source_ref_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        nodeId, boardId, input.type, input.x, input.y, input.width, input.height,
        input.zIndex ?? 0, input.title || '', input.body || '', input.color || null,
        sourceRefId, timestamp, timestamp
      );
      this.recordEvent({
        workspaceId: board.workspaceId, boardId, nodeId, actorKey, type: 'node.created',
        payload: { nodeType: input.type, sourceRefId }
      });
    });
    return this.getNode(actorKey, nodeId);
  }

  getNode(actorKey, nodeId) {
    return nodeRow(this.db.prepare(`
      SELECT n.* FROM nodes n JOIN boards b ON b.id = n.board_id
      JOIN workspaces w ON w.id = b.workspace_id
      WHERE n.id = ? AND w.owner_key = ? AND n.deleted_at IS NULL
        AND b.deleted_at IS NULL AND w.deleted_at IS NULL
    `).get(nodeId, actorKey));
  }

  updateNode(actorKey, nodeId, version, changes) {
    const node = this.getNode(actorKey, nodeId);
    if (!node) throw new CanvasNotFoundError('node not found');
    const type = changes.type ?? node.type;
    if (!NODE_TYPES.has(type)) throw new TypeError('invalid node type');
    const values = {
      x: changes.x ?? node.x, y: changes.y ?? node.y,
      width: changes.width ?? node.width, height: changes.height ?? node.height,
      zIndex: changes.zIndex ?? node.zIndex, title: changes.title ?? node.title,
      body: changes.body ?? node.body, color: changes.color === undefined ? node.color : changes.color
    };
    const board = this.requireBoard(actorKey, node.boardId);
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE nodes SET node_type = ?, x = ?, y = ?, width = ?, height = ?, z_index = ?,
          title = ?, body = ?, color = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND deleted_at IS NULL
      `).run(type, values.x, values.y, values.width, values.height, values.zIndex,
        values.title, values.body, values.color, nowIso(), nodeId, version);
      if (!result.changes) throw new CanvasConflictError('node version conflict');
      this.recordEvent({ workspaceId: board.workspaceId, boardId: node.boardId, nodeId, actorKey, type: 'node.updated', payload: changes });
    });
    return this.getNode(actorKey, nodeId);
  }

  replaceNodeSource(actorKey, nodeId, version, source) {
    const node = this.getNode(actorKey, nodeId);
    if (!node) throw new CanvasNotFoundError('node not found');
    const board = this.requireBoard(actorKey, node.boardId);
    let sourceRefId;
    this.transaction(() => {
      sourceRefId = this.createSourceRef(actorKey, source);
      const result = this.db.prepare(`
        UPDATE nodes SET source_ref_id = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND deleted_at IS NULL
      `).run(sourceRefId, nowIso(), nodeId, version);
      if (!result.changes) throw new CanvasConflictError('node version conflict');
      this.recordEvent({
        workspaceId: board.workspaceId,
        boardId: node.boardId,
        nodeId,
        actorKey,
        type: 'node.source_relinked',
        payload: {
          previousSourceRefId: node.sourceRefId,
          sourceRefId,
          annotationKey: source.annotationKey || null
        }
      });
    });
    return {
      node: this.getNode(actorKey, nodeId),
      source: sourceRow(this.db.prepare(`
        SELECT * FROM source_refs WHERE id = ? AND owner_key = ?
      `).get(sourceRefId, actorKey))
    };
  }

  deleteNode(actorKey, nodeId, version) {
    const node = this.getNode(actorKey, nodeId);
    if (!node) throw new CanvasNotFoundError('node not found');
    const board = this.requireBoard(actorKey, node.boardId);
    const timestamp = nowIso();
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE nodes SET deleted_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND deleted_at IS NULL
      `).run(timestamp, timestamp, nodeId, version);
      if (!result.changes) throw new CanvasConflictError('node version conflict');
      this.db.prepare(`
        UPDATE edges SET deleted_at = ?, version = version + 1, updated_at = ?
        WHERE (source_node_id = ? OR target_node_id = ?) AND deleted_at IS NULL
      `).run(timestamp, timestamp, nodeId, nodeId);
      this.recordEvent({ workspaceId: board.workspaceId, boardId: node.boardId, nodeId, actorKey, type: 'node.deleted' });
    });
  }

  restoreNode(actorKey, nodeId, version) {
    const row = this.db.prepare(`
      SELECT n.*, b.workspace_id FROM nodes n
      JOIN boards b ON b.id = n.board_id
      JOIN workspaces w ON w.id = b.workspace_id
      WHERE n.id = ? AND w.owner_key = ? AND n.deleted_at IS NOT NULL
        AND b.deleted_at IS NULL AND w.deleted_at IS NULL
    `).get(nodeId, actorKey);
    if (!row) throw new CanvasNotFoundError('deleted node not found');
    const deletedAt = row.deleted_at;
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE nodes SET deleted_at = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND deleted_at = ?
      `).run(nowIso(), nodeId, version, deletedAt);
      if (!result.changes) throw new CanvasConflictError('node restore version conflict');
      this.db.prepare(`
        UPDATE edges SET deleted_at = NULL, version = version + 1, updated_at = ?
        WHERE deleted_at = ? AND (source_node_id = ? OR target_node_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM nodes endpoint
            WHERE endpoint.id IN (edges.source_node_id, edges.target_node_id)
              AND endpoint.deleted_at IS NOT NULL
          )
      `).run(nowIso(), deletedAt, nodeId, nodeId);
      this.recordEvent({
        workspaceId: row.workspace_id, boardId: row.board_id, nodeId,
        actorKey, type: 'node.restored'
      });
    });
    return this.getNode(actorKey, nodeId);
  }

  createEdge(actorKey, boardId, input) {
    if (!EDGE_RELATIONS.has(input.relation)) throw new TypeError('invalid edge relation');
    const board = this.requireBoard(actorKey, boardId);
    const source = this.getNode(actorKey, input.sourceNodeId);
    const target = this.getNode(actorKey, input.targetNodeId);
    if (!source || !target || source.boardId !== boardId || target.boardId !== boardId || source.id === target.id) {
      throw new CanvasNotFoundError('edge nodes not found on board');
    }
    const edgeId = id();
    const timestamp = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO edges
          (id, board_id, source_node_id, target_node_id, relation, label, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(edgeId, boardId, source.id, target.id, input.relation, input.label || '', timestamp, timestamp);
      this.recordEvent({ workspaceId: board.workspaceId, boardId, actorKey, type: 'edge.created', payload: { edgeId } });
    });
    return this.getEdge(actorKey, edgeId);
  }

  getEdge(actorKey, edgeId) {
    return edgeRow(this.db.prepare(`
      SELECT e.* FROM edges e JOIN boards b ON b.id = e.board_id
      JOIN workspaces w ON w.id = b.workspace_id
      WHERE e.id = ? AND w.owner_key = ? AND e.deleted_at IS NULL
        AND b.deleted_at IS NULL AND w.deleted_at IS NULL
    `).get(edgeId, actorKey));
  }

  updateEdge(actorKey, edgeId, version, changes) {
    const edge = this.getEdge(actorKey, edgeId);
    if (!edge) throw new CanvasNotFoundError('edge not found');
    const relation = changes.relation ?? edge.relation;
    if (!EDGE_RELATIONS.has(relation)) throw new TypeError('invalid edge relation');
    const label = changes.label ?? edge.label;
    const board = this.requireBoard(actorKey, edge.boardId);
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE edges SET relation = ?, label = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND deleted_at IS NULL
      `).run(relation, label, nowIso(), edgeId, version);
      if (!result.changes) throw new CanvasConflictError('edge version conflict');
      this.recordEvent({ workspaceId: board.workspaceId, boardId: edge.boardId, actorKey, type: 'edge.updated', payload: { edgeId, ...changes } });
    });
    return this.getEdge(actorKey, edgeId);
  }

  deleteEdge(actorKey, edgeId, version) {
    const edge = this.getEdge(actorKey, edgeId);
    if (!edge) throw new CanvasNotFoundError('edge not found');
    const board = this.requireBoard(actorKey, edge.boardId);
    const timestamp = nowIso();
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE edges SET deleted_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND deleted_at IS NULL
      `).run(timestamp, timestamp, edgeId, version);
      if (!result.changes) throw new CanvasConflictError('edge version conflict');
      this.recordEvent({ workspaceId: board.workspaceId, boardId: edge.boardId, actorKey, type: 'edge.deleted', payload: { edgeId } });
    });
  }

  snapshot(actorKey, boardId) {
    const board = this.requireBoard(actorKey, boardId);
    const nodes = this.db.prepare(`
      SELECT * FROM nodes WHERE board_id = ? AND deleted_at IS NULL ORDER BY z_index, created_at
    `).all(boardId).map(nodeRow);
    const edges = this.db.prepare(`
      SELECT * FROM edges WHERE board_id = ? AND deleted_at IS NULL ORDER BY created_at
    `).all(boardId).map(edgeRow);
    const sourceIds = nodes.map(node => node.sourceRefId).filter(Boolean);
    const sources = sourceIds.length
      ? this.db.prepare(`SELECT * FROM source_refs WHERE owner_key = ? AND id IN (${sourceIds.map(() => '?').join(',')})`)
        .all(actorKey, ...sourceIds).map(sourceRow)
      : [];
    return { board, nodes, edges, sources };
  }

  updateLayout(actorKey, boardId, boardVersion, { viewport, nodes }) {
    const board = this.requireBoard(actorKey, boardId);
    return this.transaction(() => {
      const boardResult = this.db.prepare(`
        UPDATE boards SET viewport_x = ?, viewport_y = ?, viewport_zoom = ?,
          version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND deleted_at IS NULL
      `).run(viewport.x, viewport.y, viewport.zoom, nowIso(), boardId, boardVersion);
      if (!boardResult.changes) throw new CanvasConflictError('board version conflict');
      for (const update of nodes) {
        const nodeResult = this.db.prepare(`
          UPDATE nodes SET x = ?, y = ?, width = ?, height = ?, z_index = ?,
            version = version + 1, updated_at = ?
          WHERE id = ? AND board_id = ? AND version = ? AND deleted_at IS NULL
        `).run(update.x, update.y, update.width, update.height, update.zIndex, nowIso(),
          update.id, boardId, update.version);
        if (!nodeResult.changes) throw new CanvasConflictError(`node version conflict: ${update.id}`);
      }
      this.recordEvent({ workspaceId: board.workspaceId, boardId, actorKey, type: 'board.layout_updated', payload: { nodeCount: nodes.length } });
      return this.snapshot(actorKey, boardId);
    });
  }

  exportBoard(actorKey, boardId) {
    const snap = this.snapshot(actorKey, boardId);
    return {
      format: 'altcanvas-board-export',
      schemaVersion: 1,
      exportedAt: nowIso(),
      board: snap.board,
      nodes: snap.nodes,
      edges: snap.edges,
      sources: snap.sources
    };
  }

  importBoard(actorKey, workspaceId, bundle, options = {}) {
    this.requireWorkspace(actorKey, workspaceId);
    if (!bundle || typeof bundle !== 'object') throw new TypeError('invalid bundle object');
    if (bundle.format !== 'altcanvas-board-export' || ![1, 2].includes(bundle.schemaVersion)) {
      throw new TypeError('unsupported bundle format or schema version');
    }
    if (!bundle.board || typeof bundle.board !== 'object') throw new TypeError('bundle missing board');
    if (!Array.isArray(bundle.nodes)) throw new TypeError('bundle missing nodes array');
    if (!Array.isArray(bundle.edges)) throw new TypeError('bundle missing edges array');
    const sourcesList = Array.isArray(bundle.sources) ? bundle.sources : [];
    if (bundle.nodes.length > 500 || sourcesList.length > 500 || bundle.edges.length > 1000) {
      throw new TypeError('bundle exceeds import limits');
    }

    const newBoardId = id();
    const timestamp = nowIso();
    const boardName = options.name || (bundle.board.name ? `${bundle.board.name} (导入)` : '导入画板');
    const viewport = bundle.board.viewport || { x: 0, y: 0, zoom: 1 };

    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO boards(id, workspace_id, name, viewport_x, viewport_y, viewport_zoom, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(newBoardId, workspaceId, boardName, viewport.x || 0, viewport.y || 0, viewport.zoom || 1, timestamp, timestamp);

      const sourceIdMap = new Map();
      for (const src of sourcesList) {
        if (!src || !src.id || sourceIdMap.has(src.id)) throw new TypeError('invalid or duplicate source in bundle');
        const newSourceId = this.createSourceRef(actorKey, {
          libraryType: src.libraryType || 'user',
          libraryId: src.libraryId || '',
          itemKey: src.itemKey || null,
          attachmentKey: src.attachmentKey || null,
          annotationKey: src.annotationKey || null,
          annotationVersion: src.annotationVersion ?? null,
          pageLabel: src.pageLabel || null,
          position: src.position || null,
          quoteSnapshot: src.quoteSnapshot || null
        });
        sourceIdMap.set(src.id, newSourceId);
      }

      const nodeIdMap = new Map();
      for (const node of bundle.nodes) {
        if (!node || !node.id || nodeIdMap.has(node.id) || !NODE_TYPES.has(node.type)) throw new TypeError('invalid or duplicate node in bundle');
        const newNodeId = id();
        nodeIdMap.set(node.id, newNodeId);
        const newSourceRefId = node.sourceRefId ? (sourceIdMap.get(node.sourceRefId) || null) : null;
        this.db.prepare(`
          INSERT INTO nodes
            (id, board_id, node_type, x, y, width, height, z_index, title, body, color, source_ref_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          newNodeId, newBoardId, node.type, node.x || 0, node.y || 0,
          node.width || 240, node.height || 120, node.zIndex || 0,
          node.title || '', node.body || '', node.color || null,
          newSourceRefId, timestamp, timestamp
        );
      }

      for (const edge of bundle.edges) {
        if (!edge || !edge.id || !EDGE_RELATIONS.has(edge.relation)) throw new TypeError('invalid edge in bundle');
        const newSourceNodeId = nodeIdMap.get(edge.sourceNodeId);
        const newTargetNodeId = nodeIdMap.get(edge.targetNodeId);
        if (!newSourceNodeId || !newTargetNodeId || newSourceNodeId === newTargetNodeId) throw new TypeError('edge references invalid nodes');
        const newEdgeId = id();
        this.db.prepare(`
          INSERT INTO edges
            (id, board_id, source_node_id, target_node_id, relation, label, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          newEdgeId, newBoardId, newSourceNodeId, newTargetNodeId,
          edge.relation, edge.label || '', timestamp, timestamp
        );
      }

      this.recordEvent({
        workspaceId,
        boardId: newBoardId,
        actorKey,
        type: 'board.imported',
        payload: {
          importedFromBoardId: bundle.board.id || null,
          nodeCount: nodeIdMap.size,
          edgeCount: bundle.edges.length
        }
      });

      return this.snapshot(actorKey, newBoardId);
    });
  }

  listProvenanceEvents(actorKey, { workspaceId, boardId = null, limit = 50 } = {}) {
    if (!workspaceId && !boardId) throw new TypeError('workspaceId or boardId required');
    if (workspaceId) this.requireWorkspace(actorKey, workspaceId);
    if (boardId) this.requireBoard(actorKey, boardId);

    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    if (boardId) {
      return this.db.prepare(`
        SELECT p.* FROM provenance_events p
        JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.board_id = ? AND w.owner_key = ?
        ORDER BY p.created_at DESC
        LIMIT ?
      `).all(boardId, actorKey, safeLimit).map(provenanceRow);
    }
    return this.db.prepare(`
      SELECT p.* FROM provenance_events p
      JOIN workspaces w ON w.id = p.workspace_id
      WHERE p.workspace_id = ? AND w.owner_key = ?
      ORDER BY p.created_at DESC
      LIMIT ?
    `).all(workspaceId, actorKey, safeLimit).map(provenanceRow);
  }

  createAiSynthesisNode(actorKey, boardId, { task, model, promptVersion, prompt, inputNodeIds, title, body, x, y, width, height }) {
    const board = this.requireBoard(actorKey, boardId);
    const validInputs = (inputNodeIds || []).map(nodeId => this.getNode(actorKey, nodeId)).filter(n => n && n.boardId === boardId);
    const nodeId = id();
    const timestamp = nowIso();
    const createdEdges = [];

    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO nodes
          (id, board_id, node_type, x, y, width, height, z_index, title, body, color, source_ref_id, created_at, updated_at)
        VALUES (?, ?, 'ai_output', ?, ?, ?, ?, ?, ?, ?, '#8b5cf6', NULL, ?, ?)
      `).run(nodeId, boardId, x, y, width, height, 1, title, body, timestamp, timestamp);

      for (const inputNode of validInputs) {
        const edgeId = id();
        const relation = task === 'translate' ? 'cites' : task === 'compare' ? 'related' : 'supports';
        this.db.prepare(`
          INSERT INTO edges
            (id, board_id, source_node_id, target_node_id, relation, label, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(edgeId, boardId, inputNode.id, nodeId, relation, task === 'translate' ? '译自' : '分析', timestamp, timestamp);
        createdEdges.push(edgeId);
      }

      this.recordEvent({
        workspaceId: board.workspaceId,
        boardId,
        nodeId,
        actorKey,
        type: task === 'translate' ? 'ai.translated' : 'ai.synthesized',
        payload: {
          task,
          model: model || 'custom',
          promptVersion: promptVersion || 'unknown',
          inputNodeIds: validInputs.map(n => n.id),
          customPromptPresent: Boolean(prompt)
        }
      });
    });

    return {
      node: this.getNode(actorKey, nodeId),
      edges: createdEdges.map(eid => this.getEdge(actorKey, eid))
    };
  }

  createAiDocumentMap(actorKey, boardId, { model, promptVersion, document, graph }) {
    const board = this.requireBoard(actorKey, boardId);
    const timestamp = nowIso();
    const nodeIds = new Map();
    const createdNodeIds = [];
    const createdEdgeIds = [];
    const nodes = [
      { key: 'overview', kind: 'overview', title: `全文概览 · ${graph.title || document.title || 'PDF 全文理解'}`, body: graph.overview,
        pageStart: 1, pageEnd: document.pageCount, evidenceQuote: graph.evidenceQuote, evidencePage: graph.evidencePage },
      ...graph.sections.map((item, index) => ({ ...item, title: `章节 · ${item.title}`, key: `section-${index}`, kind: 'section' })),
      ...graph.concepts.map((item, index) => ({ ...item, title: `概念 · ${item.title}`, key: `concept-${index}`, kind: 'concept' })),
      ...graph.claims.map((item, index) => ({ ...item, title: `论点 · ${item.title}`, key: `claim-${index}`, kind: 'claim' }))
    ];

    // Compute adaptive card dimensions and non-overlapping layout
    const layoutMap = new Map();
    let currentY = 30;

    // 1. Overview card (wide header)
    const overviewItem = nodes[0];
    const overviewTextLen = (overviewItem.body || '').length + (overviewItem.evidenceQuote || '').length;
    const overviewWidth = 640;
    const overviewHeight = Math.min(540, Math.max(320, 180 + Math.ceil(overviewTextLen / 36) * 22));
    layoutMap.set('overview', { x: 280, y: currentY, width: overviewWidth, height: overviewHeight });
    currentY += overviewHeight + 60;

    // 2. Sections, Concepts, Claims lanes
    for (const kind of ['section', 'concept', 'claim']) {
      const kindNodes = nodes.filter(n => n.kind === kind);
      if (!kindNodes.length) continue;
      const count = kindNodes.length;
      const cols = count === 1 ? 1 : (count === 2 ? 2 : 3);
      const cardWidth = count === 1 ? 620 : (count === 2 ? 460 : 380);
      const colGap = 40;
      const startX = count === 1 ? 290 : (count === 2 ? 120 : 40);

      const rows = Math.ceil(count / cols);
      for (let r = 0; r < rows; r++) {
        const rowNodes = kindNodes.slice(r * cols, (r + 1) * cols);
        const rowItemsWithHeight = rowNodes.map(node => {
          const textLen = (node.body || '').length + (node.evidenceQuote || '').length;
          const charsPerLine = Math.floor(cardWidth / 14);
          const extraForQuote = node.evidenceQuote ? 70 : 0;
          const height = Math.min(480, Math.max(260, 120 + extraForQuote + Math.ceil(textLen / charsPerLine) * 20));
          return { node, height };
        });
        const maxRowHeight = Math.max(...rowItemsWithHeight.map(item => item.height));
        rowItemsWithHeight.forEach((item, cIndex) => {
          const x = startX + cIndex * (cardWidth + colGap);
          layoutMap.set(item.node.key, { x, y: currentY, width: cardWidth, height: item.height });
        });
        currentY += maxRowHeight + 50;
      }
      currentY += 30;
    }

    this.transaction(() => {
      for (let index = 0; index < nodes.length; index++) {
        const item = nodes[index];
        const nodeId = id();
        const sourceRefId = this.createSourceRef(actorKey, {
          libraryType: document.libraryType,
          libraryId: document.libraryId,
          itemKey: document.itemKey,
          attachmentKey: document.attachmentKey,
          annotationKey: null,
          annotationVersion: null,
          pageLabel: String(item.evidencePage),
          position: {
            pageIndex: Math.max(0, item.evidencePage - 1),
            pageStart: item.pageStart,
            pageEnd: item.pageEnd,
            textQuote: item.evidenceQuote
          },
          quoteSnapshot: item.evidenceQuote
        });
        const layout = layoutMap.get(item.key) || { x: 40, y: 40, width: 380, height: 260 };
        const colors = { overview: '#7c3aed', section: '#2563eb', concept: '#0891b2', claim: '#d97706' };
        this.db.prepare(`
          INSERT INTO nodes
            (id, board_id, node_type, x, y, width, height, z_index, title, body, color, source_ref_id, created_at, updated_at)
          VALUES (?, ?, 'ai_output', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(nodeId, boardId, layout.x, layout.y, layout.width, layout.height, index + 1, item.title || item.kind, item.body, colors[item.kind], sourceRefId, timestamp, timestamp);
        nodeIds.set(item.key, nodeId);
        createdNodeIds.push(nodeId);
      }

      const edgeInputs = [];
      for (const section of nodes.filter(item => item.kind === 'section')) {
        edgeInputs.push({ from: 'overview', to: section.key, relation: 'related', label: '章节脉络' });
      }
      const sections = nodes.filter(item => item.kind === 'section');
      for (const item of nodes.filter(candidate => ['concept', 'claim'].includes(candidate.kind))) {
        const nearest = sections.reduce((best, section) => {
          const overlaps = Math.max(0, Math.min(item.pageEnd, section.pageEnd) - Math.max(item.pageStart, section.pageStart) + 1);
          const distance = overlaps ? -overlaps : Math.min(Math.abs(item.pageStart - section.pageEnd), Math.abs(section.pageStart - item.pageEnd));
          return !best || distance < best.distance ? { section, distance } : best;
        }, null)?.section;
        edgeInputs.push({
          from: nearest?.key || 'overview', to: item.key,
          relation: item.kind === 'claim' ? 'supports' : 'related',
          label: item.kind === 'claim' ? '论点与证据' : '核心概念'
        });
      }
      edgeInputs.push(...graph.relations);
      const seenEdges = new Set();
      for (const edge of edgeInputs) {
        const sourceNodeId = nodeIds.get(edge.from);
        const targetNodeId = nodeIds.get(edge.to);
        const signature = `${sourceNodeId}:${targetNodeId}:${edge.relation}`;
        if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId || seenEdges.has(signature)) continue;
        seenEdges.add(signature);
        const edgeId = id();
        this.db.prepare(`
          INSERT INTO edges
            (id, board_id, source_node_id, target_node_id, relation, label, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(edgeId, boardId, sourceNodeId, targetNodeId,
          EDGE_RELATIONS.has(edge.relation) ? edge.relation : 'related', edge.label || '', timestamp, timestamp);
        createdEdgeIds.push(edgeId);
      }

      this.recordEvent({
        workspaceId: board.workspaceId,
        boardId,
        nodeId: nodeIds.get('overview'),
        actorKey,
        type: 'ai.document_mapped',
        payload: {
          model: model || 'custom', promptVersion: promptVersion || 'unknown',
          itemKey: document.itemKey || null, attachmentKey: document.attachmentKey || null,
          pageCount: document.pageCount, nodeCount: createdNodeIds.length, edgeCount: createdEdgeIds.length
        }
      });
    });

    return {
      nodes: createdNodeIds.map(nodeId => this.getNode(actorKey, nodeId)),
      edges: createdEdgeIds.map(edgeId => this.getEdge(actorKey, edgeId))
    };
  }
}

export const canvasNodeTypes = NODE_TYPES;
export const canvasEdgeRelations = EDGE_RELATIONS;
