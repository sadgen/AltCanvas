import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { resolveInsideRoot } from './native-fs.mjs';

export const SOURCE_FILE_STATUSES = new Set(['active', 'duplicate', 'missing', 'unreadable', 'trashed']);

const NODE_TYPES = new Set([
  'annotation', 'manual_note', 'zotero_item', 'attachment', 'image', 'ai_output', 'group'
]);
const EDGE_RELATIONS = new Set([
  'related', 'supports', 'contradicts', 'causes', 'cites', 'extends', 'same_method', 'context_differs', 'custom'
]);
const EDGE_ORIGINS = new Set([
  'manual', 'document_map_internal', 'document_map_context', 't3_expand', 'ai_synthesis'
]);
const TOPIC_DOC_STATUSES = new Set([
  'inbox', 'accepted', 'deferred', 'ignored', 'removed'
]);
const TOPIC_ANALYSIS_STATUSES = new Set([
  'not_started', 'queued', 'running', 'ready', 'failed', 'stale'
]);
const TOPIC_DOC_ORIGINS = new Set([
  'collection_sync', 'canvas_import', 'manual', 'ai_suggestion', 'native_upload'
]);
const COLLECTION_BINDING_MODES = new Set([
  'inbound', 'confirm_both'
]);
const INBOX_ENTRY_STATES = new Set([
  'new', 'classifying', 'ready', 'accepted', 'deferred', 'ignored', 'failed'
]);
const JOB_STATES = new Set([
  'queued', 'running', 'completed', 'failed', 'cancelled'
]);

export class CanvasNotFoundError extends Error {}
export class CanvasConflictError extends Error {}

export function canvasActorKey(issuer, subject) {
  if (!issuer || !subject) return null;
  return crypto.createHash('sha256').update(`${issuer}\0${subject}`).digest('hex');
}

export function nowIso() {
  return new Date().toISOString();
}

function normalizeDoiValue(doi) {
  const cleaned = String(doi || '').trim().toLowerCase();
  if (!cleaned) return null;
  const match = /\b(10\.\d{4,9}\/[-._;()/:a-z0-9]+)\b/.exec(cleaned);
  return match ? match[1].replace(/[.,;)]+$/, '') : cleaned;
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
    description: row.description || '',
    researchQuestion: row.research_question || '',
    inclusionRules: row.inclusion_rules || '',
    exclusionRules: row.exclusion_rules || '',
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
    label: row.label || '',
    origin: row.origin || 'manual',
    projectionKey: row.projection_key || null,
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

function topicDocumentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    libraryType: row.library_type,
    libraryId: row.library_id,
    itemKey: row.item_key,
    attachmentKey: row.attachment_key,
    status: row.status,
    analysisStatus: row.analysis_status,
    origin: row.origin,
    classificationConfidence: row.classification_confidence,
    classificationReason: row.classification_reason,
    itemVersion: row.item_version,
    attachmentVersion: row.attachment_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function collectionBindingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    libraryType: row.library_type,
    libraryId: row.library_id,
    collectionKey: row.collection_key,
    mode: row.mode,
    lastLibraryVersion: row.last_library_version,
    lastSyncedAt: row.last_synced_at,
    enabled: Boolean(row.enabled),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function inboxEntryRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    libraryType: row.library_type,
    libraryId: row.library_id,
    itemKey: row.item_key,
    attachmentKey: row.attachment_key,
    attachmentVersion: row.attachment_version !== undefined && row.attachment_version !== null ? row.attachment_version : null,
    doi: row.doi || null,
    detectedFrom: row.detected_from,
    title: row.title || '',
    cleanTitle: row.clean_title || null,
    institution: row.institution || null,
    creators: parseJson(row.creators_json) || [],
    year: row.year,
    abstractNote: row.abstract_note || '',
    collectionKeys: parseJson(row.collection_keys_json) || [],
    tags: parseJson(row.tags_json) || [],
    itemVersion: row.item_version,
    state: row.state,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at
  };
}

function documentMetaRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    libraryType: row.library_type,
    libraryId: row.library_id,
    itemKey: row.item_key,
    attachmentKey: row.attachment_key || null,
    attachmentVersion: row.attachment_version ?? null,
    doi: row.doi || null,
    cleanTitle: row.clean_title,
    institution: row.institution || '',
    reportTitle: row.report_title || '',
    subtitle: row.subtitle || '',
    year: row.year || '',
    summary: row.summary || '',
    source: row.source || 'ai',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function jobRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobType: row.job_type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    payload: parseJson(row.payload_json),
    state: row.state,
    attempts: row.attempts,
    availableAt: row.available_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    resultSummary: parseJson(row.result_summary_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function documentAnalysisRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    libraryType: row.library_type,
    libraryId: row.library_id,
    itemKey: row.item_key,
    attachmentKey: row.attachment_key,
    attachmentVersion: row.attachment_version,
    model: row.model,
    promptVersion: row.prompt_version,
    status: row.status,
    documentTitle: row.document_title || '',
    pageCount: row.page_count,
    graph: parseJson(row.graph_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function knowledgeUnitRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    analysisId: row.analysis_id,
    type: row.type,
    libraryType: row.library_type,
    libraryId: row.library_id,
    itemKey: row.item_key,
    attachmentKey: row.attachment_key,
    documentTitle: row.document_title || '',
    title: row.title || '',
    body: row.body || '',
    pageStart: row.page_start,
    pageEnd: row.page_end,
    evidencePage: row.evidence_page !== undefined && row.evidence_page !== null ? row.evidence_page : (row.page_start || 1),
    evidenceQuote: row.evidence_quote || '',
    position: parseJson(row.position_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function knowledgeRelationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceUnitId: row.source_unit_id,
    targetUnitId: row.target_unit_id,
    relationType: row.relation_type,
    confidence: row.confidence,
    reason: row.reason || '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}


export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  if (!password || !hash || !salt) return false;
  try {
    const computedHash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    const bufA = Buffer.from(computedHash, 'hex');
    const bufB = Buffer.from(hash, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function userRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function blobRow(row) {
  if (!row) return null;
  return {
    sha256: row.sha256,
    relativePath: row.relative_path,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    referenceCount: row.reference_count,
    createdAt: row.created_at
  };
}

function creatorRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.document_id,
    position: row.position,
    creatorType: row.creator_type,
    firstName: row.first_name,
    lastName: row.last_name,
    name: row.name
  };
}

function documentRow(row, creators = [], attachments = []) {
  if (!row) return null;
  return {
    id: row.id,
    ownerKey: row.owner_key,
    itemType: row.item_type,
    title: row.title,
    abstract: row.abstract,
    publicationTitle: row.publication_title,
    publisher: row.publisher,
    date: row.date,
    year: row.year,
    doi: row.doi,
    isbn: row.isbn,
    url: row.url,
    language: row.language,
    rights: row.rights,
    extra: parseJson(row.extra_json) || {},
    version: row.version,
    creators,
    attachments,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function attachmentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.document_id,
    blobHash: row.blob_hash,
    storageKind: row.storage_kind || 'managed_blob',
    sourceFileId: row.source_file_id,
    mimeType: row.mime_type,
    originalFilename: row.original_filename,
    title: row.title,
    sourceUrl: row.source_url,
    sizeBytes: row.size_bytes,
    pageCount: row.page_count,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function annotationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    annotationType: row.annotation_type,
    pageLabel: row.page_label,
    position: parseJson(row.position_json) || {},
    quote: row.quote,
    comment: row.comment,
    color: row.color,
    sortIndex: row.sort_index,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function externalRefRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.document_id,
    provider: row.provider,
    externalLibraryId: row.external_library_id,
    externalItemId: row.external_item_id,
    externalAttachmentId: row.external_attachment_id,
    externalVersion: row.external_version,
    sourceUrl: row.source_url,
    importedAt: row.imported_at
  };
}

function libraryRootRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerKey: row.owner_key,
    displayName: row.display_name,
    absolutePath: row.absolute_path,
    scanEnabled: row.scan_enabled === 1,
    lastScanAt: row.last_scan_at,
    lastScanStatus: row.last_scan_status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sourceFileRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerKey: row.owner_key,
    rootId: row.root_id,
    documentId: row.document_id,
    attachmentId: row.attachment_id,
    relativePath: row.relative_path,
    filename: row.filename,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    modifiedAt: row.modified_at,
    lastSeenAt: row.last_seen_at,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    missingAt: row.missing_at,
    trashedAt: row.trashed_at
  };
}

function fileOperationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerKey: row.owner_key,
    operationType: row.operation_type,
    sourceFileId: row.source_file_id,
    sourcePath: row.source_path,
    targetPath: row.target_path,
    state: row.state,
    payload: parseJson(row.payload_json) || {},
    errorCode: row.error_code,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function importJobRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceType: row.source_type,
    state: row.state,
    totalCount: row.total_count,
    completedCount: row.completed_count,
    failedCount: row.failed_count,
    report: parseJson(row.report_json) || {},
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

function ensureCurrentV10Features(db) {
  const hasJobs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get();
  if (hasJobs) {
    const jobCols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
    if (!jobCols.includes('payload_json')) {
      db.exec("ALTER TABLE jobs ADD COLUMN payload_json TEXT");
    }
  }
  const hasInbox = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox_entries'").get();
  if (hasInbox) {
    const inboxCols = db.prepare('PRAGMA table_info(inbox_entries)').all().map(c => c.name);
    if (!inboxCols.includes('doi')) {
      db.exec("ALTER TABLE inbox_entries ADD COLUMN doi TEXT");
    }
    if (!inboxCols.includes('attachment_version')) {
      db.exec("ALTER TABLE inbox_entries ADD COLUMN attachment_version INTEGER");
    }
  }
  const hasDocMetas = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_metas'").get();
  if (hasDocMetas) {
    const metaCols = db.prepare('PRAGMA table_info(document_metas)').all().map(c => c.name);
    if (!metaCols.includes('doi')) {
      db.exec("ALTER TABLE document_metas ADD COLUMN doi TEXT");
    }
  }
}

function ensureEdgeV11Features(db) {
  const hasEdges = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='edges'").get();
  if (hasEdges) {
    const edgeCols = db.prepare('PRAGMA table_info(edges)').all().map(c => c.name);
    if (!edgeCols.includes('origin') || !edgeCols.includes('projection_key')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS edges_v11 (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL REFERENCES boards(id),
          source_node_id TEXT NOT NULL REFERENCES nodes(id),
          target_node_id TEXT NOT NULL REFERENCES nodes(id),
          relation TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'document_map_internal', 'document_map_context', 't3_expand', 'ai_synthesis')),
          projection_key TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          CHECK (source_node_id <> target_node_id)
        ) STRICT;
      `);
      const originExpr = edgeCols.includes('origin') ? "COALESCE(origin, 'manual')" : "'manual'";
      const projExpr = edgeCols.includes('projection_key') ? "projection_key" : "NULL";

      db.exec(`
        INSERT INTO edges_v11 (id, board_id, source_node_id, target_node_id, relation, label, origin, projection_key, version, created_at, updated_at, deleted_at)
          SELECT id, board_id, source_node_id, target_node_id, relation, label,
                 ${originExpr}, ${projExpr}, version, created_at, updated_at, deleted_at
          FROM edges;
        DROP TABLE edges;
        ALTER TABLE edges_v11 RENAME TO edges;
        CREATE INDEX IF NOT EXISTS edges_board_idx ON edges(board_id, deleted_at);
        CREATE INDEX IF NOT EXISTS edges_projection_idx ON edges(board_id, projection_key, origin) WHERE deleted_at IS NULL;
      `);
    }
  }
}

function ensureNativeLibraryTypeSupport(db) {
  const tables = ['inbox_entries', 'topic_documents', 'collection_bindings', 'document_analyses', 'document_metas', 'knowledge_units', 'source_refs'];
  for (const tbl of tables) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(tbl);
    if (row && row.sql) {
      let newSql = row.sql;
      let changed = false;
      if (newSql.includes("('user', 'group')")) {
        newSql = newSql.replace("('user', 'group')", "('user', 'group', 'native')");
        changed = true;
      }
      if (tbl === 'topic_documents' && newSql.includes("('collection_sync', 'canvas_import', 'manual', 'ai_suggestion')")) {
        newSql = newSql.replace("('collection_sync', 'canvas_import', 'manual', 'ai_suggestion')", "('collection_sync', 'canvas_import', 'manual', 'ai_suggestion', 'native_upload')");
        changed = true;
      }
      if (changed) {
        const existingIndexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL").all(tbl);
        const openParenIdx = newSql.indexOf('(');
        const colsDef = newSql.slice(openParenIdx);
        db.exec(`
          CREATE TABLE ${tbl}_new ${colsDef};
          INSERT INTO ${tbl}_new SELECT * FROM ${tbl};
          DROP TABLE ${tbl};
          ALTER TABLE ${tbl}_new RENAME TO ${tbl};
        `);
        for (const idx of existingIndexes) {
          if (idx.sql) {
            db.exec(idx.sql);
          }
        }
      }
    }
  }
}

function ensureNativeCoreTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'user')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS blobs (
      sha256 TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reference_count INTEGER NOT NULL DEFAULT 1
    ) STRICT;

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'journalArticle',
      title TEXT NOT NULL,
      abstract TEXT NOT NULL DEFAULT '',
      publication_title TEXT NOT NULL DEFAULT '',
      publisher TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '',
      year INTEGER,
      doi TEXT,
      isbn TEXT,
      url TEXT,
      language TEXT NOT NULL DEFAULT '',
      rights TEXT NOT NULL DEFAULT '',
      extra_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS document_creators (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      creator_type TEXT NOT NULL DEFAULT 'author',
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT ''
    ) STRICT;

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      blob_hash TEXT REFERENCES blobs(sha256),
      mime_type TEXT NOT NULL DEFAULT 'application/pdf',
      original_filename TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      source_url TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      page_count INTEGER,
      storage_kind TEXT NOT NULL DEFAULT 'managed_blob' CHECK (storage_kind IN ('managed_blob', 'source_file')),
      source_file_id TEXT REFERENCES source_files(id),
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      CHECK (
        (storage_kind = 'managed_blob' AND blob_hash IS NOT NULL AND source_file_id IS NULL)
        OR (storage_kind = 'source_file' AND blob_hash IS NULL AND source_file_id IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      annotation_type TEXT NOT NULL DEFAULT 'highlight',
      page_label TEXT NOT NULL DEFAULT '',
      position_json TEXT NOT NULL DEFAULT '{}',
      quote TEXT NOT NULL DEFAULT '',
      comment TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#ffd400',
      sort_index INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS external_refs (
      id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      external_library_id TEXT,
      external_item_id TEXT,
      external_attachment_id TEXT,
      external_version INTEGER,
      source_url TEXT,
      imported_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS import_jobs (
      id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      source_type TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
      total_count INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      report_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      completed_at TEXT
    ) STRICT;
  `);
}

// --- M4: Schema v13 native library manager ---

function ensureM4LibraryTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_roots (
      id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      absolute_path TEXT NOT NULL,
      scan_enabled INTEGER NOT NULL DEFAULT 1 CHECK (scan_enabled IN (0, 1)),
      last_scan_at TEXT,
      last_scan_status TEXT CHECK (last_scan_status IS NULL OR last_scan_status IN ('running', 'ok', 'failed')),
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS source_files (
      id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      root_id TEXT NOT NULL REFERENCES library_roots(id),
      document_id TEXT REFERENCES documents(id),
      attachment_id TEXT REFERENCES attachments(id),
      relative_path TEXT NOT NULL,
      filename TEXT NOT NULL,
      sha256 TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      modified_at INTEGER,
      last_seen_at TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'duplicate', 'missing', 'unreadable', 'trashed')),
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      missing_at TEXT,
      trashed_at TEXT,
      deleted_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS file_operations (
      id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      operation_type TEXT NOT NULL CHECK (operation_type IN ('file.import', 'file.rename', 'file.move', 'file.trash', 'file.restore', 'file.delete_permanent', 'file.mkdir', 'library.scan', 'library.reconcile')),
      source_file_id TEXT,
      source_path TEXT,
      target_path TEXT,
      state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed', 'rolled_back')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
}

// v13 lets an attachment be backed either by the immutable managed blob store
// (existing rows) or directly by a file inside a library root. SQLite cannot
// drop a NOT NULL constraint in place, so the table is rebuilt following the
// official 12-step procedure; the constructor runs migrations with foreign
// key enforcement off, and integrity is asserted via foreign_key_check after.
function ensureM4AttachmentStorageKinds(db) {
  const cols = db.prepare('PRAGMA table_info(attachments)').all();
  if (!cols.length) return; // fresh DB: ensureNativeCoreTables already creates the v13 shape
  const colByName = new Map(cols.map(c => [c.name, c]));
  const blobNullable = colByName.get('blob_hash')?.notnull === 0;
  const hasStorageKind = colByName.has('storage_kind');
  const hasSourceFileId = colByName.has('source_file_id');
  if (blobNullable && hasStorageKind && hasSourceFileId) return;

  const legacyIndexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='attachments' AND sql IS NOT NULL").all();
  db.exec(`
    CREATE TABLE attachments_v13 (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      blob_hash TEXT REFERENCES blobs(sha256),
      mime_type TEXT NOT NULL DEFAULT 'application/pdf',
      original_filename TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      source_url TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      page_count INTEGER,
      storage_kind TEXT NOT NULL DEFAULT 'managed_blob' CHECK (storage_kind IN ('managed_blob', 'source_file')),
      source_file_id TEXT REFERENCES source_files(id),
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      CHECK (
        (storage_kind = 'managed_blob' AND blob_hash IS NOT NULL AND source_file_id IS NULL)
        OR (storage_kind = 'source_file' AND blob_hash IS NULL AND source_file_id IS NOT NULL)
      )
    ) STRICT;
    INSERT INTO attachments_v13
      (id, document_id, blob_hash, mime_type, original_filename, title, source_url, size_bytes, page_count, version, created_at, updated_at, deleted_at)
    SELECT id, document_id, blob_hash, mime_type, original_filename, title, source_url, size_bytes, page_count, version, created_at, updated_at, deleted_at
    FROM attachments;
    DROP TABLE attachments;
    ALTER TABLE attachments_v13 RENAME TO attachments;
  `);
  for (const idx of legacyIndexes) {
    if (idx.sql) db.exec(idx.sql);
  }
}

function ensureAllIndexes(db) {
  const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const tableCols = (name) => tableExists(name) ? db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name) : [];

  if (tableExists('workspaces')) {
    db.exec("CREATE INDEX IF NOT EXISTS workspaces_owner_idx ON workspaces(owner_key, deleted_at, updated_at);");
  }
  if (tableExists('boards')) {
    db.exec("CREATE INDEX IF NOT EXISTS boards_workspace_idx ON boards(workspace_id, deleted_at, updated_at);");
  }
  if (tableExists('source_refs')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS source_refs_owner_idx ON source_refs(owner_key, library_type, library_id);
      CREATE INDEX IF NOT EXISTS source_refs_target_idx ON source_refs(library_type, library_id, item_key, annotation_key);
    `);
  }
  if (tableExists('nodes')) {
    db.exec("CREATE INDEX IF NOT EXISTS nodes_board_idx ON nodes(board_id, deleted_at, z_index);");
  }
  if (tableExists('edges')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS edges_board_idx ON edges(board_id, deleted_at);
      CREATE INDEX IF NOT EXISTS edges_projection_idx ON edges(board_id, projection_key, origin) WHERE deleted_at IS NULL;
    `);
  }
  if (tableExists('topic_documents')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS topic_documents_unique_active_idx ON topic_documents(workspace_id, library_type, library_id, item_key) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS topic_documents_owner_idx ON topic_documents(owner_key, workspace_id, status, deleted_at);
      CREATE INDEX IF NOT EXISTS topic_documents_lookup_idx ON topic_documents(library_type, library_id, item_key);
    `);
  }
  if (tableExists('collection_bindings')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS collection_bindings_unique_active_idx ON collection_bindings(workspace_id, library_type, library_id, collection_key) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS collection_bindings_owner_idx ON collection_bindings(owner_key, workspace_id, deleted_at);
    `);
  }
  if (tableExists('inbox_entries')) {
    const cols = tableCols('inbox_entries');
    if (cols.includes('deleted_at')) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS inbox_entries_unique_active_idx ON inbox_entries(owner_key, library_type, library_id, item_key) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS inbox_entries_owner_state_idx ON inbox_entries(owner_key, state, deleted_at, updated_at);
      `);
    } else {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS inbox_entries_unique_idx ON inbox_entries(owner_key, library_type, library_id, item_key);
        CREATE INDEX IF NOT EXISTS inbox_entries_owner_state_idx ON inbox_entries(owner_key, state, updated_at);
      `);
    }
  }
  if (tableExists('jobs')) {
    const cols = tableCols('jobs');
    if (cols.includes('available_at') && cols.includes('attempts')) {
      db.exec("CREATE INDEX IF NOT EXISTS jobs_runner_idx ON jobs(state, available_at, attempts);");
    }
    if (cols.includes('job_type')) {
      db.exec("CREATE INDEX IF NOT EXISTS jobs_owner_idx ON jobs(owner_key, job_type, state);");
    } else {
      db.exec("CREATE INDEX IF NOT EXISTS jobs_owner_idx ON jobs(owner_key, state, updated_at);");
    }
  }
  if (tableExists('document_analyses')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS document_analyses_unique_cache_idx ON document_analyses(owner_key, library_type, library_id, attachment_key, COALESCE(attachment_version, 0), model, prompt_version);
      CREATE INDEX IF NOT EXISTS document_analyses_lookup_idx ON document_analyses(owner_key, library_type, library_id, item_key, status);
    `);
  }
  if (tableExists('document_metas')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS document_metas_unique_idx ON document_metas(owner_key, library_type, library_id, item_key);
      CREATE INDEX IF NOT EXISTS document_metas_owner_idx ON document_metas(owner_key, library_type, library_id);
    `);
  }
  if (tableExists('knowledge_units')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS knowledge_units_owner_item_idx ON knowledge_units(owner_key, library_type, library_id, item_key);
      CREATE INDEX IF NOT EXISTS knowledge_units_analysis_idx ON knowledge_units(owner_key, analysis_id);
    `);
  }
  if (tableExists('knowledge_relations')) {
    db.exec(`
      DELETE FROM knowledge_relations
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY source_unit_id, target_unit_id, relation_type
            ORDER BY updated_at DESC, created_at DESC, id DESC
          ) AS rn
          FROM knowledge_relations
        ) WHERE rn = 1
      );
      CREATE INDEX IF NOT EXISTS knowledge_relations_source_idx ON knowledge_relations(owner_key, source_unit_id, status);
      CREATE INDEX IF NOT EXISTS knowledge_relations_target_idx ON knowledge_relations(owner_key, target_unit_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS knowledge_relations_pair_idx ON knowledge_relations(source_unit_id, target_unit_id, relation_type);
      CREATE INDEX IF NOT EXISTS knowledge_relations_owner_idx ON knowledge_relations(owner_key, status, updated_at);
    `);
  }
  if (tableExists('provenance_events')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS provenance_workspace_idx ON provenance_events(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS provenance_board_idx ON provenance_events(board_id, created_at);
    `);
  }
  if (tableExists('users')) {
    db.exec("CREATE INDEX IF NOT EXISTS users_username_idx ON users(username);");
  }
  if (tableExists('documents')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS documents_owner_idx ON documents(owner_key, deleted_at, updated_at);
      CREATE INDEX IF NOT EXISTS documents_doi_idx ON documents(owner_key, doi) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS documents_year_idx ON documents(owner_key, year) WHERE deleted_at IS NULL;
    `);
  }
  if (tableExists('document_creators')) {
    db.exec("CREATE INDEX IF NOT EXISTS doc_creators_doc_idx ON document_creators(document_id, position);");
  }
  if (tableExists('attachments')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS attachments_doc_idx ON attachments(document_id, deleted_at);
      CREATE INDEX IF NOT EXISTS attachments_blob_idx ON attachments(blob_hash);
    `);
  }
  if (tableExists('annotations')) {
    db.exec("CREATE INDEX IF NOT EXISTS annotations_attachment_idx ON annotations(attachment_id, deleted_at, sort_index);");
  }
    if (tableExists('external_refs')) {
      db.exec(`
        DELETE FROM external_refs
        WHERE rowid NOT IN (
          SELECT MAX(rowid) FROM external_refs
          GROUP BY owner_key, provider, COALESCE(external_library_id, ''), external_item_id
        );
        CREATE UNIQUE INDEX IF NOT EXISTS external_refs_identity_idx
          ON external_refs(owner_key, provider, COALESCE(external_library_id, ''), external_item_id);
        CREATE INDEX IF NOT EXISTS external_refs_owner_idx
          ON external_refs(owner_key, provider, external_item_id);
      `);
    }
  if (tableExists('import_jobs')) {
    db.exec("CREATE INDEX IF NOT EXISTS import_jobs_owner_idx ON import_jobs(owner_key, state, created_at);");
  }
  if (tableExists('library_roots')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS library_roots_owner_path_idx ON library_roots(owner_key, absolute_path) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS library_roots_owner_idx ON library_roots(owner_key, deleted_at, updated_at);
    `);
  }
  if (tableExists('source_files')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS source_files_owner_path_idx ON source_files(owner_key, root_id, relative_path) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS source_files_owner_sha_idx ON source_files(owner_key, sha256);
      CREATE INDEX IF NOT EXISTS source_files_document_idx ON source_files(document_id);
      CREATE INDEX IF NOT EXISTS source_files_attachment_idx ON source_files(attachment_id);
      CREATE INDEX IF NOT EXISTS source_files_scan_idx ON source_files(owner_key, status, last_seen_at);
    `);
  }
  if (tableExists('file_operations')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS file_operations_state_idx ON file_operations(state, operation_type);
      CREATE INDEX IF NOT EXISTS file_operations_owner_idx ON file_operations(owner_key, created_at);
      CREATE INDEX IF NOT EXISTS file_operations_source_file_idx ON file_operations(source_file_id);
    `);
  }
}


// M4 compatibility migration: native-era inbox entries are deprecated. Every
// legacy native entry is checked against its document; valuable metadata is
// backfilled only into EMPTY document fields (manual/library values always
// win) and entries without a document are reported, never silently dropped.
function migrateLegacyNativeInboxEntries(db, dbDirectory) {
  let rows = [];
  try {
    rows = db.prepare("SELECT * FROM inbox_entries WHERE library_type = 'native' AND deleted_at IS NULL").all();
  } catch {
    return null; // no inbox table (fresh install)
  }
  if (!rows.length) {
    return { migratedAt: nowIso(), totalNativeEntries: 0, linkedDocuments: 0, backfilledDocuments: 0, orphanedEntries: 0, orphanDetails: [] };
  }
  let linked = 0;
  let backfilled = 0;
  const orphanDetails = [];
  for (const row of rows) {
    const doc = db.prepare('SELECT id, doi FROM documents WHERE id = ? AND deleted_at IS NULL').get(row.item_key);
    if (!doc) {
      orphanDetails.push({
        inboxEntryId: row.id,
        itemKey: row.item_key,
        title: row.title || '',
        detectedFrom: row.detected_from || '',
        firstSeenAt: row.first_seen_at || null
      });
      continue;
    }
    linked += 1;
    if (!doc.doi && row.doi) {
      db.prepare('UPDATE documents SET doi = ? WHERE id = ?').run(row.doi, doc.id);
      backfilled += 1;
    }
  }
  const report = {
    migratedAt: nowIso(),
    totalNativeEntries: rows.length,
    linkedDocuments: linked,
    backfilledDocuments: backfilled,
    orphanedEntries: orphanDetails.length,
    orphanDetails
  };
  try {
    const reportPath = path.join(dbDirectory, 'm4-inbox-migration-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  } catch {}
  return report;
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
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.migrate();
    this.db.exec('PRAGMA foreign_keys = ON');
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
    if (current > 13) {
      throw new Error(`Canvas database schema ${current} is newer than this server supports`);
    }
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
            library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group', 'native')),
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
            origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'document_map_internal', 'document_map_context', 't3_expand', 'ai_synthesis')),
            projection_key TEXT,
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
    if (current < 3) {
      this.transaction(() => {
        const cols = this.db.prepare('PRAGMA table_info(workspaces)').all().map(c => c.name);
        if (!cols.includes('description')) {
          this.db.exec("ALTER TABLE workspaces ADD COLUMN description TEXT NOT NULL DEFAULT ''");
        }
        if (!cols.includes('research_question')) {
          this.db.exec("ALTER TABLE workspaces ADD COLUMN research_question TEXT NOT NULL DEFAULT ''");
        }
        if (!cols.includes('inclusion_rules')) {
          this.db.exec("ALTER TABLE workspaces ADD COLUMN inclusion_rules TEXT NOT NULL DEFAULT ''");
        }
        if (!cols.includes('exclusion_rules')) {
          this.db.exec("ALTER TABLE workspaces ADD COLUMN exclusion_rules TEXT NOT NULL DEFAULT ''");
        }

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS topic_documents (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id),
            owner_key TEXT NOT NULL,
            library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group', 'native')),
            library_id TEXT NOT NULL,
            item_key TEXT NOT NULL,
            attachment_key TEXT,
            status TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox', 'accepted', 'deferred', 'ignored', 'removed')),
            analysis_status TEXT NOT NULL DEFAULT 'not_started' CHECK (analysis_status IN ('not_started', 'queued', 'running', 'ready', 'failed', 'stale')),
            origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('collection_sync', 'canvas_import', 'manual', 'ai_suggestion', 'native_upload')),
            classification_confidence REAL,
            classification_reason TEXT,
            item_version INTEGER,
            attachment_version INTEGER,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
          ) STRICT;
          CREATE UNIQUE INDEX IF NOT EXISTS topic_documents_unique_active_idx ON topic_documents(workspace_id, library_type, library_id, item_key) WHERE deleted_at IS NULL;
          CREATE INDEX IF NOT EXISTS topic_documents_owner_idx ON topic_documents(owner_key, workspace_id, status, deleted_at);

          CREATE TABLE IF NOT EXISTS collection_bindings (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id),
            owner_key TEXT NOT NULL,
            library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group', 'native')),
            library_id TEXT NOT NULL,
            collection_key TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'inbound' CHECK (mode IN ('inbound', 'confirm_both')),
            last_library_version INTEGER NOT NULL DEFAULT 0,
            last_synced_at TEXT,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
          ) STRICT;
          CREATE UNIQUE INDEX IF NOT EXISTS collection_bindings_unique_active_idx ON collection_bindings(workspace_id, library_type, library_id, collection_key) WHERE deleted_at IS NULL;
          CREATE INDEX IF NOT EXISTS collection_bindings_owner_idx ON collection_bindings(owner_key, workspace_id, deleted_at);

          CREATE TABLE IF NOT EXISTS inbox_entries (
            id TEXT PRIMARY KEY,
            owner_key TEXT NOT NULL,
            library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group', 'native')),
            library_id TEXT NOT NULL,
            item_key TEXT NOT NULL,
            attachment_key TEXT,
            detected_from TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            creators_json TEXT NOT NULL DEFAULT '[]',
            year INTEGER,
            abstract_note TEXT NOT NULL DEFAULT '',
            collection_keys_json TEXT NOT NULL DEFAULT '[]',
            tags_json TEXT NOT NULL DEFAULT '[]',
            item_version INTEGER,
            state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'classifying', 'ready', 'accepted', 'deferred', 'ignored', 'failed')),
            first_seen_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
          ) STRICT;
          CREATE UNIQUE INDEX IF NOT EXISTS inbox_entries_unique_active_idx ON inbox_entries(owner_key, library_type, library_id, item_key) WHERE deleted_at IS NULL;
          CREATE INDEX IF NOT EXISTS inbox_entries_owner_state_idx ON inbox_entries(owner_key, state, deleted_at, updated_at);

          CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            owner_key TEXT NOT NULL,
            job_type TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
            attempts INTEGER NOT NULL DEFAULT 0,
            available_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            error_code TEXT,
            result_summary_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS jobs_runner_idx ON jobs(state, available_at, attempts);
          CREATE INDEX IF NOT EXISTS jobs_owner_idx ON jobs(owner_key, job_type, state);
        `);

        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='topic_documents'").get()) {
          const docCols = this.db.prepare('PRAGMA table_info(topic_documents)').all().map(c => c.name);
          if (!docCols.includes('version')) {
            this.db.exec('ALTER TABLE topic_documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
          }
        }
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='collection_bindings'").get()) {
          const bindCols = this.db.prepare('PRAGMA table_info(collection_bindings)').all().map(c => c.name);
          if (!bindCols.includes('version')) {
            this.db.exec('ALTER TABLE collection_bindings ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
          }
        }

        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(3, nowIso());
      });
    }
    if (current < 4) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS document_analyses (
            id TEXT PRIMARY KEY,
            owner_key TEXT NOT NULL,
            library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group', 'native')),
            library_id TEXT NOT NULL,
            item_key TEXT NOT NULL,
            attachment_key TEXT NOT NULL,
            attachment_version INTEGER,
            model TEXT NOT NULL,
            prompt_version TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('queued', 'running', 'ready', 'failed', 'stale')),
            document_title TEXT NOT NULL DEFAULT '',
            page_count INTEGER NOT NULL DEFAULT 1,
            graph_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          CREATE UNIQUE INDEX IF NOT EXISTS document_analyses_unique_cache_idx
            ON document_analyses(owner_key, library_type, library_id, attachment_key, COALESCE(attachment_version, 0), model, prompt_version);
          CREATE INDEX IF NOT EXISTS document_analyses_lookup_idx
            ON document_analyses(owner_key, library_type, library_id, item_key, status);
        `);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(4, nowIso());
      });
    }
    if (current < 5) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS document_metas (
            id TEXT PRIMARY KEY,
            owner_key TEXT NOT NULL,
            library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group', 'native')),
            library_id TEXT NOT NULL,
            item_key TEXT NOT NULL,
            attachment_key TEXT,
            attachment_version INTEGER,
            clean_title TEXT NOT NULL,
            institution TEXT,
            report_title TEXT,
            subtitle TEXT,
            year TEXT,
            summary TEXT,
            source TEXT NOT NULL DEFAULT 'ai',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          CREATE UNIQUE INDEX IF NOT EXISTS document_metas_unique_idx
            ON document_metas(owner_key, library_type, library_id, item_key);
          CREATE INDEX IF NOT EXISTS document_metas_owner_idx
            ON document_metas(owner_key, library_type, library_id);
        `);
        const metaCols = this.db.prepare('PRAGMA table_info(document_metas)').all().map(c => c.name);
        if (!metaCols.includes('attachment_key')) {
          this.db.exec("ALTER TABLE document_metas ADD COLUMN attachment_key TEXT");
        }
        if (!metaCols.includes('attachment_version')) {
          this.db.exec("ALTER TABLE document_metas ADD COLUMN attachment_version INTEGER");
        }
        const inboxCols = this.db.prepare('PRAGMA table_info(inbox_entries)').all().map(c => c.name);
        if (!inboxCols.includes('clean_title')) {
          this.db.exec("ALTER TABLE inbox_entries ADD COLUMN clean_title TEXT");
        }
        if (!inboxCols.includes('institution')) {
          this.db.exec("ALTER TABLE inbox_entries ADD COLUMN institution TEXT");
        }
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(5, nowIso());
      });
    }
    if (current < 6) {
      this.transaction(() => {
        this.db.exec(`
          DROP INDEX IF EXISTS document_analyses_unique_cache_idx;
          CREATE UNIQUE INDEX IF NOT EXISTS document_analyses_unique_cache_idx
            ON document_analyses(owner_key, library_type, library_id, attachment_key, COALESCE(attachment_version, 0), model, prompt_version);
        `);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(6, nowIso());
      });
    }
    if (current < 7) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS knowledge_units (
            id TEXT PRIMARY KEY,
            owner_key TEXT NOT NULL,
            analysis_id TEXT NOT NULL REFERENCES document_analyses(id),
            type TEXT NOT NULL CHECK (type IN ('overview', 'section', 'concept', 'claim')),
            library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group', 'native')),
            library_id TEXT NOT NULL,
            item_key TEXT NOT NULL,
            attachment_key TEXT,
            document_title TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            page_start INTEGER NOT NULL DEFAULT 1,
            page_end INTEGER NOT NULL DEFAULT 1,
            evidence_page INTEGER NOT NULL DEFAULT 1,
            evidence_quote TEXT NOT NULL DEFAULT '',
            position_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS knowledge_units_owner_item_idx
            ON knowledge_units(owner_key, library_type, library_id, item_key);
          CREATE INDEX IF NOT EXISTS knowledge_units_analysis_idx
            ON knowledge_units(owner_key, analysis_id);

          CREATE TABLE IF NOT EXISTS knowledge_relations (
            id TEXT PRIMARY KEY,
            owner_key TEXT NOT NULL,
            source_unit_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
            target_unit_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
            relation_type TEXT NOT NULL CHECK (relation_type IN ('supports', 'contradicts', 'extends', 'same_method', 'context_differs', 'related')),
            confidence REAL NOT NULL DEFAULT 0.5,
            reason TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'confirmed', 'rejected')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK (source_unit_id <> target_unit_id)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS knowledge_relations_source_idx
            ON knowledge_relations(owner_key, source_unit_id, status);
          CREATE INDEX IF NOT EXISTS knowledge_relations_target_idx
            ON knowledge_relations(owner_key, target_unit_id, status);
        `);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(7, nowIso());
      });
    }
    if (current < 8) {
      this.transaction(() => {
        const kuCols = this.db.prepare('PRAGMA table_info(knowledge_units)').all().map(c => c.name);
        if (!kuCols.includes('evidence_page')) {
          this.db.exec("ALTER TABLE knowledge_units ADD COLUMN evidence_page INTEGER NOT NULL DEFAULT 1");
          this.db.exec("UPDATE knowledge_units SET evidence_page = page_start WHERE page_start IS NOT NULL AND page_start > 0");

          // Accurately update existing knowledge units in-place by primary key from graph_json without title collision
          const analyses = this.db.prepare("SELECT * FROM document_analyses WHERE status = 'ready'").all();
          for (const a of analyses) {
            const graph = parseJson(a.graph_json);
            if (!graph) continue;
            if (graph.evidencePage) {
              this.db.prepare("UPDATE knowledge_units SET evidence_page = ? WHERE analysis_id = ? AND type = 'overview'").run(graph.evidencePage, a.id);
            }
            if (Array.isArray(graph.sections)) {
              const secUnits = this.db.prepare("SELECT id FROM knowledge_units WHERE analysis_id = ? AND type = 'section' ORDER BY rowid ASC").all(a.id);
              graph.sections.forEach((sec, idx) => {
                if (secUnits[idx] && sec.evidencePage) {
                  this.db.prepare("UPDATE knowledge_units SET evidence_page = ? WHERE id = ?").run(sec.evidencePage, secUnits[idx].id);
                }
              });
            }
            if (Array.isArray(graph.concepts)) {
              const conceptUnits = this.db.prepare("SELECT id FROM knowledge_units WHERE analysis_id = ? AND type = 'concept' ORDER BY rowid ASC").all(a.id);
              graph.concepts.forEach((concept, idx) => {
                if (conceptUnits[idx] && concept.evidencePage) {
                  this.db.prepare("UPDATE knowledge_units SET evidence_page = ? WHERE id = ?").run(concept.evidencePage, conceptUnits[idx].id);
                }
              });
            }
            if (Array.isArray(graph.claims)) {
              const claimUnits = this.db.prepare("SELECT id FROM knowledge_units WHERE analysis_id = ? AND type = 'claim' ORDER BY rowid ASC").all(a.id);
              graph.claims.forEach((claim, idx) => {
                if (claimUnits[idx] && claim.evidencePage) {
                  this.db.prepare("UPDATE knowledge_units SET evidence_page = ? WHERE id = ?").run(claim.evidencePage, claimUnits[idx].id);
                }
              });
            }
          }
        }

        // Recreate knowledge_relations table with ON DELETE CASCADE for existing databases
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS knowledge_relations_new (
            id TEXT PRIMARY KEY,
            owner_key TEXT NOT NULL,
            source_unit_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
            target_unit_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
            relation_type TEXT NOT NULL CHECK (relation_type IN ('supports', 'contradicts', 'extends', 'same_method', 'context_differs', 'related')),
            confidence REAL NOT NULL DEFAULT 0.5,
            reason TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'confirmed', 'rejected')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK (source_unit_id <> target_unit_id)
          ) STRICT;
          INSERT OR IGNORE INTO knowledge_relations_new SELECT * FROM knowledge_relations;
          DROP TABLE knowledge_relations;
          ALTER TABLE knowledge_relations_new RENAME TO knowledge_relations;
          CREATE INDEX IF NOT EXISTS knowledge_relations_source_idx
            ON knowledge_relations(owner_key, source_unit_id, status);
          CREATE INDEX IF NOT EXISTS knowledge_relations_target_idx
            ON knowledge_relations(owner_key, target_unit_id, status);
        `);

        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(8, nowIso());
      });
    }
    if (current < 9) {
      this.transaction(() => {
        const hasInbox = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox_entries'").get();
        if (hasInbox) {
          const inboxCols = this.db.prepare('PRAGMA table_info(inbox_entries)').all().map(c => c.name);
          if (!inboxCols.includes('attachment_version')) {
            this.db.exec("ALTER TABLE inbox_entries ADD COLUMN attachment_version INTEGER");
          }
        }
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(9, nowIso());
      });
    }
    if (current < 10) {
      this.transaction(() => {
        const hasJobs = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get();
        if (hasJobs) {
          const jobCols = this.db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
          if (!jobCols.includes('payload_json')) {
            this.db.exec("ALTER TABLE jobs ADD COLUMN payload_json TEXT");
          }
        }
        const hasInbox = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox_entries'").get();
        if (hasInbox) {
          const inboxCols = this.db.prepare('PRAGMA table_info(inbox_entries)').all().map(c => c.name);
          if (!inboxCols.includes('doi')) {
            this.db.exec("ALTER TABLE inbox_entries ADD COLUMN doi TEXT");
          }
        }
        const hasDocMetas = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_metas'").get();
        if (hasDocMetas) {
          const metaCols = this.db.prepare('PRAGMA table_info(document_metas)').all().map(c => c.name);
          if (!metaCols.includes('doi')) {
            this.db.exec("ALTER TABLE document_metas ADD COLUMN doi TEXT");
          }
        }
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(10, nowIso());
      });
    }
    if (current < 11) {
      this.transaction(() => {
        const hasEdges = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='edges'").get();
        if (hasEdges) {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS edges_v11 (
              id TEXT PRIMARY KEY,
              board_id TEXT NOT NULL REFERENCES boards(id),
              source_node_id TEXT NOT NULL REFERENCES nodes(id),
              target_node_id TEXT NOT NULL REFERENCES nodes(id),
              relation TEXT NOT NULL,
              label TEXT NOT NULL DEFAULT '',
              origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'document_map_internal', 'document_map_context', 't3_expand', 'ai_synthesis')),
              projection_key TEXT,
              version INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              deleted_at TEXT,
              CHECK (source_node_id <> target_node_id)
            ) STRICT;
          `);
          const edgeCols = this.db.prepare('PRAGMA table_info(edges)').all().map(c => c.name);
          const originExpr = edgeCols.includes('origin') ? "COALESCE(origin, 'manual')" : "'manual'";
          const projExpr = edgeCols.includes('projection_key') ? "projection_key" : "NULL";

          this.db.exec(`
            INSERT INTO edges_v11 (id, board_id, source_node_id, target_node_id, relation, label, origin, projection_key, version, created_at, updated_at, deleted_at)
              SELECT id, board_id, source_node_id, target_node_id, relation, label,
                     ${originExpr}, ${projExpr}, version, created_at, updated_at, deleted_at
              FROM edges;
            DROP TABLE edges;
            ALTER TABLE edges_v11 RENAME TO edges;
            CREATE INDEX IF NOT EXISTS edges_board_idx ON edges(board_id, deleted_at);
            CREATE INDEX IF NOT EXISTS edges_projection_idx ON edges(board_id, projection_key, origin) WHERE deleted_at IS NULL;
          `);
        }
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(11, nowIso());
      });
    }
    if (current < 12) {
      this.transaction(() => {
        ensureCurrentV10Features(this.db);
        ensureEdgeV11Features(this.db);
        ensureNativeCoreTables(this.db);
        ensureNativeLibraryTypeSupport(this.db);
        ensureAllIndexes(this.db);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(12, nowIso());
      });
    }
    if (current < 13) {
      this.transaction(() => {
        ensureM4LibraryTables(this.db);
        ensureM4AttachmentStorageKinds(this.db);
        ensureAllIndexes(this.db);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(13, nowIso());
      });
      const violations = this.db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(`Schema v13 migration left foreign key violations: ${JSON.stringify(violations.slice(0, 5))}`);
      }
      const inboxReport = migrateLegacyNativeInboxEntries(this.db, path.dirname(this.dbPath));
      if (inboxReport && inboxReport.totalNativeEntries > 0) {
        console.log(`[m4-migration] legacy native inbox entries: ${JSON.stringify({
          total: inboxReport.totalNativeEntries,
          linked: inboxReport.linkedDocuments,
          backfilled: inboxReport.backfilledDocuments,
          orphaned: inboxReport.orphanedEntries
        })}`);
      }
    }
  }

  transaction(callback) {
    if (this._inTransaction) {
      return callback();
    }
    this._inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this._inTransaction = false;
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

  createWorkspace(actorKey, { name, description = '', researchQuestion = '', inclusionRules = '', exclusionRules = '' }) {
    const workspaceId = id();
    const timestamp = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO workspaces
          (id, owner_key, name, description, research_question, inclusion_rules, exclusion_rules, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(workspaceId, actorKey, name, description, researchQuestion, inclusionRules, exclusionRules, timestamp, timestamp);
      this.recordEvent({
        workspaceId, actorKey, type: 'workspace.created',
        payload: { name, description, researchQuestion }
      });
    });
    return this.getWorkspace(actorKey, workspaceId);
  }

  updateWorkspace(actorKey, workspaceId, version, changes = {}) {
    const current = this.requireWorkspace(actorKey, workspaceId);
    const name = changes.name !== undefined ? changes.name : current.name;
    const description = changes.description !== undefined ? changes.description : current.description;
    const researchQuestion = changes.researchQuestion !== undefined ? changes.researchQuestion : current.researchQuestion;
    const inclusionRules = changes.inclusionRules !== undefined ? changes.inclusionRules : current.inclusionRules;
    const exclusionRules = changes.exclusionRules !== undefined ? changes.exclusionRules : current.exclusionRules;
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE workspaces SET
          name = ?,
          description = ?,
          research_question = ?,
          inclusion_rules = ?,
          exclusion_rules = ?,
          version = version + 1,
          updated_at = ?
        WHERE id = ? AND owner_key = ? AND deleted_at IS NULL AND version = ?
      `).run(name, description, researchQuestion, inclusionRules, exclusionRules, nowIso(), workspaceId, actorKey, version);
      if (!result.changes) throw new CanvasConflictError('workspace version conflict');
      this.recordEvent({
        workspaceId, actorKey, type: 'workspace.updated',
        payload: { name, description, researchQuestion }
      });
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

  // --- Topic Documents ---

  listTopicDocuments(actorKey, workspaceId, { status } = {}) {
    this.requireWorkspace(actorKey, workspaceId);
    let query = 'SELECT * FROM topic_documents WHERE workspace_id = ? AND owner_key = ? AND deleted_at IS NULL';
    const params = [workspaceId, actorKey];
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    query += ' ORDER BY updated_at DESC';
    return this.db.prepare(query).all(...params).map(topicDocumentRow);
  }

  getTopicDocument(actorKey, topicDocumentId) {
    return topicDocumentRow(this.db.prepare(`
      SELECT * FROM topic_documents WHERE id = ? AND owner_key = ? AND deleted_at IS NULL
    `).get(topicDocumentId, actorKey));
  }

  requireTopicDocument(actorKey, topicDocumentId) {
    const doc = this.getTopicDocument(actorKey, topicDocumentId);
    if (!doc) throw new CanvasNotFoundError('topic document not found');
    return doc;
  }

  addTopicDocument(actorKey, workspaceId, {
    libraryType, libraryId, itemKey, attachmentKey = null,
    status = 'inbox', origin = 'manual',
    classificationConfidence = null, classificationReason = null,
    itemVersion = null, attachmentVersion = null
  }) {
    this.requireWorkspace(actorKey, workspaceId);
    const timestamp = nowIso();
    const existing = this.db.prepare(`
      SELECT * FROM topic_documents
      WHERE workspace_id = ? AND library_type = ? AND library_id = ? AND item_key = ?
    `).get(workspaceId, libraryType, libraryId, itemKey);

    if (existing && existing.deleted_at === null) {
      // Idempotent duplicate: return existing entity unmodified to preserve ETag and concurrent edits
      return topicDocumentRow(existing);
    }

    let docId;
    this.transaction(() => {
      if (existing) {
        docId = existing.id;
        this.db.prepare(`
          UPDATE topic_documents SET
            attachment_key = ?,
            status = ?,
            origin = ?,
            classification_confidence = ?,
            classification_reason = ?,
            item_version = ?,
            attachment_version = ?,
            version = version + 1,
            deleted_at = NULL,
            updated_at = ?
          WHERE id = ?
        `).run(attachmentKey, status, origin, classificationConfidence, classificationReason, itemVersion, attachmentVersion, timestamp, docId);
      } else {
        docId = id();
        this.db.prepare(`
          INSERT INTO topic_documents
            (id, workspace_id, owner_key, library_type, library_id, item_key, attachment_key,
             status, origin, classification_confidence, classification_reason, item_version, attachment_version,
             version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(docId, workspaceId, actorKey, libraryType, libraryId, itemKey, attachmentKey,
               status, origin, classificationConfidence, classificationReason, itemVersion, attachmentVersion,
               timestamp, timestamp);
      }
      this.recordEvent({
        workspaceId, actorKey, type: 'topic.document_added',
        payload: { docId, itemKey, libraryType, libraryId, status, origin }
      });
    });
    return this.getTopicDocument(actorKey, docId);
  }

  syncTopicDocumentAttachment(actorKey, workspaceId, { libraryType, libraryId, itemKey, attachmentKey, attachmentVersion = null }) {
    this.requireWorkspace(actorKey, workspaceId);
    const existing = this.db.prepare(`
      SELECT * FROM topic_documents
      WHERE workspace_id = ? AND library_type = ? AND library_id = ? AND item_key = ? AND deleted_at IS NULL
    `).get(workspaceId, libraryType, libraryId, itemKey);
    if (!existing) return null;
    if (existing.attachment_key === attachmentKey && existing.attachment_version === attachmentVersion) {
      return topicDocumentRow(existing);
    }
    const timestamp = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        UPDATE topic_documents SET
          attachment_key = ?,
          attachment_version = ?,
          analysis_status = CASE WHEN analysis_status IN ('ready', 'running', 'queued') THEN 'stale' ELSE analysis_status END,
          version = version + 1,
          updated_at = ?
        WHERE id = ?
      `).run(attachmentKey, attachmentVersion, timestamp, existing.id);
    });
    return this.getTopicDocument(actorKey, existing.id);
  }

  updateTopicDocument(actorKey, docId, version, changes = {}) {
    this.requireTopicDocument(actorKey, docId);
    const timestamp = nowIso();
    const current = this.getTopicDocument(actorKey, docId);
    const status = changes.status !== undefined ? changes.status : current.status;
    const analysisStatus = changes.analysisStatus !== undefined ? changes.analysisStatus : current.analysisStatus;
    const attachmentKey = changes.attachmentKey !== undefined ? changes.attachmentKey : current.attachmentKey;
    const itemVersion = changes.itemVersion !== undefined ? changes.itemVersion : current.itemVersion;
    const attachmentVersion = changes.attachmentVersion !== undefined ? changes.attachmentVersion : current.attachmentVersion;
    const classificationConfidence = changes.classificationConfidence !== undefined ? changes.classificationConfidence : current.classificationConfidence;
    const classificationReason = changes.classificationReason !== undefined ? changes.classificationReason : current.classificationReason;

    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE topic_documents SET
          status = ?,
          analysis_status = ?,
          attachment_key = ?,
          item_version = ?,
          attachment_version = ?,
          classification_confidence = ?,
          classification_reason = ?,
          version = version + 1,
          updated_at = ?
        WHERE id = ? AND owner_key = ? AND deleted_at IS NULL AND version = ?
      `).run(status, analysisStatus, attachmentKey, itemVersion, attachmentVersion,
             classificationConfidence, classificationReason, timestamp, docId, actorKey, version);
      if (!result.changes) throw new CanvasConflictError('topic document version conflict');
      this.recordEvent({
        workspaceId: current.workspaceId, actorKey, type: 'topic.document_updated',
        payload: { docId, itemKey: current.itemKey, status, analysisStatus }
      });
    });
    return this.getTopicDocument(actorKey, docId);
  }

  removeTopicDocument(actorKey, docId, version) {
    const doc = this.requireTopicDocument(actorKey, docId);
    const timestamp = nowIso();
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE topic_documents SET deleted_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND owner_key = ? AND deleted_at IS NULL AND version = ?
      `).run(timestamp, timestamp, docId, actorKey, version);
      if (!result.changes) throw new CanvasConflictError('topic document version conflict');
      this.recordEvent({
        workspaceId: doc.workspaceId, actorKey, type: 'topic.document_removed',
        payload: { docId, itemKey: doc.itemKey }
      });
    });
  }

  // --- Collection Bindings ---

  listCollectionBindings(actorKey, workspaceId) {
    this.requireWorkspace(actorKey, workspaceId);
    return this.db.prepare(`
      SELECT * FROM collection_bindings
      WHERE workspace_id = ? AND owner_key = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `).all(workspaceId, actorKey).map(collectionBindingRow);
  }

  getCollectionBinding(actorKey, bindingId) {
    return collectionBindingRow(this.db.prepare(`
      SELECT * FROM collection_bindings WHERE id = ? AND owner_key = ? AND deleted_at IS NULL
    `).get(bindingId, actorKey));
  }

  requireCollectionBinding(actorKey, bindingId) {
    const binding = this.getCollectionBinding(actorKey, bindingId);
    if (!binding) throw new CanvasNotFoundError('collection binding not found');
    return binding;
  }

  addCollectionBinding(actorKey, workspaceId, { libraryType, libraryId, collectionKey, mode = 'inbound' }) {
    this.requireWorkspace(actorKey, workspaceId);
    const timestamp = nowIso();
    const existing = this.db.prepare(`
      SELECT * FROM collection_bindings
      WHERE workspace_id = ? AND library_type = ? AND library_id = ? AND collection_key = ?
    `).get(workspaceId, libraryType, libraryId, collectionKey);

    if (existing && existing.deleted_at === null) {
      // Idempotent duplicate: return existing entity unmodified to preserve ETag and concurrent edits
      return collectionBindingRow(existing);
    }

    let bindingId;
    this.transaction(() => {
      if (existing) {
        bindingId = existing.id;
        this.db.prepare(`
          UPDATE collection_bindings SET
            mode = ?,
            enabled = 1,
            version = version + 1,
            deleted_at = NULL,
            updated_at = ?
          WHERE id = ?
        `).run(mode, timestamp, bindingId);
      } else {
        bindingId = id();
        this.db.prepare(`
          INSERT INTO collection_bindings
            (id, workspace_id, owner_key, library_type, library_id, collection_key, mode, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(bindingId, workspaceId, actorKey, libraryType, libraryId, collectionKey, mode, timestamp, timestamp);
      }
      this.recordEvent({
        workspaceId, actorKey, type: 'topic.collection_bound',
        payload: { bindingId, collectionKey, mode }
      });
    });
    return this.getCollectionBinding(actorKey, bindingId);
  }

  updateCollectionBinding(actorKey, bindingId, version, changes = {}) {
    const binding = this.requireCollectionBinding(actorKey, bindingId);
    const timestamp = nowIso();
    const mode = changes.mode !== undefined ? changes.mode : binding.mode;
    const lastLibraryVersion = changes.lastLibraryVersion !== undefined ? changes.lastLibraryVersion : binding.lastLibraryVersion;
    const lastSyncedAt = changes.lastSyncedAt !== undefined ? changes.lastSyncedAt : binding.lastSyncedAt;
    const enabled = changes.enabled !== undefined ? (changes.enabled ? 1 : 0) : (binding.enabled ? 1 : 0);

    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE collection_bindings SET
          mode = ?,
          last_library_version = ?,
          last_synced_at = ?,
          enabled = ?,
          version = version + 1,
          updated_at = ?
        WHERE id = ? AND owner_key = ? AND deleted_at IS NULL AND version = ?
      `).run(mode, lastLibraryVersion, lastSyncedAt, enabled, timestamp, bindingId, actorKey, version);
      if (!result.changes) throw new CanvasConflictError('collection binding version conflict');
      this.recordEvent({
        workspaceId: binding.workspaceId, actorKey, type: 'topic.collection_binding_updated',
        payload: { bindingId, mode, enabled: Boolean(enabled) }
      });
    });
    return this.getCollectionBinding(actorKey, bindingId);
  }

  removeCollectionBinding(actorKey, bindingId, version) {
    const binding = this.requireCollectionBinding(actorKey, bindingId);
    const timestamp = nowIso();
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE collection_bindings SET deleted_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND owner_key = ? AND deleted_at IS NULL AND version = ?
      `).run(timestamp, timestamp, bindingId, actorKey, version);
      if (!result.changes) throw new CanvasConflictError('collection binding version conflict');
      this.recordEvent({
        workspaceId: binding.workspaceId, actorKey, type: 'topic.collection_unbound',
        payload: { bindingId, collectionKey: binding.collectionKey }
      });
    });
  }

  // --- Inbox Entries ---

  listInboxEntries(actorKey, { state, collectionKey, limit = 100, cursor } = {}) {
    let query = 'SELECT * FROM inbox_entries WHERE owner_key = ? AND deleted_at IS NULL';
    const params = [actorKey];
    if (state) {
      query += ' AND state = ?';
      params.push(state);
    }
    if (collectionKey) {
      query += ' AND collection_keys_json LIKE ?';
      params.push(`%"${collectionKey}"%`);
    }
    if (cursor) {
      const parts = String(cursor).split('|');
      if (parts.length === 2 && parts[0] && parts[1]) {
        query += ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
        params.push(parts[0], parts[0], parts[1]);
      } else {
        query += ' AND updated_at < ?';
        params.push(String(cursor));
      }
    }
    query += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
    params.push(Math.min(500, Math.max(1, limit)));
    return this.db.prepare(query).all(...params).map(inboxEntryRow);
  }

  countInboxEntries(actorKey, { state, collectionKey } = {}) {
    let query = 'SELECT COUNT(*) AS count FROM inbox_entries WHERE owner_key = ? AND deleted_at IS NULL';
    const params = [actorKey];
    if (state) {
      query += ' AND state = ?';
      params.push(state);
    }
    if (collectionKey) {
      query += ' AND collection_keys_json LIKE ?';
      params.push(`%"${collectionKey}"%`);
    }
    return this.db.prepare(query).get(...params).count;
  }

  getInboxEntry(actorKey, entryId) {
    return inboxEntryRow(this.db.prepare(`
      SELECT * FROM inbox_entries WHERE id = ? AND owner_key = ?
    `).get(entryId, actorKey));
  }

  upsertInboxEntries(actorKey, entries = []) {
    if (!Array.isArray(entries) || !entries.length) return [];
    const timestamp = nowIso();
    const results = [];
    this.transaction(() => {
      for (const entry of entries) {
        const existing = this.db.prepare(`
          SELECT * FROM inbox_entries
          WHERE owner_key = ? AND library_type = ? AND library_id = ? AND item_key = ?
        `).get(actorKey, entry.libraryType, entry.libraryId, entry.itemKey);

        let entryId;
        if (existing) {
          entryId = existing.id;
          const nextAttachmentKey = entry.attachmentKey !== undefined ? entry.attachmentKey : existing.attachment_key;
          const nextAttachmentVersion = entry.attachmentKey !== undefined
            ? (entry.attachmentVersion !== undefined ? entry.attachmentVersion : null)
            : existing.attachment_version;

          const nextDoi = entry.doi !== undefined ? (entry.doi || null) : (existing.doi || null);

          this.db.prepare(`
            UPDATE inbox_entries SET
              attachment_key = ?,
              attachment_version = ?,
              doi = ?,
              title = ?,
              creators_json = ?,
              year = ?,
              abstract_note = ?,
              collection_keys_json = ?,
              tags_json = ?,
              item_version = ?,
              deleted_at = NULL,
              updated_at = ?
            WHERE id = ?
          `).run(
            nextAttachmentKey || null,
            nextAttachmentVersion,
            nextDoi,
            entry.title || '',
            JSON.stringify(entry.creators || []),
            entry.year || null,
            entry.abstractNote || '',
            JSON.stringify(entry.collectionKeys || []),
            JSON.stringify(entry.tags || []),
            entry.itemVersion || null,
            timestamp,
            entryId
          );
        } else {
          entryId = id();
          this.db.prepare(`
            INSERT INTO inbox_entries
              (id, owner_key, library_type, library_id, item_key, attachment_key, attachment_version, doi, detected_from,
               title, creators_json, year, abstract_note, collection_keys_json, tags_json, item_version,
               state, first_seen_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
          `).run(
            entryId, actorKey, entry.libraryType, entry.libraryId, entry.itemKey, entry.attachmentKey || null,
            entry.attachmentVersion !== undefined ? entry.attachmentVersion : null,
            entry.doi || null,
            entry.detectedFrom || 'scan', entry.title || '', JSON.stringify(entry.creators || []),
            entry.year || null, entry.abstractNote || '', JSON.stringify(entry.collectionKeys || []),
            JSON.stringify(entry.tags || []), entry.itemVersion || null, timestamp, timestamp
          );
        }
        results.push(this.getInboxEntry(actorKey, entryId));
      }
    });
    return results;
  }

  batchActionInbox(actorKey, { entryIds = [], action, targetWorkspaceIds = [] }) {
    if (!Array.isArray(entryIds) || !entryIds.length) return { processed: 0, targetWorkspaceIds: [] };
    const validWorkspaces = [];
    if (action === 'accept' || action === 'add_to_topics') {
      if (!Array.isArray(targetWorkspaceIds) || !targetWorkspaceIds.length) {
        throw new TypeError('targetWorkspaceIds must be a non-empty array for action accept');
      }
      for (const wid of targetWorkspaceIds) {
        validWorkspaces.push(this.requireWorkspace(actorKey, wid));
      }
    }

    const timestamp = nowIso();
    let processedCount = 0;
    this.transaction(() => {
      for (const entryId of entryIds) {
        const entry = this.getInboxEntry(actorKey, entryId);
        if (!entry) continue;

        if (action === 'accept' || action === 'add_to_topics') {
          for (const ws of validWorkspaces) {
            this.addTopicDocument(actorKey, ws.id, {
              libraryType: entry.libraryType,
              libraryId: entry.libraryId,
              itemKey: entry.itemKey,
              attachmentKey: entry.attachmentKey,
              status: 'accepted',
              origin: 'manual',
              itemVersion: entry.itemVersion,
              attachmentVersion: entry.attachmentVersion
            });
            this.syncTopicDocumentAttachment(actorKey, ws.id, {
              libraryType: entry.libraryType,
              libraryId: entry.libraryId,
              itemKey: entry.itemKey,
              attachmentKey: entry.attachmentKey,
              attachmentVersion: entry.attachmentVersion
            });
          }
          this.db.prepare(`UPDATE inbox_entries SET state = 'accepted', updated_at = ? WHERE id = ?`).run(timestamp, entryId);
          processedCount++;
        } else if (action === 'defer') {
          this.db.prepare(`UPDATE inbox_entries SET state = 'deferred', updated_at = ? WHERE id = ?`).run(timestamp, entryId);
          processedCount++;
        } else if (action === 'ignore') {
          this.db.prepare(`UPDATE inbox_entries SET state = 'ignored', updated_at = ? WHERE id = ?`).run(timestamp, entryId);
          processedCount++;
        } else if (action === 'reopen') {
          this.db.prepare(`UPDATE inbox_entries SET state = 'new', updated_at = ? WHERE id = ?`).run(timestamp, entryId);
          processedCount++;
        }
      }
      for (const ws of validWorkspaces) {
        this.recordEvent({
          workspaceId: ws.id, actorKey, type: 'inbox.batch_action',
          payload: { action, count: processedCount, entryIds }
        });
      }
    });

    return { processed: processedCount, action, targetWorkspaceIds };
  }

  // --- Jobs ---

  enqueueJob(actorKey, { jobType, resourceType, resourceId, payload = null, availableAt = nowIso() }) {
    const jobId = id();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO jobs
        (id, owner_key, job_type, resource_type, resource_id, payload_json, state, attempts, available_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
    `).run(jobId, actorKey, jobType, resourceType, resourceId, payload ? JSON.stringify(payload) : null, availableAt, timestamp, timestamp);
    return this.getJob(actorKey, jobId);
  }

  getJob(actorKey, jobId) {
    return jobRow(this.db.prepare(`
      SELECT * FROM jobs WHERE id = ? AND owner_key = ?
    `).get(jobId, actorKey));
  }

  listJobs(actorKey, { jobType, state, limit = 50 } = {}) {
    let query = 'SELECT * FROM jobs WHERE owner_key = ?';
    const params = [actorKey];
    if (jobType) {
      query += ' AND job_type = ?';
      params.push(jobType);
    }
    if (state) {
      query += ' AND state = ?';
      params.push(state);
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Math.min(200, Math.max(1, limit)));
    return this.db.prepare(query).all(...params).map(jobRow);
  }

  updateJobState(jobId, { state, startedAt, finishedAt, errorCode, resultSummary, incrementAttempts = false }) {
    const timestamp = nowIso();
    const existing = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!existing) return null;

    const nextState = state !== undefined ? state : existing.state;
    const nextStartedAt = startedAt !== undefined ? startedAt : existing.started_at;
    const nextFinishedAt = finishedAt !== undefined ? finishedAt : existing.finished_at;
    const nextErrorCode = errorCode !== undefined ? errorCode : existing.error_code;
    const nextResultSummary = resultSummary !== undefined
      ? (resultSummary ? JSON.stringify(resultSummary) : null)
      : existing.result_summary_json;
    const attemptsDelta = incrementAttempts ? 1 : 0;

    this.db.prepare(`
      UPDATE jobs SET
        state = ?,
        started_at = ?,
        finished_at = ?,
        error_code = ?,
        result_summary_json = ?,
        attempts = attempts + ?,
        updated_at = ?
      WHERE id = ?
    `).run(nextState, nextStartedAt, nextFinishedAt, nextErrorCode, nextResultSummary, attemptsDelta, timestamp, jobId);
    return jobRow(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId));
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
      source: this.getSourceRef(actorKey, sourceRefId)
    };
  }

  getSourceRef(actorKey, sourceRefId) {
    return sourceRow(this.db.prepare(`
      SELECT * FROM source_refs WHERE id = ? AND owner_key = ?
    `).get(sourceRefId, actorKey));
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
    const origin = input.origin || 'manual';
    if (!EDGE_ORIGINS.has(origin)) throw new TypeError('invalid edge origin');
    const board = this.requireBoard(actorKey, boardId);
    const source = this.getNode(actorKey, input.sourceNodeId);
    const target = this.getNode(actorKey, input.targetNodeId);
    if (!source || !target || source.boardId !== boardId || target.boardId !== boardId || source.id === target.id) {
      throw new CanvasNotFoundError('edge nodes not found on board');
    }
    const edgeId = id();
    const timestamp = nowIso();
    const projectionKey = input.projectionKey || null;
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO edges
          (id, board_id, source_node_id, target_node_id, relation, label, origin, projection_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(edgeId, boardId, source.id, target.id, input.relation, input.label || '', origin, projectionKey, timestamp, timestamp);
      this.recordEvent({ workspaceId: board.workspaceId, boardId, actorKey, type: 'edge.created', payload: { edgeId, origin } });
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
    const origin = changes.origin !== undefined ? changes.origin : edge.origin;
    if (!EDGE_ORIGINS.has(origin)) throw new TypeError('invalid edge origin');
    const label = changes.label ?? edge.label;
    const board = this.requireBoard(actorKey, edge.boardId);
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE edges SET relation = ?, label = ?, origin = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND deleted_at IS NULL
      `).run(relation, label, origin, nowIso(), edgeId, version);
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
            (id, board_id, source_node_id, target_node_id, relation, label, origin, projection_key, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'ai_synthesis', NULL, ?, ?)
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

  // --- Document Analyses (Cache & Cross-Topic Reuse) ---

  getDocumentAnalysis(actorKey, { libraryType, libraryId, attachmentKey, attachmentVersion = null, model, promptVersion }) {
    const v = Number(attachmentVersion);
    if (!Number.isFinite(v) || v <= 0) {
      // Without an explicit, positive attachmentVersion from Altero, we cannot guarantee cache freshness against updated PDFs; treat as cache miss.
      return null;
    }
    return documentAnalysisRow(this.db.prepare(`
      SELECT * FROM document_analyses
      WHERE owner_key = ? AND library_type = ? AND library_id = ? AND attachment_key = ? AND attachment_version = ? AND model = ? AND prompt_version = ?
    `).get(actorKey, libraryType, libraryId, attachmentKey, v, model, promptVersion));
  }

  saveDocumentAnalysis(actorKey, {
    libraryType, libraryId, itemKey, attachmentKey, attachmentVersion = null,
    model, promptVersion, status = 'ready', documentTitle = '', pageCount = 1, graph
  }) {
    const timestamp = nowIso();
    const v = Number.isFinite(Number(attachmentVersion)) && Number(attachmentVersion) > 0 ? Number(attachmentVersion) : null;
    const existing = v !== null
      ? this.db.prepare(`
          SELECT * FROM document_analyses
          WHERE owner_key = ? AND library_type = ? AND library_id = ? AND attachment_key = ? AND attachment_version = ? AND model = ? AND prompt_version = ?
        `).get(actorKey, libraryType, libraryId, attachmentKey, v, model, promptVersion)
      : this.db.prepare(`
          SELECT * FROM document_analyses
          WHERE owner_key = ? AND library_type = ? AND library_id = ? AND attachment_key = ? AND attachment_version IS NULL AND model = ? AND prompt_version = ?
        `).get(actorKey, libraryType, libraryId, attachmentKey, model, promptVersion);

    let analysisId;
    this.transaction(() => {
      if (existing) {
        analysisId = existing.id;
        this.db.prepare(`
          UPDATE document_analyses SET
            item_key = ?,
            attachment_version = ?,
            status = ?,
            document_title = ?,
            page_count = ?,
            graph_json = ?,
            updated_at = ?
          WHERE id = ?
        `).run(itemKey, v, status, documentTitle, pageCount, JSON.stringify(graph || {}), timestamp, analysisId);
      } else {
        analysisId = id();
        this.db.prepare(`
          INSERT INTO document_analyses
            (id, owner_key, library_type, library_id, item_key, attachment_key, attachment_version,
             model, prompt_version, status, document_title, page_count, graph_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(analysisId, actorKey, libraryType, libraryId, itemKey, attachmentKey, v,
               model, promptVersion, status, documentTitle, pageCount, JSON.stringify(graph || {}), timestamp, timestamp);
      }

      // Automatically index fine-grained knowledge units from graph
      if (graph && status === 'ready') {
        this.syncKnowledgeUnitsForAnalysis(actorKey, analysisId, {
          libraryType, libraryId, itemKey, attachmentKey, documentTitle, pageCount, graph, timestamp
        });
      }
    });
    return documentAnalysisRow(this.db.prepare('SELECT * FROM document_analyses WHERE id = ?').get(analysisId));
  }

  syncKnowledgeUnitsForAnalysis(actorKey, analysisId, {
    libraryType, libraryId, itemKey, attachmentKey, documentTitle, pageCount, graph, timestamp = nowIso()
  }) {
    const oldUnits = this.db.prepare(`
      SELECT id FROM knowledge_units
      WHERE owner_key = ? AND (analysis_id = ? OR (library_type = ? AND library_id = ? AND item_key = ? AND attachment_key = ?))
    `).all(actorKey, analysisId, libraryType, libraryId, itemKey, attachmentKey);
    if (oldUnits.length) {
      const oldIds = oldUnits.map(u => u.id);
      const placeholders = oldIds.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM knowledge_relations WHERE owner_key = ? AND (source_unit_id IN (${placeholders}) OR target_unit_id IN (${placeholders}))`)
        .run(actorKey, ...oldIds, ...oldIds);
      this.db.prepare(`DELETE FROM knowledge_units WHERE owner_key = ? AND id IN (${placeholders})`)
        .run(actorKey, ...oldIds);
    }

    const unitsToInsert = [];
    if (graph.overview) {
      unitsToInsert.push({
        type: 'overview',
        title: `全文概览 · ${graph.title || documentTitle || '研报概览'}`,
        body: graph.overview,
        pageStart: 1,
        pageEnd: pageCount || 1,
        evidencePage: graph.evidencePage || 1,
        evidenceQuote: graph.evidenceQuote || ''
      });
    }

    for (const sec of (graph.sections || [])) {
      unitsToInsert.push({
        type: 'section',
        title: sec.title || '',
        body: sec.body || '',
        pageStart: sec.pageStart || 1,
        pageEnd: sec.pageEnd || sec.pageStart || 1,
        evidencePage: sec.evidencePage || sec.pageStart || 1,
        evidenceQuote: sec.evidenceQuote || ''
      });
    }

    for (const concept of (graph.concepts || [])) {
      unitsToInsert.push({
        type: 'concept',
        title: concept.title || '',
        body: concept.body || '',
        pageStart: concept.pageStart || 1,
        pageEnd: concept.pageEnd || concept.pageStart || 1,
        evidencePage: concept.evidencePage || concept.pageStart || 1,
        evidenceQuote: concept.evidenceQuote || ''
      });
    }

    for (const claim of (graph.claims || [])) {
      unitsToInsert.push({
        type: 'claim',
        title: claim.title || '',
        body: claim.body || '',
        pageStart: claim.pageStart || 1,
        pageEnd: claim.pageEnd || claim.pageStart || 1,
        evidencePage: claim.evidencePage || claim.pageStart || 1,
        evidenceQuote: claim.evidenceQuote || ''
      });
    }

    for (const u of unitsToInsert) {
      const unitId = id();
      this.db.prepare(`
        INSERT INTO knowledge_units
          (id, owner_key, analysis_id, type, library_type, library_id, item_key, attachment_key,
           document_title, title, body, page_start, page_end, evidence_page, evidence_quote, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(unitId, actorKey, analysisId, u.type, libraryType, libraryId, itemKey, attachmentKey,
             documentTitle || '', u.title, u.body, u.pageStart, u.pageEnd, u.evidencePage, u.evidenceQuote, timestamp, timestamp);
    }
  }

  listTopicKnowledgeUnits(actorKey, workspaceId, { excludeFocal = null, type = null } = {}) {
    this.requireWorkspace(actorKey, workspaceId);
    let query = `
      SELECT ku.* FROM knowledge_units ku
      JOIN topic_documents td ON td.owner_key = ku.owner_key
        AND td.library_type = ku.library_type
        AND td.library_id = ku.library_id
        AND td.item_key = ku.item_key
        AND (td.attachment_key IS NULL OR ku.attachment_key = td.attachment_key)
      WHERE td.workspace_id = ? AND td.owner_key = ? AND td.deleted_at IS NULL
        AND ku.analysis_id = (
          SELECT da.id FROM document_analyses da
          WHERE da.owner_key = ku.owner_key
            AND da.library_type = ku.library_type
            AND da.library_id = ku.library_id
            AND da.item_key = ku.item_key
            AND (td.attachment_key IS NULL OR da.attachment_key = td.attachment_key)
            AND da.status = 'ready'
          ORDER BY COALESCE(da.attachment_version, 0) DESC, da.updated_at DESC
          LIMIT 1
        )
    `;
    const params = [workspaceId, actorKey];
    if (excludeFocal && excludeFocal.itemKey) {
      const libType = excludeFocal.libraryType || 'user';
      const libId = String(excludeFocal.libraryId);
      const itemKey = String(excludeFocal.itemKey);
      query += ' AND NOT (ku.library_type = ? AND ku.library_id = ? AND ku.item_key = ?)';
      params.push(libType, libId, itemKey);
    }
    if (type) {
      query += ' AND ku.type = ?';
      params.push(type);
    }
    query += ' ORDER BY ku.created_at DESC, ku.id DESC';
    return this.db.prepare(query).all(...params).map(knowledgeUnitRow);
  }

  getKnowledgeUnit(actorKey, unitId) {
    return knowledgeUnitRow(this.db.prepare(`
      SELECT * FROM knowledge_units WHERE id = ? AND owner_key = ?
    `).get(unitId, actorKey));
  }

  saveKnowledgeRelation(actorKey, { sourceUnitId, targetUnitId, relationType, confidence = 0.5, reason = '', status = 'suggested' }) {
    const timestamp = nowIso();
    const existing = this.db.prepare(`
      SELECT id FROM knowledge_relations
      WHERE owner_key = ? AND source_unit_id = ? AND target_unit_id = ? AND relation_type = ?
    `).get(actorKey, sourceUnitId, targetUnitId, relationType);

    let relId;
    this.transaction(() => {
      if (existing) {
        relId = existing.id;
        this.db.prepare(`
          UPDATE knowledge_relations SET
            confidence = ?,
            reason = ?,
            status = ?,
            updated_at = ?
          WHERE id = ?
        `).run(confidence, reason, status, timestamp, relId);
      } else {
        relId = id();
        this.db.prepare(`
          INSERT INTO knowledge_relations
            (id, owner_key, source_unit_id, target_unit_id, relation_type, confidence, reason, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(relId, actorKey, sourceUnitId, targetUnitId, relationType, confidence, reason, status, timestamp, timestamp);
      }
    });
    return knowledgeRelationRow(this.db.prepare('SELECT * FROM knowledge_relations WHERE id = ?').get(relId));
  }

  listKnowledgeRelations(actorKey, { unitId = null, relationType = null, status = null } = {}) {
    let query = 'SELECT * FROM knowledge_relations WHERE owner_key = ?';
    const params = [actorKey];
    if (unitId) {
      query += ' AND (source_unit_id = ? OR target_unit_id = ?)';
      params.push(unitId, unitId);
    }
    if (relationType) {
      query += ' AND relation_type = ?';
      params.push(relationType);
    }
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    query += ' ORDER BY updated_at DESC';
    return this.db.prepare(query).all(...params).map(knowledgeRelationRow);
  }

  hasDocumentOnBoard(actorKey, boardId, { libraryType, libraryId, itemKey, attachmentKey }) {
    this.requireBoard(actorKey, boardId);
    let query = `
      SELECT 1 FROM nodes n
      JOIN source_refs s ON n.source_ref_id = s.id
      WHERE n.board_id = ? AND n.deleted_at IS NULL
        AND s.owner_key = ? AND s.library_type = ? AND s.library_id = ? AND s.item_key = ?
    `;
    const params = [boardId, actorKey, libraryType, String(libraryId), itemKey];
    if (attachmentKey) {
      query += ' AND s.attachment_key = ?';
      params.push(attachmentKey);
    }
    query += ' LIMIT 1';
    return Boolean(this.db.prepare(query).get(...params));
  }

  createAiDocumentMap(actorKey, boardId, { model, promptVersion, document, graph }) {
    // Decouple global document_analyses caching from board-level context:
    // Pure document analysis cache must not contain board-specific existing:<nodeId> relations
    const pureGraph = {
      ...graph,
      relations: (Array.isArray(graph?.relations) ? graph.relations : []).filter(
        r => !String(r.from || '').startsWith('existing:') && !String(r.to || '').startsWith('existing:')
      )
    };

    this.saveDocumentAnalysis(actorKey, {
      libraryType: document.libraryType,
      libraryId: document.libraryId,
      itemKey: document.itemKey,
      attachmentKey: document.attachmentKey,
      attachmentVersion: document.attachmentVersion || null,
      model,
      promptVersion,
      status: 'ready',
      documentTitle: document.title || graph.title || '',
      pageCount: document.pageCount || 1,
      graph: pureGraph
    });

    return this.projectDocumentAnalysisToBoard(actorKey, boardId, { model, promptVersion, document, graph, cached: false });
  }

  projectDocumentAnalysisToBoard(actorKey, boardId, { model, promptVersion, document, graph, cached = false }) {
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

    const projKey = `${document.libraryType}:${document.libraryId}:${document.itemKey}:${document.attachmentKey || ''}`;

    // Check if ai_output nodes for this document are already on the board
    const existingDocNodes = this.db.prepare(`
      SELECT n.*, s.quote_snapshot, s.page_label, s.position_json
      FROM nodes n
      JOIN source_refs s ON n.source_ref_id = s.id
      WHERE n.board_id = ? AND n.deleted_at IS NULL AND n.node_type = 'ai_output'
        AND s.owner_key = ? AND s.library_type = ? AND s.library_id = ? AND s.item_key = ?
        AND (? IS NULL OR s.attachment_key = ?)
        AND (n.color IN ('#7c3aed', '#2563eb', '#0891b2', '#d97706')
             OR n.title LIKE '全文概览%' OR n.title LIKE '章节 ·%' OR n.title LIKE '概念 ·%' OR n.title LIKE '论点 ·%')
      ORDER BY n.z_index ASC, n.rowid ASC
    `).all(boardId, actorKey, document.libraryType, String(document.libraryId), document.itemKey,
           document.attachmentKey || null, document.attachmentKey || null);

    const isUpdateInPlace = existingDocNodes.length > 0;

    // Check existing nodes on the board for calculating layout offset if placing a new document
    const existingBoardNodes = this.db.prepare(`
      SELECT x, y, width, height FROM nodes WHERE board_id = ? AND deleted_at IS NULL
    `).all(boardId);

    let startOffsetX = 0;
    if (!isUpdateInPlace && existingBoardNodes.length > 0) {
      const maxX = Math.max(...existingBoardNodes.map(n => n.x + n.width));
      if (maxX > 0) {
        startOffsetX = maxX + 80;
      }
    }

    // Compute adaptive card dimensions and non-overlapping layout
    const layoutMap = new Map();
    let currentY = 30;

    // 1. Overview card (wide header)
    const overviewItem = nodes[0];
    const overviewTextLen = (overviewItem.body || '').length;
    const overviewQuoteLen = (overviewItem.evidenceQuote || '').length;
    const overviewWidth = 640;
    const extraForOverviewQuote = overviewQuoteLen ? 36 + Math.ceil(overviewQuoteLen / 44) * 16 : 0;
    const overviewHeight = Math.min(520, Math.max(120, 80 + extraForOverviewQuote + Math.ceil(overviewTextLen / 42) * 18));
    layoutMap.set('overview', { x: 280 + startOffsetX, y: currentY, width: overviewWidth, height: overviewHeight });
    currentY += overviewHeight + 40;

    // 2. Sections, Concepts, Claims lanes
    let previousColumns = null;
    for (const kind of ['section', 'concept', 'claim']) {
      const kindNodes = nodes.filter(n => n.kind === kind);
      if (!kindNodes.length) continue;
      const count = kindNodes.length;
      const cols = count === 1 ? 1 : (count === 2 ? 2 : 3);
      const cardWidth = count === 1 ? 620 : (count === 2 ? 460 : 380);
      const colGap = 32;
      const startX = (count === 1 ? 290 : (count === 2 ? 120 : 40)) + startOffsetX;

      const canContinueColumns = previousColumns
        && previousColumns.cols === cols
        && previousColumns.cardWidth === cardWidth
        && previousColumns.startX === startX;
      const columnBottoms = canContinueColumns
        ? previousColumns.bottoms.map(bottom => bottom + 24)
        : Array(cols).fill(currentY);
      kindNodes.forEach((node, index) => {
          const bodyLen = (node.body || '').length;
          const quoteLen = (node.evidenceQuote || '').length;
          const charsPerLine = Math.max(16, Math.floor(cardWidth / 14));
          const extraForQuote = quoteLen ? 36 + Math.ceil(quoteLen / charsPerLine) * 16 : 0;
          const height = Math.min(460, Math.max(88, 76 + extraForQuote + Math.ceil(bodyLen / charsPerLine) * 18));
          const columnIndex = index % cols;
          const x = startX + columnIndex * (cardWidth + colGap);
          layoutMap.set(node.key, { x, y: columnBottoms[columnIndex], width: cardWidth, height });
          columnBottoms[columnIndex] += height + 36;
      });
      currentY = Math.max(...columnBottoms) - 36;
      previousColumns = { cols, cardWidth, startX, bottoms: columnBottoms };
      currentY += 24;
    }

    const colors = { overview: '#7c3aed', section: '#2563eb', concept: '#0891b2', claim: '#d97706' };

    this.transaction(() => {
      const reusedNodeIds = new Set();

      if (isUpdateInPlace) {
        // Find existing nodes bucketed by kind
        const existingOverview = existingDocNodes.find(n => n.color === '#7c3aed' || n.title?.includes('全文概览'));
        const existingSections = existingDocNodes.filter(n => n.color === '#2563eb' || n.title?.startsWith('章节 · '));
        const existingConcepts = existingDocNodes.filter(n => n.color === '#0891b2' || n.title?.startsWith('概念 · '));
        const existingClaims = existingDocNodes.filter(n => n.color === '#d97706' || n.title?.startsWith('论点 · '));

        const getExistingSlot = (kind, index) => {
          if (kind === 'overview') return existingOverview;
          if (kind === 'section') return existingSections[index];
          if (kind === 'concept') return existingConcepts[index];
          if (kind === 'claim') return existingClaims[index];
          return null;
        };

        for (let index = 0; index < nodes.length; index++) {
          const item = nodes[index];
          const kindIndex = item.key.includes('-') ? Number(item.key.split('-')[1]) : 0;
          const existingSlot = getExistingSlot(item.kind, kindIndex);

          if (existingSlot) {
            // Update node in place
            const layout = layoutMap.get(item.key) || { width: 380, height: 260 };
            const finalHeight = layout.height || existingSlot.height;
            this.db.prepare(`
              UPDATE nodes SET
                title = ?,
                body = ?,
                height = ?,
                color = ?,
                version = version + 1,
                updated_at = ?
              WHERE id = ?
            `).run(item.title || item.kind, item.body, finalHeight, colors[item.kind], timestamp, existingSlot.id);

            // Update source ref
            if (existingSlot.source_ref_id) {
              this.db.prepare(`
                UPDATE source_refs SET
                  page_label = ?,
                  quote_snapshot = ?,
                  position_json = ?,
                  updated_at = ?
                WHERE id = ?
              `).run(String(item.evidencePage), item.evidenceQuote || '',
                     JSON.stringify({
                       pageIndex: Math.max(0, item.evidencePage - 1),
                       pageStart: item.pageStart,
                       pageEnd: item.pageEnd,
                       textQuote: item.evidenceQuote
                     }), timestamp, existingSlot.source_ref_id);
            }

            nodeIds.set(item.key, existingSlot.id);
            createdNodeIds.push(existingSlot.id);
            reusedNodeIds.add(existingSlot.id);
          } else {
            // Create new node if analysis has more items than previous
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
            const layout = layoutMap.get(item.key) || { x: 40 + startOffsetX, y: 40, width: 380, height: 260 };
            this.db.prepare(`
              INSERT INTO nodes
                (id, board_id, node_type, x, y, width, height, z_index, title, body, color, source_ref_id, created_at, updated_at)
              VALUES (?, ?, 'ai_output', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(nodeId, boardId, layout.x, layout.y, layout.width, layout.height, index + 1, item.title || item.kind, item.body, colors[item.kind], sourceRefId, timestamp, timestamp);
            nodeIds.set(item.key, nodeId);
            createdNodeIds.push(nodeId);
          }
        }

        const overviewNodeId = nodeIds.get('overview');
        // Soft delete leftover old nodes, migrating external user edges to document overview
        for (const oldNode of existingDocNodes) {
          if (!reusedNodeIds.has(oldNode.id)) {
            if (overviewNodeId && overviewNodeId !== oldNode.id) {
              const touchingEdges = this.db.prepare(`
                SELECT * FROM edges WHERE board_id = ? AND (source_node_id = ? OR target_node_id = ?) AND deleted_at IS NULL
              `).all(boardId, oldNode.id, oldNode.id);

              for (const e of touchingEdges) {
                const isSource = e.source_node_id === oldNode.id;
                const newSource = isSource ? overviewNodeId : e.source_node_id;
                const newTarget = isSource ? e.target_node_id : overviewNodeId;

                // Self-loop elimination: if both ends become overviewNodeId, delete the self-loop edge
                if (newSource === newTarget) {
                  this.db.prepare(`DELETE FROM edges WHERE id = ?`).run(e.id);
                  continue;
                }

                // Deduplicate against existing signature on the board
                const existingDup = this.db.prepare(`
                  SELECT * FROM edges
                  WHERE board_id = ? AND source_node_id = ? AND target_node_id = ? AND relation = ? AND id <> ? AND deleted_at IS NULL
                `).get(boardId, newSource, newTarget, e.relation, e.id);

                if (existingDup) {
                  if (e.origin === 'manual' && existingDup.origin !== 'manual') {
                    // Manual edge wins: delete the AI edge, retarget and keep the manual edge
                    this.db.prepare(`DELETE FROM edges WHERE id = ?`).run(existingDup.id);
                    this.db.prepare(`
                      UPDATE edges SET source_node_id = ?, target_node_id = ?, version = version + 1, updated_at = ?
                      WHERE id = ?
                    `).run(newSource, newTarget, timestamp, e.id);

                    this.recordEvent({
                      workspaceId: board.workspaceId,
                      boardId,
                      nodeId: overviewNodeId,
                      actorKey,
                      type: 'edge.retargeted',
                      payload: { edgeId: e.id, oldNodeId: oldNode.id, retargetedNodeId: overviewNodeId, relation: e.relation, replacedEdgeId: existingDup.id }
                    });
                  } else {
                    // Either existingDup is manual, or both are AI edges: delete e and keep existingDup
                    this.db.prepare(`DELETE FROM edges WHERE id = ?`).run(e.id);
                  }
                } else {
                  this.db.prepare(`
                    UPDATE edges SET source_node_id = ?, target_node_id = ?, version = version + 1, updated_at = ?
                    WHERE id = ?
                  `).run(newSource, newTarget, timestamp, e.id);

                  this.recordEvent({
                    workspaceId: board.workspaceId,
                    boardId,
                    nodeId: overviewNodeId,
                    actorKey,
                    type: 'edge.retargeted',
                    payload: { edgeId: e.id, oldNodeId: oldNode.id, retargetedNodeId: overviewNodeId, relation: e.relation }
                  });
                }
              }
            }
            this.db.prepare(`UPDATE nodes SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(timestamp, timestamp, oldNode.id);
          }
        }

        // Remove old internal AI document-map edges (preserve manual user edges connecting within document nodes)
        const docNodeIdSet = new Set(existingDocNodes.map(n => n.id));
        const allDocNodePlaceholders = Array.from(docNodeIdSet).map(() => '?').join(',');
        if (allDocNodePlaceholders) {
          this.db.prepare(`
            DELETE FROM edges
            WHERE board_id = ?
              AND origin = 'document_map_internal'
              AND (projection_key = ? OR (source_node_id IN (${allDocNodePlaceholders}) AND target_node_id IN (${allDocNodePlaceholders})))
          `).run(boardId, projKey, ...docNodeIdSet, ...docNodeIdSet);
        }

        // Clean up old Stage 2 context edges for this projection
        this.db.prepare(`
          DELETE FROM edges
          WHERE board_id = ? AND projection_key = ? AND origin = 'document_map_context'
        `).run(boardId, projKey);
      } else {
        // First-time projection to this board
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
          const layout = layoutMap.get(item.key) || { x: 40 + startOffsetX, y: 40, width: 380, height: 260 };
          this.db.prepare(`
            INSERT INTO nodes
              (id, board_id, node_type, x, y, width, height, z_index, title, body, color, source_ref_id, created_at, updated_at)
            VALUES (?, ?, 'ai_output', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(nodeId, boardId, layout.x, layout.y, layout.width, layout.height, index + 1, item.title || item.kind, item.body, colors[item.kind], sourceRefId, timestamp, timestamp);
          nodeIds.set(item.key, nodeId);
          createdNodeIds.push(nodeId);
        }
      }

      // Build edges
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
        let sourceNodeId = nodeIds.get(edge.from);
        if (!sourceNodeId && typeof edge.from === 'string' && edge.from.startsWith('existing:')) {
          const rawId = edge.from.slice('existing:'.length);
          const existingNode = this.getNode(actorKey, rawId);
          if (existingNode && existingNode.boardId === boardId) {
            sourceNodeId = existingNode.id;
          }
        }
        let targetNodeId = nodeIds.get(edge.to);
        if (!targetNodeId && typeof edge.to === 'string' && edge.to.startsWith('existing:')) {
          const rawId = edge.to.slice('existing:'.length);
          const existingNode = this.getNode(actorKey, rawId);
          if (existingNode && existingNode.boardId === boardId) {
            targetNodeId = existingNode.id;
          }
        }
        const signature = `${sourceNodeId}:${targetNodeId}:${edge.relation}`;
        if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId || seenEdges.has(signature)) continue;
        seenEdges.add(signature);

        const edgeRelation = EDGE_RELATIONS.has(edge.relation) ? edge.relation : 'related';
        const isStage2Context = (typeof edge.to === 'string' && edge.to.startsWith('existing:')) || (typeof edge.from === 'string' && edge.from.startsWith('existing:'));
        const edgeOrigin = isStage2Context ? 'document_map_context' : 'document_map_internal';

        const existingDbEdge = this.db.prepare(`
          SELECT * FROM edges
          WHERE board_id = ? AND source_node_id = ? AND target_node_id = ? AND relation = ? AND deleted_at IS NULL
        `).get(boardId, sourceNodeId, targetNodeId, edgeRelation);

        if (existingDbEdge) {
          if (existingDbEdge.origin === 'manual') {
            // DO NOT overwrite manual user edge label, version, or ownership
            createdEdgeIds.push(existingDbEdge.id);
          } else {
            this.db.prepare(`
              UPDATE edges SET label = ?, updated_at = ? WHERE id = ?
            `).run(edge.label || '', timestamp, existingDbEdge.id);
            createdEdgeIds.push(existingDbEdge.id);
          }
        } else {
          const edgeId = id();
          this.db.prepare(`
            INSERT INTO edges
              (id, board_id, source_node_id, target_node_id, relation, label, origin, projection_key, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(edgeId, boardId, sourceNodeId, targetNodeId, edgeRelation, edge.label || '', edgeOrigin, projKey, timestamp, timestamp);
          createdEdgeIds.push(edgeId);
        }
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
          pageCount: document.pageCount, nodeCount: createdNodeIds.length, edgeCount: createdEdgeIds.length,
          cached: Boolean(cached), inPlaceUpdated: isUpdateInPlace
        }
      });
    });

    return {
      nodes: createdNodeIds.map(nodeId => this.getNode(actorKey, nodeId)),
      edges: createdEdgeIds.map(edgeId => this.getEdge(actorKey, edgeId)),
      cached: Boolean(cached),
      inPlaceUpdated: isUpdateInPlace
    };
  }

  // --- Document Metas (Clean Title, Institution, Metadata) ---

  getDocumentMeta(actorKey, { libraryType, libraryId, itemKey }) {
    return documentMetaRow(this.db.prepare(`
      SELECT * FROM document_metas
      WHERE owner_key = ? AND library_type = ? AND library_id = ? AND item_key = ?
    `).get(actorKey, libraryType, libraryId, itemKey));
  }

  listDocumentMetas(actorKey, { libraryType, libraryId }) {
    return this.db.prepare(`
      SELECT * FROM document_metas
      WHERE owner_key = ? AND library_type = ? AND library_id = ?
      ORDER BY updated_at DESC
    `).all(actorKey, libraryType, libraryId).map(documentMetaRow);
  }

  saveDocumentMeta(actorKey, {
    libraryType, libraryId, itemKey, attachmentKey = null, attachmentVersion = null,
    doi = null, cleanTitle, institution = '', reportTitle = '',
    subtitle = '', year = '', summary = '', source = 'ai'
  }) {
    const timestamp = nowIso();
    const existing = this.getDocumentMeta(actorKey, { libraryType, libraryId, itemKey });
    let metaId;
    this.transaction(() => {
      if (existing) {
        metaId = existing.id;
        this.db.prepare(`
          UPDATE document_metas SET
            attachment_key = ?,
            attachment_version = ?,
            doi = ?,
            clean_title = ?,
            institution = ?,
            report_title = ?,
            subtitle = ?,
            year = ?,
            summary = ?,
            source = ?,
            updated_at = ?
          WHERE id = ?
        `).run(attachmentKey !== undefined ? attachmentKey : existing.attachmentKey,
               attachmentVersion !== undefined ? attachmentVersion : existing.attachmentVersion,
               doi !== undefined ? doi : existing.doi,
               cleanTitle, institution, reportTitle, subtitle, year, summary, source, timestamp, metaId);
      } else {
        metaId = id();
        this.db.prepare(`
          INSERT INTO document_metas
            (id, owner_key, library_type, library_id, item_key, attachment_key, attachment_version,
             doi, clean_title, institution, report_title, subtitle, year, summary, source, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(metaId, actorKey, libraryType, libraryId, itemKey, attachmentKey, attachmentVersion,
               doi || null, cleanTitle, institution, reportTitle, subtitle, year, summary, source, timestamp, timestamp);
      }
      this.db.prepare(`
        UPDATE inbox_entries SET
          clean_title = ?,
          institution = ?,
          updated_at = ?
        WHERE owner_key = ? AND library_type = ? AND library_id = ? AND item_key = ?
      `).run(cleanTitle, institution, timestamp, actorKey, libraryType, libraryId, itemKey);
    });
    return documentMetaRow(this.db.prepare('SELECT * FROM document_metas WHERE id = ?').get(metaId));
  }
  // --- Users & Native Local Authentication ---

  hasUsers() {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM users').get();
    return (row?.c || 0) > 0;
  }

  countUsers() {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM users').get();
    return row?.c || 0;
  }

  createUser(inputOrUsername, passwordArg, roleArg = 'admin') {
    let username, password, role;
    if (typeof inputOrUsername === 'object' && inputOrUsername !== null) {
      username = inputOrUsername.username;
      password = inputOrUsername.password;
      role = inputOrUsername.role || 'admin';
    } else {
      username = inputOrUsername;
      password = passwordArg;
      role = roleArg || 'admin';
    }
    if (!username || typeof username !== 'string' || username.trim().length < 3) {
      throw new TypeError('Username must be at least 3 characters');
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      throw new TypeError('Password must be at least 8 characters');
    }
    const cleanUsername = username.trim().toLowerCase();
    const existing = this.db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
    if (existing) {
      throw new CanvasConflictError('Username already exists');
    }
    const userId = id();
    const { hash, salt } = hashPassword(password);
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO users (id, username, password_hash, password_salt, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, cleanUsername, hash, salt, role, timestamp, timestamp);
    return userRow(this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
  }

  getUserById(userId) {
    return userRow(this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
  }

  getUserByUsername(username) {
    if (!username || typeof username !== 'string') return null;
    return userRow(this.db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase()));
  }

  verifyUserPassword(username, password) {
    if (!username || !password) return null;
    const user = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
    if (!user) return null;
    const ok = verifyPassword(password, user.password_hash, user.password_salt);
    if (!ok) return null;
    return userRow(user);
  }

  // --- Blobs Storage ---

  importNativeUploadedDocument(actorKey, {
    sha256,
    relativePath,
    sizeBytes,
    mimeType = 'application/pdf',
    originalFilename = 'document.pdf',
    targetWorkspaceId = null,
    forceNew = false
  }) {
    return this.transaction(() => {
      // 1. Check duplicate document for this owner first
      const existingDoc = this.findDocumentByBlobHash(actorKey, sha256);
      if (existingDoc && !forceNew) {
        const blob = this.getBlob(sha256);
        let topicDoc = null;
        if (targetWorkspaceId) {
          topicDoc = this.addTopicDocument(actorKey, targetWorkspaceId, {
            libraryType: 'native',
            libraryId: 'local',
            itemKey: existingDoc.id,
            attachmentKey: existingDoc.attachments?.[0]?.id || null,
            status: 'accepted',
            origin: 'native_upload'
          });
        }
        return {
          duplicate: true,
          document: existingDoc,
          attachment: existingDoc.attachments?.[0] || null,
          blob,
          topicDocument: topicDoc
        };
      }

      // 2. Blob insertion or reference increment only when actually creating a new attachment
      const blob = this.upsertBlob({ sha256, relativePath, sizeBytes, mimeType });

      // 3. Document Creation
      let cleanTitle = originalFilename.replace(/\.pdf$/i, '').trim();
      try { cleanTitle = decodeURIComponent(cleanTitle); } catch {}
      if (!cleanTitle) cleanTitle = '未命名文献';

      const document = this.createDocument(actorKey, {
        title: cleanTitle,
        itemType: 'journalArticle'
      });

      // 4. Attachment Creation
      const attachment = this.createAttachment(actorKey, document.id, {
        blobHash: sha256,
        mimeType,
        originalFilename,
        title: cleanTitle,
        sizeBytes
      });

      // 5. (M4) Inbox retired: new uploads go straight to the library.
      // The deprecated inbox_entries table is no longer written.

      // 6. Topic Document association
      let topicDoc = null;
      if (targetWorkspaceId) {
        topicDoc = this.addTopicDocument(actorKey, targetWorkspaceId, {
          libraryType: 'native',
          libraryId: 'local',
          itemKey: document.id,
          attachmentKey: attachment.id,
          status: 'accepted',
          origin: 'native_upload'
        });
      }

      const fullDoc = this.getDocument(actorKey, document.id);
      return {
        duplicate: false,
        document: fullDoc,
        attachment,
        blob,
        topicDocument: topicDoc
      };
    });
  }

  getBlobStorageDir() {
    const dataDir = path.dirname(this.dbPath);
    const blobDir = path.join(dataDir, 'blobs');
    fs.mkdirSync(blobDir, { recursive: true, mode: 0o700 });
    return blobDir;
  }

  resolveBlobPath(blobHash, ext = '.pdf') {
    const blobDir = this.getBlobStorageDir();
    return path.join(blobDir, 'sha256', blobHash.slice(0, 2), blobHash.slice(2, 4), `${blobHash}${ext}`);
  }

  getBlob(sha256) {
    if (!sha256) return null;
    return blobRow(this.db.prepare('SELECT * FROM blobs WHERE sha256 = ?').get(sha256));
  }

  upsertBlob({ sha256, relativePath, sizeBytes, mimeType = 'application/pdf' }) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO blobs (sha256, relative_path, size_bytes, mime_type, created_at, reference_count)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(sha256) DO UPDATE SET
        reference_count = reference_count + 1
    `).run(sha256, relativePath, sizeBytes, mimeType, timestamp);
    return this.getBlob(sha256);
  }

  incrementBlobRef(sha256) {
    this.db.prepare('UPDATE blobs SET reference_count = reference_count + 1 WHERE sha256 = ?').run(sha256);
  }

  decrementBlobRef(sha256) {
    this.db.prepare('UPDATE blobs SET reference_count = MAX(0, reference_count - 1) WHERE sha256 = ?').run(sha256);
  }

  // --- Documents & Creators ---

  createDocument(actorKey, {
    itemType = 'journalArticle',
    title = '未命名文献',
    abstract = '',
    publicationTitle = '',
    publisher = '',
    date = '',
    year = null,
    doi = null,
    isbn = null,
    url = null,
    language = '',
    rights = '',
    extra = {},
    creators = []
  }) {
    const docId = id();
    const timestamp = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO documents
          (id, owner_key, item_type, title, abstract, publication_title, publisher,
           date, year, doi, isbn, url, language, rights, extra_json, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        docId, actorKey, itemType, title, abstract, publicationTitle, publisher,
        date, year ? Number(year) : null, doi || null, isbn || null, url || null,
        language, rights, JSON.stringify(extra || {}), timestamp, timestamp
      );

      if (Array.isArray(creators)) {
        creators.forEach((c, idx) => {
          this.db.prepare(`
            INSERT INTO document_creators
              (id, document_id, position, creator_type, first_name, last_name, name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(id(), docId, idx, c.creatorType || 'author', c.firstName || '', c.lastName || '', c.name || '');
        });
      }
    });
    return this.getDocument(actorKey, docId);
  }

  getDocument(actorKey, documentId) {
    const docRow = this.db.prepare(`
      SELECT * FROM documents WHERE id = ? AND owner_key = ? AND deleted_at IS NULL
    `).get(documentId, actorKey);
    if (!docRow) return null;
    const creators = this.db.prepare(`
      SELECT * FROM document_creators WHERE document_id = ? ORDER BY position ASC
    `).all(documentId).map(creatorRow);
    const attachments = this.db.prepare(`
      SELECT * FROM attachments WHERE document_id = ? AND deleted_at IS NULL ORDER BY created_at ASC
    `).all(documentId).map(attachmentRow);
    return documentRow(docRow, creators, attachments);
  }

  requireDocument(actorKey, documentId) {
    const doc = this.getDocument(actorKey, documentId);
    if (!doc) throw new CanvasNotFoundError('Document not found');
    return doc;
  }

  listDocuments(actorKey, { search = '', year = null, limit = 50, offset = 0, includeDeleted = false } = {}) {
    let query = 'SELECT * FROM documents WHERE owner_key = ?';
    const params = [actorKey];
    if (!includeDeleted) {
      query += ' AND deleted_at IS NULL';
    }
    if (year) {
      query += ' AND year = ?';
      params.push(Number(year));
    }
    if (search && search.trim()) {
      query += ' AND (title LIKE ? OR abstract LIKE ? OR publication_title LIKE ?)';
      const s = `%${search.trim()}%`;
      params.push(s, s, s);
    }
    query += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params.push(Math.min(200, Math.max(1, limit)), Math.max(0, offset));
    const docRows = this.db.prepare(query).all(...params);
    return docRows.map(r => {
      const creators = this.db.prepare('SELECT * FROM document_creators WHERE document_id = ? ORDER BY position ASC').all(r.id).map(creatorRow);
      const attachments = this.db.prepare('SELECT * FROM attachments WHERE document_id = ? AND deleted_at IS NULL ORDER BY created_at ASC').all(r.id).map(attachmentRow);
      return documentRow(r, creators, attachments);
    });
  }

  updateDocument(actorKey, documentId, expectedVersion, updates = {}) {
    const current = this.requireDocument(actorKey, documentId);
    if (expectedVersion !== undefined && expectedVersion !== null && current.version !== expectedVersion) {
      throw new CanvasConflictError('Document version conflict');
    }
    const timestamp = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        UPDATE documents SET
          item_type = COALESCE(?, item_type),
          title = COALESCE(?, title),
          abstract = COALESCE(?, abstract),
          publication_title = COALESCE(?, publication_title),
          publisher = COALESCE(?, publisher),
          date = COALESCE(?, date),
          year = CASE WHEN ? IS NOT NULL THEN ? ELSE year END,
          doi = CASE WHEN ? IS NOT NULL THEN ? ELSE doi END,
          isbn = CASE WHEN ? IS NOT NULL THEN ? ELSE isbn END,
          url = CASE WHEN ? IS NOT NULL THEN ? ELSE url END,
          language = COALESCE(?, language),
          rights = COALESCE(?, rights),
          extra_json = CASE WHEN ? IS NOT NULL THEN ? ELSE extra_json END,
          version = version + 1,
          updated_at = ?
        WHERE id = ? AND owner_key = ? AND deleted_at IS NULL
      `).run(
        updates.itemType ?? null,
        updates.title ?? null,
        updates.abstract ?? null,
        updates.publicationTitle ?? null,
        updates.publisher ?? null,
        updates.date ?? null,
        updates.year !== undefined ? 1 : null,
        updates.year !== undefined ? Number(updates.year) : null,
        updates.doi !== undefined ? 1 : null,
        updates.doi !== undefined ? updates.doi : null,
        updates.isbn !== undefined ? 1 : null,
        updates.isbn !== undefined ? updates.isbn : null,
        updates.url !== undefined ? 1 : null,
        updates.url !== undefined ? updates.url : null,
        updates.language ?? null,
        updates.rights ?? null,
        updates.extra !== undefined ? 1 : null,
        updates.extra !== undefined ? JSON.stringify(updates.extra) : null,
        timestamp,
        documentId,
        actorKey
      );

      if (Array.isArray(updates.creators)) {
        this.db.prepare('DELETE FROM document_creators WHERE document_id = ?').run(documentId);
        updates.creators.forEach((c, idx) => {
          this.db.prepare(`
            INSERT INTO document_creators
              (id, document_id, position, creator_type, first_name, last_name, name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(id(), documentId, idx, c.creatorType || 'author', c.firstName || '', c.lastName || '', c.name || '');
        });
      }
    });
    return this.getDocument(actorKey, documentId);
  }

  deleteDocument(actorKey, documentId, expectedVersion) {
    const current = this.requireDocument(actorKey, documentId);
    if (expectedVersion !== undefined && expectedVersion !== null && current.version !== expectedVersion) {
      throw new CanvasConflictError('Document version conflict');
    }
    const timestamp = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        UPDATE documents SET deleted_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND owner_key = ? AND deleted_at IS NULL
      `).run(timestamp, timestamp, documentId, actorKey);

      const atts = this.db.prepare('SELECT blob_hash FROM attachments WHERE document_id = ? AND deleted_at IS NULL').all(documentId);
      for (const att of atts) {
        if (att.blob_hash) this.decrementBlobRef(att.blob_hash);
      }

      this.db.prepare(`
        UPDATE attachments SET deleted_at = ?, version = version + 1, updated_at = ?
        WHERE document_id = ? AND deleted_at IS NULL
      `).run(timestamp, timestamp, documentId);
    });
  }

  findDocumentByDoi(actorKey, doi) {
    if (!doi) return null;
    const row = this.db.prepare(`
      SELECT id FROM documents WHERE owner_key = ? AND LOWER(doi) = LOWER(?) AND deleted_at IS NULL LIMIT 1
    `).get(actorKey, doi.trim());
    return row ? this.getDocument(actorKey, row.id) : null;
  }

  findDocumentByBlobHash(actorKey, blobHash) {
    if (!blobHash) return null;
    const row = this.db.prepare(`
      SELECT d.id FROM documents d
      JOIN attachments a ON a.document_id = d.id
      WHERE d.owner_key = ? AND a.blob_hash = ? AND d.deleted_at IS NULL AND a.deleted_at IS NULL
      LIMIT 1
    `).get(actorKey, blobHash);
    return row ? this.getDocument(actorKey, row.id) : null;
  }

  findDocumentByExternalRef(actorKey, provider, externalItemId, externalLibraryId = null) {
    if (!provider || !externalItemId) return null;
    const normalizedLibId = externalLibraryId !== null && externalLibraryId !== undefined ? String(externalLibraryId) : '';
    const row = this.db.prepare(`
      SELECT d.id FROM documents d
      JOIN external_refs er ON er.document_id = d.id
      WHERE er.owner_key = ? AND er.provider = ?
        AND COALESCE(er.external_library_id, '') = ?
        AND er.external_item_id = ?
        AND d.deleted_at IS NULL
      LIMIT 1
    `).get(actorKey, provider, normalizedLibId, String(externalItemId));
    return row ? this.getDocument(actorKey, row.id) : null;
  }

  findDocumentByIsbn(actorKey, isbn) {
    if (!isbn) return null;
    const row = this.db.prepare(`
      SELECT id FROM documents
      WHERE owner_key = ? AND LOWER(isbn) = LOWER(?) AND deleted_at IS NULL
      LIMIT 1
    `).get(actorKey, isbn.trim());
    return row ? this.getDocument(actorKey, row.id) : null;
  }

  findDocumentByArxivId(actorKey, arxivId) {
    if (!arxivId) return null;
    return this.findDocumentByExternalRef(actorKey, 'arxiv', String(arxivId).trim());
  }

  findFuzzyNativeDocumentCandidates(actorKey, { title, year }) {
    const normalizedTitle = String(title || '').toLowerCase().replace(/[\s\-_:：,，.。;；/\\()（）[\]【】]+/g, '');
    if (!normalizedTitle || normalizedTitle.length < 6) return [];
    const keywords = String(title || '')
      .split(/[\s:：,，.。;；/\\()（）[\]【】]+/)
      .filter(w => w.length >= 3)
      .slice(0, 5);
    if (!keywords.length) return [];

    const clauses = keywords.map(() => 'title LIKE ?').join(' OR ');
    const params = keywords.flatMap(k => [`%${k}%`]);
    const rows = this.db.prepare(`
      SELECT id, title, year FROM documents
      WHERE owner_key = ? AND deleted_at IS NULL AND (${clauses})
      LIMIT 20
    `).all(actorKey, ...params);

    const candidates = [];
    for (const row of rows) {
      const rowNormTitle = String(row.title || '').toLowerCase().replace(/[\s\-_:：,，.。;；/\\()（）[\]【】]+/g, '');
      const isMatch = rowNormTitle === normalizedTitle
        || rowNormTitle.includes(normalizedTitle)
        || normalizedTitle.includes(rowNormTitle);
      if (!isMatch) continue;
      if (year && row.year && Number(year) !== Number(row.year)) continue;
      candidates.push({
        documentId: row.id,
        title: row.title,
        year: row.year,
        matchReason: `标题高度相似${year && row.year ? `（${row.year} 年）` : ''}`
      });
    }
    return candidates;
  }

  // Shared dedup decision chain. Performs NO writes; returns the authoritative match state.
  _decideNativeImportMatch(actorKey, {
    title, year, doi, isbn, arxivId, attachment, externalRefs, forceNew, confirmFuzzy
  }) {
    const normalizedDoi = doi ? normalizeDoiValue(doi) : null;
    const normalizedIsbn = isbn ? String(isbn).trim() : null;
    const normalizedArxivId = arxivId ? String(arxivId).trim() : null;

    const exactMatches = [];
    if (!forceNew) {
      if (attachment?.sha256) {
        const doc = this.findDocumentByBlobHash(actorKey, attachment.sha256);
        if (doc) exactMatches.push({ strategy: 'sha256', document: doc });
      }
      if (normalizedDoi) {
        const doc = this.findDocumentByDoi(actorKey, normalizedDoi);
        if (doc) exactMatches.push({ strategy: 'doi', document: doc });
      }
      for (const ref of externalRefs) {
        if (!ref?.provider || !ref?.externalItemId) continue;
        const doc = this.findDocumentByExternalRef(actorKey, ref.provider, ref.externalItemId, ref.externalLibraryId || null);
        if (doc) exactMatches.push({ strategy: 'external_ref', document: doc, ref });
      }
      if (normalizedIsbn) {
        const doc = this.findDocumentByIsbn(actorKey, normalizedIsbn);
        if (doc) exactMatches.push({ strategy: 'isbn', document: doc });
      }
      if (normalizedArxivId) {
        const doc = this.findDocumentByArxivId(actorKey, normalizedArxivId);
        if (doc) exactMatches.push({ strategy: 'arxiv', document: doc });
      }
    }

    const distinctDocIds = new Set(exactMatches.map(m => m.document.id));
    if (distinctDocIds.size > 1) {
      return {
        outcome: 'conflicting_identities',
        conflicts: exactMatches.map(m => ({ strategy: m.strategy, documentId: m.document.id, title: m.document.title })),
        normalized: { normalizedDoi, normalizedIsbn, normalizedArxivId }
      };
    }

    const matched = exactMatches.length > 0 ? exactMatches[0] : null;
    let fuzzyCandidates = [];
    if (!matched && !forceNew) {
      fuzzyCandidates = this.findFuzzyNativeDocumentCandidates(actorKey, { title, year });
      if (fuzzyCandidates.length && !confirmFuzzy) {
        return {
          outcome: 'requires_confirmation',
          candidates: fuzzyCandidates,
          normalized: { normalizedDoi, normalizedIsbn, normalizedArxivId }
        };
      }
    }

    return {
      outcome: 'writable',
      matched,
      normalized: { normalizedDoi, normalizedIsbn, normalizedArxivId }
    };
  }

  // Read-only precheck for callers that must sequence external side effects (e.g. file
  // promotion) BEFORE the database write. Never mutates state.
  precheckNativeDocumentImport(actorKey, input) {
    if (!input?.title || typeof input.title !== 'string' || !input.title.trim()) {
      throw new TypeError('title is required');
    }
    return this._decideNativeImportMatch(actorKey, input);
  }

  // Startup crash-recovery scan reconciling blobs/attachments rows with on-disk files:
  //  - attachments whose blob file is missing are soft-deleted, their business bindings
  //    (inbox attachment pairs, topic attachment pairs, analysis status) cleaned in the
  //    SAME transaction, and their blob refcount released;
  //  - blob rows with no remaining references are removed (or zeroed when a soft-deleted
  //    attachment still holds the foreign key);
  //  - files on disk with no database row are deleted as orphans ONLY after a grace
  //    period, so files promoted by an in-flight import (promoted before its DB write)
  //    are never reaped by a concurrent scan.
  // Must only be invoked by the instance that holds the listen port.
  recoverBlobConsistency({ orphanGraceMs = 15 * 60 * 1000 } = {}) {
    const summary = {
      danglingAttachments: 0, removedBlobRows: 0, zeroedBlobRows: 0, deletedOrphanFiles: 0,
      sparedRecentOrphans: 0, clearedInboxBindings: 0, clearedTopicBindings: 0, staledTopicAnalyses: 0
    };
    const blobDir = this.getBlobStorageDir();

    // Phase 1+2 run in one transaction together with business-layer cleanup.
    const missingHashes = new Set();
    this.transaction(() => {
      const dangling = this.db.prepare(`
        SELECT a.id AS attachment_id, b.sha256 AS sha256, b.relative_path AS relative_path
        FROM attachments a JOIN blobs b ON b.sha256 = a.blob_hash
        WHERE a.deleted_at IS NULL
      `).all();
      for (const row of dangling) {
        const filePath = path.resolve(blobDir, row.relative_path);
        if (fs.existsSync(filePath)) continue;
        missingHashes.add(row.sha256);
        const timestamp = nowIso();
        this.db.prepare(`
          UPDATE attachments SET deleted_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(timestamp, timestamp, row.attachment_id);
        summary.danglingAttachments++;

        // Business binding 1: inbox entries referencing this attachment lose the atomic pair.
        summary.clearedInboxBindings += this.db.prepare(`
          UPDATE inbox_entries SET attachment_key = NULL, attachment_version = NULL, updated_at = ?
          WHERE attachment_key = ? AND attachment_key IS NOT NULL
        `).run(timestamp, row.attachment_id).changes;

        // Business binding 2: analyses bound to this vanished attachment turn stale FIRST
        // (matched while attachment_key still identifies the binding), then the pair is cleared.
        summary.staledTopicAnalyses += this.db.prepare(`
          UPDATE topic_documents SET analysis_status = 'stale', version = version + 1, updated_at = ?
          WHERE attachment_key = ? AND analysis_status IN ('ready', 'running')
        `).run(timestamp, row.attachment_id).changes;
        summary.clearedTopicBindings += this.db.prepare(`
          UPDATE topic_documents SET attachment_key = NULL, attachment_version = NULL, updated_at = ?
          WHERE attachment_key = ? AND attachment_key IS NOT NULL
        `).run(timestamp, row.attachment_id).changes;
      }

      // Release blob rows for missing files when no attachment row remains (soft-deleted
      // attachments still hold a foreign key, so those blobs are zeroed instead of deleted).
      for (const sha256 of missingHashes) {
        const anyAttachments = this.db.prepare(`
          SELECT 1 FROM attachments WHERE blob_hash = ? LIMIT 1
        `).get(sha256);
        if (!anyAttachments) {
          this.db.prepare('DELETE FROM blobs WHERE sha256 = ?').run(sha256);
          summary.removedBlobRows++;
        } else {
          this.db.prepare('UPDATE blobs SET reference_count = 0 WHERE sha256 = ?').run(sha256);
          summary.zeroedBlobRows++;
        }
      }
    });

    // Phase 3 (file system only): orphan files with no database row, past the grace period.
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
      let files = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files = files.concat(walk(full));
        else files.push(full);
      }
      return files;
    };
    const blobRoot = path.join(blobDir, 'sha256');
    if (fs.existsSync(blobRoot)) {
      for (const filePath of walk(blobRoot)) {
        const sha256 = path.basename(filePath).replace(/\.pdf$/i, '');
        const row = this.db.prepare('SELECT 1 FROM blobs WHERE sha256 = ?').get(sha256);
        if (row) continue;
        try {
          const ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
          if (ageMs < orphanGraceMs) {
            summary.sparedRecentOrphans++;
            continue;
          }
          fs.unlinkSync(filePath);
          summary.deletedOrphanFiles++;
        } catch {}
      }
    }

    const touched = summary.danglingAttachments || summary.removedBlobRows || summary.zeroedBlobRows
      || summary.deletedOrphanFiles || summary.clearedInboxBindings || summary.clearedTopicBindings;
    if (touched) {
      console.warn(`[blob-consistency] recovered: ${JSON.stringify(summary)}`);
    }
    return summary;
  }

  // M2 unified native import pipeline.
  // Dedup priority: SHA-256 → normalized DOI → external_refs → ISBN/arXiv → title+year fuzzy.
  // Fuzzy matches NEVER silently merge: the caller must re-submit with confirmFuzzy.
  importNativeDocument(actorKey, {
    sourceType,
    title,
    abstract = '',
    creators = [],
    year = null,
    doi = null,
    url = null,
    isbn = null,
    arxivId = null,
    attachment = null,
    externalRefs = [],
    targetWorkspaceId = null,
    forceNew = false,
    confirmFuzzy = false
  }) {
    if (!title || typeof title !== 'string' || !title.trim()) {
      throw new TypeError('title is required');
    }
    if (targetWorkspaceId) this.requireWorkspace(actorKey, targetWorkspaceId);

    const decision = this._decideNativeImportMatch(actorKey, {
      title, year, doi, isbn, arxivId, attachment, externalRefs, forceNew, confirmFuzzy
    });
    if (decision.outcome !== 'writable') {
      return decision;
    }
    const { matched } = decision;
    const { normalizedDoi, normalizedIsbn, normalizedArxivId } = decision.normalized;

    const refsToWrite = [];
    if (normalizedDoi) refsToWrite.push({ provider: 'doi', externalItemId: normalizedDoi, sourceUrl: url || null });
    if (normalizedArxivId) refsToWrite.push({ provider: 'arxiv', externalItemId: normalizedArxivId, sourceUrl: url || null });
    for (const ref of externalRefs) {
      if (ref?.provider && ref?.externalItemId) {
        refsToWrite.push({
          provider: String(ref.provider),
          externalItemId: String(ref.externalItemId),
          externalLibraryId: ref.externalLibraryId || null,
          externalAttachmentId: ref.externalAttachmentId || null,
          externalVersion: ref.externalVersion || null,
          sourceUrl: ref.sourceUrl || null
        });
      }
    }

    const tags = [sourceType, normalizedDoi ? 'doi' : '', normalizedArxivId ? 'arxiv' : ''].filter(Boolean);
    const creatorsInput = (Array.isArray(creators) ? creators : []).map(c => ({
      creatorType: c.creatorType || 'author',
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      name: c.name || ''
    }));

    const result = this.transaction(() => {
      let document;
      if (matched) {
        document = matched.document;
        // Backfill missing metadata; existing values always win.
        const updates = {};
        if (normalizedDoi && !document.doi) updates.doi = normalizedDoi;
        if (normalizedIsbn && !document.isbn) updates.isbn = normalizedIsbn;
        if (url && !document.url) updates.url = url;
        if (abstract && !document.abstract) updates.abstract = abstract;
        if (year && !document.year) updates.year = Number(year);
        if (creatorsInput.length && !document.creators.length) updates.creators = creatorsInput;
        if (Object.keys(updates).length) {
          document = this.updateDocument(actorKey, document.id, undefined, updates);
        }
      } else {
        document = this.createDocument(actorKey, {
          title: title.trim(),
          abstract: abstract || '',
          year: year ? Number(year) : null,
          doi: normalizedDoi,
          isbn: normalizedIsbn,
          url: url || null,
          creators: creatorsInput
        });
      }

      // External refs: idempotent backfill for both reuse and create paths (with library dimension).
      for (const ref of refsToWrite) {
        const existingRef = this.getExternalRef(actorKey, ref.provider, ref.externalItemId, ref.externalLibraryId || null);
        if (!existingRef) {
          this.createExternalRef(actorKey, document.id, ref);
        }
      }

      // Attachment: link blob to document when provided and not already linked.
      let linkedAttachment = null;
      if (attachment?.sha256) {
        const existingAtt = (document.attachments || []).find(a => a.blobHash === attachment.sha256);
        if (existingAtt) {
          linkedAttachment = { attachment: existingAtt };
        } else {
          this.upsertBlob({
            sha256: attachment.sha256,
            relativePath: attachment.relativePath,
            sizeBytes: attachment.sizeBytes,
            mimeType: attachment.mimeType || 'application/pdf'
          });
          linkedAttachment = {
            attachment: this.createAttachment(actorKey, document.id, {
              blobHash: attachment.sha256,
              mimeType: attachment.mimeType || 'application/pdf',
              originalFilename: attachment.originalFilename || '',
              title: attachment.title || title.trim(),
              sourceUrl: attachment.sourceUrl || url || null,
              sizeBytes: attachment.sizeBytes || 0,
              pageCount: attachment.pageCount || null
            })
          };
        }
      }

      // (M4) Inbox retired: imports bind topics directly, no inbox_entries writes.
      const resolvedAttachmentId = linkedAttachment?.attachment?.id || document.attachments?.[0]?.id || null;

      let topicDocument = null;
      if (targetWorkspaceId) {
        topicDocument = this.addTopicDocument(actorKey, targetWorkspaceId, {
          libraryType: 'native',
          libraryId: 'local',
          itemKey: document.id,
          attachmentKey: resolvedAttachmentId,
          status: 'accepted',
          origin: 'canvas_import'
        });
      }

      const fullDoc = this.getDocument(actorKey, document.id);
      return {
        outcome: matched ? 'reused' : 'created',
        match: matched ? { strategy: matched.strategy, documentId: matched.document.id } : null,
        document: fullDoc,
        attachment: linkedAttachment?.attachment || fullDoc.attachments?.[0] || null,
        inboxEntry: null,
        topicDocument
      };
    });

    return result;
  }

  // --- Attachments ---

  createAttachment(actorKey, documentId, {
    blobHash,
    mimeType = 'application/pdf',
    originalFilename = '',
    title = '',
    sourceUrl = null,
    sizeBytes = 0,
    pageCount = null
  }) {
    this.requireDocument(actorKey, documentId);
    const attachmentId = id();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO attachments
        (id, document_id, blob_hash, mime_type, original_filename, title, source_url, size_bytes, page_count, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      attachmentId, documentId, blobHash, mimeType, originalFilename, title, sourceUrl, sizeBytes, pageCount, timestamp, timestamp
    );
    return this.getAttachment(actorKey, attachmentId);
  }

  getAttachment(actorKey, attachmentId) {
    const row = this.db.prepare(`
      SELECT a.* FROM attachments a
      JOIN documents d ON d.id = a.document_id
      WHERE a.id = ? AND d.owner_key = ? AND a.deleted_at IS NULL AND d.deleted_at IS NULL
    `).get(attachmentId, actorKey);
    return attachmentRow(row);
  }

  getAttachmentWithBlob(actorKey, attachmentId) {
    const row = this.db.prepare(`
      SELECT a.*, b.relative_path, b.size_bytes AS blob_size_bytes, b.mime_type AS blob_mime_type, d.id as doc_id, d.title as doc_title
      FROM attachments a
      JOIN documents d ON d.id = a.document_id
      JOIN blobs b ON b.sha256 = a.blob_hash
      WHERE a.id = ? AND d.owner_key = ? AND a.deleted_at IS NULL AND d.deleted_at IS NULL
    `).get(attachmentId, actorKey);
    if (!row) return null;
    return {
      attachment: attachmentRow(row),
      blob: {
        sha256: row.blob_hash,
        relativePath: row.relative_path,
        sizeBytes: row.blob_size_bytes,
        mimeType: row.blob_mime_type
      },
      document: {
        id: row.doc_id,
        title: row.doc_title
      }
    };
  }

  requireAttachment(actorKey, attachmentId) {
    const att = this.getAttachment(actorKey, attachmentId);
    if (!att) throw new CanvasNotFoundError('Attachment not found');
    return att;
  }

  listAttachments(actorKey, documentId) {
    this.requireDocument(actorKey, documentId);
    return this.db.prepare(`
      SELECT * FROM attachments WHERE document_id = ? AND deleted_at IS NULL ORDER BY created_at ASC
    `).all(documentId).map(attachmentRow);
  }

  updateAttachment(actorKey, attachmentId, expectedVersion, updates = {}) {
    const current = this.requireAttachment(actorKey, attachmentId);
    if (expectedVersion !== undefined && expectedVersion !== null && current.version !== expectedVersion) {
      throw new CanvasConflictError('Attachment version conflict');
    }
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE attachments SET
        title = COALESCE(?, title),
        page_count = COALESCE(?, page_count),
        version = version + 1,
        updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(updates.title ?? null, updates.pageCount ?? null, timestamp, attachmentId);
    return this.getAttachment(actorKey, attachmentId);
  }

  deleteAttachment(actorKey, attachmentId, expectedVersion) {
    const current = this.requireAttachment(actorKey, attachmentId);
    if (expectedVersion !== undefined && expectedVersion !== null && current.version !== expectedVersion) {
      throw new CanvasConflictError('Attachment version conflict');
    }
    const timestamp = nowIso();
    this.transaction(() => {
      if (current.blobHash) {
        this.decrementBlobRef(current.blobHash);
      }
      this.db.prepare(`
        UPDATE attachments SET deleted_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(timestamp, timestamp, attachmentId);
    });
  }

  // --- Annotations ---

  createAnnotation(actorKey, attachmentId, {
    annotationType = 'highlight',
    pageLabel = '',
    position = {},
    quote = '',
    comment = '',
    color = '#ffd400',
    sortIndex = 0
  }) {
    this.requireAttachment(actorKey, attachmentId);
    const annotationId = id();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO annotations
        (id, attachment_id, annotation_type, page_label, position_json, quote, comment, color, sort_index, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      annotationId, attachmentId, annotationType, pageLabel,
      JSON.stringify(position || {}), quote, comment, color, sortIndex,
      timestamp, timestamp
    );
    return this.getAnnotation(actorKey, annotationId);
  }

  getAnnotation(actorKey, annotationId) {
    const row = this.db.prepare(`
      SELECT an.* FROM annotations an
      JOIN attachments a ON a.id = an.attachment_id
      JOIN documents d ON d.id = a.document_id
      WHERE an.id = ? AND d.owner_key = ? AND an.deleted_at IS NULL AND a.deleted_at IS NULL AND d.deleted_at IS NULL
    `).get(annotationId, actorKey);
    return annotationRow(row);
  }

  requireAnnotation(actorKey, annotationId) {
    const ann = this.getAnnotation(actorKey, annotationId);
    if (!ann) throw new CanvasNotFoundError('Annotation not found');
    return ann;
  }

  listAnnotations(actorKey, attachmentId, { includeDeleted = false } = {}) {
    this.requireAttachment(actorKey, attachmentId);
    let query = `
      SELECT an.* FROM annotations an
      JOIN attachments a ON a.id = an.attachment_id
      JOIN documents d ON d.id = a.document_id
      WHERE an.attachment_id = ? AND d.owner_key = ?
    `;
    if (!includeDeleted) {
      query += ' AND an.deleted_at IS NULL';
    }
    query += ' ORDER BY an.sort_index ASC, an.created_at ASC';
    return this.db.prepare(query).all(attachmentId, actorKey).map(annotationRow);
  }

  updateAnnotation(actorKey, annotationId, expectedVersion, updates = {}) {
    const current = this.requireAnnotation(actorKey, annotationId);
    if (expectedVersion !== undefined && expectedVersion !== null && current.version !== expectedVersion) {
      throw new CanvasConflictError('Annotation version conflict');
    }
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE annotations SET
        annotation_type = COALESCE(?, annotation_type),
        page_label = COALESCE(?, page_label),
        position_json = CASE WHEN ? IS NOT NULL THEN ? ELSE position_json END,
        quote = COALESCE(?, quote),
        comment = COALESCE(?, comment),
        color = COALESCE(?, color),
        sort_index = COALESCE(?, sort_index),
        version = version + 1,
        updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(
      updates.annotationType ?? null,
      updates.pageLabel ?? null,
      updates.position !== undefined ? 1 : null,
      updates.position !== undefined ? JSON.stringify(updates.position) : null,
      updates.quote ?? null,
      updates.comment ?? null,
      updates.color ?? null,
      updates.sortIndex ?? null,
      timestamp,
      annotationId
    );
    return this.getAnnotation(actorKey, annotationId);
  }

  deleteAnnotation(actorKey, annotationId, expectedVersion) {
    const current = this.requireAnnotation(actorKey, annotationId);
    if (expectedVersion !== undefined && expectedVersion !== null && current.version !== expectedVersion) {
      throw new CanvasConflictError('Annotation version conflict');
    }
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE annotations SET deleted_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(timestamp, timestamp, annotationId);
  }

  restoreAnnotation(actorKey, annotationId, expectedVersion) {
    const row = this.db.prepare(`
      SELECT an.* FROM annotations an
      JOIN attachments a ON a.id = an.attachment_id
      JOIN documents d ON d.id = a.document_id
      WHERE an.id = ? AND d.owner_key = ?
    `).get(annotationId, actorKey);
    if (!row) throw new CanvasNotFoundError('Annotation not found');
    if (expectedVersion === undefined || expectedVersion === null || row.version !== expectedVersion) {
      throw new CanvasConflictError('Annotation version conflict');
    }
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE annotations SET deleted_at = NULL, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(timestamp, annotationId);
    return this.getAnnotation(actorKey, annotationId);
  }

  // --- External Refs ---

  createExternalRef(actorKey, documentId, {
    provider,
    externalLibraryId = null,
    externalItemId = null,
    externalAttachmentId = null,
    externalVersion = null,
    sourceUrl = null
  }) {
    this.requireDocument(actorKey, documentId);
    const refId = id();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO external_refs
        (id, owner_key, document_id, provider, external_library_id, external_item_id, external_attachment_id, external_version, source_url, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(refId, actorKey, documentId, provider, externalLibraryId, externalItemId, externalAttachmentId, externalVersion, sourceUrl, timestamp);
    return externalRefRow(this.db.prepare('SELECT * FROM external_refs WHERE id = ?').get(refId));
  }

  getExternalRef(actorKey, provider, externalItemId, externalLibraryId = null) {
    const normalizedLibId = externalLibraryId !== null && externalLibraryId !== undefined ? String(externalLibraryId) : '';
    return externalRefRow(this.db.prepare(`
      SELECT * FROM external_refs
      WHERE owner_key = ? AND provider = ?
        AND COALESCE(external_library_id, '') = ?
        AND external_item_id = ?
    `).get(actorKey, provider, normalizedLibId, externalItemId));
  }

  listExternalRefs(actorKey, documentId) {
    this.requireDocument(actorKey, documentId);
    return this.db.prepare(`
      SELECT * FROM external_refs WHERE owner_key = ? AND document_id = ? ORDER BY imported_at DESC
    `).all(actorKey, documentId).map(externalRefRow);
  }

  // --- Import Jobs ---

  createImportJob(actorKey, { sourceType, totalCount = 0 }) {
    const jobId = id();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO import_jobs
        (id, owner_key, source_type, state, total_count, completed_count, failed_count, report_json, created_at)
      VALUES (?, ?, ?, 'pending', ?, 0, 0, '{}', ?)
    `).run(jobId, actorKey, sourceType, totalCount, timestamp);
    return importJobRow(this.db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(jobId));
  }

  getImportJob(actorKey, jobId) {
    return importJobRow(this.db.prepare(`
      SELECT * FROM import_jobs WHERE id = ? AND owner_key = ?
    `).get(jobId, actorKey));
  }

  updateImportJob(actorKey, jobId, { state, completedCount, failedCount, report, completedAt }) {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE import_jobs SET
        state = COALESCE(?, state),
        completed_count = COALESCE(?, completed_count),
        failed_count = COALESCE(?, failed_count),
        report_json = CASE WHEN ? IS NOT NULL THEN ? ELSE report_json END,
        completed_at = CASE WHEN ? IS NOT NULL THEN ? ELSE completed_at END
      WHERE id = ? AND owner_key = ?
    `).run(
      state ?? null,
      completedCount ?? null,
      failedCount ?? null,
      report !== undefined ? 1 : null,
      report !== undefined ? JSON.stringify(report) : null,
      completedAt ?? (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(state) ? timestamp : null),
      completedAt ?? (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(state) ? timestamp : null),
      jobId,
      actorKey
    );
    return this.getImportJob(actorKey, jobId);
  }

  listImportJobs(actorKey, { state, limit = 50 } = {}) {
    let query = 'SELECT * FROM import_jobs WHERE owner_key = ?';
    const params = [actorKey];
    if (state) {
      query += ' AND state = ?';
      params.push(state);
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Math.min(200, Math.max(1, limit)));
    return this.db.prepare(query).all(...params).map(importJobRow);
  }

  // Append a per-item record to a batch import job's report and adjust counters while keeping job in running state.
  appendImportJobItemReport(actorKey, jobId, itemReport) {
    const timestamp = nowIso();
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM import_jobs WHERE id = ? AND owner_key = ?').get(jobId, actorKey);
      if (!row) return null;
      const report = parseJson(row.report_json) || {};
      const items = Array.isArray(report.items) ? report.items : [];
      items.push({
        index: items.length,
        ok: Boolean(itemReport.ok),
        title: String(itemReport.title || '').slice(0, 500),
        documentId: itemReport.documentId || null,
        inboxEntryId: itemReport.inboxEntryId || null,
        outcome: itemReport.outcome || null,
        matchStrategy: itemReport.matchStrategy || null,
        error: itemReport.error ? String(itemReport.error).slice(0, 500) : null,
        errorCode: itemReport.errorCode ? String(itemReport.errorCode).slice(0, 64) : (itemReport.error ? 'item_failed' : null),
        warning: itemReport.warning ? String(itemReport.warning).slice(0, 500) : undefined,
        candidates: Array.isArray(itemReport.candidates) ? itemReport.candidates : undefined,
        conflicts: Array.isArray(itemReport.conflicts) ? itemReport.conflicts : undefined,
        at: timestamp
      });
      const completedCount = items.filter(i => i.ok).length;
      const failedCount = items.length - completedCount;
      const nextState = row.state === 'pending' ? 'running' : row.state;
      this.db.prepare(`
        UPDATE import_jobs SET
          state = ?,
          completed_count = ?,
          failed_count = ?,
          report_json = ?
        WHERE id = ? AND owner_key = ?
      `).run(nextState, completedCount, failedCount, JSON.stringify({ items }), jobId, actorKey);
      return this.getImportJob(actorKey, jobId);
    });
  }

  // Finalize the batch import job after all items have been processed or when explicitly terminated.
  finalizeImportJob(actorKey, jobId) {
    const timestamp = nowIso();
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM import_jobs WHERE id = ? AND owner_key = ?').get(jobId, actorKey);
      if (!row) return null;
      if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(row.state)) {
        return importJobRow(row);
      }
      const finalState = row.failed_count > 0 ? 'completed_with_errors' : 'completed';
      this.db.prepare(`
        UPDATE import_jobs SET
          state = ?,
          completed_at = ?
        WHERE id = ? AND owner_key = ?
      `).run(finalState, timestamp, jobId, actorKey);
      return this.getImportJob(actorKey, jobId);
    });
  }

  cancelImportJob(actorKey, jobId) {
    const row = this.db.prepare('SELECT * FROM import_jobs WHERE id = ? AND owner_key = ?').get(jobId, actorKey);
    if (!row) throw new CanvasNotFoundError('import job not found');
    if (!['pending', 'running'].includes(row.state)) {
      return this.getImportJob(actorKey, jobId);
    }
    return this.updateImportJob(actorKey, jobId, { state: 'cancelled' });
  }

  // ============================================================
  // --- M4: library roots, source files, file operations ---
  // ============================================================

  // Syncs server-configured library roots (NATIVE_LIBRARY_ROOTS) for a user.
  // Clients have no endpoint to register arbitrary absolute paths. Roots that
  // disappear from the configuration are DEACTIVATED (soft-deleted) and all
  // access through requireLibraryRoot is refused from then on; if the same
  // path returns later, the previous row is reactivated so source_files
  // keep their root linkage and scan history.
  ensureLibraryRootsFromConfig(actorKey, roots) {
    const timestamp = nowIso();
    this.transaction(() => {
      const configuredPaths = new Set();
      for (const root of roots) {
        const absolutePath = path.resolve(root.absolutePath);
        const displayName = String(root.displayName || path.basename(absolutePath)).trim().slice(0, 200) || path.basename(absolutePath);
        configuredPaths.add(absolutePath);
        const existing = this.db.prepare(
          'SELECT * FROM library_roots WHERE owner_key = ? AND absolute_path = ?'
        ).get(actorKey, absolutePath);
        if (existing && existing.deleted_at === null) {
          if (existing.display_name !== displayName) {
            this.db.prepare('UPDATE library_roots SET display_name = ?, updated_at = ? WHERE id = ?')
              .run(displayName, timestamp, existing.id);
          }
          continue;
        }
        if (existing && existing.deleted_at !== null) {
          this.db.prepare('UPDATE library_roots SET deleted_at = NULL, display_name = ?, version = version + 1, updated_at = ? WHERE id = ?')
            .run(displayName, timestamp, existing.id);
          continue;
        }
        this.db.prepare(`
          INSERT INTO library_roots (id, owner_key, display_name, absolute_path, scan_enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?)
        `).run(id(), actorKey, displayName, absolutePath, timestamp, timestamp);
      }
      // Deactivate configured-away roots: hidden from lists and refused on
      // every access path (requireLibraryRoot filters deleted rows).
      const active = this.db.prepare(
        'SELECT id, absolute_path FROM library_roots WHERE owner_key = ? AND deleted_at IS NULL'
      ).all(actorKey);
      for (const row of active) {
        if (!configuredPaths.has(row.absolute_path)) {
          this.db.prepare('UPDATE library_roots SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?')
            .run(timestamp, timestamp, row.id);
        }
      }
    });
    return this.listLibraryRoots(actorKey);
  }

  listLibraryRoots(actorKey) {
    return this.db.prepare(
      'SELECT * FROM library_roots WHERE owner_key = ? AND deleted_at IS NULL ORDER BY created_at ASC'
    ).all(actorKey).map(libraryRootRow);
  }

  getLibraryRoot(actorKey, rootId) {
    return libraryRootRow(this.db.prepare(
      'SELECT * FROM library_roots WHERE id = ? AND owner_key = ? AND deleted_at IS NULL'
    ).get(rootId, actorKey));
  }

  requireLibraryRoot(actorKey, rootId) {
    const root = this.getLibraryRoot(actorKey, rootId);
    if (!root) throw new CanvasNotFoundError('library root not found');
    return root;
  }

  setLibraryRootScanState(actorKey, rootId, { status, at = null } = {}) {
    this.requireLibraryRoot(actorKey, rootId);
    this.db.prepare('UPDATE library_roots SET last_scan_status = ?, last_scan_at = COALESCE(?, last_scan_at), updated_at = ? WHERE id = ?')
      .run(status, at, nowIso(), rootId);
    return this.getLibraryRoot(actorKey, rootId);
  }

  createSourceFile(actorKey, rootId, {
    relativePath,
    filename,
    sha256 = null,
    sizeBytes = 0,
    modifiedAt = null,
    status = 'active',
    documentId = null,
    attachmentId = null,
    lastSeenAt = null
  }) {
    const sourceFileId = id();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO source_files
        (id, owner_key, root_id, document_id, attachment_id, relative_path, filename,
         sha256, size_bytes, modified_at, last_seen_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sourceFileId, actorKey, rootId, documentId, attachmentId,
      relativePath, filename, sha256, sizeBytes, modifiedAt,
      lastSeenAt || timestamp, status, timestamp, timestamp
    );
    return this.getSourceFile(actorKey, sourceFileId);
  }

  getSourceFile(actorKey, sourceFileId) {
    return sourceFileRow(this.db.prepare(
      'SELECT * FROM source_files WHERE id = ? AND owner_key = ? AND deleted_at IS NULL'
    ).get(sourceFileId, actorKey));
  }

  requireSourceFile(actorKey, sourceFileId) {
    const sourceFile = this.getSourceFile(actorKey, sourceFileId);
    if (!sourceFile) throw new CanvasNotFoundError('source file not found');
    return sourceFile;
  }

  getSourceFileByPath(actorKey, rootId, relativePath) {
    return sourceFileRow(this.db.prepare(`
      SELECT * FROM source_files
      WHERE owner_key = ? AND root_id = ? AND relative_path = ? AND deleted_at IS NULL
    `).get(actorKey, rootId, relativePath));
  }

  listSourceFilesBySha(actorKey, sha256) {
    if (!sha256) return [];
    return this.db.prepare(`
      SELECT * FROM source_files WHERE owner_key = ? AND sha256 = ? AND deleted_at IS NULL ORDER BY relative_path ASC
    `).all(actorKey, sha256).map(sourceFileRow);
  }

  listSourceFiles(actorKey, { rootId = null, status = null, limit = 200, offset = 0 } = {}) {
    const clauses = ['owner_key = ?', 'deleted_at IS NULL'];
    const params = [actorKey];
    if (rootId) { clauses.push('root_id = ?'); params.push(rootId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    params.push(Math.max(0, Math.min(1000, limit)), Math.max(0, offset));
    return this.db.prepare(`
      SELECT * FROM source_files WHERE ${clauses.join(' AND ')}
      ORDER BY root_id, relative_path ASC LIMIT ? OFFSET ?
    `).all(...params).map(sourceFileRow);
  }

  // Library binding info for a set of concrete paths inside one root, used by
  // the original-files tree view to show the library filename (document title)
  // next to each disk file. Documents soft-deleted from the library count as
  // unbound (未入库).
  getSourceFileLibraryInfoByPaths(actorKey, rootId, relativePaths) {
    const info = new Map();
    if (!Array.isArray(relativePaths) || relativePaths.length === 0) return info;
    const placeholders = relativePaths.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT sf.id, sf.relative_path, sf.status, sf.document_id, sf.attachment_id,
             d.title AS document_title, d.deleted_at AS document_deleted_at
      FROM source_files sf
      LEFT JOIN documents d ON d.id = sf.document_id
      WHERE sf.owner_key = ? AND sf.root_id = ? AND sf.deleted_at IS NULL
        AND sf.relative_path IN (${placeholders})
    `).all(actorKey, rootId, ...relativePaths);
    for (const row of rows) {
      info.set(row.relative_path, {
        sourceFileId: row.id,
        status: row.status,
        documentId: row.document_deleted_at ? null : row.document_id,
        attachmentId: row.document_deleted_at ? null : row.attachment_id,
        documentTitle: row.document_deleted_at ? null : row.document_title
      });
    }
    return info;
  }

  // Full scan inventory of a root (not-deleted, non-trashed rows) used for
  // incremental diffing; scanner compares this against the live directory.
  listRootSourceFilesForScan(actorKey, rootId) {
    return this.db.prepare(`
      SELECT * FROM source_files
      WHERE owner_key = ? AND root_id = ? AND deleted_at IS NULL AND status != 'trashed'
      ORDER BY relative_path ASC
    `).all(actorKey, rootId).map(sourceFileRow);
  }

  // Applies scanner-discovered facts to a source_files row. Version is
  // incremented so concurrent scans conflict visibly instead of interleaving.
  updateSourceFile(actorKey, sourceFileId, changes = {}) {
    const current = this.requireSourceFile(actorKey, sourceFileId);
    const timestamp = nowIso();
    const next = {
      relativePath: changes.relativePath !== undefined ? changes.relativePath : current.relativePath,
      filename: changes.filename !== undefined ? changes.filename : current.filename,
      sha256: changes.sha256 !== undefined ? changes.sha256 : current.sha256,
      sizeBytes: changes.sizeBytes !== undefined ? changes.sizeBytes : current.sizeBytes,
      modifiedAt: changes.modifiedAt !== undefined ? changes.modifiedAt : current.modifiedAt,
      lastSeenAt: changes.lastSeenAt !== undefined ? changes.lastSeenAt : current.lastSeenAt,
      status: changes.status !== undefined ? changes.status : current.status,
      documentId: changes.documentId !== undefined ? changes.documentId : current.documentId,
      attachmentId: changes.attachmentId !== undefined ? changes.attachmentId : current.attachmentId,
      missingAt: changes.missingAt !== undefined ? changes.missingAt : current.missingAt,
      trashedAt: changes.trashedAt !== undefined ? changes.trashedAt : current.trashedAt
    };
    this.db.prepare(`
      UPDATE source_files SET
        relative_path = ?, filename = ?, sha256 = ?, size_bytes = ?, modified_at = ?,
        last_seen_at = ?, status = ?, document_id = ?, attachment_id = ?,
        missing_at = ?, trashed_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND owner_key = ? AND deleted_at IS NULL
    `).run(
      next.relativePath, next.filename, next.sha256, next.sizeBytes, next.modifiedAt,
      next.lastSeenAt, next.status, next.documentId, next.attachmentId,
      next.missingAt, next.trashedAt, timestamp, sourceFileId, actorKey
    );
    return this.getSourceFile(actorKey, sourceFileId);
  }

  linkSourceFileToDocument(actorKey, sourceFileId, { documentId, attachmentId }) {
    return this.updateSourceFile(actorKey, sourceFileId, { documentId, attachmentId });
  }

  // Bulk scan bookkeeping: refresh last_seen without bumping version, so
  // unchanged files do not churn concurrency versions on every scan.
  touchSourceFiles(actorKey, rootId, sourceFileIds, timestamp) {
    if (!Array.isArray(sourceFileIds) || sourceFileIds.length === 0) return;
    const placeholders = sourceFileIds.map(() => '?').join(', ');
    this.db.prepare(`
      UPDATE source_files SET last_seen_at = ?, updated_at = ?
      WHERE owner_key = ? AND root_id = ? AND id IN (${placeholders})
    `).run(timestamp, timestamp, actorKey, rootId, ...sourceFileIds);
  }

  // Creates the source_file-backed attachment for an enrolled document.
  // The CHECK constraint on attachments requires source_file kind rows to
  // carry a source_file_id and a NULL blob_hash.
  createSourceFileAttachment(actorKey, documentId, {
    sourceFileId,
    originalFilename = '',
    title = '',
    sizeBytes = 0,
    mimeType = 'application/pdf'
  }) {
    this.requireDocument(actorKey, documentId);
    const attachmentId = id();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO attachments
        (id, document_id, blob_hash, mime_type, original_filename, title, size_bytes,
         storage_kind, source_file_id, version, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, 'source_file', ?, 1, ?, ?)
    `).run(attachmentId, documentId, mimeType, originalFilename, title, sizeBytes, sourceFileId, timestamp, timestamp);
    return this.getAttachment(actorKey, attachmentId);
  }

  // Library identity holder for a content hash: the single active source file
  // row that is enrolled with a document. Used by imports for duplicate rules.
  findEnrolledSourceFileBySha(actorKey, sha256) {
    if (!sha256) return null;
    const row = this.db.prepare(`
      SELECT sf.* FROM source_files sf
      JOIN documents d ON d.id = sf.document_id AND d.deleted_at IS NULL
      WHERE sf.owner_key = ? AND sf.sha256 = ? AND sf.status = 'active'
        AND sf.document_id IS NOT NULL AND sf.deleted_at IS NULL
      ORDER BY sf.created_at ASC LIMIT 1
    `).get(actorKey, sha256);
    return sourceFileRow(row);
  }

  // Version-guarded mutation used by file operations after a filesystem
  // mutation: a lost race (412) lets the caller trigger compensation.
  updateSourceFileGuarded(actorKey, sourceFileId, expectedVersion, changes = {}) {
    const current = this.requireSourceFile(actorKey, sourceFileId);
    if (current.version !== expectedVersion) {
      throw new CanvasConflictError('source file version conflict');
    }
    return this.updateSourceFile(actorKey, sourceFileId, changes);
  }

  // Frees a target path when the occupying row is stale (its file is absent
  // from disk). The stale row is soft-deleted with bookkeeping; this never
  // touches a live file. Called inside import/move transactions.
  releaseSourceFilePath(actorKey, rootId, relativePath, reason) {
    const row = this.getSourceFileByPath(actorKey, rootId, relativePath);
    if (!row) return false;
    if (row.status === 'active' || row.status === 'duplicate') {
      const onDisk = fs.existsSync(resolveInsideRoot(
        this.getLibraryRoot(actorKey, row.rootId)?.absolutePath || '', relativePath
      ));
      if (onDisk) {
        throw new CanvasConflictError('target path is occupied by a live source file');
      }
    }
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE source_files SET deleted_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND owner_key = ? AND deleted_at IS NULL
    `).run(timestamp, timestamp, row.id, actorKey);
    return true;
  }

  // 加入文库: creates a library identity (document + source_file attachment)
  // for an unenrolled on-disk file. Content must not already be enrolled.
  enrollExistingSourceFile(actorKey, sourceFileId) {
    const row = this.requireSourceFile(actorKey, sourceFileId);
    if (row.status === 'trashed') {
      throw new CanvasConflictError('trashed files must be restored before enrolling');
    }
    if (row.sha256) {
      const holder = this.findEnrolledSourceFileBySha(actorKey, row.sha256);
      if (holder && holder.id !== row.id) {
        return { duplicate: true, document: this.getDocument(actorKey, holder.documentId), sourceFile: holder };
      }
    }
    if (row.documentId) {
      return { duplicate: false, document: this.getDocument(actorKey, row.documentId), sourceFile: row };
    }
    const title = row.filename.replace(/\.pdf$/i, '').trim() || '未命名文献';
    return this.transaction(() => {
      const document = this.createDocument(actorKey, { title });
      const attachment = this.createSourceFileAttachment(actorKey, document.id, {
        sourceFileId: row.id,
        originalFilename: row.filename,
        title,
        sizeBytes: row.sizeBytes
      });
      const updated = this.updateSourceFile(actorKey, row.id, {
        documentId: document.id,
        attachmentId: attachment.id,
        status: 'active'
      });
      return { duplicate: false, document: this.getDocument(actorKey, document.id), sourceFile: updated, attachment };
    });
  }

  // 从文库移除: unbinds the library identity while leaving the original file
  // untouched on disk. The document (and its annotations through the
  // attachment) is soft-deleted; the source file row is detached so future
  // scans never re-enroll it automatically.
  unbindDocumentFromLibrary(actorKey, documentId, expectedVersion) {
    const document = this.requireDocument(actorKey, documentId);
    if (document.version !== expectedVersion) {
      throw new CanvasConflictError('document version conflict');
    }
    return this.transaction(() => {
      this.deleteDocument(actorKey, documentId, expectedVersion);
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE source_files SET document_id = NULL, attachment_id = NULL, updated_at = ?, version = version + 1
        WHERE owner_key = ? AND document_id = ? AND deleted_at IS NULL
      `).run(timestamp, actorKey, documentId);
      return true;
    });
  }

  // 永久删除 (trash stage 2): remove the trashed file plus every binding.
  purgeTrashedSourceFile(actorKey, sourceFileId) {
    const row = this.requireSourceFile(actorKey, sourceFileId);
    if (row.status !== 'trashed') {
      throw new CanvasConflictError('only trashed source files can be permanently deleted');
    }
    return this.transaction(() => {
      if (row.attachmentId) {
        const timestamp = nowIso();
        this.db.prepare(`
          UPDATE attachments SET deleted_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND deleted_at IS NULL
        `).run(timestamp, timestamp, row.attachmentId);
      }
      if (row.documentId) {
        this.db.prepare('DELETE FROM topic_documents WHERE library_type = ? AND item_key = ?')
          .run('native', row.documentId);
        this.db.prepare('UPDATE documents SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL')
          .run(nowIso(), nowIso(), row.documentId);
      }
      const timestamp = nowIso();
      this.db.prepare('UPDATE source_files SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?')
        .run(timestamp, timestamp, row.id);
      return true;
    });
  }

  // M4 library document list: search/topic/unclassified/fileStatus filters
  // with enriched topic and source-file information per document.
  listNativeLibraryDocuments(actorKey, {
    search = '', topicId = null, unclassified = false, fileStatus = null,
    limit = 50, offset = 0
  } = {}) {
    const params = [actorKey];
    let havingTopic = '';
    if (unclassified) {
      havingTopic = `AND NOT EXISTS (
        SELECT 1 FROM topic_documents td
        WHERE td.library_type = 'native' AND td.item_key = d.id AND td.deleted_at IS NULL
      )`;
    } else if (topicId) {
      havingTopic = `AND EXISTS (
        SELECT 1 FROM topic_documents td
        WHERE td.library_type = 'native' AND td.item_key = d.id AND td.deleted_at IS NULL AND td.workspace_id = ?
      )`;
      params.push(topicId);
    }
    let fileFilter = '';
    if (fileStatus) {
      fileFilter = `AND EXISTS (
        SELECT 1 FROM source_files sf
        WHERE sf.document_id = d.id AND sf.deleted_at IS NULL AND sf.status = ?
      )`;
      params.push(fileStatus);
    }
    const like = `%${String(search).trim()}%`;
    const searchClause = String(search).trim()
      ? 'AND (d.title LIKE ? OR d.abstract LIKE ? OR d.doi LIKE ?)'
      : '';
    if (searchClause) params.push(like, like, like);

    const total = this.db.prepare(`
      SELECT COUNT(*) AS c FROM documents d
      WHERE d.owner_key = ? AND d.deleted_at IS NULL ${havingTopic} ${fileFilter} ${searchClause}
    `).get(...params).c;

    params.push(Math.max(0, Math.min(200, limit)), Math.max(0, offset));
    const rows = this.db.prepare(`
      SELECT d.* FROM documents d
      WHERE d.owner_key = ? AND d.deleted_at IS NULL ${havingTopic} ${fileFilter} ${searchClause}
      ORDER BY d.updated_at DESC LIMIT ? OFFSET ?
    `).all(...params);

    return { total, documents: rows.map(row => {
      const doc = documentRow(row);
      doc.topics = this.db.prepare(`
        SELECT td.id AS topic_document_id, td.version AS topic_version, w.id AS workspace_id, w.name AS workspace_name
        FROM topic_documents td JOIN workspaces w ON w.id = td.workspace_id
        WHERE td.library_type = 'native' AND td.item_key = ? AND td.deleted_at IS NULL AND w.deleted_at IS NULL
        ORDER BY w.name ASC
      `).all(row.id);
      doc.sourceFile = sourceFileRow(this.db.prepare(`
        SELECT sf.* FROM source_files sf
        WHERE sf.document_id = ? AND sf.deleted_at IS NULL
        ORDER BY sf.status = 'active' DESC, sf.created_at ASC LIMIT 1
      `).get(row.id) || null);
      return doc;
    }) };
  }

  addDocumentTopics(actorKey, documentId, topicIds, { origin = 'manual' } = {}) {
    const document = this.requireDocument(actorKey, documentId);
    if (!Array.isArray(topicIds) || topicIds.length === 0 || topicIds.length > 50) {
      throw new TypeError('topicIds must be an array of 1-50 workspace ids');
    }
    // Topic bindings must point at the ACTIVE attachment id + version so
    // analysis staleness and knowledge-unit filtering stay correct.
    const activeAttachment = this.db.prepare(`
      SELECT * FROM attachments WHERE document_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC LIMIT 1
    `).get(document.id);
    const results = [];
    return this.transaction(() => {
      for (const workspaceId of topicIds) {
        results.push(this.addTopicDocument(actorKey, workspaceId, {
          libraryType: 'native',
          libraryId: 'local',
          itemKey: documentId,
          attachmentKey: activeAttachment?.id || null,
          attachmentVersion: activeAttachment?.version ?? null,
          status: 'accepted',
          origin
        }));
      }
      return results;
    });
  }

  removeDocumentTopic(actorKey, documentId, workspaceId) {
    const binding = this.db.prepare(`
      SELECT td.* FROM topic_documents td
      JOIN documents d ON d.id = td.item_key
      WHERE td.workspace_id = ? AND td.library_type = 'native' AND td.item_key = ?
        AND td.deleted_at IS NULL AND d.owner_key = ?
    `).get(workspaceId, documentId, actorKey);
    if (!binding) throw new CanvasNotFoundError('topic document binding not found');
    return this.removeTopicDocument(actorKey, binding.id, binding.version);
  }

  // Scanner hook: an enrolled source file's content changed on disk.
  //  - New content is still unique: attachment version+1 with refreshed size,
  //    bound topic_documents follow the new attachment version and their
  //    analyses go stale (forcing re-analysis of the new content).
  //  - New content already belongs to another enrolled document: the row is
  //    demoted to duplicate with NO second library identity; the previous
  //    attachment is soft-deleted and its topic bindings are cleared with
  //    analyses stale.
  applySourceContentChange(actorKey, sourceFileId, { sha256, sizeBytes, modifiedAt, lastSeenAt }) {
    const row = this.requireSourceFile(actorKey, sourceFileId);
    const holder = this.findEnrolledSourceFileBySha(actorKey, sha256);
    const nowDuplicate = holder && holder.id !== row.id;
    const timestamp = nowIso();
    return this.transaction(() => {
      if (nowDuplicate) {
        if (row.attachmentId) {
          this.db.prepare(`
            UPDATE attachments SET deleted_at = ?, updated_at = ?, version = version + 1
            WHERE id = ? AND deleted_at IS NULL
          `).run(timestamp, timestamp, row.attachmentId);
          this.db.prepare(`
            UPDATE topic_documents SET
              attachment_key = NULL, attachment_version = NULL, analysis_status = 'stale',
              version = version + 1, updated_at = ?
            WHERE attachment_key = ? AND deleted_at IS NULL
          `).run(timestamp, row.attachmentId);
        }
        return this.updateSourceFile(actorKey, sourceFileId, {
          sha256, sizeBytes, modifiedAt, lastSeenAt,
          status: 'duplicate',
          documentId: null,
          attachmentId: null
        });
      }
      let newAttachmentVersion = null;
      if (row.attachmentId) {
        const att = this.db.prepare('SELECT version, size_bytes FROM attachments WHERE id = ? AND deleted_at IS NULL').get(row.attachmentId);
        if (att) {
          newAttachmentVersion = att.version + 1;
          this.db.prepare(`
            UPDATE attachments SET version = version + 1, size_bytes = ?, updated_at = ?
            WHERE id = ?
          `).run(sizeBytes, timestamp, row.attachmentId);
          this.db.prepare(`
            UPDATE topic_documents SET
              analysis_status = 'stale', attachment_version = ?,
              version = version + 1, updated_at = ?
            WHERE attachment_key = ? AND deleted_at IS NULL
          `).run(newAttachmentVersion, timestamp, row.attachmentId);
        }
      }
      const updated = this.updateSourceFile(actorKey, sourceFileId, {
        sha256, sizeBytes, modifiedAt, lastSeenAt,
        status: 'active',
        missingAt: null
      });
      return { sourceFile: updated, attachmentVersion: newAttachmentVersion, demoted: false };
    });
  }

  // M4 import landing: identical identity/dedupe chain to importNativeDocument
  // (with source-file SHA checked first), but the PDF lives in a library root
  // directory instead of the managed blob store.
  importNativeDocumentToSourceFile(actorKey, {
    sourceType,
    title,
    abstract = '',
    creators = [],
    year = null,
    doi = null,
    url = null,
    isbn = null,
    arxivId = null,
    externalRefs = [],
    rootId,
    relativePath,
    filename,
    sha256,
    sizeBytes,
    modifiedAt = null,
    topicIds = [],
    forceNew = false,
    confirmFuzzy = false
  }) {
    if (!title || typeof title !== 'string' || !title.trim()) {
      throw new TypeError('title is required');
    }
    if (topicIds.length > 50) throw new TypeError('at most 50 topics per import');

    // Content identity: the same SHA-256 never joins the library twice.
    // forceNew is deliberately NOT honored here — it only relaxes the fuzzy
    // metadata match below, never content dedupe.
    const holder = this.findEnrolledSourceFileBySha(actorKey, sha256);
    if (holder) {
      return {
        outcome: 'duplicate_content',
        match: { strategy: 'sha256', documentId: holder.documentId },
        document: this.getDocument(actorKey, holder.documentId),
        sourceFile: holder
      };
    }

    const decision = this._decideNativeImportMatch(actorKey, {
      title, year, doi, isbn, arxivId, attachment: null, externalRefs, forceNew, confirmFuzzy
    });
    if (decision.outcome !== 'writable') {
      return decision;
    }
    const { matched } = decision;
    const { normalizedDoi, normalizedIsbn, normalizedArxivId } = decision.normalized;

    const refsToWrite = [];
    if (normalizedDoi) refsToWrite.push({ provider: 'doi', externalItemId: normalizedDoi, sourceUrl: url || null });
    if (normalizedArxivId) refsToWrite.push({ provider: 'arxiv', externalItemId: normalizedArxivId, sourceUrl: url || null });
    for (const ref of externalRefs) {
      if (ref?.provider && ref?.externalItemId) {
        refsToWrite.push({
          provider: String(ref.provider),
          externalItemId: String(ref.externalItemId),
          externalLibraryId: ref.externalLibraryId || null,
          externalAttachmentId: ref.externalAttachmentId || null,
          externalVersion: ref.externalVersion || null,
          sourceUrl: ref.sourceUrl || null
        });
      }
    }
    const creatorsInput = (Array.isArray(creators) ? creators : []).map(c => ({
      creatorType: c.creatorType || 'author',
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      name: c.name || ''
    }));

    return this.transaction(() => {
      let document;
      if (matched) {
        document = matched.document;
        const updates = {};
        if (normalizedDoi && !document.doi) updates.doi = normalizedDoi;
        if (normalizedIsbn && !document.isbn) updates.isbn = normalizedIsbn;
        if (url && !document.url) updates.url = url;
        if (abstract && !document.abstract) updates.abstract = abstract;
        if (year && !document.year) updates.year = Number(year);
        if (creatorsInput.length && !document.creators.length) updates.creators = creatorsInput;
        if (Object.keys(updates).length) {
          document = this.updateDocument(actorKey, document.id, undefined, updates);
        }
      } else {
        document = this.createDocument(actorKey, {
          title: title.trim(),
          abstract: abstract || '',
          year: year ? Number(year) : null,
          doi: normalizedDoi,
          isbn: normalizedIsbn,
          url: url || null,
          creators: creatorsInput
        });
      }
      for (const ref of refsToWrite) {
        const existingRef = this.getExternalRef(actorKey, ref.provider, ref.externalItemId, ref.externalLibraryId || null);
        if (!existingRef) this.createExternalRef(actorKey, document.id, ref);
      }

      // Take over a stale DB row at the target path (its file is absent).
      this.releaseSourceFilePath(actorKey, rootId, relativePath, 'import_takeover');

      const sourceFile = this.createSourceFile(actorKey, rootId, {
        relativePath,
        filename,
        sha256,
        sizeBytes,
        modifiedAt,
        status: 'active',
        documentId: document.id,
        lastSeenAt: nowIso()
      });
      const attachment = this.createSourceFileAttachment(actorKey, document.id, {
        sourceFileId: sourceFile.id,
        originalFilename: filename,
        title: title.trim(),
        sizeBytes
      });
      this.updateSourceFile(actorKey, sourceFile.id, { attachmentId: attachment.id });

      const topicDocuments = [];
      for (const workspaceId of topicIds) {
        topicDocuments.push(this.addTopicDocument(actorKey, workspaceId, {
          libraryType: 'native',
          libraryId: 'local',
          itemKey: document.id,
          attachmentKey: attachment.id,
          attachmentVersion: attachment.version,
          status: 'accepted',
          origin: 'canvas_import'
        }));
      }

      return {
        outcome: matched ? 'reused' : 'created',
        match: matched ? { strategy: matched.strategy, documentId: matched.document.id } : null,
        document: this.getDocument(actorKey, document.id),
        sourceFile: this.getSourceFile(actorKey, sourceFile.id),
        attachment,
        topicDocuments
      };
    });
  }

  // --- File operations (persistent operation log with crash compensation) ---

  createFileOperation(actorKey, { operationType, sourceFileId = null, sourcePath = null, targetPath = null, payload = {} }) {
    const fileOpId = id();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO file_operations
        (id, owner_key, operation_type, source_file_id, source_path, target_path, state, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(fileOpId, actorKey, operationType, sourceFileId, sourcePath, targetPath, JSON.stringify(payload || {}), timestamp, timestamp);
    return this.getFileOperation(actorKey, fileOpId);
  }

  getFileOperation(actorKey, fileOpId) {
    return fileOperationRow(this.db.prepare(
      'SELECT * FROM file_operations WHERE id = ? AND owner_key = ?'
    ).get(fileOpId, actorKey));
  }

  startFileOperation(fileOpId) {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE file_operations SET state = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND state IN ('queued', 'running')
    `).run(timestamp, timestamp, fileOpId);
  }

  completeFileOperation(fileOpId) {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE file_operations SET state = 'completed', completed_at = ?, updated_at = ?
      WHERE id = ? AND state IN ('queued', 'running')
    `).run(timestamp, timestamp, fileOpId);
  }

  failFileOperation(fileOpId, errorCode) {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE file_operations SET state = 'failed', error_code = ?, updated_at = ?
      WHERE id = ? AND state IN ('queued', 'running')
    `).run(errorCode ? String(errorCode).slice(0, 128) : 'operation_failed', timestamp, fileOpId);
  }

  markFileOperationRolledBack(fileOpId) {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE file_operations SET state = 'rolled_back', error_code = COALESCE(error_code, 'interrupted'), updated_at = ?
      WHERE id = ? AND state IN ('queued', 'running', 'failed')
    `).run(timestamp, fileOpId);
  }

  // Startup recovery: operations that were queued/running when the process
  // died. The executor decides per type whether to resume or roll back.
  listResumableFileOperations() {
    return this.db.prepare(`
      SELECT * FROM file_operations WHERE state IN ('queued', 'running') ORDER BY created_at ASC
    `).all().map(fileOperationRow);
  }

  // Unified attachment content access: Reader, Range serving, full-text
  // analysis and annotation tooling all resolve bytes through this method and
  // must not care whether the backing store is the managed blob store or a
  // file inside a library root.
  getAttachmentContent(actorKey, attachmentId) {
    const row = this.db.prepare(`
      SELECT a.*, d.id AS doc_id, d.title AS doc_title,
             b.relative_path AS blob_relative_path, b.size_bytes AS blob_size_bytes, b.mime_type AS blob_mime_type,
             sf.id AS sf_id, sf.relative_path AS sf_relative_path, sf.filename AS sf_filename,
             sf.sha256 AS sf_sha256, sf.size_bytes AS sf_size_bytes, sf.status AS sf_status,
             lr.id AS sf_root_id, lr.absolute_path AS sf_root_path
      FROM attachments a
      JOIN documents d ON d.id = a.document_id
      LEFT JOIN blobs b ON b.sha256 = a.blob_hash
      LEFT JOIN source_files sf ON sf.id = a.source_file_id AND sf.deleted_at IS NULL
      LEFT JOIN library_roots lr ON lr.id = sf.root_id AND lr.deleted_at IS NULL
      WHERE a.id = ? AND d.owner_key = ? AND a.deleted_at IS NULL AND d.deleted_at IS NULL
    `).get(attachmentId, actorKey);
    if (!row) return null;
    const attachment = attachmentRow(row);
    const document = { id: row.doc_id, title: row.doc_title };
    if (attachment.storageKind === 'source_file') {
      if (!row.sf_id || !row.sf_root_path) return null;
      return {
        kind: 'source_file',
        attachment,
        document,
        sha256: row.sf_sha256,
        mimeType: attachment.mimeType || 'application/pdf',
        sizeBytes: row.sf_size_bytes,
        fileName: row.sf_filename,
        sourceFile: {
          id: row.sf_id,
          rootId: row.sf_root_id,
          rootAbsolutePath: row.sf_root_path,
          relativePath: row.sf_relative_path,
          status: row.sf_status
        }
      };
    }
    if (!row.blob_relative_path) return null;
    const blobDir = this.getBlobStorageDir();
    return {
      kind: 'managed_blob',
      attachment,
      document,
      sha256: row.blob_hash,
      mimeType: row.blob_mime_type || attachment.mimeType || 'application/pdf',
      sizeBytes: row.blob_size_bytes,
      fileName: attachment.originalFilename || 'document.pdf',
      blob: { relativePath: row.blob_relative_path },
      filePath: resolveInsideRoot(blobDir, row.blob_relative_path)
    };
  }
}

export const canvasNodeTypes = NODE_TYPES;
export const canvasEdgeRelations = EDGE_RELATIONS;
export const canvasEdgeOrigins = EDGE_ORIGINS;
export const canvasTopicDocStatuses = TOPIC_DOC_STATUSES;
export const canvasTopicAnalysisStatuses = TOPIC_ANALYSIS_STATUSES;
export const canvasTopicDocOrigins = TOPIC_DOC_ORIGINS;
export const canvasCollectionBindingModes = COLLECTION_BINDING_MODES;
export const canvasInboxEntryStates = INBOX_ENTRY_STATES;
export const canvasJobStates = JOB_STATES;
