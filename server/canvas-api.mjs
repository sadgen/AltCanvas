import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CanvasConflictError,
  CanvasNotFoundError,
  CanvasStore,
  canvasActorKey,
  canvasCollectionBindingModes,
  canvasEdgeRelations,
  canvasInboxEntryStates,
  canvasJobStates,
  canvasNodeTypes,
  canvasTopicAnalysisStatuses,
  canvasTopicDocOrigins,
  canvasTopicDocStatuses
} from './canvas-store.mjs';
import { getSession, getSessionIdFromRequest } from './session.mjs';
import { getAiPublicConfig, requestAiCompletion, validateAiEndpoint } from './ai-provider.mjs';
import { resolveImportInput, findDuplicateCandidates, safeDownloadPdfFile } from './import-resolver.mjs';
import { NativePathError, openFileInsideRoot, normalizeRelativePath, normalizeFilename, listDirectoryPage, ensureDirectoryInsideRoot, safeUnlinkWithExpectedSha } from './native-fs.mjs';
import { scanLibraryRoot, LibraryScanError } from './library-scanner.mjs';
import { runBlobOnlyWebImportMigration } from './blob-migration.mjs';
import {
  FileOpError,
  probeTargetPath,
  placeFileIntoRoot,
  renameSourceFile,
  moveSourceFile,
  trashSourceFile,
  restoreSourceFile,
  deleteSourceFilePermanent
} from './native-file-ops.mjs';

// M4: server-configured library roots. Format: JSON array
// [{"path": "/data/library", "name": "研究文库"}] or a semicolon separated
// list of "path|name" entries (name optional). Clients cannot register roots.
export function parseNativeLibraryRootsConfig(env = process.env) {
  const raw = (env.NATIVE_LIBRARY_ROOTS || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('NATIVE_LIBRARY_ROOTS must be valid JSON when it starts with "["');
    }
    if (!Array.isArray(parsed)) throw new Error('NATIVE_LIBRARY_ROOTS JSON must be an array');
    return parsed.map(entry => {
      if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) {
        throw new Error('NATIVE_LIBRARY_ROOTS entries must use absolute paths');
      }
      return {
        absolutePath: path.resolve(entry.path),
        displayName: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 200) : path.basename(entry.path)
      };
    });
  }
  return raw.split(';').map(chunk => chunk.trim()).filter(Boolean).map(chunk => {
    const [rawPath, rawName] = chunk.split('|');
    if (!rawPath || !path.isAbsolute(rawPath.trim())) {
      throw new Error('NATIVE_LIBRARY_ROOTS entries must use absolute paths');
    }
    const abs = path.resolve(rawPath.trim());
    return {
      absolutePath: abs,
      displayName: rawName && rawName.trim() ? rawName.trim().slice(0, 200) : path.basename(abs)
    };
  });
}

const MAX_BODY_BYTES = Number(process.env.MAX_CANVAS_BODY_BYTES || 512 * 1024);
const MAX_DOCUMENT_BODY_BYTES = Number(process.env.MAX_AI_DOCUMENT_BODY_BYTES || 768 * 1024);
const MAX_DOCUMENT_TEXT_CHARS = Number(process.env.MAX_AI_DOCUMENT_TEXT_CHARS || 600_000);
const AI_DOCUMENT_CHUNK_CHARS = Number(process.env.AI_DOCUMENT_CHUNK_CHARS || 30_000);
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const AI_TASKS = new Set(['translate', 'synthesize', 'compare', 'explain']);
const AI_PROMPT_VERSION = 'altcanvas-ai-v1';
const MAX_IMPORT_NODES = 500;
const MAX_IMPORT_EDGES = 1000;
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 104_857_600); // 100 MiB default
const MAX_IMPORT_BODY_BYTES = Number(process.env.MAX_IMPORT_BODY_BYTES || 2 * 1024 * 1024); // 2 MiB for import requests
let defaultStore;

async function streamUploadToFile(req, targetDir, maxBytes = MAX_UPLOAD_BYTES) {
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const tempFileName = `upload-${crypto.randomBytes(16).toString('hex')}.tmp`;
  const tempFilePath = path.join(targetDir, tempFileName);
  const writeStream = fs.createWriteStream(tempFilePath, { mode: 0o600 });
  const hash = crypto.createHash('sha256');

  const contentType = String(req.headers['content-type'] || '');
  let originalFilename = 'document.pdf';
  if (req.headers['x-filename']) {
    try {
      originalFilename = decodeURIComponent(String(req.headers['x-filename']));
    } catch {
      originalFilename = String(req.headers['x-filename']);
    }
  }
  let targetWorkspaceId = req.headers['x-target-workspace-id'] || null;
  let forceNew = req.headers['x-force-new'] === 'true';

  let totalBytes = 0;
  let firstChunk = null;

  let streamError = null;
  writeStream.on('error', (err) => { streamError = err; });

  const cleanup = () => {
    try { writeStream.destroy(); } catch {}
    try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch {}
  };

  const safeWrite = async (chunk) => {
    if (streamError) throw streamError;
    if (!writeStream.write(chunk)) {
      await new Promise((resolve, reject) => {
        const onDrain = () => { cleanupListeners(); resolve(); };
        const onError = (err) => { cleanupListeners(); reject(err); };
        const onClose = () => { cleanupListeners(); reject(new Error('Upload stream closed prematurely during write')); };
        const cleanupListeners = () => {
          writeStream.removeListener('drain', onDrain);
          writeStream.removeListener('error', onError);
          writeStream.removeListener('close', onClose);
        };
        writeStream.once('drain', onDrain);
        writeStream.once('error', onError);
        writeStream.once('close', onClose);
      });
    }
  };

  try {
    if (contentType.includes('multipart/form-data')) {
      const boundaryMatch = /boundary=(?:["']([^"']+)["']|([^;]+))/i.exec(contentType);
      if (!boundaryMatch) throw new TypeError('Missing multipart boundary');
      const boundary = (boundaryMatch[1] || boundaryMatch[2]).trim();
      const boundaryBuffer = Buffer.from(`--${boundary}`);
      const doubleCrlf = Buffer.from('\r\n\r\n');
      const MAX_TEXT_FIELD_BYTES = 65536; // 64 KiB limit for text fields like workspaceId

      let state = 'SEEK_BOUNDARY';
      let buffer = Buffer.alloc(0);
      let currentFieldName = null;
      let hasCompletedFile = false;
      let sawClosingBoundary = false;

      for await (const chunk of req) {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          const err = new Error('File exceeds maximum upload size (100MB)');
          err.status = 413;
          throw err;
        }

        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

        while (true) {
          if (state === 'SEEK_BOUNDARY') {
            const idx = buffer.indexOf(boundaryBuffer);
            if (idx === -1) {
              if (buffer.length > boundaryBuffer.length + 4) {
                buffer = buffer.slice(buffer.length - boundaryBuffer.length - 4);
              }
              break;
            }
            if (buffer.length < idx + boundaryBuffer.length + 2) {
              // Wait for at least 2 bytes after boundary to check for closing '--' vs '\r\n'
              break;
            }
            const tail = buffer.slice(idx + boundaryBuffer.length, idx + boundaryBuffer.length + 2).toString('ascii');
            if (tail === '--') {
              sawClosingBoundary = true;
              buffer = buffer.slice(idx + boundaryBuffer.length + 2);
              state = 'CLOSED';
              break;
            } else if (tail === '\r\n') {
              buffer = buffer.slice(idx + boundaryBuffer.length + 2);
              state = 'HEADERS';
            } else {
              buffer = buffer.slice(idx + boundaryBuffer.length);
              state = 'HEADERS';
            }
          } else if (state === 'HEADERS') {
            const idx = buffer.indexOf(doubleCrlf);
            if (idx === -1) break;
            const headerStr = buffer.slice(0, idx).toString('utf8');
            buffer = buffer.slice(idx + 4);

            const filenameMatch = /filename=["']?([^"';\r\n]+)["']?/i.exec(headerStr);
            if (filenameMatch) {
              originalFilename = path.basename(filenameMatch[1].trim());
              state = 'FILE_DATA';
            } else {
              const nameMatch = /name=["']?([^"';\r\n]+)["']?/i.exec(headerStr);
              currentFieldName = nameMatch ? nameMatch[1] : '';
              state = 'FIELD_DATA';
            }
          } else if (state === 'FIELD_DATA') {
            if (buffer.length > MAX_TEXT_FIELD_BYTES) {
              const err = new Error('Form text field exceeds maximum length (64KB)');
              err.status = 400;
              throw err;
            }
            const nextBoundaryIdx = buffer.indexOf(boundaryBuffer);
            if (nextBoundaryIdx === -1) {
              break;
            } else {
              const fieldValue = buffer.slice(0, Math.max(0, nextBoundaryIdx - 2)).toString('utf8');
              if (currentFieldName === 'targetWorkspaceId') targetWorkspaceId = fieldValue.trim();
              if (currentFieldName === 'forceNew') forceNew = fieldValue.trim() === 'true';
              buffer = buffer.slice(nextBoundaryIdx);
              state = 'SEEK_BOUNDARY';
            }
          } else if (state === 'FILE_DATA') {
            const nextBoundaryIdx = buffer.indexOf(boundaryBuffer);
            if (nextBoundaryIdx === -1) {
              const safeLen = Math.max(0, buffer.length - boundaryBuffer.length - 8);
              if (safeLen > 0) {
                const toWrite = buffer.slice(0, safeLen);
                if (!firstChunk && toWrite.length > 0) firstChunk = toWrite.slice(0, 5);
                hash.update(toWrite);
                await safeWrite(toWrite);
                buffer = buffer.slice(safeLen);
              }
              break;
            } else {
              const fileData = buffer.slice(0, Math.max(0, nextBoundaryIdx - 2));
              if (!firstChunk && fileData.length > 0) firstChunk = fileData.slice(0, 5);
              hash.update(fileData);
              await safeWrite(fileData);
              hasCompletedFile = true;
              buffer = buffer.slice(nextBoundaryIdx);
              state = 'SEEK_BOUNDARY';
            }
          } else if (state === 'CLOSED') {
            break;
          }
        }
      }

      if (!hasCompletedFile || !sawClosingBoundary || state !== 'CLOSED') {
        const err = new Error('Multipart payload was truncated or ended prematurely without valid closing boundary');
        err.status = 400;
        throw err;
      }
    } else {
      for await (const chunk of req) {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          const err = new Error('File exceeds maximum upload size (100MB)');
          err.status = 413;
          throw err;
        }
        const buf = Buffer.from(chunk);
        if (!firstChunk && buf.length > 0) firstChunk = buf.slice(0, 5);
        hash.update(buf);
        await safeWrite(buf);
      }
    }

    await new Promise((resolve, reject) => {
      writeStream.end(err => err ? reject(err) : resolve());
    });

    const fd = fs.openSync(tempFilePath, 'r');
    const headBuf = Buffer.alloc(5);
    fs.readSync(fd, headBuf, 0, 5, 0);
    fs.closeSync(fd);
    if (!headBuf.toString('ascii').startsWith('%PDF-')) {
      cleanup();
      const err = new Error('File is not a valid PDF (%PDF- header missing)');
      err.status = 400;
      throw err;
    }

    const sha256 = hash.digest('hex');
    const stat = fs.statSync(tempFilePath);
    return {
      tempFilePath,
      sha256,
      sizeBytes: stat.size,
      originalFilename,
      targetWorkspaceId,
      forceNew
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function json(res, status, payload, headers = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}

function error(res, status, code, message) {
  json(res, status, { error: { code, message } });
}

function etag(version) {
  return `W/"${version}"`;
}

function versionFromIfMatch(req) {
  const value = String(req.headers['if-match'] || '');
  const match = /^(?:W\/)?"(\d+)"$/.exec(value);
  return match ? Number(match[1]) : null;
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      const err = new Error('request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    const err = new Error('request body must be a JSON object');
    err.status = 400;
    throw err;
  }
}

function parseAiJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 未返回可识别的画板结构');
  try { return JSON.parse(raw.slice(start, end + 1)); }
  catch { throw new Error('AI 返回的画板结构不是有效 JSON'); }
}

function parseAiJsonArray(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveClassificationDocumentMetas(store, actorKey, entries, parsed) {
  const rawMap = parsed?.documentMetadata || parsed?.documentMetas || parsed?.titles || {};
  const saved = [];

  for (const entry of entries) {
    const raw = rawMap?.[entry.id] ?? rawMap?.[entry.itemKey] ?? rawMap?.[entry.title];
    const candidate = typeof raw === 'string' ? { cleanTitle: raw } : raw;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;

    const cleanTitle = String(candidate.cleanTitle || candidate.chineseTitle || '').trim().slice(0, 500);
    if (!cleanTitle) continue;

    const existing = store.getDocumentMeta(actorKey, entry);
    if (existing?.source === 'manual') {
      saved.push(existing);
      continue;
    }

    saved.push(store.saveDocumentMeta(actorKey, {
      libraryType: entry.libraryType,
      libraryId: entry.libraryId,
      itemKey: entry.itemKey,
      attachmentKey: existing?.attachmentKey || entry.attachmentKey || null,
      attachmentVersion: existing?.attachmentVersion ?? null,
      cleanTitle,
      institution: String(candidate.institution || '').trim().slice(0, 200),
      reportTitle: String(candidate.reportTitle || candidate.chineseTitle || '').trim().slice(0, 300),
      subtitle: String(candidate.subtitle || '').trim().slice(0, 300),
      year: String(candidate.year || entry.year || '').trim().slice(0, 50),
      summary: String(candidate.summary || '').trim().slice(0, 5000),
      source: 'ai_classification'
    }));
  }

  return saved;
}

// [M4] executeImportJob (inbox-era import job runner) was removed with
// the inbox; queued leftovers are failed by recoverQueuedAndRunningJobs.

export function recoverQueuedAndRunningJobs(store) {
  if (!store?.db) return;
  try {
    const pendingJobs = store.db.prepare(`
      SELECT * FROM jobs WHERE state IN ('queued', 'running') ORDER BY created_at ASC
    `).all();
    for (const rawJob of pendingJobs) {
      const actorKey = rawJob.owner_key;
      const job = store.getJob(actorKey, rawJob.id);
      if (job && job.jobType === 'import_document' && job.payload) {
        // [M4] The inbox-era import job writes the retired inbox_entries table;
        // queued/running leftovers are failed at startup, never executed.
        store.updateJobState(job.id, {
          state: 'failed',
          errorCode: 'feature_retired'
        });
      }
    }
  } catch {}
}

function searchableText(value) {
  return String(value || '').normalize('NFKC').replace(/[\s\u00ad]+/g, '').toLocaleLowerCase();
}

function textShingles(value) {
  const normalized = searchableText(value);
  const values = new Set();
  for (let index = 0; index < normalized.length - 1; index++) values.add(normalized.slice(index, index + 2));
  return values;
}

function pageSentences(page) {
  const pieces = String(page.text || '').match(/[^。！？.!?\n]+[。！？.!?]?/g) || [];
  return pieces.flatMap(piece => {
    const text = piece.trim();
    if (text.length < 8) return [];
    if (text.length <= 420) return [{ pageNumber: page.pageNumber, text }];
    const chunks = [];
    for (let offset = 0; offset < text.length; offset += 320) {
      const chunk = text.slice(offset, offset + 360).trim();
      if (chunk.length >= 8) chunks.push({ pageNumber: page.pageNumber, text: chunk });
    }
    return chunks;
  });
}

// Build the searchable corpus once per document-map request: exact matching
// needs normalized page text, similarity fallback needs per-sentence shingles.
function buildEvidenceIndex(pages) {
  return {
    normalizedPages: pages.map(page => ({ pageNumber: page.pageNumber, normalized: searchableText(page.text) })),
    sentences: pages.flatMap(pageSentences).map(sentence => ({ ...sentence, shingles: textShingles(sentence.text) }))
  };
}

function verifiedEvidence(item, evidenceIndex, pageStart, pageEnd, name, context) {
  const quote = String(item?.evidenceQuote || item?.quote || '').trim().slice(0, 1200);
  const needle = searchableText(quote);
  const requestedPage = Number.isInteger(item?.evidencePage) ? item.evidencePage : null;
  if (needle.length >= 8) {
    const exactPages = evidenceIndex.normalizedPages.filter(page => page.normalized.includes(needle));
    const matchedPage = exactPages.find(page => page.pageNumber === requestedPage)
      || exactPages.find(page => page.pageNumber >= pageStart && page.pageNumber <= pageEnd)
      || exactPages[0];
    if (matchedPage) return { evidenceQuote: quote, evidencePage: matchedPage.pageNumber };
  }

  const target = textShingles(`${context}\n${quote}`);
  let best = null;
  for (const candidate of evidenceIndex.sentences) {
    let intersection = 0;
    for (const value of candidate.shingles) if (target.has(value)) intersection++;
    const similarity = candidate.shingles.size && target.size
      ? (2 * intersection) / (candidate.shingles.size + target.size) : 0;
    const inRange = candidate.pageNumber >= pageStart && candidate.pageNumber <= pageEnd;
    const score = similarity + (inRange ? 0.05 : 0) + (candidate.pageNumber === requestedPage ? 0.03 : 0);
    if (!best || score > best.score) best = { ...candidate, score, similarity };
  }
  // Every card must stay locatable: a fabricated citation (zero lexical
  // overlap) still anchors to the highest-scoring sentence of its claimed
  // page range. Only a corpus without usable sentences leaves a card with
  // no evidence at all.
  if (!best || (best.similarity <= 0 && best.score <= 0)) {
    return { evidenceQuote: null, evidencePage: null };
  }
  return { evidenceQuote: best.text, evidencePage: best.pageNumber };
}

function normalizeDocumentGraph(raw, evidenceIndex, pageCount, fallbackTitle, existingNodeIds = []) {
  const page = value => Math.min(pageCount, Math.max(1, Number.isInteger(value) ? value : 1));
  const items = (value, kind, max) => (Array.isArray(value) ? value : []).slice(0, max).map((item, index) => {
    const pageStart = page(item?.pageStart);
    const pageEnd = Math.max(pageStart, page(item?.pageEnd ?? pageStart));
    const title = string(item?.title || `${kind} ${index + 1}`, `${kind}.title`, { min: 1, max: 300 });
    const body = string(item?.body || item?.summary || item?.explanation || item?.claim || '', `${kind}.body`, { min: 1, max: 20_000 });
    const evidence = verifiedEvidence(item, evidenceIndex, pageStart, pageEnd, `${kind}-${index}`, `${title}\n${body}`);
    return {
      id: `${kind}-${index}`,
      title, body,
      pageStart,
      pageEnd,
      evidenceQuote: evidence.evidenceQuote,
      evidencePage: evidence.evidencePage ?? pageStart
    };
  });
  const sections = items(raw?.sections, 'section', 12);
  const concepts = items(raw?.concepts, 'concept', 12);
  const claims = items(raw?.claims, 'claim', 12);
  const validNewIds = new Set(['overview', ...sections.map(x => x.id), ...concepts.map(x => x.id), ...claims.map(x => x.id)]);
  const validExistingSet = new Set(existingNodeIds);
  const relations = (Array.isArray(raw?.relations) ? raw.relations : []).slice(0, 80).flatMap(item => {
    const from = String(item?.from || '');
    const to = String(item?.to || '');
    const normalizeKey = key => {
      if (validNewIds.has(key)) return key;
      const stripped = key.startsWith('existing:') ? key.slice('existing:'.length) : key;
      if (validExistingSet.has(stripped)) return `existing:${stripped}`;
      return null;
    };
    const normFrom = normalizeKey(from);
    const normTo = normalizeKey(to);
    if (!normFrom || !normTo || normFrom === normTo) return [];
    const relation = canvasEdgeRelations.has(item?.relation) ? item.relation : 'related';
    return [{ from: normFrom, to: normTo, relation, label: string(item?.label || '', 'relation.label', { max: 120 }) }];
  });
  if (!sections.length && !concepts.length && !claims.length) throw new Error('AI 返回的理解画板没有有效内容节点');
  const overview = string(raw?.overview || '', 'graph.overview', { min: 1, max: 30_000 });
  const graphTitle = string(raw?.title || fallbackTitle || 'PDF 全文理解', 'graph.title', { min: 1, max: 300 });
  const overviewEvidence = verifiedEvidence(raw, evidenceIndex, 1, pageCount, 'overview', `${graphTitle}\n${overview}`);
  return {
    title: graphTitle,
    overview,
    evidenceQuote: overviewEvidence.evidenceQuote,
    evidencePage: overviewEvidence.evidencePage ?? 1,
    sections, concepts, claims, relations
  };
}

function documentChunks(pages) {
  const chunks = [];
  let current = '';
  for (const page of pages) {
    const block = `\n\n--- 第 ${page.pageNumber} 页 ---\n${page.text}`;
    if (current && current.length + block.length > AI_DOCUMENT_CHUNK_CHARS) {
      chunks.push(current.trim());
      current = '';
    }
    current += block;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function string(value, name, { min = 0, max, optional = false, nullable = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new TypeError(`${name} length must be between ${min} and ${max}`);
  }
  return normalized;
}

function number(value, name, { min = -1_000_000, max = 1_000_000, integer = false, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new TypeError(`${name} is out of range`);
  }
  return value;
}

function key(value, name, optional = true) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function viewport(value, optional = false) {
  if (value === undefined && optional) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('viewport is invalid');
  return {
    x: number(value.x, 'viewport.x'),
    y: number(value.y, 'viewport.y'),
    zoom: number(value.zoom, 'viewport.zoom', { min: 0.1, max: 8 })
  };
}

function validateLibraryAccess(libraryType, libraryId, session) {
  if (!['user', 'group', 'native'].includes(libraryType)) throw new TypeError('libraryType is invalid');
  const lid = key(libraryId, 'libraryId', false);
  const allowed = libraryType === 'native'
    ? true
    : (libraryType === 'user'
      ? lid === String(session.userId)
      : (session.groupIds || []).map(String).includes(lid));
  if (!allowed) {
    const err = new Error('library is not accessible to this session');
    err.status = 403;
    throw err;
  }
  return { libraryType, libraryId: lid };
}

function topicDocumentInput(body, session) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('body must be an object');
  const { libraryType, libraryId } = validateLibraryAccess(body.libraryType, body.libraryId, session);
  const itemKey = key(body.itemKey, 'itemKey', false);
  const attachmentKey = body.attachmentKey ? key(body.attachmentKey, 'attachmentKey') : null;
  const status = body.status === undefined ? 'inbox' : body.status;
  if (!canvasTopicDocStatuses.has(status)) throw new TypeError('status is invalid');
  const origin = body.origin === undefined ? 'manual' : body.origin;
  if (!canvasTopicDocOrigins.has(origin)) throw new TypeError('origin is invalid');
  const classificationConfidence = body.classificationConfidence === undefined || body.classificationConfidence === null
    ? null : number(body.classificationConfidence, 'classificationConfidence', { min: 0, max: 1 });
  const classificationReason = body.classificationReason === undefined || body.classificationReason === null
    ? null : string(body.classificationReason, 'classificationReason', { max: 2000 });
  const itemVersion = body.itemVersion === undefined || body.itemVersion === null
    ? null : number(body.itemVersion, 'itemVersion', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
  const attachmentVersion = body.attachmentVersion === undefined || body.attachmentVersion === null
    ? null : number(body.attachmentVersion, 'attachmentVersion', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
  return {
    libraryType, libraryId, itemKey, attachmentKey, status, origin,
    classificationConfidence, classificationReason, itemVersion, attachmentVersion
  };
}

function topicDocumentChanges(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('body must be an object');
  const changes = {};
  if (body.status !== undefined) {
    if (!canvasTopicDocStatuses.has(body.status)) throw new TypeError('status is invalid');
    changes.status = body.status;
  }
  if (body.analysisStatus !== undefined) {
    if (!canvasTopicAnalysisStatuses.has(body.analysisStatus)) throw new TypeError('analysisStatus is invalid');
    changes.analysisStatus = body.analysisStatus;
  }
  if (body.attachmentKey !== undefined) {
    changes.attachmentKey = body.attachmentKey ? key(body.attachmentKey, 'attachmentKey') : null;
  }
  if (body.itemVersion !== undefined) {
    changes.itemVersion = body.itemVersion === null ? null : number(body.itemVersion, 'itemVersion', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
  }
  if (body.attachmentVersion !== undefined) {
    changes.attachmentVersion = body.attachmentVersion === null ? null : number(body.attachmentVersion, 'attachmentVersion', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
  }
  if (body.classificationConfidence !== undefined) {
    changes.classificationConfidence = body.classificationConfidence === null ? null : number(body.classificationConfidence, 'classificationConfidence', { min: 0, max: 1 });
  }
  if (body.classificationReason !== undefined) {
    changes.classificationReason = body.classificationReason === null ? null : string(body.classificationReason, 'classificationReason', { max: 2000 });
  }
  if (!Object.keys(changes).length) throw new TypeError('no supported topic document changes');
  return changes;
}

function collectionBindingInput(body, session) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('body must be an object');
  const { libraryType, libraryId } = validateLibraryAccess(body.libraryType, body.libraryId, session);
  const collectionKey = key(body.collectionKey, 'collectionKey', false);
  const mode = body.mode === undefined ? 'inbound' : body.mode;
  if (!canvasCollectionBindingModes.has(mode)) throw new TypeError('mode is invalid');
  return { libraryType, libraryId, collectionKey, mode };
}

function collectionBindingChanges(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('body must be an object');
  const changes = {};
  if (body.mode !== undefined) {
    if (!canvasCollectionBindingModes.has(body.mode)) throw new TypeError('mode is invalid');
    changes.mode = body.mode;
  }
  if (body.enabled !== undefined) {
    changes.enabled = Boolean(body.enabled);
  }
  if (body.lastLibraryVersion !== undefined) {
    changes.lastLibraryVersion = number(body.lastLibraryVersion, 'lastLibraryVersion', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
  }
  if (body.lastSyncedAt !== undefined) {
    changes.lastSyncedAt = body.lastSyncedAt === null ? null : string(body.lastSyncedAt, 'lastSyncedAt', { max: 64 });
  }
  if (!Object.keys(changes).length) throw new TypeError('no supported collection binding changes');
  return changes;
}

// [M4] The Altero/Zotero upstream scan helpers (inboxEntryInput,
// normalizeZoteroItemToInboxEntry, resolveItemAttachment, defaultFetchAltero,
// fetchAllUpstreamItems) were removed together with the inbox and collection
// sync. The archived implementation lives on archive/last-altero-compatible.

function source(value, session) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('source must be an object');
  const libraryType = value.libraryType;
  if (!['user', 'group', 'native'].includes(libraryType)) throw new TypeError('source.libraryType is invalid');
  const normalizedLibId = (value.libraryId !== undefined && value.libraryId !== null) ? String(value.libraryId) : value.libraryId;
  const libraryId = key(normalizedLibId, 'source.libraryId', false);
  const allowed = libraryType === 'native'
    ? true
    : (libraryType === 'user'
      ? libraryId === String(session.userId)
      : (session.groupIds || []).map(String).includes(libraryId));
  if (!allowed) {
    const err = new Error('source library is not available to this session');
    err.status = 403;
    throw err;
  }
  const position = value.position === undefined || value.position === null ? null : value.position;
  if (position !== null) {
    if (typeof position !== 'object' || Array.isArray(position) || JSON.stringify(position).length > 16_384) {
      throw new TypeError('source.position is invalid');
    }
  }
  return {
    libraryType,
    libraryId,
    itemKey: value.itemKey ? key(value.itemKey, 'source.itemKey') : null,
    attachmentKey: value.attachmentKey ? key(value.attachmentKey, 'source.attachmentKey') : null,
    attachmentVersion: value.attachmentVersion === undefined || value.attachmentVersion === null
      ? null : number(value.attachmentVersion, 'source.attachmentVersion', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }),
    annotationKey: value.annotationKey ? key(value.annotationKey, 'source.annotationKey') : null,
    annotationVersion: value.annotationVersion === undefined || value.annotationVersion === null
      ? null : number(value.annotationVersion, 'source.annotationVersion', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }),
    pageLabel: value.pageLabel === undefined || value.pageLabel === null
      ? null : string(value.pageLabel, 'source.pageLabel', { max: 64 }),
    position,
    quoteSnapshot: value.quoteSnapshot === undefined || value.quoteSnapshot === null
      ? null : string(value.quoteSnapshot, 'source.quoteSnapshot', { max: 20_000 })
  };
}

function nodeInput(body, session) {
  if (!canvasNodeTypes.has(body.type)) throw new TypeError('type is invalid');
  return {
    type: body.type,
    x: number(body.x, 'x'),
    y: number(body.y, 'y'),
    width: number(body.width, 'width', { min: 80, max: 5000 }),
    height: number(body.height, 'height', { min: 40, max: 5000 }),
    zIndex: body.zIndex === undefined ? 0 : number(body.zIndex, 'zIndex', { min: -100_000, max: 100_000, integer: true }),
    title: body.title === undefined ? '' : string(body.title, 'title', { max: 500 }),
    body: body.body === undefined ? '' : string(body.body, 'body', { max: 100_000 }),
    color: body.color === undefined || body.color === null ? null : string(body.color, 'color', { max: 64 }),
    source: source(body.source, session)
  };
}

function nodeChanges(body) {
  const changes = {};
  if (body.type !== undefined) {
    if (!canvasNodeTypes.has(body.type)) throw new TypeError('type is invalid');
    changes.type = body.type;
  }
  for (const name of ['x', 'y']) if (body[name] !== undefined) changes[name] = number(body[name], name);
  for (const name of ['width', 'height']) {
    if (body[name] !== undefined) changes[name] = number(body[name], name, { min: name === 'width' ? 80 : 40, max: 5000 });
  }
  if (body.zIndex !== undefined) changes.zIndex = number(body.zIndex, 'zIndex', { min: -100_000, max: 100_000, integer: true });
  if (body.title !== undefined) changes.title = string(body.title, 'title', { max: 500 });
  if (body.body !== undefined) changes.body = string(body.body, 'body', { max: 100_000 });
  if (body.color !== undefined) changes.color = body.color === null ? null : string(body.color, 'color', { max: 64 });
  if (!Object.keys(changes).length) throw new TypeError('no supported node changes');
  return changes;
}

function normalizedImportBundle(bundle, session) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new TypeError('bundle must be an object');
  if (bundle.format !== 'altcanvas-board-export' || ![1, 2].includes(bundle.schemaVersion)) {
    throw new TypeError('unsupported bundle format or schema version');
  }
  if (!bundle.board || typeof bundle.board !== 'object' || Array.isArray(bundle.board)) throw new TypeError('bundle.board is invalid');
  if (!Array.isArray(bundle.nodes) || bundle.nodes.length > MAX_IMPORT_NODES) {
    throw new TypeError(`bundle.nodes must contain at most ${MAX_IMPORT_NODES} items`);
  }
  if (!Array.isArray(bundle.edges) || bundle.edges.length > MAX_IMPORT_EDGES) {
    throw new TypeError(`bundle.edges must contain at most ${MAX_IMPORT_EDGES} items`);
  }
  const rawSources = Array.isArray(bundle.sources) ? bundle.sources : [];
  if (rawSources.length > MAX_IMPORT_NODES) throw new TypeError(`bundle.sources must contain at most ${MAX_IMPORT_NODES} items`);

  const seenSourceIds = new Set();
  const sources = rawSources.map(rawSource => {
    if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) throw new TypeError('bundle source is invalid');
    const id = key(rawSource.id, 'bundle.sources.id', false);
    if (seenSourceIds.has(id)) throw new TypeError('bundle source IDs must be unique');
    seenSourceIds.add(id);
    return { id, ...source(rawSource, session) };
  });

  const seenNodeIds = new Set();
  const nodes = bundle.nodes.map(rawNode => {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) throw new TypeError('bundle node is invalid');
    const id = key(rawNode.id, 'bundle.nodes.id', false);
    if (seenNodeIds.has(id)) throw new TypeError('bundle node IDs must be unique');
    seenNodeIds.add(id);
    const normalized = nodeInput({ ...rawNode, source: null }, session);
    const sourceRefId = rawNode.sourceRefId == null ? null : key(rawNode.sourceRefId, 'bundle.nodes.sourceRefId', false);
    if (sourceRefId && !seenSourceIds.has(sourceRefId)) throw new TypeError('bundle node references an unknown source');
    return { id, ...normalized, sourceRefId };
  });

  const seenEdgeIds = new Set();
  const edges = bundle.edges.map(rawEdge => {
    if (!rawEdge || typeof rawEdge !== 'object' || Array.isArray(rawEdge)) throw new TypeError('bundle edge is invalid');
    const id = key(rawEdge.id, 'bundle.edges.id', false);
    if (seenEdgeIds.has(id)) throw new TypeError('bundle edge IDs must be unique');
    seenEdgeIds.add(id);
    const sourceNodeId = key(rawEdge.sourceNodeId, 'bundle.edges.sourceNodeId', false);
    const targetNodeId = key(rawEdge.targetNodeId, 'bundle.edges.targetNodeId', false);
    if (!seenNodeIds.has(sourceNodeId) || !seenNodeIds.has(targetNodeId) || sourceNodeId === targetNodeId) {
      throw new TypeError('bundle edge references invalid nodes');
    }
    if (!canvasEdgeRelations.has(rawEdge.relation)) throw new TypeError('bundle edge relation is invalid');
    return {
      id,
      sourceNodeId,
      targetNodeId,
      relation: rawEdge.relation,
      label: rawEdge.label === undefined ? '' : string(rawEdge.label, 'bundle.edges.label', { max: 500 }),
    };
  });

  return {
    format: 'altcanvas-board-export',
    schemaVersion: bundle.schemaVersion,
    board: {
      id: key(bundle.board.id, 'bundle.board.id', false),
      name: string(bundle.board.name || '导入画板', 'bundle.board.name', { min: 1, max: 200 }),
      viewport: viewport(bundle.board.viewport || { x: 0, y: 0, zoom: 1 }),
    },
    nodes,
    edges,
    sources,
  };
}

function actorFromRequest(req) {
  const sessionId = getSessionIdFromRequest(req);
  const session = getSession(sessionId);
  if (!session) return null;
  const actorKey = session.actorKey || canvasActorKey(session.issuer || (session.authMode === 'local' ? 'local' : null), session.subject || session.userId);
  return actorKey ? { actorKey, session } : null;
}

function defaultPromoteBlob(store, tempFilePath, sha256) {  const targetBlobPath = store.resolveBlobPath(sha256, '.pdf');
  fs.mkdirSync(path.dirname(targetBlobPath), { recursive: true, mode: 0o700 });
  const relativePath = path.relative(store.getBlobStorageDir(), targetBlobPath);

  const removeTemp = () => { try { fs.unlinkSync(tempFilePath); } catch {} };

  // Exclusive, atomic promotion: hard link fails with EEXIST if a concurrent promoter
  // already created the target, so exactly one caller can ever observe newlyCreated=true.
  try {
    fs.linkSync(tempFilePath, targetBlobPath);
    removeTemp();
    fs.chmodSync(targetBlobPath, 0o600);
    return { targetBlobPath, relativePath, newlyCreated: true };
  } catch (err) {
    if (err.code === 'EEXIST') {
      removeTemp();
      return { targetBlobPath, relativePath, newlyCreated: false };
    }
    if (err.code === 'EXDEV') {
      // Cross-device fallback: exclusive copy, never overwriting an existing target.
      try {
        fs.copyFileSync(tempFilePath, targetBlobPath, fs.constants.COPYFILE_EXCL);
        removeTemp();
        fs.chmodSync(targetBlobPath, 0o600);
        return { targetBlobPath, relativePath, newlyCreated: true };
      } catch (copyErr) {
        if (copyErr.code === 'EEXIST') {
          removeTemp();
          return { targetBlobPath, relativePath, newlyCreated: false };
        }
        throw copyErr;
      }
    }
    throw err;
  }
}

// Compensate a promoted blob after a non-write outcome: remove the file only when the
// database holds no live reference to it.
function compensatePromotedBlob(store, sha256, targetBlobPath) {
  try {
    if (!fs.existsSync(targetBlobPath)) return;
    const blob = store.getBlob(sha256);
    if (!blob || blob.referenceCount <= 0) {
      fs.unlinkSync(targetBlobPath);
    }
  } catch {}
}

// Unified M2/M3 metadata normalizer: the single authoritative normalizer for any
// resolved metadata dictionary (body.resolved, Translation Server DTO, DOI/arXiv/URL
// resolver output, and the final DTO before DB write). Enforces field types, lengths,
// year range, and creators count <= 100 with non-empty name checks.
export function normalizeResolvedImportMetadata(resolved, label = 'resolved') {
  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new TypeError(`${label} must be an object`);
  }

  const rawTitle = resolved.title;
  if (typeof rawTitle !== 'string' || !rawTitle.trim() || rawTitle.length > 500) {
    throw new TypeError(`${label}.title must be a non-empty string of at most 500 characters`);
  }

  const STRING_LIMITS = {
    abstractNote: 20_000,
    abstract: 20_000,
    sourceType: 64,
    doi: 2000,
    url: 2000,
    isbn: 64,
    arxivId: 64,
    arXivId: 64,
    pdfUrl: 2000,
    publisher: 300
  };
  for (const [field, maxLen] of Object.entries(STRING_LIMITS)) {
    if (resolved[field] !== undefined && resolved[field] !== null) {
      if (typeof resolved[field] !== 'string') {
        throw new TypeError(`${label}.${field} must be a string`);
      }
      if (resolved[field].length > maxLen) {
        throw new TypeError(`${label}.${field} must be at most ${maxLen} characters`);
      }
    }
  }

  const pdfUrl = resolved.pdfUrl ? String(resolved.pdfUrl).trim() : null;
  if (pdfUrl && !/^https?:\/\//i.test(pdfUrl)) {
    throw new TypeError(`${label}.pdfUrl must be an http(s) URL`);
  }

  if (resolved.year !== undefined && resolved.year !== null) {
    if (typeof resolved.year !== 'number' || !Number.isInteger(resolved.year) || resolved.year < 1400 || resolved.year > 2200) {
      throw new TypeError(`${label}.year must be an integer between 1400 and 2200`);
    }
  }

  let creators = resolved.creators || [];
  if (!Array.isArray(creators)) {
    throw new TypeError(`${label}.creators must be an array`);
  }
  if (creators.length > 100) {
    throw new TypeError(`${label}.creators must contain at most 100 entries`);
  }
  const cleanCreators = creators.map((c, idx) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new TypeError(`${label}.creators[${idx}] must be an object`);
    }
    const entry = {};
    for (const field of ['creatorType', 'firstName', 'lastName', 'name']) {
      if (c[field] !== undefined && c[field] !== null) {
        if (typeof c[field] !== 'string' || c[field].length > 200) {
          throw new TypeError(`${label}.creators[${idx}].${field} must be a string of at most 200 characters`);
        }
        entry[field] = c[field];
      }
    }
    if (![entry.firstName, entry.lastName, entry.name].some(v => typeof v === 'string' && v.trim())) {
      throw new TypeError(`${label}.creators[${idx}] must carry at least one non-blank name field (firstName, lastName, or name)`);
    }
    return entry;
  });

  const abstractText = resolved.abstractNote || resolved.abstract || '';

  return {
    sourceType: resolved.sourceType || 'manual',
    title: rawTitle.trim(),
    abstractNote: abstractText,
    abstract: abstractText,
    creators: cleanCreators,
    year: resolved.year ?? null,
    doi: resolved.doi ? String(resolved.doi).trim() : null,
    isbn: resolved.isbn ? String(resolved.isbn).trim() : null,
    arxivId: (resolved.arxivId || resolved.arXivId) ? String(resolved.arxivId || resolved.arXivId).trim() : null,
    url: resolved.url ? String(resolved.url).trim() : null,
    pdfUrl: pdfUrl || null,
    publisher: resolved.publisher ? String(resolved.publisher).trim() : undefined,
    resolvedBy: resolved.resolvedBy || undefined
  };
}

// Unified M2 input normalizer: the single source of truth for import item structure.
// Throws TypeError on any contract violation so single and batch endpoints share one contract.
function normalizeNativeImportItem(item, indexLabel = 'item') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new TypeError(`${indexLabel} must be an object`);
  }

  let resolved = item.resolved;
  if (resolved !== undefined) {
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
      throw new TypeError(`${indexLabel}.resolved must be an object`);
    }
    if (resolved.title !== undefined && (typeof resolved.title !== 'string' || resolved.title.length > 500)) {
      throw new TypeError(`${indexLabel}.resolved.title must be a string of at most 500 characters`);
    }
  }

  const rawTitle = resolved?.title ?? item.title;
  if (rawTitle === undefined && !resolved && !item.input && !item.url && !item.identifier) {
    throw new TypeError(`${indexLabel}: resolved metadata, a title, or an input is required`);
  }
  if (rawTitle !== undefined && (typeof rawTitle !== 'string' || rawTitle.length > 500)) {
    throw new TypeError(`${indexLabel}.title must be a string of at most 500 characters`);
  }

  // Client-supplied `resolved` objects go through the SAME contract as top-level fields.
  if (resolved) {
    // The executor accepts both spellings; BOTH must satisfy the contract so neither
    // casing can bypass validation.
    const RESOLVED_LIMITS = {
      abstractNote: 20_000, sourceType: 64, doi: 2000, url: 2000, pdfUrl: 2000,
      arxivId: 64, arXivId: 64
    };
    for (const [field, maxLen] of Object.entries(RESOLVED_LIMITS)) {
      if (resolved[field] !== undefined && resolved[field] !== null) {
        if (typeof resolved[field] !== 'string') {
          throw new TypeError(`${indexLabel}.resolved.${field} must be a string`);
        }
        if (resolved[field].length > maxLen) {
          throw new TypeError(`${indexLabel}.resolved.${field} must be at most ${maxLen} characters`);
        }
      }
    }
    if (resolved.pdfUrl && !/^https?:\/\//i.test(resolved.pdfUrl)) {
      throw new TypeError(`${indexLabel}.resolved.pdfUrl must be an http(s) URL`);
    }
    if (resolved.creators !== undefined && !Array.isArray(resolved.creators)) {
      throw new TypeError(`${indexLabel}.resolved.creators must be an array`);
    }
  }

  const validateYear = (value, label) => {
    if (value === undefined || value === null) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1400 || value > 2200) {
      throw new TypeError(`${label} must be an integer between 1400 and 2200`);
    }
  };
  validateYear(item.year, `${indexLabel}.year`);
  validateYear(resolved?.year, `${indexLabel}.resolved.year`);

  // An explicitly provided pdfUrl that is not http(s) is a contract violation, never a
  // silent metadata-only degradation.
  if (item.pdfUrl !== undefined && item.pdfUrl !== null && String(item.pdfUrl).trim() !== ''
    && !/^https?:\/\//i.test(String(item.pdfUrl))) {
    throw new TypeError(`${indexLabel}.pdfUrl must be an http(s) URL`);
  }

  const FIELD_LIMITS = { abstract: 20_000, pdfUrl: 2000, isbn: 64, arxivId: 64, doi: 2000, url: 2000, sourceType: 64, input: 1024 * 1024 };
  for (const [field, maxLen] of Object.entries(FIELD_LIMITS)) {
    if (item[field] !== undefined && item[field] !== null) {
      if (typeof item[field] !== 'string') {
        throw new TypeError(`${indexLabel}.${field} must be a string`);
      }
      if (item[field].length > maxLen) {
        throw new TypeError(`${indexLabel}.${field} must be at most ${maxLen} characters`);
      }
    }
  }

  let creators = resolved?.creators ?? item.creators ?? [];
  if (!Array.isArray(creators)) {
    throw new TypeError(`${indexLabel}.creators must be an array`);
  }
  if (creators.length > 100) {
    throw new TypeError(`${indexLabel}.creators must contain at most 100 entries`);
  }
  creators = creators.map(c => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new TypeError(`${indexLabel}.creators entries must be objects`);
    }
    const out = {};
    for (const field of ['creatorType', 'firstName', 'lastName', 'name']) {
      if (c[field] !== undefined && c[field] !== null) {
        if (typeof c[field] !== 'string' || c[field].length > 200) {
          throw new TypeError(`${indexLabel}.creators.${field} must be a string of at most 200 characters`);
        }
        out[field] = c[field];
      }
    }
    if (![out.firstName, out.lastName, out.name].some(v => typeof v === 'string' && v.trim())) {
      throw new TypeError(`${indexLabel}.creators entries must carry at least one non-blank name (firstName, lastName, or name)`);
    }
    return out;
  });

  let externalRefs = item.externalRefs ?? [];
  if (!Array.isArray(externalRefs)) {
    throw new TypeError(`${indexLabel}.externalRefs must be an array`);
  }
  externalRefs = externalRefs.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
      throw new TypeError(`${indexLabel}.externalRefs entries must be objects`);
    }
    if (!ref.provider || typeof ref.provider !== 'string' || ref.provider.length > 64) {
      throw new TypeError(`${indexLabel}.externalRefs.provider must be a non-empty string of at most 64 characters`);
    }
    if (!ref.externalItemId || typeof ref.externalItemId !== 'string' || ref.externalItemId.length > 256) {
      throw new TypeError(`${indexLabel}.externalRefs.externalItemId must be a non-empty string of at most 256 characters`);
    }
    if (ref.externalLibraryId !== undefined && ref.externalLibraryId !== null
      && (typeof ref.externalLibraryId !== 'string' || ref.externalLibraryId.length > 128)) {
      throw new TypeError(`${indexLabel}.externalRefs.externalLibraryId must be a string of at most 128 characters`);
    }
    if (ref.externalAttachmentId !== undefined && ref.externalAttachmentId !== null
      && (typeof ref.externalAttachmentId !== 'string' || ref.externalAttachmentId.length > 256)) {
      throw new TypeError(`${indexLabel}.externalRefs.externalAttachmentId must be a string of at most 256 characters`);
    }
    if (ref.externalVersion !== undefined && ref.externalVersion !== null) {
      if (typeof ref.externalVersion !== 'number' || !Number.isInteger(ref.externalVersion) || ref.externalVersion < 0) {
        throw new TypeError(`${indexLabel}.externalRefs.externalVersion must be a non-negative integer`);
      }
    }
    if (ref.sourceUrl !== undefined && ref.sourceUrl !== null) {
      if (typeof ref.sourceUrl !== 'string' || ref.sourceUrl.length > 2000) {
        throw new TypeError(`${indexLabel}.externalRefs.sourceUrl must be a string of at most 2000 characters`);
      }
      if (ref.sourceUrl !== '' && !/^https?:\/\//i.test(ref.sourceUrl)) {
        throw new TypeError(`${indexLabel}.externalRefs.sourceUrl must be an http(s) URL`);
      }
    }
    // Emit a fully normalized reference object; unknown keys are dropped.
    return {
      provider: ref.provider,
      externalItemId: ref.externalItemId,
      externalLibraryId: ref.externalLibraryId ?? null,
      externalAttachmentId: ref.externalAttachmentId ?? null,
      externalVersion: ref.externalVersion ?? null,
      sourceUrl: ref.sourceUrl ?? null
    };
  });

  return {
    resolved,
    sourceType: item.sourceType ?? null,
    title: typeof rawTitle === 'string' ? rawTitle : undefined,
    abstract: item.abstract ?? null,
    creators,
    year: item.year ?? resolved?.year ?? null,
    doi: item.doi ?? null,
    url: item.url ?? null,
    isbn: item.isbn ?? null,
    arxivId: item.arxivId ?? null,
    pdfUrl: item.pdfUrl ?? null,
    externalRefs,
    targetWorkspaceId: item.targetWorkspaceId ?? null,
    forceNew: Boolean(item.forceNew),
    confirmFuzzy: Boolean(item.confirmFuzzy),
    input: item.input ?? item.url ?? item.identifier ?? null
  };
}

// Unified M2 native import executor shared by single and batch endpoints.
// Sequencing: resolve -> safe download -> precheck (no writes) -> promote blob -> DB write,
// with bidirectional compensation so neither orphan files nor dangling DB rows survive.
// Shared M4 AI topic classification over classification-shaped entries.
// Used by /canvas/native/documents/classify; throws on AI failures so the
// endpoint can map AbortError to 504 and everything else to 502.
async function runAiClassification({ store, actorKey, targetEntries, workspaces, privateConfig, aiCompletion }) {
  const systemPrompt = [
    '你是专业学术研究助手。你的任务是根据用户的多个研究主题及其纳入/排除规则，评估给定的文献是否适合归入各主题。',
    '只输出一个合法的 JSON 对象，不要 Markdown 代码块。',
    'JSON 格式示例：',
    '{"classifications": {',
    '  "entry-id-1": [',
    '    {"workspaceId": "ws-1", "workspaceName": "主题名称", "confidence": 0.92, "reason": "匹配纳入规则：聚焦于大模型逻辑推理机制"}',
    '  ]',
    '}, "documentMetadata": {',
    '  "entry-id-1": {"cleanTitle": "【机构】规范中文标题（2025）", "institution": "机构", "reportTitle": "中文主标题", "subtitle": "", "year": "2025", "summary": "一句话中文摘要"}',
    '}}',
    '【规则】',
    '1. confidence 为 0.0 到 1.0 之间的浮点数。若不符合主题或命中排除规则，置信度应低于 0.3；',
    '2. reason 简述推荐或不推荐的核心理由（30字以内）；',
    '3. 同一篇文献可同时推荐给多个符合的主题（多对多归类）；',
    '4. 必须在同一次返回中为每篇文献生成 documentMetadata；cleanTitle 必须是准确、自然、可直接展示的简体中文名，保留机构与年份等关键辨识信息。'
  ].join('\n');

  const topicContexts = workspaces.map((w, idx) => `[主题 ${idx + 1}] ID: ${w.id}\n名称: ${w.name}\n研究问题: ${w.researchQuestion || '无'}\n纳入规则: ${w.inclusionRules || '无'}\n排除规则: ${w.exclusionRules || '无'}`).join('\n\n');
  const docContexts = targetEntries.map(e => `[待分拣文献] ID: ${e.id}\n标题: ${e.title}\n作者: ${(e.creators || []).map(c => typeof c === 'string' ? c : (c.name || `${c.firstName || ''} ${c.lastName || ''}`)).join(', ')}\n年份: ${e.year || '未知'}\n摘要: ${(e.abstractNote || '').slice(0, 800)}\n标签: ${(e.tags || []).join(', ')}`).join('\n\n');

  const aiResponse = await aiCompletion({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `【候选研究主题】\n\n${topicContexts}\n\n【待分类文献列表】\n\n${docContexts}` }
    ],
    temperature: 0.2
  }, privateConfig);

  let parsed = parseAiJson(aiResponse);
  if (!parsed || typeof parsed !== 'object') parsed = { classifications: {} };
  const rawMap = parsed.classifications || parsed;
  const classifications = {};

  for (const entry of targetEntries) {
    const list = Array.isArray(rawMap[entry.id])
      ? rawMap[entry.id]
      : (Array.isArray(rawMap[entry.itemKey])
        ? rawMap[entry.itemKey]
        : (Array.isArray(rawMap[entry.title]) ? rawMap[entry.title] : []));

    classifications[entry.id] = list.map(item => {
      const matchedWs = workspaces.find(w => w.id === item.workspaceId) || workspaces.find(w => w.name === item.workspaceName);
      if (!matchedWs) return null;
      const conf = typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0.5;
      return {
        workspaceId: matchedWs.id,
        workspaceName: matchedWs.name,
        confidence: conf,
        reason: String(item.reason || '主题匹配').slice(0, 30)
      };
    }).filter(Boolean);
  }

  const documentMetas = saveClassificationDocumentMetas(store, actorKey, targetEntries, parsed);
  return { classifications, documentMetas };
}

// Shared M4 AI topic-taxonomy generation over classification-shaped entries.
async function runAiTopicGeneration({ store, actorKey, targetEntries, maxTopics = 5, privateConfig, aiCompletion }) {
  const existingWorkspaces = store.listWorkspaces(actorKey);
  const systemPrompt = [
    '你是资深学术研究与产业分析专家。请根据给定的文献列表，自动提炼并规划一套清晰、聚焦的研究主题体系（Topic Taxonomy）。',
    '【关键原则】',
    `1. 主题数量严格精炼：提炼 3 到 ${maxTopics} 个高层次、非重叠的核心研究方向，避免过多细碎主题；`,
    '2. 若已有候选主题且语义契合，请优先复用或在其基础上扩展，避免创建重复主题；',
    '3. 为每个主题提供：`name`（15字以内的凝练中文名称）、`researchQuestion`（核心研究问题）、`inclusionRules`（清晰的纳入规则）、`exclusionRules`（排除规则）；',
    '4. 为每篇待分类文献推荐最契合的主题（可多对多），仅当极个别文献确实与主要主题完全无关时才设立兜底补充主题；',
    '5. 在同一次返回中为每篇文献生成规范中文名与元数据，不要要求第二次模型调用；',
    '6. 只输出合法的 JSON 对象，严禁 Markdown 代码块。',
    'JSON 格式示例：',
    '{',
    '  "topics": [',
    '    {',
    '      "name": "具身智能与机器人控制",',
    '      "researchQuestion": "端到端具身多模态模型在通用机器人控制与动作规划中的落地机制",',
    '      "inclusionRules": "涉及机器人感知、决策、控制、动作生成及具身数据训练的文献",',
    '      "exclusionRules": "纯软件大模型推理或传统非智能自动化"',
    '    }',
    '  ],',
    '  "classifications": {',
    '    "entry-id-1": [',
    '      { "topicName": "具身智能与机器人控制", "confidence": 0.95, "reason": "聚焦端到端机器人动作生成" }',
    '    ]',
    '  },',
    '  "documentMetadata": {',
    '    "entry-id-1": { "cleanTitle": "【机构】规范中文标题（2025）", "institution": "机构", "reportTitle": "中文主标题", "subtitle": "", "year": "2025", "summary": "一句话中文摘要" }',
    '  }',
    '}'
  ].join('\n');

  const existingContext = existingWorkspaces.length
    ? existingWorkspaces.map((w, idx) => `[已有主题 ${idx + 1}] 名称: ${w.name}\n研究问题: ${w.researchQuestion || '无'}\n纳入规则: ${w.inclusionRules || '无'}`).join('\n\n')
    : '（当前尚无已有主题）';

  const docContexts = targetEntries.map(e => `[文献] ID: ${e.id}\n标题: ${e.title}\n作者: ${(e.creators || []).map(c => typeof c === 'string' ? c : (c.name || `${c.firstName || ''} ${c.lastName || ''}`)).join(', ')}\n年份: ${e.year || '未知'}\n摘要: ${(e.abstractNote || '').slice(0, 500)}\n标签: ${(e.tags || []).join(', ')}`).join('\n\n');

  const aiResponse = await aiCompletion({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `【用户已有主题】\n\n${existingContext}\n\n【待分析与归类文献列表】\n\n${docContexts}` }
    ],
    temperature: 0.2
  }, privateConfig);

  let parsed = parseAiJson(aiResponse);
  if (!parsed || typeof parsed !== 'object') parsed = { topics: [], classifications: {} };

  const rawTopics = Array.isArray(parsed.topics) ? parsed.topics : [];
  const rawClassifications = parsed.classifications || {};

  const createdWorkspaces = [];
  const allCurrentWorkspaces = [...existingWorkspaces];

  for (const topic of rawTopics) {
    const rawName = String(topic?.name || '').trim().slice(0, 100);
    if (!rawName) continue;
    const existing = allCurrentWorkspaces.find(w => w.name.toLowerCase() === rawName.toLowerCase());
    if (existing) continue;

    const ws = store.createWorkspace(actorKey, {
      name: rawName,
      researchQuestion: String(topic.researchQuestion || '').slice(0, 500),
      inclusionRules: String(topic.inclusionRules || '').slice(0, 500),
      exclusionRules: String(topic.exclusionRules || '').slice(0, 500)
    });
    createdWorkspaces.push(ws);
    allCurrentWorkspaces.push(ws);
  }

  const classifications = {};
  for (const entry of targetEntries) {
    const list = Array.isArray(rawClassifications[entry.id])
      ? rawClassifications[entry.id]
      : (Array.isArray(rawClassifications[entry.itemKey])
        ? rawClassifications[entry.itemKey]
        : (Array.isArray(rawClassifications[entry.title]) ? rawClassifications[entry.title] : []));

    classifications[entry.id] = list.map(item => {
      const topicName = String(item?.topicName || item?.workspaceName || '').trim().toLowerCase();
      const wsId = item?.workspaceId;
      const matchedWs = allCurrentWorkspaces.find(w => w.id === wsId) || allCurrentWorkspaces.find(w => w.name.toLowerCase() === topicName);
      if (!matchedWs) return null;
      const conf = typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0.85;
      return {
        workspaceId: matchedWs.id,
        workspaceName: matchedWs.name,
        confidence: conf,
        reason: String(item.reason || '契合主题研究方向').slice(0, 30)
      };
    }).filter(Boolean);
  }

  const documentMetas = saveClassificationDocumentMetas(store, actorKey, targetEntries, parsed);

  return {
    createdWorkspaces,
    workspaces: store.listWorkspaces(actorKey),
    classifications,
    documentMetas
  };
}

const WEB_IMPORT_DEFAULT_DIR = '网页导入';

// Sanitizes a candidate web-import original filename: strips separators,
// control characters and NUL, collapses whitespace, enforces the .pdf
// extension and a bounded length. Never invents "(2)" suffixes.
function sanitizeWebImportFilename(raw, fallbackStem) {
  let candidate = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  if (!candidate) candidate = String(fallbackStem || 'import');
  if (!candidate.toLowerCase().endsWith('.pdf')) candidate += '.pdf';
  if (candidate.length < 5) candidate = `${candidate.replace(/\.pdf$/i, '') || 'import'}.pdf`;
  return candidate;
}

// Original-filename candidates for web imports, in product priority order:
// 1. trusted Content-Disposition name (when the downloader surfaced one);
// 2. the PDF URL path's own filename;
// 3. a sanitized library title;
// 4. a deterministic content-hash fallback.
function deriveWebImportFilename({ download, pdfUrl, title, sha256 }) {
  const dispositionName = download && typeof download.filename === 'string' ? download.filename.trim() : '';
  if (dispositionName) {
    return sanitizeWebImportFilename(dispositionName, 'import');
  }
  if (pdfUrl) {
    try {
      const urlPath = decodeURIComponent(new URL(pdfUrl).pathname);
      const base = urlPath.split('/').filter(Boolean).pop() || '';
      if (base.toLowerCase().endsWith('.pdf')) {
        return sanitizeWebImportFilename(base, 'import');
      }
    } catch {}
  }
  const titleStem = String(title || '').replace(/\.pdf$/i, '').trim();
  if (titleStem) {
    return sanitizeWebImportFilename(`${titleStem.slice(0, 80)}.pdf`, 'import');
  }
  return sanitizeWebImportFilename(`import-${String(sha256 || '').slice(0, 16)}.pdf`, 'import');
}

// Anchored stat for a freshly placed file: the descriptor comes from
// openFileInsideRoot (O_NOFOLLOW + realpath containment + regular-file check),
// never from a raw path stat — the fd IS the TOCTOU anchor.
function statPlacedFileInsideRoot(rootAbsolutePath, relativePath) {
  const opened = openFileInsideRoot(rootAbsolutePath, relativePath);
  try { return opened.stat; } finally { try { fs.closeSync(opened.fd); } catch {} }
}

async function executeNativeImportItem(store, actorKey, normalized, {
  downloadPdfFn,
  promoteBlobFn = defaultPromoteBlob,
  fallbackTargetWorkspaceId = null,
  translationServerFn = null,
  fileTarget = null,
  webImportArchive = false,
  statPlacedFileFn = statPlacedFileInsideRoot
}) {
  // Defensive shallow clone: per-item derived filenames must NEVER mutate
  // the caller's shared target object (e.g. batch imports).
  const effectiveFileTarget = fileTarget ? { ...fileTarget } : null;
  let resolved = normalized.resolved;
  if (!resolved && normalized.input) {
    try {
      resolved = await resolveImportInput(normalized.input, { translationServerFn });
    } catch (resolveErr) {
      resolveErr.code = resolveErr.code || 'resolve_error';
      resolveErr.status = resolveErr.status || 400;
      throw resolveErr;
    }
  }
  if (!resolved && !normalized.title) {
    throw new TypeError('resolved metadata or a title is required');
  }

  // Build the single FINAL metadata object merging the resolver output with the
  // top-level structured fields, then normalize it exactly once. Every source —
  // Translation Server DTO, native resolver output, or a pure structured payload —
  // passes the identical contract (creators <= 100 with non-blank names, string
  // limits, year range) before any database write. Never stitch normalized
  // fragments by hand.
  const meta = normalizeResolvedImportMetadata({
    sourceType: resolved?.sourceType || normalized.sourceType,
    title: resolved?.title || normalized.title,
    abstractNote: resolved?.abstractNote || resolved?.abstract || normalized.abstract,
    creators: (Array.isArray(resolved?.creators) && resolved.creators.length)
      ? resolved.creators
      : normalized.creators,
    year: resolved?.year ?? normalized.year,
    doi: resolved?.doi || normalized.doi,
    isbn: resolved?.isbn || normalized.isbn,
    arxivId: resolved?.arxivId || resolved?.arXivId || normalized.arxivId,
    url: resolved?.url || normalized.url,
    pdfUrl: resolved?.pdfUrl || normalized.pdfUrl,
    publisher: resolved?.publisher
  }, 'item');

  const title = meta.title;
  const abstract = meta.abstractNote;
  const creators = meta.creators;
  const year = meta.year;
  const doi = meta.doi;
  const isbn = meta.isbn;
  const url = meta.url;
  const arxivId = meta.arxivId;
  const externalRefs = normalized.externalRefs;
  const targetWorkspaceId = normalized.targetWorkspaceId || fallbackTargetWorkspaceId;

  // PDF acquisition: explicit item.pdfUrl failures are fatal; resolver-derived failures degrade with warning.
  let warning = null;
  let attachment = null;
  let tempFilePath = null;
  let downloadDispositionName = null;
  const explicitPdfUrl = normalized.pdfUrl && normalized.pdfUrl.trim() ? normalized.pdfUrl.trim() : null;
  const pdfUrl = explicitPdfUrl || meta.pdfUrl;

  if (pdfUrl && typeof pdfUrl === 'string' && /^https?:\/\//i.test(pdfUrl)) {
    try {
      const tempDir = path.join(store.getBlobStorageDir(), 'tmp');
      const downloadResult = await downloadPdfFn(pdfUrl, tempDir);
      tempFilePath = downloadResult.tempFilePath;
      downloadDispositionName = typeof downloadResult.filename === 'string' ? downloadResult.filename : null;
      attachment = {
        sha256: downloadResult.sha256,
        sizeBytes: downloadResult.sizeBytes,
        mimeType: 'application/pdf',
        originalFilename: `${String(title || 'document').slice(0, 100)}.pdf`,
        sourceUrl: pdfUrl
      };
    } catch (downloadErr) {
      try { if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch {}
      if (explicitPdfUrl) {
        const err = new Error(`PDF 下载失败: ${downloadErr.message}`);
        err.status = downloadErr.status || 502;
        err.code = 'pdf_download_failed';
        throw err;
      }
      warning = `PDF 附件下载失败，已降级为仅元数据导入: ${downloadErr.message}`;
      attachment = null;
      tempFilePath = null;
    }
    if (attachment && webImportArchive && !effectiveFileTarget) {
      // [M4] Web imports that obtained a PDF must be archived into the
      // library roots, never left as a blob-only document.
      try { if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch {}
      const err = new Error('未配置可用的文库根目录（NATIVE_LIBRARY_ROOTS），无法归档网页导入的 PDF');
      err.status = 422;
      err.code = 'library_root_required';
      throw err;
    }
  }

  const cleanupTemp = () => {
    try { if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch {}
  };

  // Phase 0 (file-target imports only): Content identity check & auto-archiving.
  // When an identical PDF (same SHA-256) is imported again:
  //   1. If already archived as a source_file: zero disk copy, backfill missing
  //      metadata (abstract/creators/year/doi) and bind to new topics cleanly.
  //   2. If currently a legacy managed_blob: promote the attachment to a real
  //      source_file in the target directory, backfill metadata and topics.
  // This satisfies single-instance storage while allowing re-imports to refresh
  // metadata and organize into research topics without a 409 error.
  if (effectiveFileTarget && attachment && tempFilePath) {
    const allTopicIds = Array.from(new Set([
      ...(effectiveFileTarget.topicIds || []),
      ...(targetWorkspaceId ? [targetWorkspaceId] : [])
    ])).filter(Boolean);

    // Case 1: Already has an enrolled source_file in a real directory
    const holder = store.findEnrolledSourceFileBySha(actorKey, attachment.sha256);
    if (holder) {
      cleanupTemp();
      const updatedDoc = store.backfillDocumentAndTopics(actorKey, holder.documentId, {
        doi, isbn, url, abstract, year, creators, topicIds: allTopicIds
      });
      return {
        result: {
          outcome: 'reused',
          match: { strategy: 'sha256', documentId: holder.documentId },
          document: updatedDoc,
          sourceFile: holder,
          reusedSourceFile: true
        },
        warning
      };
    }

    // Case 2: Exists as a legacy managed_blob -> promote to source_file in root directory
    const blobHolder = store.findDocumentByBlobHash(actorKey, attachment.sha256);
    if (blobHolder) {
      const targetFilename = effectiveFileTarget.filename || deriveWebImportFilename({
        download: { filename: downloadDispositionName },
        pdfUrl,
        title: blobHolder.title || title,
        sha256: attachment.sha256
      });
      const archiveDir = effectiveFileTarget.targetDir || WEB_IMPORT_DEFAULT_DIR;
      const targetRelativePath = archiveDir ? `${archiveDir}/${targetFilename}` : targetFilename;

      const conflict = await probeTargetPath(store, actorKey, effectiveFileTarget.root, targetRelativePath, attachment.sha256);
      if (conflict && conflict.type === 'filename_conflict') {
        cleanupTemp();
        return {
          result: { outcome: 'filename_conflict', targetPath: targetRelativePath, existingSha256: conflict.sha256 },
          warning
        };
      }

      // [P1-1 Fix] Journal operation in file_operations BEFORE touching the disk
      const operation = store.createFileOperation(actorKey, {
        operationType: 'file.import',
        sourcePath: tempFilePath,
        targetPath: `${effectiveFileTarget.root.absolutePath}/${targetRelativePath}`,
        payload: { rootId: effectiveFileTarget.root.id, targetDir: archiveDir, filename: targetFilename, kind: 'blob_promotion', sha256: attachment.sha256 }
      });
      store.startFileOperation(operation.id);

      let placedOnDisk = false;
      let targetStat = null;
      try {
        if (!conflict) {
          const placedTarget = placeFileIntoRoot(effectiveFileTarget.root.absolutePath, targetRelativePath, tempFilePath);
          // Set IMMEDIATELY after placement: any later failure in this block
          // (anchored stat, containment recheck) must still compensate the
          // placed file instead of silently leaving it behind.
          placedOnDisk = true;
          targetStat = statPlacedFileFn(effectiveFileTarget.root.absolutePath, targetRelativePath);
        } else {
          // conflict.type === 'duplicate_content': identical bytes already at the
          // target (NOT placed by this request) — adopt its anchored stat.
          targetStat = statPlacedFileFn(effectiveFileTarget.root.absolutePath, targetRelativePath);
        }
      } catch (placeErr) {
        cleanupTemp();
        if (placedOnDisk) {
          // The file landed but a post-placement step failed: compensate it now,
          // with verified content identity. A refused/failed compensation is
          // compensation_failed — recovery re-examines exactly those operations.
          try {
            await safeUnlinkWithExpectedSha(effectiveFileTarget.root.absolutePath, targetRelativePath, attachment.sha256);
            store.markFileOperationRolledBack(operation.id);
          } catch (compensationErr) {
            store.failFileOperation(operation.id, 'compensation_failed');
          }
        } else {
          store.failFileOperation(operation.id, placeErr.code || 'placement_failed');
        }
        if (placeErr instanceof FileOpError || placeErr instanceof NativePathError) {
          return { result: { outcome: placeErr.code, targetPath: targetRelativePath }, warning };
        }
        throw placeErr;
      }
      cleanupTemp();

      const legacyAtt = (blobHolder.attachments || []).find(a => a.blobHash === attachment.sha256) || blobHolder.attachments?.[0];
      try {
        const promotion = store.promoteBlobAttachmentToSourceFile(actorKey, {
          attachmentId: legacyAtt.id,
          documentId: blobHolder.id,
          rootId: effectiveFileTarget.root.id,
          relativePath: targetRelativePath,
          filename: targetFilename,
          sha256: attachment.sha256,
          sizeBytes: attachment.sizeBytes || targetStat.size,
          modifiedAt: Math.round(targetStat.mtimeMs)
        });

        const updatedDoc = store.backfillDocumentAndTopics(actorKey, blobHolder.id, {
          doi, isbn, url, abstract, year, creators, topicIds: allTopicIds
        });

        store.completeFileOperation(operation.id);

        return {
          result: {
            outcome: 'reused',
            match: { strategy: 'sha256', documentId: blobHolder.id },
            document: updatedDoc,
            sourceFile: promotion.sourceFile,
            attachment: promotion.attachment,
            promotedFromBlob: true
          },
          warning
        };
      } catch (promoteErr) {
        if (promoteErr.code === 'promotion_target_diverged') {
          // A concurrent request archived this attachment under a DIFFERENT
          // target. This request's own placement (if any) is compensated with
          // verified identity; the authoritative archived state is then reported
          // as a reuse so the client still sees the real file. When this request
          // adopted pre-existing identical bytes (placed nothing), that file is
          // not ours to remove — the scanner classifies it as a duplicate.
          if (placedOnDisk) {
            try {
              await safeUnlinkWithExpectedSha(effectiveFileTarget.root.absolutePath, targetRelativePath, attachment.sha256);
              store.markFileOperationRolledBack(operation.id);
            } catch (compensationErr) {
              store.failFileOperation(operation.id, 'compensation_failed');
            }
          } else {
            store.markFileOperationRolledBack(operation.id);
          }
          const currentAtt = store.getAttachment(actorKey, legacyAtt.id);
          const currentSource = currentAtt && currentAtt.sourceFileId
            ? store.getSourceFile(actorKey, currentAtt.sourceFileId)
            : null;
          const divergedDoc = store.backfillDocumentAndTopics(actorKey, blobHolder.id, {
            doi, isbn, url, abstract, year, creators, topicIds: allTopicIds
          });
          return {
            result: {
              outcome: 'reused',
              match: { strategy: 'sha256', documentId: blobHolder.id },
              document: divergedDoc,
              sourceFile: currentSource,
              attachment: currentAtt,
              promotedFromBlob: true,
              promotionTargetDiverged: true
            },
            warning
          };
        }
        if (placedOnDisk) {
          try {
            await safeUnlinkWithExpectedSha(effectiveFileTarget.root.absolutePath, targetRelativePath, attachment.sha256);
            store.markFileOperationRolledBack(operation.id);
          } catch (compensationErr) {
            store.failFileOperation(operation.id, 'compensation_failed');
          }
        } else {
          store.failFileOperation(operation.id, 'promotion_failed');
        }
        throw promoteErr;
      }
    }
  }

  const precheckInput = {
    title, year, doi, isbn, arxivId,
    attachment,
    externalRefs,
    forceNew: normalized.forceNew,
    confirmFuzzy: normalized.confirmFuzzy
  };

  // Phase 1: read-only precheck BEFORE promoting any file.
  const precheck = store.precheckNativeDocumentImport(actorKey, precheckInput);
  if (precheck.outcome !== 'writable') {
    cleanupTemp();
    return { result: precheck, warning };
  }

  // Phase 2: promote temp file to content-addressed storage (exclusive, atomic rename),
  // or — for M4 file-target imports — place the file into the requested library root
  // directory after the content/name conflict rules have been applied.
  let promotion = null;
  let filePlacement = null;
  if (effectiveFileTarget) {
    if (attachment && tempFilePath) {
      if (!effectiveFileTarget.filename && attachment) {
        effectiveFileTarget.filename = deriveWebImportFilename({
          download: { filename: downloadDispositionName },
          pdfUrl: pdfUrl,
          title,
          sha256: attachment.sha256
        });
      }
      const archiveDir = effectiveFileTarget.targetDir || WEB_IMPORT_DEFAULT_DIR;
      const targetRelativePath = archiveDir
        ? `${archiveDir}/${effectiveFileTarget.filename}`
        : effectiveFileTarget.filename;
      const conflict = await probeTargetPath(store, actorKey, effectiveFileTarget.root, targetRelativePath, attachment.sha256);
      if (conflict) {
        cleanupTemp();
        return {
          result: { outcome: conflict.type, existingSha256: conflict.sha256, targetPath: targetRelativePath },
          warning
        };
      }
      const operation = store.createFileOperation(actorKey, {
        operationType: 'file.import',
        sourcePath: tempFilePath,
        targetPath: `${effectiveFileTarget.root.absolutePath}/${targetRelativePath}`,
        payload: { rootId: effectiveFileTarget.root.id, targetDir: archiveDir, filename: effectiveFileTarget.filename, sha256: attachment.sha256 }
      });
      store.startFileOperation(operation.id);
      try {
        placeFileIntoRoot(effectiveFileTarget.root.absolutePath, targetRelativePath, tempFilePath);
      } catch (placeErr) {
        cleanupTemp();
        if (placeErr instanceof NativePathError) {
          // Path-safety rejection (e.g. symlinked parent): a client-visible 400.
          store.failFileOperation(operation.id, placeErr.code);
          const err = new Error(placeErr.message);
          err.status = 400;
          err.code = placeErr.code;
          throw err;
        }
        if (placeErr instanceof FileOpError) {
          store.failFileOperation(operation.id, placeErr.code);
          return { result: { outcome: placeErr.code, targetPath: targetRelativePath }, warning };
        }
        store.failFileOperation(operation.id, 'file_placement_failed');
        const err = new Error(`PDF 落盘到文库目录失败: ${placeErr.message}`);
        err.status = 500;
        err.code = 'file_placement_failed';
        throw err;
      }
      // The placed file must be verifiable through the anchored fd path. A
      // post-placement verification failure compensates the placement instead
      // of enrolling a phantom row (or leaking an orphan file).
      let placedStat;
      try {
        placedStat = statPlacedFileFn(effectiveFileTarget.root.absolutePath, targetRelativePath);
      } catch (statErr) {
        cleanupTemp();
        try {
          await safeUnlinkWithExpectedSha(effectiveFileTarget.root.absolutePath, targetRelativePath, attachment.sha256);
          store.markFileOperationRolledBack(operation.id);
        } catch (compensationErr) {
          store.failFileOperation(operation.id, 'compensation_failed');
        }
        const err = new Error(`PDF 落盘后校验失败: ${statErr.message}`);
        err.status = 500;
        err.code = 'placement_verify_failed';
        throw err;
      }
      filePlacement = {
        operationId: operation.id,
        rootId: effectiveFileTarget.root.id,
        rootAbsolutePath: effectiveFileTarget.root.absolutePath,
        relativePath: targetRelativePath,
        filename: effectiveFileTarget.filename,
        archiveDir,
        sha256: attachment.sha256,
        sizeBytes: attachment.sizeBytes,
        modifiedAt: Math.round(placedStat.mtimeMs)
      };
      cleanupTemp();
    }
  } else if (attachment && tempFilePath) {
    try {
      promotion = promoteBlobFn(store, tempFilePath, attachment.sha256);
      attachment.relativePath = promotion.relativePath;
    } catch (promoteErr) {
      cleanupTemp();
      const err = new Error(`PDF 附件落盘失败: ${promoteErr.message}`);
      err.status = 500;
      err.code = 'blob_persist_failed';
      throw err;
    }
  }

  // Phase 3: transactional database write.
  if (effectiveFileTarget && !filePlacement) {
    // Metadata-only web import: no downloadable PDF -> create the Native
    // document (marked 无 PDF) WITHOUT fabricating a source_file. It never
    // appears in the original-files view and may gain a PDF later.
    const metadataResult = store.importNativeDocument(actorKey, {
      sourceType: meta.sourceType,
      title,
      abstract,
      creators,
      year,
      doi,
      url,
      isbn,
      arxivId,
      externalRefs,
      attachment: null,
      targetWorkspaceId: (effectiveFileTarget.topicIds && effectiveFileTarget.topicIds[0]) || targetWorkspaceId,
      forceNew: normalized.forceNew,
      confirmFuzzy: normalized.confirmFuzzy
    });
    if (metadataResult.outcome === 'created' || metadataResult.outcome === 'reused') {
      const extraTopics = (effectiveFileTarget.topicIds || []).slice(metadataResult.topicDocument ? 1 : 0);
      for (const workspaceId of extraTopics) {
        try {
          store.addDocumentTopics(actorKey, metadataResult.document.id, [workspaceId], { origin: 'canvas_import' });
        } catch {}
      }
    }
    const metadataWarning = `${warning ? warning + '；' : ''}未取得 PDF，已创建无 PDF 的元数据文档（可稍后补充 PDF）`;
    return { result: { ...metadataResult, hasPdf: false }, warning: metadataWarning };
  }
  let result;
  try {
    if (filePlacement) {
      const existingRow = store.getSourceFileByPath(actorKey, filePlacement.rootId, filePlacement.relativePath);
      if (existingRow) {
        // Placement replaced a path whose row was stale; the stale row was not
        // active (probe passed), so detach it before claiming the path.
        store.releaseSourceFilePath(actorKey, filePlacement.rootId, filePlacement.relativePath, 'import_takeover');
      }
      result = store.importNativeDocumentToSourceFile(actorKey, {
        sourceType: meta.sourceType,
        title,
        abstract,
        creators,
        year,
        doi,
        url,
        isbn,
        arxivId,
        externalRefs,
        rootId: filePlacement.rootId,
        relativePath: filePlacement.relativePath,
        filename: filePlacement.filename,
        sha256: filePlacement.sha256,
        sizeBytes: filePlacement.sizeBytes,
        modifiedAt: filePlacement.modifiedAt,
        topicIds: effectiveFileTarget.topicIds || [],
        forceNew: normalized.forceNew,
        confirmFuzzy: normalized.confirmFuzzy
      });
    } else {
      result = store.importNativeDocument(actorKey, {
        sourceType: meta.sourceType,
        title,
        abstract,
        creators,
        year,
        doi,
        url,
        isbn,
        arxivId,
        externalRefs,
        attachment,
        targetWorkspaceId,
        forceNew: normalized.forceNew,
        confirmFuzzy: normalized.confirmFuzzy
      });
    }
  } catch (dbErr) {
    if (filePlacement) {
      // Compensation: remove the just-placed file ONLY if content matches expected SHA.
      // A failed unlink leaves the operation marked as compensation_failed.
      try {
        await safeUnlinkWithExpectedSha(filePlacement.rootAbsolutePath, filePlacement.relativePath, filePlacement.sha256);
        store.markFileOperationRolledBack(filePlacement.operationId);
      } catch (unlinkErr) {
        store.failFileOperation(filePlacement.operationId, 'compensation_failed');
      }
    }
    if (promotion?.newlyCreated) {
      compensatePromotedBlob(store, attachment.sha256, promotion.targetBlobPath);
    }
    throw dbErr;
  }

  // Write-time decision diverged (concurrent import raced the precheck): compensate file.
  const diverged = result.outcome !== 'created' && result.outcome !== 'reused'
    && result.outcome !== 'duplicate_content' && result.outcome !== 'filename_conflict';
  if (filePlacement) {
    if (result.outcome === 'created' || result.outcome === 'reused') {
      store.completeFileOperation(filePlacement.operationId);
    } else {
      // duplicate_content / filename_conflict resolved after placement lost a race:
      // verify expected SHA before unlinking; failure marks compensation_failed.
      try {
        await safeUnlinkWithExpectedSha(filePlacement.rootAbsolutePath, filePlacement.relativePath, filePlacement.sha256);
        store.markFileOperationRolledBack(filePlacement.operationId);
      } catch (unlinkErr) {
        store.failFileOperation(filePlacement.operationId, 'compensation_failed');
      }
    }
  } else if (diverged && promotion?.newlyCreated) {
    compensatePromotedBlob(store, attachment.sha256, promotion.targetBlobPath);
  }

  if (!attachment && !result.attachment && result.hasPdf === undefined) {
    result.hasPdf = false;
  }
  return { result, warning };
}

// Exported for direct concurrency testing of the exclusive promotion primitive.
export { defaultPromoteBlob };

// Exported so external parse adapters (e.g. the M3 Translation Server layer) can be
// contract-tested against the exact import-item normalizer used by the executor.
export { normalizeNativeImportItem };

// Resolves the archive target for web imports (DOI/arXiv/URL/BibTeX/RIS/TS):
// an explicit rootId wins; otherwise the FIRST configured library root is the
// deterministic default. An omitted/empty targetDir defaults to 网页导入 per
// the M4 product rule. Returns null when the deployment has no active root —
// callers then refuse to archive PDFs as blobs (metadata-only still allowed).
function resolveWebImportFileTarget(store, actorKey, body = {}) {
  const rawTargetDir = body.targetDir === undefined || body.targetDir === null ? '' : String(body.targetDir).trim();
  const targetDir = rawTargetDir ? normalizeRelativePath(rawTargetDir) : WEB_IMPORT_DEFAULT_DIR;
  const rawFilename = body.filename === undefined || body.filename === null ? '' : String(body.filename).trim();
  const filename = rawFilename ? normalizeFilename(rawFilename, { requirePdf: true }) : undefined;
  if (body.rootId) {
    const root = store.requireLibraryRoot(actorKey, string(body.rootId, 'rootId', { max: 128 }));
    return { root, targetDir, filename };
  }
  const roots = store.listLibraryRoots(actorKey);
  if (!roots.length) return null;
  return { root: roots[0], targetDir, filename };
}

export function createCanvasHandler(store, {
  aiCompletion = requestAiCompletion,
  aiPublicConfig = getAiPublicConfig,
  aiEndpointValidator = validateAiEndpoint,
  downloadPdfFn = safeDownloadPdfFile,
  promoteBlobFn = defaultPromoteBlob,
  translationServerFn = null,
  statPlacedFileFn = statPlacedFileInsideRoot,
} = {}) {
  recoverQueuedAndRunningJobs(store);
  // NOTE: recoverBlobConsistency is intentionally NOT invoked here. It must only run on
  // the instance that holds the listen port (see scripts/dev-server.mjs), after bind
  // succeeds — otherwise a competing startup could reap files that an in-flight import
  // has promoted but not yet committed to the database.

  return async function handleCanvasApi(req, res, url) {
    const actor = actorFromRequest(req);
    if (!actor) {
      error(res, 401, 'authentication_required', 'Canvas requires an authenticated AltCanvas session');
      return;
    }

    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';
    let match;
    try {
      // ==========================================
      // --- Native Library Core Endpoints (M1) ---
      // ==========================================

      // --- Native PDF Upload ---
      if (pathname === '/canvas/native/upload' && method === 'POST') {
        const tempDir = path.join(store.getBlobStorageDir(), 'tmp');
        const uploadResult = await streamUploadToFile(req, tempDir);
        const { tempFilePath, sha256, sizeBytes, originalFilename, targetWorkspaceId, forceNew } = uploadResult;

        let importResult;
        let newlyCreatedBlobPath = null;
        try {
          const targetBlobPath = store.resolveBlobPath(sha256, '.pdf');
          const relativePath = path.relative(store.getBlobStorageDir(), targetBlobPath);

          // Atomic check and move file only if blob doesn't already exist on disk
          if (!fs.existsSync(targetBlobPath)) {
            fs.mkdirSync(path.dirname(targetBlobPath), { recursive: true, mode: 0o700 });
            fs.renameSync(tempFilePath, targetBlobPath);
            fs.chmodSync(targetBlobPath, 0o600);
            newlyCreatedBlobPath = targetBlobPath;
          } else {
            try { fs.unlinkSync(tempFilePath); } catch {}
          }

          importResult = store.importNativeUploadedDocument(actor.actorKey, {
            sha256,
            relativePath,
            sizeBytes,
            mimeType: 'application/pdf',
            originalFilename,
            targetWorkspaceId,
            forceNew
          });
        } catch (err) {
          try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch {}
          if (newlyCreatedBlobPath && fs.existsSync(newlyCreatedBlobPath)) {
            try {
              const existingBlobInDb = store.getBlob(sha256);
              if (!existingBlobInDb || existingBlobInDb.referenceCount <= 0) {
                fs.unlinkSync(newlyCreatedBlobPath);
              }
            } catch {}
          }
          throw err;
        }

        if (importResult.duplicate) {
          json(res, 200, {
            duplicate: true,
            data: {
              document: importResult.document,
              attachment: importResult.attachment,
              blob: importResult.blob,
              topicDocument: importResult.topicDocument
            },
            message: '该文献已在文库中'
          });
          return;
        }

        json(res, 201, {
          data: {
            document: importResult.document,
            attachment: importResult.attachment,
            blob: importResult.blob,
            topicDocument: importResult.topicDocument
          }
        });
        return;
      }

      // --- M2 Unified Native Import Pipeline ---
      // --- M4 blob-only web-import migration ---
      match = /^\/canvas\/native\/migrations\/blob-only-web-imports$/.exec(pathname);
      if (match && method === 'GET') {
        const pending = store.countBlobOnlyWebImports(actor.actorKey);
        let lastReport = null;
        const lastOp = store.db.prepare(`
          SELECT payload_json, completed_at FROM file_operations
          WHERE owner_key = ? AND operation_type = 'library.reconcile'
            AND payload_json LIKE '%blob-only-web-import-migration%'
          ORDER BY created_at DESC LIMIT 1
        `).get(actor.actorKey);
        if (lastOp) {
          try { lastReport = { ...JSON.parse(lastOp.payload_json), completedAt: lastOp.completed_at }; } catch {}
        }
        json(res, 200, { data: { pending, lastReport } });
        return;
      }
      if (match && method === 'POST') {
        const body = await readJson(req, MAX_IMPORT_BODY_BYTES);
        if (body && (typeof body !== 'object' || Array.isArray(body))) {
          throw new TypeError('request body must be an object');
        }
        try {
          const result = await runBlobOnlyWebImportMigration(store, actor.actorKey, {
            rootId: body?.rootId || null,
            targetDir: typeof body?.targetDir === 'string' && body.targetDir.trim() ? body.targetDir : undefined
          });
          json(res, 200, { data: result });
        } catch (err) {
          if (err.status === 422) {
            error(res, 422, err.code || 'library_root_required', err.message);
            return;
          }
          throw err;
        }
        return;
      }

      if (pathname === '/canvas/imports/native' && method === 'POST') {
        const body = await readJson(req, MAX_IMPORT_BODY_BYTES);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new TypeError('request body must be an object');
        }

        let normalized;
        try {
          normalized = normalizeNativeImportItem(body, 'body');
        } catch (err) {
          error(res, 400, 'invalid_request', err.message);
          return;
        }
        if (body.targetWorkspaceId) {
          normalized.targetWorkspaceId = string(body.targetWorkspaceId, 'targetWorkspaceId', { max: 128 });
        }
        if (body.confirmFuzzy !== undefined && normalized.confirmFuzzy === false) {
          normalized.confirmFuzzy = Boolean(body.confirmFuzzy);
        }

        // [M4] Web imports that obtain a PDF are always archived into the
        // library roots (default 网页导入); blob-only web imports are gone.
        // The requested topic rides on the fileTarget so the placement path
        // binds topic_documents to the archived source_file.
        const webImportTopicIds = normalized.targetWorkspaceId ? [normalized.targetWorkspaceId] : [];
        let webImportFileTarget = null;
        if (body.rootId !== undefined || body.targetDir !== undefined || body.filename !== undefined) {
          webImportFileTarget = resolveWebImportFileTarget(store, actor.actorKey, body);
          if (webImportFileTarget) webImportFileTarget.topicIds = webImportTopicIds;
        } else {
          const roots = store.listLibraryRoots(actor.actorKey);
          webImportFileTarget = roots.length
            ? { root: roots[0], targetDir: WEB_IMPORT_DEFAULT_DIR, filename: undefined, topicIds: webImportTopicIds }
            : null;
        }

        let outcome;
        try {
          outcome = await executeNativeImportItem(store, actor.actorKey, normalized, {
            downloadPdfFn,
            promoteBlobFn,
            translationServerFn,
            statPlacedFileFn,
            fileTarget: webImportFileTarget,
            webImportArchive: true
          });
        } catch (execErr) {
          if (execErr.code === 'pdf_download_failed' || execErr.code === 'blob_persist_failed') {
            error(res, execErr.status || 502, execErr.code, execErr.message);
            return;
          }
          if (execErr.status) {
            error(res, execErr.status, execErr.code || 'import_error', execErr.message);
            return;
          }
          if (execErr.code === 'resolve_error') {
            error(res, 400, 'resolve_error', `Failed to resolve input: ${execErr.message}`);
            return;
          }
          throw execErr;
        }

        const { result, warning } = outcome;
        if (result.outcome === 'requires_confirmation') {
          json(res, 409, {
            error: { code: 'duplicate_confirmation_required', message: '检测到高度相似的文献，需要用户确认后才能合并' },
            data: { candidates: result.candidates }
          });
          return;
        }
        if (result.outcome === 'conflicting_identities') {
          json(res, 409, {
            error: { code: 'identity_conflict', message: '多个精确标识分别指向不同文献，无法确定合并目标，请手动处理' },
            data: { conflicts: result.conflicts }
          });
          return;
        }
        if (result.outcome === 'duplicate_content') {
          json(res, 409, {
            error: { code: 'duplicate_content', message: '相同 SHA-256 的内容已在文库中，未重复导入' },
            data: {
              outcome: result.outcome,
              document: result.document || null,
              sourceFile: result.sourceFile || null,
              match: result.match || null,
              warning: warning || undefined
            }
          });
          return;
        }
        if (result.outcome === 'filename_conflict') {
          json(res, 409, {
            error: { code: 'filename_conflict', message: '目标目录已存在同名但内容不同的文件，请修改原始文件名后重试' },
            data: {
              outcome: result.outcome,
              targetPath: result.targetPath || null,
              existingSha256: result.existingSha256 || null,
              warning: warning || undefined
            }
          });
          return;
        }

        json(res, result.outcome === 'reused' ? 200 : 201, {
          data: warning ? { ...result, warning } : result
        });
        return;
      }

      if (pathname === '/canvas/imports/native/batch' && method === 'POST') {
        const body = await readJson(req, MAX_IMPORT_BODY_BYTES);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new TypeError('request body must be an object');
        }
        if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) {
          throw new TypeError('items must be a non-empty array of at most 100 entries');
        }

        // Full deep pre-validation via the unified normalizer BEFORE creating the job.
        const normalizedItems = [];
        for (let i = 0; i < body.items.length; i++) {
          normalizedItems.push(normalizeNativeImportItem(body.items[i], `item at index ${i}`));
        }

        const targetWorkspaceId = body.targetWorkspaceId
          ? string(body.targetWorkspaceId, 'targetWorkspaceId', { max: 128 })
          : null;
        const batchConfirmFuzzy = Boolean(body.confirmFuzzy);
        // [M4] Batch web imports archive PDFs into the library roots too.
        const batchFileTarget = resolveWebImportFileTarget(store, actor.actorKey, body);

        const batchJob = store.createImportJob(actor.actorKey, {
          sourceType: string(body.sourceType || 'batch', 'sourceType', { max: 32 }),
          totalCount: normalizedItems.length
        });

        // Set import_jobs state to running on startup (import_jobs table, not jobs table)
        store.updateImportJob(actor.actorKey, batchJob.id, { state: 'running' });

        // Process synchronously so the batch report is complete in the response.
        let cancelled = false;
        for (const normalized of normalizedItems) {
          const currentJob = store.getImportJob(actor.actorKey, batchJob.id);
          if (currentJob?.state === 'cancelled') {
            cancelled = true;
            break;
          }
          if (batchConfirmFuzzy && !normalized.confirmFuzzy) {
            normalized.confirmFuzzy = true;
          }
          const fallbackTitle = normalized.title || normalized.input || '';
          // [P1 Fix] Construct an independent fileTarget per item so that filename
          // derivation never mutates a shared object across items, and merge
          // targetWorkspaceId so batch items always join the requested topic.
          const itemTopicIds = Array.from(new Set([
            ...(Array.isArray(body.topicIds) ? body.topicIds : []),
            ...(targetWorkspaceId ? [targetWorkspaceId] : []),
            ...(normalized.targetWorkspaceId ? [normalized.targetWorkspaceId] : [])
          ])).filter(Boolean);

          const itemFileTarget = batchFileTarget ? {
            root: batchFileTarget.root,
            targetDir: batchFileTarget.targetDir,
            filename: normalized.filename || undefined,
            topicIds: itemTopicIds
          } : null;

          try {
            const { result, warning } = await executeNativeImportItem(store, actor.actorKey, normalized, {
              downloadPdfFn,
              promoteBlobFn,
              fallbackTargetWorkspaceId: targetWorkspaceId,
              translationServerFn,
              statPlacedFileFn,
              fileTarget: itemFileTarget,
              webImportArchive: true
            });
            if (result.outcome === 'requires_confirmation') {
              store.appendImportJobItemReport(actor.actorKey, batchJob.id, {
                ok: false,
                title: fallbackTitle,
                outcome: 'requires_confirmation',
                error: 'Fuzzy duplicate requires user confirmation',
                candidates: result.candidates
              });
            } else if (result.outcome === 'conflicting_identities') {
              store.appendImportJobItemReport(actor.actorKey, batchJob.id, {
                ok: false,
                title: fallbackTitle,
                outcome: 'identity_conflict',
                error: 'Multiple exact identities resolve to different documents; manual resolution required',
                conflicts: result.conflicts
              });
            } else if (result.outcome === 'duplicate_content') {
              // A resolved dedupe decision, not a failure: the content already
              // lives in the library, nothing was imported.
              store.appendImportJobItemReport(actor.actorKey, batchJob.id, {
                ok: true,
                title: result.document?.title || fallbackTitle,
                documentId: result.document?.id || null,
                outcome: result.outcome,
                matchStrategy: result.match?.strategy || null,
                warning: warning || undefined
              });
            } else if (result.outcome === 'filename_conflict') {
              // Different content claimed the target filename: recorded as a
              // failed item for the user to resolve with a new original name.
              store.appendImportJobItemReport(actor.actorKey, batchJob.id, {
                ok: false,
                title: fallbackTitle,
                outcome: result.outcome,
                error: '目标目录已存在同名但内容不同的文件，请修改原始文件名后重试',
                errorCode: 'filename_conflict',
                targetPath: result.targetPath || null,
                warning: warning || undefined
              });
            } else {
              store.appendImportJobItemReport(actor.actorKey, batchJob.id, {
                ok: true,
                title: result.document.title,
                documentId: result.document.id,
                inboxEntryId: result.inboxEntry?.id || null,
                outcome: result.outcome,
                matchStrategy: result.match?.strategy || null,
                warning: warning || undefined
              });
            }
          } catch (itemErr) {
            store.appendImportJobItemReport(actor.actorKey, batchJob.id, {
              ok: false,
              title: fallbackTitle,
              error: itemErr.message,
              errorCode: itemErr.code || undefined,
              warning: /PDF 附件下载失败/.test(itemErr.message) ? itemErr.message : undefined
            });
          }
        }

        // Finalize state to completed or completed_with_errors
        if (!cancelled) {
          store.finalizeImportJob(actor.actorKey, batchJob.id);
        }

        const finalJob = store.getImportJob(actor.actorKey, batchJob.id);
        json(res, 201, {
          data: {
            job: finalJob,
            cancelled
          }
        });
        return;
      }

      match = /^\/canvas\/import-jobs\/([0-9a-f-]+)$/.exec(pathname);
      if (match && method === 'GET') {
        const job = store.getImportJob(actor.actorKey, match[1]);
        if (!job) throw new CanvasNotFoundError('import job not found');
        json(res, 200, { data: job });
        return;
      }
      match = /^\/canvas\/import-jobs\/([0-9a-f-]+)\/cancel$/.exec(pathname);
      if (match && method === 'POST') {
        const job = store.cancelImportJob(actor.actorKey, match[1]);
        json(res, 200, { data: job });
        return;
      }
      if (pathname === '/canvas/import-jobs' && method === 'GET') {
        const state = url.searchParams.get('state') || undefined;
        const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50;
        const jobs = store.listImportJobs(actor.actorKey, { state, limit });
        json(res, 200, { data: jobs });
        return;
      }

      // --- Native Library Roots (M4) ---
      if (pathname === '/canvas/native/library-roots' && method === 'GET') {
        const configuredRoots = parseNativeLibraryRootsConfig();
        const roots = store.ensureLibraryRootsFromConfig(actor.actorKey, configuredRoots);
        json(res, 200, { data: roots });
        return;
      }

      match = /^\/canvas\/native\/library-roots\/([0-9a-f-]+)\/tree$/.exec(pathname);
      if (match && method === 'GET') {
        const root = store.requireLibraryRoot(actor.actorKey, match[1]);
        const rawPath = url.searchParams.get('path') || '';
        const relativePath = rawPath ? normalizeRelativePath(rawPath) : '';
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200));
        const cursor = Math.max(0, Number(url.searchParams.get('cursor')) || 0);
        // Pagination is pushed into the listing itself: the directory is
        // verified per component (symlinked ancestors rejected), streamed via
        // opendir with a bounded name buffer, and stats run only for the
        // requested page.
        const listing = listDirectoryPage(root.absolutePath, relativePath, { cursor, limit });
        const pdfPaths = listing.entries.filter(e => e.type === 'pdf').map(e => e.relativePath);
        const libraryInfo = store.getSourceFileLibraryInfoByPaths(actor.actorKey, root.id, pdfPaths);
        const data = listing.entries.map(entry => {
          const binding = libraryInfo.get(entry.relativePath) || null;
          return { ...entry, library: binding };
        });
        json(res, 200, {
          data,
          meta: {
            rootId: root.id,
            path: relativePath,
            total: listing.total,
            cursor: listing.cursor,
            nextCursor: listing.nextCursor,
            truncated: listing.truncated
          }
        });
        return;
      }

      match = /^\/canvas\/native\/library-roots\/([0-9a-f-]+)\/directories$/.exec(pathname);
      if (match && method === 'POST') {
        const root = store.requireLibraryRoot(actor.actorKey, match[1]);
        const body = await readJson(req);
        const relativeDir = body?.path ? normalizeRelativePath(body.path) : '';
        const name = normalizeFilename(body?.name, { requirePdf: false });
        const targetRel = relativeDir ? `${relativeDir}/${name}` : name;
        const operation = store.createFileOperation(actor.actorKey, {
          operationType: 'file.mkdir',
          targetPath: `${root.absolutePath}/${targetRel}`,
          payload: { rootId: root.id, path: targetRel }
        });
        store.startFileOperation(operation.id);
        try {
          ensureDirectoryInsideRoot(root.absolutePath, targetRel);
          store.completeFileOperation(operation.id);
          json(res, 201, { data: { path: targetRel } });
        } catch (err) {
          store.failFileOperation(operation.id, 'mkdir_failed');
          throw err;
        }
        return;
      }

      match = /^\/canvas\/native\/library-roots\/([0-9a-f-]+)\/scan$/.exec(pathname);
      if (match && method === 'POST') {
        const root = store.requireLibraryRoot(actor.actorKey, match[1]);
        let result;
        try {
          result = await scanLibraryRoot(store, actor.actorKey, root.id);
        } catch (err) {
          if (err instanceof LibraryScanError || err?.code === 'library_root_unavailable') {
            error(res, err.code === 'library_root_unavailable' ? 503 : 500,
              err.code || 'library_scan_failed',
              err.code === 'library_root_unavailable' ? 'Library root is not available' : 'Library scan failed');
            return;
          }
          throw err;
        }
        json(res, result.alreadyRunning ? 200 : 202, {
          data: {
            operationId: result.operationId,
            state: result.state,
            alreadyRunning: result.alreadyRunning,
            report: result.report || null
          }
        });
        return;
      }

      match = /^\/canvas\/native\/file-operations\/([0-9a-f-]+)$/.exec(pathname);
      if (match && method === 'GET') {
        const operation = store.getFileOperation(actor.actorKey, match[1]);
        if (!operation) {
          error(res, 404, 'not_found', 'File operation not found');
          return;
        }
        json(res, 200, { data: operation });
        return;
      }

      // --- M4 Source File Operations ---
      function sourceFileConflictResponse(result, warning) {
        if (result.outcome === 'duplicate_content') {
          json(res, 409, {
            error: { code: 'duplicate_content', message: '相同 SHA-256 的内容已在文库中，未重复加入' },
            data: {
              outcome: result.outcome,
              document: result.document || null,
              sourceFile: result.sourceFile || null,
              match: result.match || null,
              warning: warning || undefined
            }
          });
          return true;
        }
        if (result.outcome === 'filename_conflict') {
          json(res, 409, {
            error: { code: 'filename_conflict', message: '目标目录已存在同名但内容不同的文件，请输入新的原始文件名后重试' },
            data: { outcome: result.outcome, targetPath: result.targetPath || null }
          });
          return true;
        }
        return false;
      }

      if (pathname === '/canvas/native/source-files/import' && method === 'POST') {
        const body = await readJson(req, MAX_IMPORT_BODY_BYTES);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new TypeError('request body must be an object');
        }
        let normalized;
        try {
          normalized = normalizeNativeImportItem(body, 'body');
        } catch (err) {
          error(res, 400, 'invalid_request', err.message);
          return;
        }
        if (!body.rootId || typeof body.rootId !== 'string') {
          throw new TypeError('rootId is required');
        }
        const root = store.requireLibraryRoot(actor.actorKey, body.rootId);
        const rawTargetDir = typeof body.targetDir === 'string' ? body.targetDir.trim() : '';
        const targetDir = rawTargetDir ? normalizeRelativePath(rawTargetDir) : WEB_IMPORT_DEFAULT_DIR;
        let filename = body.filename ? normalizeFilename(body.filename, { requirePdf: true }) : null;

        if (!filename) {
          // Derive the original filename from the resolved title.
          let resolved = normalized.resolved;
          if (!resolved && normalized.input) {
            resolved = await resolveImportInput(normalized.input, {
              translationServerFn: translationServerFn || undefined
            }).catch(err => {
              if (err.status) throw err;
              const wrapped = new Error(err.message);
              wrapped.status = err.status || 400;
              wrapped.code = err.code || 'resolve_error';
              throw wrapped;
            });
          }
          normalized.resolved = resolved;
          const base = String(resolved?.title || normalized.title || normalized.input || 'document')
            .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80) || 'document';
          filename = normalizeFilename(`${base}.pdf`, { requirePdf: true });
        }

        let topicIds = [];
        if (body.topicIds !== undefined) {
          if (!Array.isArray(body.topicIds) || body.topicIds.length > 50
            || body.topicIds.some(t => typeof t !== 'string' || t.length > 128)) {
            throw new TypeError('topicIds must be an array of at most 50 workspace ids');
          }
          topicIds = body.topicIds;
        }

        let outcome;
        try {
          outcome = await executeNativeImportItem(store, actor.actorKey, normalized, {
            downloadPdfFn,
            promoteBlobFn,
            translationServerFn,
            statPlacedFileFn,
            fileTarget: { root, targetDir, filename, topicIds }
          });
        } catch (execErr) {
          if (execErr.status) {
            error(res, execErr.status, execErr.code || 'import_error', execErr.message);
            return;
          }
          throw execErr;
        }

        const { result, warning } = outcome;
        if (result.outcome === 'requires_confirmation') {
          json(res, 409, {
            error: { code: 'duplicate_confirmation_required', message: '检测到高度相似的文献，需要用户确认后才能合并' },
            data: { candidates: result.candidates }
          });
          return;
        }
        if (result.outcome === 'conflicting_identities') {
          json(res, 409, {
            error: { code: 'identity_conflict', message: '多个精确标识分别指向不同文献，无法确定合并目标，请手动处理' },
            data: { conflicts: result.conflicts }
          });
          return;
        }
        if (sourceFileConflictResponse(result, warning)) return;

        json(res, result.outcome === 'reused' ? 200 : 201, {
          data: warning ? { ...result, warning } : result,
          message: result.outcome === 'reused'
            ? '已复用文库中的既有文献，并将 PDF 归档到目标目录'
            : undefined
        });
        return;
      }

      match = /^\/canvas\/native\/source-files\/([0-9a-f-]+)\/rename$/.exec(pathname);
      if (match && method === 'POST') {
        const body = await readJson(req);
        const result = await renameSourceFile(store, actor.actorKey, match[1], versionFromIfMatch(req), body?.filename);
        json(res, 200, { data: result.sourceFile }, { ETag: etag(result.sourceFile.version) });
        return;
      }

      match = /^\/canvas\/native\/source-files\/([0-9a-f-]+)\/move$/.exec(pathname);
      if (match && method === 'POST') {
        const body = await readJson(req);
        const result = await moveSourceFile(store, actor.actorKey, match[1], versionFromIfMatch(req),
          body?.targetDir ?? '', body?.filename ?? null);
        json(res, 200, { data: result.sourceFile }, { ETag: etag(result.sourceFile.version) });
        return;
      }

      match = /^\/canvas\/native\/source-files\/([0-9a-f-]+)\/restore$/.exec(pathname);
      if (match && method === 'POST') {
        const body = await readJson(req);
        const result = await restoreSourceFile(store, actor.actorKey, match[1], versionFromIfMatch(req), body?.filename ?? null);
        json(res, 200, { data: result.sourceFile }, { ETag: etag(result.sourceFile.version) });
        return;
      }

      match = /^\/canvas\/native\/source-files\/([0-9a-f-]+)\/permanent$/.exec(pathname);
      if (match && method === 'DELETE') {
        const result = await deleteSourceFilePermanent(store, actor.actorKey, match[1], versionFromIfMatch(req));
        json(res, 200, { data: { deleted: true, operationId: result.operation.id } });
        return;
      }

      match = /^\/canvas\/native\/source-files\/([0-9a-f-]+)\/enroll$/.exec(pathname);
      if (match && method === 'POST') {
        const enrolled = store.enrollExistingSourceFile(actor.actorKey, match[1]);
        if (enrolled.duplicate) {
          json(res, 409, {
            error: { code: 'duplicate_content', message: '相同 SHA-256 的内容已在文库中，未重复加入' },
            data: { document: enrolled.document, sourceFile: enrolled.sourceFile }
          });
          return;
        }
        json(res, 201, { data: enrolled });
        return;
      }

      match = /^\/canvas\/native\/source-files\/([0-9a-f-]+)$/.exec(pathname);
      if (match && method === 'DELETE') {
        const result = await trashSourceFile(store, actor.actorKey, match[1], versionFromIfMatch(req));
        json(res, 200, { data: result.sourceFile }, { ETag: etag(result.sourceFile.version) });
        return;
      }

      // --- Native Documents List & CRUD ---
      if (pathname === '/canvas/native/documents' && method === 'GET') {
        const search = url.searchParams.get('search') || '';
        const topicId = url.searchParams.get('topicId') || null;
        const unclassified = url.searchParams.get('unclassified') === 'true';
        const fileStatus = url.searchParams.get('fileStatus') || null;
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        if (fileStatus && !['active', 'duplicate', 'missing', 'unreadable', 'trashed'].includes(fileStatus)) {
          throw new TypeError('fileStatus must be one of active/duplicate/missing/unreadable/trashed');
        }
        const { total, documents } = store.listNativeLibraryDocuments(actor.actorKey, {
          search, topicId, unclassified, fileStatus, limit, offset
        });
        json(res, 200, {
          data: documents,
          meta: { total, limit, offset, nextCursor: offset + documents.length < total ? offset + documents.length : null }
        });
        return;
      }

      if (pathname === '/canvas/native/documents' && method === 'POST') {
        const body = await readJson(req);
        const title = string(body.title || '未命名文献', 'title', { min: 1, max: 500 });
        const doc = store.createDocument(actor.actorKey, {
          ...body,
          title
        });
        json(res, 201, { data: doc }, { ETag: etag(doc.version) });
        return;
      }

      match = /^\/canvas\/native\/documents\/([0-9a-f-]+)$/.exec(pathname);
      if (match && method === 'GET') {
        const doc = store.requireDocument(actor.actorKey, match[1]);
        json(res, 200, { data: doc }, { ETag: etag(doc.version) });
        return;
      }
      if (match && ['PATCH', 'DELETE'].includes(method)) {
        const version = versionFromIfMatch(req);
        if (version === null) {
          error(res, 428, 'precondition_required', 'A valid If-Match header is required');
          return;
        }
        if (method === 'DELETE') {
          // 从文库移除: unbind the library identity; the original file stays on disk.
          store.unbindDocumentFromLibrary(actor.actorKey, match[1], version);
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        const body = await readJson(req);
        const doc = store.updateDocument(actor.actorKey, match[1], version, body);
        json(res, 200, { data: doc }, { ETag: etag(doc.version) });
        return;
      }

      // --- M4 Document Topic Binding ---
      match = /^\/canvas\/native\/documents\/([0-9a-f-]+)\/topics$/.exec(pathname);
      if (match && method === 'POST') {
        const body = await readJson(req);
        const bindings = store.addDocumentTopics(actor.actorKey, match[1], body?.topicIds);
        json(res, 201, { data: bindings });
        return;
      }

      match = /^\/canvas\/native\/documents\/([0-9a-f-]+)\/topics\/([0-9a-f-]+)$/.exec(pathname);
      if (match && method === 'DELETE') {
        const version = versionFromIfMatch(req);
        if (version === null) {
          error(res, 428, 'precondition_required', 'A valid If-Match header is required');
          return;
        }
        store.removeDocumentTopic(actor.actorKey, match[1], match[2]);
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      if (pathname === '/canvas/native/documents/batch-topics' && method === 'POST') {
        const body = await readJson(req);
        if (!Array.isArray(body?.documentIds) || !body.documentIds.length || body.documentIds.length > 200
          || body.documentIds.some(id => typeof id !== 'string')) {
          throw new TypeError('documentIds must be an array of at most 200 document ids');
        }
        const results = [];
        for (const documentId of body.documentIds) {
          try {
            const bindings = store.addDocumentTopics(actor.actorKey, documentId, body.topicIds);
            results.push({ documentId, ok: true, bindings });
          } catch (err) {
            results.push({ documentId, ok: false, errorCode: err instanceof CanvasNotFoundError ? 'not_found' : 'failed' });
          }
        }
        json(res, 200, { data: results });
        return;
      }

      // --- Native Attachment File Streaming with HTTP Range ---
      // Unified across managed blobs (M1) and library-root source files (M4).
      match = /^\/canvas\/native\/attachments\/([0-9a-f-]+)\/file$/.exec(pathname);
      if (match && ['GET', 'HEAD'].includes(method)) {
        const attachmentId = match[1];
        const content = store.getAttachmentContent(actor.actorKey, attachmentId);
        if (!content) {
          error(res, 404, 'not_found', 'Attachment not found');
          return;
        }

        // Open a read handle before emitting headers: this validates that the
        // backing file exists and (for source files) rejects symlink escapes.
        let readContext;
        try {
          if (content.kind === 'source_file') {
            const opened = openFileInsideRoot(content.sourceFile.rootAbsolutePath, content.sourceFile.relativePath);
            let released = false;
            readContext = {
              fileSize: opened.stat.size,
              createStream: (start, end) => fs.createReadStream('', { fd: opened.fd, start, end, autoClose: false }),
              release: () => {
                if (released) return;
                released = true;
                try { fs.closeSync(opened.fd); } catch {}
              }
            };
          } else {
            const blobFilePath = content.filePath;
            if (!fs.existsSync(blobFilePath)) {
              error(res, 404, 'file_not_found', 'Attachment file not found on disk');
              return;
            }
            const stat = fs.statSync(blobFilePath);
            readContext = {
              fileSize: stat.size,
              createStream: (start, end) => fs.createReadStream(blobFilePath, { start, end }),
              release: () => {}
            };
          }
        } catch (err) {
          if (err instanceof NativePathError) {
            const status = err.code === 'file_not_found' || err.code === 'symlink_rejected' ? 404 : 400;
            error(res, status, err.code, 'Attachment file is not readable');
            return;
          }
          throw err;
        }

        try {
          const fileSize = readContext.fileSize;
          const contentEtag = `W/"${content.sha256}"`;

          const ifNoneMatch = req.headers['if-none-match'];
          if (ifNoneMatch && (ifNoneMatch === contentEtag || ifNoneMatch === `"${content.sha256}"` || ifNoneMatch === '*')) {
            readContext.release();
            res.writeHead(304, {
              'ETag': contentEtag,
              'Cache-Control': 'private, max-age=86400',
              'Accept-Ranges': 'bytes'
            });
            res.end();
            return;
          }

          const baseHeaders = {
            'Content-Type': content.mimeType || 'application/pdf',
            'Accept-Ranges': 'bytes',
            'ETag': contentEtag,
            'Cache-Control': 'private, max-age=86400',
            'Content-Disposition': `inline; filename="${encodeURIComponent(content.fileName || 'document.pdf')}"`
          };

          const streamRange = (start, end) => {
            const stream = readContext.createStream(start, end);
            stream.on('close', () => readContext.release());
            res.on('close', () => readContext.release());
            return stream;
          };

          const rangeHeader = req.headers['range'];
          if (!rangeHeader) {
            res.writeHead(200, { ...baseHeaders, 'Content-Length': fileSize });
            if (method === 'HEAD') {
              readContext.release();
              res.end();
              return;
            }
            streamRange(0, fileSize - 1).pipe(res);
            return;
          }

          // Parse Range header
          const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
          if (!rangeMatch) {
            res.writeHead(416, {
              'Content-Range': `bytes */${fileSize}`,
              'Content-Type': 'text/plain'
            });
            res.end('416 Range Not Satisfiable');
            return;
          }

          let start;
          let end;
          if (rangeMatch[1] === '' && rangeMatch[2] !== '') {
            const suffix = Number(rangeMatch[2]);
            if (suffix <= 0) {
              res.writeHead(416, { 'Content-Range': `bytes */${fileSize}`, 'Content-Type': 'text/plain' });
              res.end('416 Range Not Satisfiable');
              return;
            }
            start = Math.max(0, fileSize - suffix);
            end = fileSize - 1;
          } else if (rangeMatch[1] !== '' && rangeMatch[2] === '') {
            start = Number(rangeMatch[1]);
            end = fileSize - 1;
          } else if (rangeMatch[1] !== '' && rangeMatch[2] !== '') {
            start = Number(rangeMatch[1]);
            end = Number(rangeMatch[2]);
          } else {
            res.writeHead(416, { 'Content-Range': `bytes */${fileSize}`, 'Content-Type': 'text/plain' });
            res.end('416 Range Not Satisfiable');
            return;
          }

          if (isNaN(start) || isNaN(end) || start < 0 || start > end || start >= fileSize || end >= fileSize) {
            res.writeHead(416, {
              'Content-Range': `bytes */${fileSize}`,
              'Content-Type': 'text/plain'
            });
            res.end('416 Range Not Satisfiable');
            return;
          }

          const chunkLength = end - start + 1;
          res.writeHead(206, {
            ...baseHeaders,
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': chunkLength
          });
          if (method === 'HEAD') {
            readContext.release();
            res.end();
            return;
          }
          streamRange(start, end).pipe(res);
          return;
        } catch (err) {
          readContext.release();
          throw err;
        }
      }

      // --- Native Annotations ---
      match = /^\/canvas\/native\/attachments\/([0-9a-f-]+)\/annotations$/.exec(pathname);
      if (match && method === 'GET') {
        const annotations = store.listAnnotations(actor.actorKey, match[1]);
        json(res, 200, { data: annotations });
        return;
      }
      if (match && method === 'POST') {
        const body = await readJson(req);
        const ann = store.createAnnotation(actor.actorKey, match[1], body);
        json(res, 201, { data: ann }, { ETag: etag(ann.version) });
        return;
      }

      match = /^\/canvas\/native\/annotations\/([0-9a-f-]+)$/.exec(pathname);
      if (match && method === 'GET') {
        const ann = store.requireAnnotation(actor.actorKey, match[1]);
        json(res, 200, { data: ann }, { ETag: etag(ann.version) });
        return;
      }
      if (match && ['PATCH', 'DELETE'].includes(method)) {
        const version = versionFromIfMatch(req);
        if (version === null) {
          error(res, 428, 'precondition_required', 'A valid If-Match header is required');
          return;
        }
        if (method === 'DELETE') {
          store.deleteAnnotation(actor.actorKey, match[1], version);
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        const body = await readJson(req);
        const ann = store.updateAnnotation(actor.actorKey, match[1], version, body);
        json(res, 200, { data: ann }, { ETag: etag(ann.version) });
        return;
      }

      match = /^\/canvas\/native\/annotations\/([0-9a-f-]+)\/restore$/.exec(pathname);
      if (match && method === 'POST') {
        const version = versionFromIfMatch(req);
        if (version === null) {
          error(res, 428, 'precondition_required', 'A valid If-Match header is required');
          return;
        }
        const ann = store.restoreAnnotation(actor.actorKey, match[1], version);
        json(res, 200, { data: ann }, { ETag: etag(ann.version) });
        return;
      }

      if (pathname === '/canvas/inbox' && method === 'GET') {
        error(res, 410, 'feature_retired', '收件箱已于 M4 退役；未分类文献请使用文库“未分类”筛选');
        return;
      }
      if (pathname === '/canvas/inbox/scan' && method === 'POST') {
        error(res, 410, 'feature_retired', 'Altero 扫描与收件箱已于 M4 退役；文库内容请使用原始文件扫描');
        return;
      }
      if (pathname === '/canvas/inbox/entries' && method === 'POST') {
        error(res, 410, 'feature_retired', '收件箱写入已于 M4 退役');
        return;
      }
      if (pathname === '/canvas/inbox/batch-action' && method === 'POST') {
        error(res, 410, 'feature_retired', '收件箱批量操作已于 M4 退役；请使用文库主题归类接口');
        return;
      }
      if (pathname === '/canvas/imports/resolve' && method === 'POST') {
        const body = await readJson(req, MAX_IMPORT_BODY_BYTES);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new TypeError('request body must be an object');
        }
        const rawInput = string(body.input, 'input', { min: 1, max: 1024 * 1024 });
        const format = body.format !== undefined && body.format !== null
          ? string(body.format, 'format', { max: 32 })
          : undefined;
        let resolved;
        try {
          resolved = await resolveImportInput(rawInput, { format, translationServerFn });
        } catch (err) {
          // Authoritative status from the resolver (504 timeout, 502 upstream,
          // 503 unconfigured, 413 size cap, 400 syntax/unsupported input).
          const status = Number.isInteger(err.status) ? err.status : 400;
          error(res, status, err.code || 'resolve_error', `Failed to resolve input: ${err.message}`);
          return;
        }

        const duplicateCandidates = findDuplicateCandidates(store, actor.actorKey, resolved);
        json(res, 200, {
          data: {
            resolved,
            duplicateCandidates,
            parsedBy: resolved.resolvedBy || 'native_resolver'
          }
        });
        return;
      }
      if (pathname === '/canvas/imports' && method === 'POST') {
        error(res, 410, 'feature_retired', '旧版收件箱导入任务已于 M4 退役；请使用 /canvas/imports/native');
        return;
      }

      match = /^\/canvas\/imports\/([0-9a-f-]+)\/retry$/.exec(pathname);
      if (match && method === 'POST') {
        const job = store.getJob(actor.actorKey, match[1]);
        if (!job || job.jobType !== 'import_document') {
          throw new CanvasNotFoundError('Import job not found');
        }
        error(res, 410, 'feature_retired', '旧版收件箱导入任务已于 M4 退役');
        return;
      }

      match = /^\/canvas\/imports\/([0-9a-f-]+)$/.exec(pathname);
      if (match && method === 'GET') {
        const job = store.getJob(actor.actorKey, match[1]);
        if (!job || job.jobType !== 'import_document') {
          throw new CanvasNotFoundError('Import job not found');
        }
        json(res, 200, { data: job });
        return;
      }
      if (pathname === '/canvas/inbox/classify' && method === 'POST') {
        error(res, 410, 'feature_retired', '收件箱已于 M4 退役；AI 主题分类请使用 /canvas/native/documents/classify');
        return;
      }

      if (pathname === '/canvas/inbox/generate-topics' && method === 'POST') {
        error(res, 410, 'feature_retired', '收件箱已于 M4 退役；AI 主题提炼请使用 /canvas/native/classify/generate-topics');
        return;
      }

      // --- M4 文库级 AI 主题分类与提炼（不依赖收件箱） ---
      function nativeDocumentToClassificationEntry(doc) {
        return {
          id: doc.id,
          itemKey: doc.id,
          libraryType: 'native',
          libraryId: 'local',
          title: doc.title,
          creators: doc.creators || [],
          year: doc.year || null,
          abstractNote: doc.abstract || '',
          tags: [],
          attachmentKey: doc.attachments?.[0]?.id || null
        };
      }

      if (pathname === '/canvas/native/documents/classify' && method === 'POST') {
        const body = await readJson(req);
        if (body && (typeof body !== 'object' || Array.isArray(body))) {
          throw new TypeError('request body must be an object');
        }
        const workspaces = store.listWorkspaces(actor.actorKey);
        if (!workspaces.length) {
          json(res, 200, { data: { classifications: {}, message: '暂无可用的研究主题，请先创建主题' } });
          return;
        }
        let targetEntries = [];
        if (Array.isArray(body?.documentIds)) {
          if (body.documentIds.length > 200) throw new TypeError('documentIds must contain at most 200 ids');
          for (const id of body.documentIds) {
            const doc = store.getDocument(actor.actorKey, string(id, 'documentIds.id', { max: 128 }));
            if (doc) targetEntries.push(nativeDocumentToClassificationEntry(doc));
          }
        } else {
          targetEntries = store.listNativeLibraryDocuments(actor.actorKey, { limit: 50 })
            .documents.map(nativeDocumentToClassificationEntry);
        }
        if (!targetEntries.length) {
          json(res, 200, { data: { classifications: {} } });
          return;
        }
        const privateConfig = store.getAiSettings(actor.actorKey);
        if (!aiPublicConfig(privateConfig).configured) {
          error(res, 503, 'ai_not_configured', 'AI 模型尚未配置');
          return;
        }
        try {
          const data = await runAiClassification({ store, actorKey: actor.actorKey, targetEntries, workspaces, privateConfig, aiCompletion });
          json(res, 200, { data });
        } catch (aiErr) {
          error(res, aiErr?.name === 'AbortError' ? 504 : 502, 'ai_gateway_error', aiErr.message);
        }
        return;
      }

      if (pathname === '/canvas/native/classify/generate-topics' && method === 'POST') {
        const body = await readJson(req);
        if (body && (typeof body !== 'object' || Array.isArray(body))) {
          throw new TypeError('request body must be an object');
        }
        let targetEntries = [];
        if (Array.isArray(body?.documentIds)) {
          if (body.documentIds.length > 200) throw new TypeError('documentIds must contain at most 200 ids');
          for (const id of body.documentIds) {
            const doc = store.getDocument(actor.actorKey, string(id, 'documentIds.id', { max: 128 }));
            if (doc) targetEntries.push(nativeDocumentToClassificationEntry(doc));
          }
        } else {
          targetEntries = store.listNativeLibraryDocuments(actor.actorKey, { limit: 50 })
            .documents.map(nativeDocumentToClassificationEntry);
        }
        if (!targetEntries.length) {
          json(res, 200, { data: { createdWorkspaces: [], workspaces: store.listWorkspaces(actor.actorKey), classifications: {}, message: '文库中暂无可供提炼的文献' } });
          return;
        }
        const privateConfig = store.getAiSettings(actor.actorKey);
        if (!aiPublicConfig(privateConfig).configured) {
          error(res, 503, 'ai_not_configured', 'AI 模型尚未配置');
          return;
        }
        const maxTopics = typeof body?.maxTopics === 'number' ? Math.max(2, Math.min(8, Math.floor(body.maxTopics))) : 5;
        try {
          const data = await runAiTopicGeneration({ store, actorKey: actor.actorKey, targetEntries, maxTopics, privateConfig, aiCompletion });
          json(res, 200, { data });
        } catch (aiErr) {
          error(res, aiErr?.name === 'AbortError' ? 504 : 502, 'ai_gateway_error', aiErr.message);
        }
        return;
      }

      if (pathname === '/canvas/workspaces' && method === 'GET') {
        json(res, 200, { data: store.listWorkspaces(actor.actorKey) });
        return;
      }
      if (pathname === '/canvas/workspaces' && method === 'POST') {
        const body = await readJson(req);
        const resource = store.createWorkspace(actor.actorKey, {
          name: string(body.name, 'name', { min: 1, max: 200 }),
          description: body.description !== undefined ? string(body.description, 'description', { max: 5000 }) : '',
          researchQuestion: body.researchQuestion !== undefined ? string(body.researchQuestion, 'researchQuestion', { max: 2000 }) : '',
          inclusionRules: body.inclusionRules !== undefined ? string(body.inclusionRules, 'inclusionRules', { max: 5000 }) : '',
          exclusionRules: body.exclusionRules !== undefined ? string(body.exclusionRules, 'exclusionRules', { max: 5000 }) : ''
        });
        json(res, 201, { data: resource }, { ETag: etag(resource.version) });
        return;
      }

      if (pathname === '/canvas/ai/config' && method === 'GET') {
        const personal = store.getAiSettings(actor.actorKey);
        const publicCfg = aiPublicConfig(personal);
        json(res, 200, { data: {
          ...publicCfg,
          baseUrl: personal?.baseUrl || publicCfg.baseUrl || process.env.AI_BASE_URL || '',
          userConfigured: Boolean(personal),
          hasApiKey: Boolean(personal?.apiKey || process.env.AI_API_KEY)
        } });
        return;
      }
      if (pathname === '/canvas/ai/config' && method === 'POST') {
        const body = await readJson(req);
        const baseUrl = string(body.baseUrl, 'baseUrl', { min: 1, max: 2048 }).trim();
        const model = string(body.model, 'model', { min: 1, max: 200 }).trim();
        const validatedEndpoint = await aiEndpointValidator(baseUrl, {
          allowPrivate: process.env.ALLOW_PRIVATE_AI_HOSTS === 'true',
          allowInsecure: process.env.ALLOW_INSECURE_AI === 'true'
        });
        const previous = store.getAiSettings(actor.actorKey) || {};
        const apiKey = body.apiKey === undefined
          ? String(previous.apiKey || '')
          : string(body.apiKey, 'apiKey', { max: 4096 });
        const personal = { baseUrl: validatedEndpoint, model, apiKey };
        store.saveAiSettings(actor.actorKey, personal);
        json(res, 200, { data: {
          ...aiPublicConfig(personal), baseUrl: validatedEndpoint, userConfigured: true, hasApiKey: Boolean(apiKey)
        } });
        return;
      }
      if (pathname === '/canvas/ai/config' && method === 'DELETE') {
        store.clearAiSettings(actor.actorKey);
        json(res, 200, { data: {
          ...aiPublicConfig(), baseUrl: '', userConfigured: false, hasApiKey: false
        } });
        return;
      }
      if (pathname === '/canvas/ai/test' && method === 'POST') {
        const privateConfig = store.getAiSettings(actor.actorKey);
        const publicConfig = aiPublicConfig(privateConfig);
        if (!publicConfig.configured) {
          error(res, 503, 'ai_not_configured', 'AI 模型尚未在服务器端配置');
          return;
        }
        try {
          await aiCompletion({
            messages: [{ role: 'user', content: 'Reply with OK.' }],
            temperature: 0,
            maxTokens: 5,
          }, privateConfig);
          json(res, 200, { data: { ok: true, ...publicConfig } });
        } catch (aiError) {
          error(res, 502, 'ai_gateway_error', aiError.message);
        }
        return;
      }

      if (pathname === '/canvas/ai/translate' && method === 'POST') {
        const body = await readJson(req);
        const textToTranslate = string(body.text, 'text', { min: 1, max: 20_000 });
        const privateConfig = store.getAiSettings(actor.actorKey);
        const publicConfig = aiPublicConfig(privateConfig);
        if (!publicConfig.configured) {
          error(res, 503, 'ai_not_configured', 'AI 模型尚未配置');
          return;
        }
        try {
          const translation = await aiCompletion({
            messages: [
              { role: 'system', content: '你是严谨的学术翻译助手。将用户提供的原文完整、忠实地翻译为简体中文；保留术语、数字和逻辑，不概括、不评论，只输出译文。' },
              { role: 'user', content: textToTranslate }
            ],
            temperature: 0.1
          }, privateConfig);
          json(res, 200, { data: { translation: String(translation).trim() } });
        } catch (aiError) {
          error(res, aiError?.name === 'AbortError' ? 504 : 502, 'ai_gateway_error', aiError.message);
        }
        return;
      }

      if (pathname === '/canvas/documents/metadata' && method === 'GET') {
        const libType = url.searchParams.get('libraryType') || 'user';
        const libId = url.searchParams.get('libraryId') || actor.session.userId;
        const targetLib = validateLibraryAccess(libType, libId, actor.session);
        const itemKey = url.searchParams.get('itemKey');
        if (itemKey) {
          const validatedItemKey = key(itemKey, 'itemKey', false);
          const meta = store.getDocumentMeta(actor.actorKey, {
            libraryType: targetLib.libraryType,
            libraryId: targetLib.libraryId,
            itemKey: validatedItemKey
          });
          json(res, 200, { data: meta });
          return;
        }
        const metas = store.listDocumentMetas(actor.actorKey, {
          libraryType: targetLib.libraryType,
          libraryId: targetLib.libraryId
        });
        json(res, 200, { data: metas });
        return;
      }

      if (pathname === '/canvas/documents/metadata' && method === 'PATCH') {
        const body = await readJson(req);
        const libType = body?.libraryType !== undefined ? string(body.libraryType, 'libraryType') : 'user';
        const libId = body?.libraryId !== undefined ? string(body.libraryId, 'libraryId', { max: 128 }) : actor.session.userId;
        const targetLib = validateLibraryAccess(libType, libId, actor.session);
        const itemKey = key(body.itemKey, 'itemKey', false);
        const existing = store.getDocumentMeta(actor.actorKey, {
          libraryType: targetLib.libraryType,
          libraryId: targetLib.libraryId,
          itemKey
        });

        const cleanTitle = body.cleanTitle !== undefined
          ? string(body.cleanTitle, 'cleanTitle', { min: 1, max: 500 }).trim()
          : (existing?.cleanTitle || '');
        if (!cleanTitle) throw new TypeError('cleanTitle is required');

        const institution = body.institution !== undefined
          ? string(body.institution, 'institution', { max: 200 }).trim()
          : (existing?.institution || '');
        const reportTitle = body.reportTitle !== undefined
          ? string(body.reportTitle, 'reportTitle', { max: 300 }).trim()
          : (existing?.reportTitle || '');
        const subtitle = body.subtitle !== undefined
          ? string(body.subtitle, 'subtitle', { max: 300 }).trim()
          : (existing?.subtitle || '');
        const year = body.year !== undefined
          ? string(body.year, 'year', { max: 50 }).trim()
          : (existing?.year || '');
        const summary = body.summary !== undefined
          ? string(body.summary, 'summary', { max: 5000 }).trim()
          : (existing?.summary || '');
        const attachmentKey = body.attachmentKey !== undefined
          ? key(body.attachmentKey, 'attachmentKey', true)
          : (existing?.attachmentKey || null);
        const attachmentVersion = body.attachmentVersion !== undefined
          ? (body.attachmentVersion === null ? null : number(body.attachmentVersion, 'attachmentVersion', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }))
          : (existing?.attachmentVersion ?? null);

        const meta = store.saveDocumentMeta(actor.actorKey, {
          libraryType: targetLib.libraryType,
          libraryId: targetLib.libraryId,
          itemKey,
          attachmentKey,
          attachmentVersion,
          cleanTitle,
          institution,
          reportTitle,
          subtitle,
          year,
          summary,
          source: 'manual'
        });
        json(res, 200, { data: meta });
        return;
      }

      if (pathname === '/canvas/documents/extract-metadata' && method === 'POST') {
        const body = await readJson(req, MAX_DOCUMENT_BODY_BYTES);
        const libType = body?.libraryType !== undefined ? string(body.libraryType, 'libraryType') : 'user';
        const libId = body?.libraryId !== undefined ? string(body.libraryId, 'libraryId', { max: 128 }) : actor.session.userId;
        const targetLib = validateLibraryAccess(libType, libId, actor.session);
        const itemKey = key(body.itemKey, 'itemKey', false);
        const attachmentKey = body?.attachmentKey !== undefined ? key(body.attachmentKey, 'attachmentKey', true) : null;
        const attachmentVersion = body?.attachmentVersion !== undefined
          ? (body.attachmentVersion === null ? null : number(body.attachmentVersion, 'attachmentVersion', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }))
          : null;
        const filename = body.filename !== undefined ? string(body.filename, 'filename', { max: 500 }) : '';
        const rawTitle = body.rawTitle !== undefined ? string(body.rawTitle, 'rawTitle', { max: 500 }) : '';
        const textSnippet = body.textSnippet !== undefined ? string(body.textSnippet, 'textSnippet', { max: 50_000 }) : '';
        const forceRefresh = Boolean(body.forceRefresh);

        if (!forceRefresh) {
          const cached = store.getDocumentMeta(actor.actorKey, {
            libraryType: targetLib.libraryType,
            libraryId: targetLib.libraryId,
            itemKey
          });
          if (cached) {
            const attachmentMatches = (!attachmentKey && !cached.attachmentKey) || (attachmentKey && cached.attachmentKey === attachmentKey);
            const cachedVer = cached.attachmentVersion ?? null;
            const targetVer = attachmentVersion ?? null;
            const versionMatches = (cachedVer === null && targetVer === null) || (cachedVer !== null && targetVer !== null && cachedVer === targetVer);
            if (attachmentMatches && versionMatches) {
              json(res, 200, { data: cached, cached: true });
              return;
            }
          }
        }

        const privateConfig = store.getAiSettings(actor.actorKey);
        const publicConfig = aiPublicConfig(privateConfig);
        if (!publicConfig.configured) {
          error(res, 503, 'ai_not_configured', 'AI 模型尚未配置');
          return;
        }

        const prompt = `你是专业的投研与研报文献分析助手。请分析以下报告文本（前1-2页摘要/封面/导言）和文件名，提取并输出规范易读的中文研报元数据。

要求：
1. 机构来源 (institution)：提取发布机构（如中金公司、华泰证券、麦肯锡、高盛、清华大学等；无法确认则写"未知机构"或作者）。
2. 报告主标题 (reportTitle)：提取核心中文研报主标题。如果原标题是无意义文件名或含糊名称（如"周报"、"专题研究"），请根据正文提取精炼准确的业务研报名称。
3. 副标题 (subtitle)：若有细分方向或具体副标题则提取，否则留空字符串 ""。
4. 年份 (year)：提取发布年份（如 2024；无法确认则留空字符串 ""）。
5. 规范中文标题 (cleanTitle)：组合成【机构】主标题：副标题 (年份) 格式。例如：【中金公司】人形机器人产业链深度：从核心零部件到整机制造（2024）。
6. 一句话摘要 (summary)：用一句话概括本篇报告的核心结论或论述主题（50-100字）。

必须严格返回合法 JSON 对象，格式如下：
{
  "institution": "机构名",
  "reportTitle": "报告主标题",
  "subtitle": "副标题",
  "year": "2024",
  "cleanTitle": "【机构名】报告主标题：副标题（2024）",
  "summary": "一句话核心结论"
}

参考输入：
文件名：${filename || '无'}
原始标题：${rawTitle || '无'}
文档前序文本：
${textSnippet.slice(0, 8000) || '无'}`;

        try {
          const rawAi = await aiCompletion({
            messages: [
              { role: 'system', content: '你是严谨专业的研报元数据结构化提取助手，必须仅返回合法 JSON。' },
              { role: 'user', content: prompt }
            ],
            temperature: 0.1,
            maxTokens: 1000
          }, privateConfig);

          let parsed;
          try {
            parsed = parseAiJson(rawAi);
          } catch {
            parsed = null;
          }

          const institution = (parsed?.institution && typeof parsed.institution === 'string') ? parsed.institution.trim() : '';
          const reportTitle = (parsed?.reportTitle && typeof parsed.reportTitle === 'string') ? parsed.reportTitle.trim() : (rawTitle || filename || '研究报告');
          const subtitle = (parsed?.subtitle && typeof parsed.subtitle === 'string') ? parsed.subtitle.trim() : '';
          const year = (parsed?.year && typeof parsed.year === 'string') ? parsed.year.trim() : '';
          let cleanTitle = (parsed?.cleanTitle && typeof parsed.cleanTitle === 'string') ? parsed.cleanTitle.trim() : '';
          if (!cleanTitle) {
            const instPrefix = institution ? `【${institution}】` : '';
            const subSuffix = subtitle ? `：${subtitle}` : '';
            const yearSuffix = year ? `（${year}）` : '';
            cleanTitle = `${instPrefix}${reportTitle}${subSuffix}${yearSuffix}`;
          }
          const summary = (parsed?.summary && typeof parsed.summary === 'string') ? parsed.summary.trim() : '';

          const saved = store.saveDocumentMeta(actor.actorKey, {
            libraryType: targetLib.libraryType,
            libraryId: targetLib.libraryId,
            itemKey,
            attachmentKey,
            attachmentVersion,
            cleanTitle,
            institution,
            reportTitle,
            subtitle,
            year,
            summary,
            source: 'ai'
          });

          json(res, 200, { data: saved, cached: false });
        } catch (aiError) {
          error(res, aiError?.name === 'AbortError' ? 504 : 502, 'ai_gateway_error', aiError.message);
        }
        return;
      }

      match = /^\/canvas\/boards\/([0-9a-f-]+)\/ai\/document-map$/.exec(pathname);
      if (match && method === 'POST') {
        const boardId = match[1];
        const body = await readJson(req, MAX_DOCUMENT_BODY_BYTES);
        store.requireBoard(actor.actorKey, boardId);
        const documentSource = source(body.document, actor.session);
        if (!documentSource?.attachmentKey || !documentSource?.itemKey) {
          throw new TypeError('document itemKey and attachmentKey are required');
        }
        const title = string(body.title || 'PDF 全文理解', 'title', { min: 1, max: 500 });
        const attachmentVersion = documentSource.attachmentVersion ?? documentSource.annotationVersion ?? (Number.isFinite(body.attachmentVersion) ? body.attachmentVersion : null);

        const privateConfig = store.getAiSettings(actor.actorKey);
        const publicConfig = aiPublicConfig(privateConfig);
        if (!publicConfig.configured) {
          error(res, 503, 'ai_not_configured', 'AI 模型尚未配置');
          return;
        }

        const promptVersion = 'altcanvas-document-map-v2';
        const cachedAnalysis = store.getDocumentAnalysis(actor.actorKey, {
          libraryType: documentSource.libraryType,
          libraryId: documentSource.libraryId,
          attachmentKey: documentSource.attachmentKey,
          attachmentVersion,
          model: publicConfig.model,
          promptVersion
        });

        const focalSourceRefs = new Set(
          store.db.prepare(`
            SELECT id FROM source_refs
            WHERE owner_key = ? AND library_type = ? AND library_id = ? AND item_key = ?
              AND (? IS NULL OR attachment_key = ?)
          `).all(actor.actorKey, documentSource.libraryType, String(documentSource.libraryId), documentSource.itemKey,
                 documentSource.attachmentKey || null, documentSource.attachmentKey || null).map(r => r.id)
        );

        const currentSnapshot = store.snapshot(actor.actorKey, boardId);
        const existingNodes = (currentSnapshot.nodes || [])
          .filter(n => !focalSourceRefs.has(n.sourceRefId))
          .map(n => ({
            id: n.id,
            type: n.type,
            title: n.title,
            body: (n.body || '').slice(0, 300)
          }));
        const existingNodeIds = existingNodes.map(n => n.id);

        if (body.checkOnly) {
          const alreadyOnBoard = store.hasDocumentOnBoard(actor.actorKey, boardId, documentSource);
          json(res, 200, { data: { cached: Boolean(cachedAnalysis && cachedAnalysis.status === 'ready' && cachedAnalysis.graph), alreadyOnBoard } });
          return;
        }

        let baseGraph = null;
        let pageCount = 1;
        let isCached = false;

        if (cachedAnalysis && cachedAnalysis.status === 'ready' && cachedAnalysis.graph) {
          baseGraph = cachedAnalysis.graph;
          pageCount = cachedAnalysis.pageCount || body.pages?.length || 1;
          isCached = true;
        } else {
          if (!Array.isArray(body.pages) || body.pages.length < 1 || body.pages.length > 500) {
            throw new TypeError('pages must contain between 1 and 500 PDF pages');
          }
          let textChars = 0;
          const pages = body.pages.map((item, index) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('page is invalid');
            const pageNumber = number(item.pageNumber, 'page.pageNumber', { min: 1, max: 5000, integer: true });
            const pageText = string(item.text || '', 'page.text', { max: 80_000 });
            textChars += pageText.length;
            return { pageNumber, text: pageText, index };
          }).filter(item => item.text);
          if (!pages.length) throw new TypeError('PDF 没有可提取的文本');
          if (textChars > MAX_DOCUMENT_TEXT_CHARS) {
            const limitError = new Error(`PDF 可提取文本超过当前全文分析上限（${MAX_DOCUMENT_TEXT_CHARS} 字符）`);
            limitError.status = 413;
            throw limitError;
          }

          try {
            const chunks = documentChunks(pages);
            const chunkSummaries = await mapWithConcurrency(chunks, 3, (chunk, index) => aiCompletion({
              messages: [
                { role: 'system', content: [
                  '你是学术论文阅读助手。完整阅读所给页段并做结构化中间笔记。',
                  '保留章节结构、关键概念定义、主要论点、方法、数据/证据、结论、限制，以及准确页码。',
                  '每项重要发现都附带一段来自所给正文的逐字原文短引用（不要改写）及其页码，供后续核验。',
                  '不要写泛泛评价，不要遗漏相互矛盾或限定性的内容。这是内部合成材料。'
                ].join('\n') },
                { role: 'user', content: `文档《${title}》第 ${index + 1}/${chunks.length} 个页段：\n\n${chunk}` }
              ],
              temperature: 0.2
            }, privateConfig));

            // Stage 1: Pure document synthesis (topic-agnostic base graph)
            const synthesis = await aiCompletion({
              messages: [
                { role: 'system', content: [
                  '你要把一篇 PDF 的逐段阅读笔记组织成帮助读者快速理解全文的空间画板。',
                  '只输出一个 JSON 对象，不要 Markdown 代码围栏。内容必须使用简体中文。',
                  'JSON schema:',
                  '{"title":"...","overview":"完整全文概览","evidenceQuote":"逐字原文","evidencePage":1,',
                  '"sections":[{"title":"...","body":"章节作用和内容","pageStart":1,"pageEnd":3,"evidenceQuote":"逐字原文","evidencePage":2}],',
                  '"concepts":[{"title":"...","body":"定义、意义与上下文","pageStart":2,"pageEnd":2,"evidenceQuote":"逐字原文","evidencePage":2}],',
                  '"claims":[{"title":"...","body":"论点及证据/方法/限制","pageStart":4,"pageEnd":6,"evidenceQuote":"逐字原文","evidencePage":5}],',
                  '"relations":[{"from":"section-0","to":"concept-0","relation":"supports","label":"使用"}]}',
                  '节点 ID 必须严格使用数组下标形成 section-N、concept-N、claim-N，或 overview。',
                  'relation 只能是 related/supports/contradicts/causes/cites/extends/same_method/context_differs/custom。',
                  '生成 3–10 个 sections、3–10 个 concepts、3–10 个 claims；页码必须来自笔记。',
                  'overview 必须按“研究问题 / 方法 / 核心发现 / 贡献 / 限制”五项组织，能独立帮助读者理解全文。',
                  '每个 section.body 必须说明本节作用、关键内容及其在全文论证中的位置。',
                  '每个 concept.body 必须给出文中定义、作用和使用语境，不能只写名词解释。',
                  '每个 claim.body 必须同时写清论点、对应证据或方法、适用条件/限制。',
                  '每张卡片只覆盖其 pageStart–pageEnd 页内有依据的内容；不要把全文页码填给局部卡片。',
                  '每个 evidenceQuote 必须逐字复制自对应 evidencePage 的原文，不得翻译、改写或自行补全。'
                ].join('\n') },
                { role: 'user', content: `文档标题：${title}\n总页数：${body.pages.length}\n\n${chunkSummaries.map((summary, index) => `【页段 ${index + 1}】\n${summary}`).join('\n\n')}` }
              ],
              temperature: 0.25
            }, privateConfig);

            baseGraph = normalizeDocumentGraph(parseAiJson(synthesis), buildEvidenceIndex(pages), body.pages.length, title);
            pageCount = body.pages.length;

            // Cache pure base graph into document_analyses
            store.saveDocumentAnalysis(actor.actorKey, {
              libraryType: documentSource.libraryType,
              libraryId: documentSource.libraryId,
              itemKey: documentSource.itemKey,
              attachmentKey: documentSource.attachmentKey,
              attachmentVersion: documentSource.attachmentVersion || null,
              model: publicConfig.model,
              promptVersion,
              status: 'ready',
              documentTitle: documentSource.title || title || baseGraph.title || '',
              pageCount,
              graph: baseGraph
            });
          } catch (aiError) {
            error(res, aiError?.name === 'AbortError' ? 504 : 502, 'ai_gateway_error', aiError.message);
            return;
          }
        }

        // Stage 2: Board-Specific Relation Synthesis (runs for both fresh analysis and cache hit)
        let boardRelations = [];
        if (existingNodes.length > 0) {
          try {
            const cardsBrief = [
              ...(baseGraph.sections || []).map(s => `[${s.id}] (章节) ${s.title}: ${s.body.slice(0, 100)}`),
              ...(baseGraph.concepts || []).map(c => `[${c.id}] (概念) ${c.title}: ${c.body.slice(0, 100)}`),
              ...(baseGraph.claims || []).map(cl => `[${cl.id}] (论点) ${cl.title}: ${cl.body.slice(0, 100)}`)
            ].join('\n');

            const boardContextText = existingNodes.map(n => `- [${n.id}] (${n.type}) ${n.title}: ${n.body}`).join('\n');

            const boardRelationAiRes = await aiCompletion({
              messages: [
                { role: 'system', content: [
                  '你是学术研究助手，负责在新文献卡片与当前画板已有卡片之间发现关键学术关联。',
                  '只输出一个 JSON 数组，不要 Markdown 代码围栏。若无明显关联返回 []。',
                  '格式：[{"from":"section-0","to":"existing:<已有卡片ID>","relation":"supports|contradicts|extends|same_method|context_differs|related","label":"简短标签"}]',
                  'from 必须是新文献卡片 ID（overview/section-N/concept-N/claim-N），to 必须是 existing:<已有卡片ID>。',
                  'relation 必须是 related/supports/contradicts/causes/cites/extends/same_method/context_differs/custom。'
                ].join('\n') },
                { role: 'user', content: `新文献《${title}》概览：${baseGraph.overview}\n\n新文献卡片：\n${cardsBrief}\n\n当前画板已有卡片：\n${boardContextText}` }
              ],
              temperature: 0.2
            }, privateConfig);

            const parsedBoardRelations = parseAiJsonArray(boardRelationAiRes);
            const validExistingSet = new Set(existingNodeIds);
            const validNewIds = new Set(['overview', ...(baseGraph.sections || []).map(s => s.id), ...(baseGraph.concepts || []).map(c => c.id), ...(baseGraph.claims || []).map(cl => cl.id)]);
            boardRelations = parsedBoardRelations.slice(0, 30).flatMap(item => {
              const from = String(item?.from || '');
              const to = String(item?.to || '');
              const normTo = to.startsWith('existing:') ? to : (validExistingSet.has(to) ? `existing:${to}` : null);
              if (!validNewIds.has(from) || !normTo) return [];
              const rawToId = normTo.slice('existing:'.length);
              if (!validExistingSet.has(rawToId)) return [];
              const relation = canvasEdgeRelations.has(item?.relation) ? item.relation : 'related';
              return [{ from, to: normTo, relation, label: string(item?.label || '', 'boardRelation.label', { max: 120 }) }];
            });
          } catch (boardAiErr) {
            // Gracefully ignore board relation inference error; base graph still projects cleanly
          }
        }

        const finalGraph = {
          ...baseGraph,
          relations: [...(baseGraph.relations || []), ...boardRelations]
        };

        const result = store.projectDocumentAnalysisToBoard(actor.actorKey, boardId, {
          model: publicConfig.model,
          promptVersion,
          document: { ...documentSource, title, pageCount },
          graph: finalGraph,
          cached: isCached
        });

        json(res, 201, { data: { ...result, cached: isCached } });
        return;
      }

      match = /^\/canvas\/workspaces\/([0-9a-f-]+)\/related-knowledge$/.exec(pathname);
      if (match && method === 'POST') {
        const workspaceId = match[1];
        store.requireWorkspace(actor.actorKey, workspaceId);
        const body = await readJson(req);
        const focalText = body.focalText ? string(body.focalText, 'focalText', { max: 10_000 }) : '';
        let focalFocal = null;
        if (body.focalDocument) {
          const focalSource = source(body.focalDocument, actor.session);
          if (focalSource) {
            focalFocal = {
              libraryType: focalSource.libraryType,
              libraryId: String(focalSource.libraryId),
              itemKey: focalSource.itemKey
            };
          }
        } else if (body.focalItemKey) {
          focalFocal = {
            libraryType: body.libraryType || 'user',
            libraryId: String(body.libraryId || actor.session.userId),
            itemKey: body.focalItemKey
          };
        }

        let focalUnit = null;
        if (body.focalUnitId) {
          const unitIdStr = string(body.focalUnitId, 'focalUnitId', { max: 128 });
          const activeTopicUnits = store.listTopicKnowledgeUnits(actor.actorKey, workspaceId);
          focalUnit = activeTopicUnits.find(u => u.id === unitIdStr);
          if (!focalUnit) {
            throw new TypeError('focalUnitId not found in active topic knowledge units');
          }
          if (focalFocal) {
            if (focalUnit.libraryType !== focalFocal.libraryType || String(focalUnit.libraryId) !== String(focalFocal.libraryId) || focalUnit.itemKey !== focalFocal.itemKey) {
              throw new TypeError('focalUnitId does not match focalDocument');
            }
          } else {
            focalFocal = { libraryType: focalUnit.libraryType, libraryId: String(focalUnit.libraryId), itemKey: focalUnit.itemKey };
          }
        }

        const focalTriple = focalFocal ? `${focalFocal.libraryType}:${focalFocal.libraryId}:${focalFocal.itemKey}` : null;
        const requestedLimit = body.limit !== undefined ? number(body.limit, 'limit', { min: 1, max: 20, integer: true }) : 5;

        // Fetch candidate knowledge units from other documents in this topic
        const candidates = store.listTopicKnowledgeUnits(actor.actorKey, workspaceId, { excludeFocal: focalFocal });
        if (!candidates.length || !focalText) {
          json(res, 200, { data: { relations: [] } });
          return;
        }

        const privateConfig = store.getAiSettings(actor.actorKey);
        const publicConfig = aiPublicConfig(privateConfig);

        if (!publicConfig.configured) {
          // Rule-based keyword matching fallback when AI is not configured
          const keywords = focalText.toLowerCase().split(/[\s,，.。；;、]+/).filter(w => w.length >= 2).slice(0, 10);
          const matched = candidates.filter(u => {
            const text = `${u.title} ${u.body} ${u.evidenceQuote}`.toLowerCase();
            return keywords.some(kw => text.includes(kw));
          }).slice(0, requestedLimit);

          json(res, 200, {
            data: {
              relations: matched.map(unit => ({
                unit,
                relationType: 'related',
                confidence: 0.6,
                reason: '关键词语义关联'
              }))
            }
          });
          return;
        }

        try {
          const systemPrompt = [
            '你是一位严谨的学术研报跨文档关联分析专家。',
            '你的任务是在给定的焦点观点/论点与同主题下的其他研报知识单元之间，评估是否存在跨报告关联。',
            '只输出一个 JSON 对象，不要 Markdown 代码块。',
            'JSON schema:',
            '{"relations": [',
            '  {"unitId": "...", "relationType": "supports", "confidence": 0.88, "reason": "支撑论点：相同实证发现"}',
            ']}',
            '【关系类型】',
            '- supports: 外部报告提供了支撑、相同结论或一致实证证据；',
            '- contradicts: 外部报告提出了冲突、反驳、相反发现或质疑；',
            '- extends: 外部报告提供了补充视角、深化拓展或延伸讨论；',
            '- same_method: 外部报告采用了相似的研究方法或模型架构；',
            '- context_differs: 结论在不同情境、样本或边界条件下存在差异；',
            '- related: 一般性主题相关。',
            '【严格准则】',
            '1. 必须客观严谨，无明确关联则不推荐；',
            '2. confidence 为 0.0 到 1.0 之间的浮点数；',
            '3. reason 简要说明跨报告关联的核心理由（30字以内）。'
          ].join('\n');

          const candidateList = candidates.slice(0, 20).map((u, idx) => `[候选单元 ${idx + 1}] ID: ${u.id}\n来源研报: 《${u.documentTitle}》 (Doc #${u.itemKey}, p.${u.pageStart}-${u.pageEnd})\n标题/类别: [${u.type}] ${u.title}\n内容: ${u.body}\n原文证据: ${u.evidenceQuote || '无'}`).join('\n\n');
          const userMessage = `【焦点观点/论点】\n${focalText}\n\n【其他研报候选知识单元】\n${candidateList}`;

          const aiRes = await aiCompletion({
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage }
            ],
            temperature: 0.2
          }, privateConfig);

          let parsed = parseAiJson(aiRes);
          if (!parsed || typeof parsed !== 'object') parsed = { relations: [] };
          const rawRelations = Array.isArray(parsed.relations) ? parsed.relations : [];

          const relations = [];
          for (const rel of rawRelations) {
            let unit = candidates.find(u => u.id === rel.unitId);
            if (!unit && rel.unitId) {
              const idxMatch = /^(?:\[?候选单元\s*|candidate[-_\s]*|unit-target[-_\s]*)([1-9][0-9]*)\]?$/i.exec(String(rel.unitId || '').trim());
              if (idxMatch) {
                const idx = Number(idxMatch[1]) - 1;
                if (idx >= 0 && idx < candidates.length) unit = candidates[idx];
              }
            }
            if (!unit) continue;

            const targetTriple = `${unit.libraryType}:${unit.libraryId}:${unit.itemKey}`;
            if (focalTriple && targetTriple === focalTriple) {
              continue; // Exclude units from the same document
            }

            const relationType = ['supports', 'contradicts', 'extends', 'same_method', 'context_differs', 'related'].includes(rel.relationType)
              ? rel.relationType : 'related';
            const confidence = typeof rel.confidence === 'number' ? Math.max(0, Math.min(1, rel.confidence)) : 0.6;
            const reason = string(rel.reason || '关联观点', 'reason', { max: 200 });

            // Store discovered knowledge relation with verified focal unit ownership, topic membership, and cross-report constraint
            if (body.focalUnitId) {
              try {
                const focalUnit = store.getKnowledgeUnit(actor.actorKey, string(body.focalUnitId, 'focalUnitId', { max: 128 }));
                if (focalUnit) {
                  const topicDocs = store.listTopicDocuments(actor.actorKey, workspaceId);
                  const allowedTriples = new Set(topicDocs.map(d => `${d.libraryType}:${d.libraryId}:${d.itemKey}`));
                  const focalTriple = `${focalUnit.libraryType}:${focalUnit.libraryId}:${focalUnit.itemKey}`;

                  // Verify focalUnit matches focalDocument (if provided), belongs to topic, and is strictly cross-report (different document)
                  const matchesFocalDoc = !focalFocal || (focalUnit.libraryType === focalFocal.libraryType && focalUnit.libraryId === focalFocal.libraryId && focalUnit.itemKey === focalFocal.itemKey);
                  if (matchesFocalDoc && allowedTriples.has(focalTriple) && allowedTriples.has(targetTriple) && focalTriple !== targetTriple) {
                    store.saveKnowledgeRelation(actor.actorKey, {
                      sourceUnitId: focalUnit.id,
                      targetUnitId: unit.id,
                      relationType,
                      confidence,
                      reason
                    });
                  }
                }
              } catch {}
            }

            relations.push({
              unit,
              relationType,
              confidence,
              reason
            });
            if (relations.length >= requestedLimit) break;
          }

          json(res, 200, { data: { relations } });
        } catch (aiErr) {
          error(res, aiErr?.name === 'AbortError' ? 504 : 502, 'ai_gateway_error', aiErr.message);
        }
        return;
      }

      match = /^\/canvas\/boards\/([0-9a-f-]+)\/expand-related$/.exec(pathname);
      if (match && method === 'POST') {
        const boardId = match[1];
        const board = store.requireBoard(actor.actorKey, boardId);
        const body = await readJson(req);
        const focalNodeId = string(body.focalNodeId, 'focalNodeId');
        const focalNode = store.getNode(actor.actorKey, focalNodeId);
        if (!focalNode || focalNode.boardId !== boardId) {
          throw new TypeError('focal node not found on this board');
        }

        const relatedUnitsInput = Array.isArray(body.relatedUnits) ? body.relatedUnits.slice(0, 6) : [];
        if (!relatedUnitsInput.length) {
          json(res, 200, { data: { createdNodes: [], createdEdges: [] } });
          return;
        }

        // Validate that requested units exist in DB, are owned by user, and belong to this topic workspace
        const topicDocs = store.listTopicDocuments(actor.actorKey, board.workspaceId);
        const allowedTriples = new Set(topicDocs.map(d => `${d.libraryType}:${d.libraryId}:${d.itemKey}`));

        const timestamp = new Date().toISOString();
        const createdNodes = [];
        const createdEdges = [];

        store.transaction(() => {
          const startX = focalNode.x + focalNode.width + 60;
          let startY = focalNode.y;
          const cardWidth = 360;

          for (const item of relatedUnitsInput) {
            const rawUnitId = item.unitId || item.unit?.id;
            if (!rawUnitId) continue;
            const unitId = key(rawUnitId, 'relatedUnit.unitId', false);
            const u = store.getKnowledgeUnit(actor.actorKey, unitId);
            if (!u) continue; // Skip non-existent units

            // Verify library triple belongs to the current workspace
            const triple = `${u.libraryType}:${u.libraryId}:${u.itemKey}`;
            if (!allowedTriples.has(triple)) continue;

            const relationType = ['supports', 'contradicts', 'extends', 'same_method', 'context_differs', 'related'].includes(item.relationType)
              ? item.relationType : 'related';
            const reason = string(item.reason || relationType, 'reason', { max: 100 });

            const evidencePageNum = u.evidencePage || u.pageStart || 1;
            const sourceRefId = store.createSourceRef(actor.actorKey, {
              libraryType: u.libraryType,
              libraryId: u.libraryId,
              itemKey: u.itemKey,
              attachmentKey: u.attachmentKey || null,
              annotationKey: null,
              annotationVersion: null,
              pageLabel: String(evidencePageNum),
              position: {
                pageIndex: Math.max(0, evidencePageNum - 1),
                pageStart: u.pageStart || 1,
                pageEnd: u.pageEnd || u.pageStart || 1,
                textQuote: u.evidenceQuote || ''
              },
              quoteSnapshot: u.evidenceQuote || null
            });

            const textLen = (u.body || '').length;
            const quoteLen = (u.evidenceQuote || '').length;
            const extraForQuote = quoteLen ? 36 + Math.ceil(quoteLen / 24) * 16 : 0;
            const height = Math.min(420, Math.max(88, 76 + extraForQuote + Math.ceil(textLen / 24) * 18));
            const nodeId = crypto.randomUUID();

            const relationColors = {
              supports: '#10b981',
              contradicts: '#f43f5e',
              extends: '#3b82f6',
              same_method: '#8b5cf6',
              context_differs: '#f59e0b',
              related: '#6366f1'
            };

            const relationBadge = {
              supports: '支持论点',
              contradicts: '质疑/冲突',
              extends: '补充视角',
              same_method: '同类方法',
              context_differs: '情境差异',
              related: '相关观点'
            }[relationType] || '关联观点';

            store.db.prepare(`
              INSERT INTO nodes
                (id, board_id, node_type, x, y, width, height, z_index, title, body, color, source_ref_id, created_at, updated_at)
              VALUES (?, ?, 'ai_output', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              nodeId, boardId, startX, startY, cardWidth, height, focalNode.zIndex + 1,
              `[${relationBadge}] ${u.title || u.type} · 《${u.documentTitle || u.itemKey}》`,
              u.body, relationColors[relationType], sourceRefId, timestamp, timestamp
            );

            const edgeId = crypto.randomUUID();
            store.db.prepare(`
              INSERT INTO edges
                (id, board_id, source_node_id, target_node_id, relation, label, origin, projection_key, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 't3_expand', ?, ?, ?)
            `).run(edgeId, boardId, focalNode.id, nodeId, relationType, reason, `t3:${focalNode.id}`, timestamp, timestamp);

            createdNodes.push(store.getNode(actor.actorKey, nodeId));
            createdEdges.push(store.getEdge(actor.actorKey, edgeId));

            startY += height + 30;
          }

            store.recordEvent({
              workspaceId: board.workspaceId,
              boardId,
              nodeId: focalNode.id,
              actorKey: actor.actorKey,
              type: 'board.expanded_related',
              payload: {
                focalNodeId,
                nodeIds: createdNodes.map(n => n.id),
                count: createdNodes.length
              }
            });
          });

          json(res, 201, { data: { createdNodes, createdEdges } });
          return;
        }

        match = /^\/canvas\/boards\/([0-9a-f-]+)\/collapse-related$/.exec(pathname);
        if (match && method === 'POST') {
          const boardId = match[1];
          const board = store.requireBoard(actor.actorKey, boardId);
          const body = await readJson(req);
          const focalNodeId = string(body.focalNodeId, 'focalNodeId');
          const focalNode = store.getNode(actor.actorKey, focalNodeId);
          if (!focalNode || focalNode.boardId !== boardId) {
            throw new TypeError('valid focalNodeId is required on this board');
          }

          const requestedNodeIds = Array.isArray(body.nodeIds) ? body.nodeIds.map(String) : [];
          if (!requestedNodeIds.length) {
            json(res, 200, { data: { collapsedCount: 0 } });
            return;
          }

          // Query provenance events to strictly verify which nodes were expanded by /expand-related from this focalNode
          const expandEvents = store.db.prepare(`
            SELECT payload_json FROM provenance_events
            WHERE board_id = ? AND actor_key = ? AND event_type = 'board.expanded_related'
          `).all(boardId, actor.actorKey);
          const provenExpandedNodeIds = new Set();
          for (const ev of expandEvents) {
            let payload = null;
            try { payload = JSON.parse(ev.payload_json); } catch {}
            if (payload?.focalNodeId === focalNodeId && Array.isArray(payload.nodeIds)) {
              payload.nodeIds.forEach(id => provenExpandedNodeIds.add(id));
            }
          }

          const safeNodeIdsToDelete = requestedNodeIds.filter(nid => {
            if (!provenExpandedNodeIds.has(nid)) return false;
            const node = store.getNode(actor.actorKey, nid);
            return node && node.boardId === boardId && node.type === 'ai_output';
          });

          if (safeNodeIdsToDelete.length) {
            store.transaction(() => {
              for (const nodeId of safeNodeIdsToDelete) {
                const node = store.getNode(actor.actorKey, nodeId);
                if (node && node.boardId === boardId) {
                  store.deleteNode(actor.actorKey, nodeId, node.version);
                }
              }
              store.recordEvent({
                workspaceId: board.workspaceId,
                boardId,
                nodeId: focalNodeId,
                actorKey: actor.actorKey,
                type: 'board.collapsed_related',
                payload: { nodeIds: safeNodeIdsToDelete }
              });
            });
          }

          json(res, 200, { data: { collapsedCount: safeNodeIdsToDelete.length } });
          return;
        }

      match = /^\/canvas\/workspaces\/([0-9a-f-]+)$/.exec(pathname);
      if (match && method === 'GET') {
        const resource = store.getWorkspace(actor.actorKey, match[1]);
        if (!resource) throw new CanvasNotFoundError();
        json(res, 200, { data: resource }, { ETag: etag(resource.version) });
        return;
      }
      if (match && ['PATCH', 'DELETE'].includes(method)) {
        const version = versionFromIfMatch(req);
        if (version === null) {
          error(res, 428, 'precondition_required', 'A valid If-Match header is required');
          return;
        }
        if (method === 'DELETE') {
          store.deleteWorkspace(actor.actorKey, match[1], version);
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        const body = await readJson(req);
        const changes = {};
        if (body.name !== undefined) changes.name = string(body.name, 'name', { min: 1, max: 200 });
        if (body.description !== undefined) changes.description = string(body.description, 'description', { max: 5000 });
        if (body.researchQuestion !== undefined) changes.researchQuestion = string(body.researchQuestion, 'researchQuestion', { max: 2000 });
        if (body.inclusionRules !== undefined) changes.inclusionRules = string(body.inclusionRules, 'inclusionRules', { max: 5000 });
        if (body.exclusionRules !== undefined) changes.exclusionRules = string(body.exclusionRules, 'exclusionRules', { max: 5000 });
        if (!Object.keys(changes).length) throw new TypeError('no supported workspace changes');
        const resource = store.updateWorkspace(actor.actorKey, match[1], version, changes);
        json(res, 200, { data: resource }, { ETag: etag(resource.version) });
        return;
      }

      match = /^\/canvas\/workspaces\/([0-9a-f-]+)\/documents$/.exec(pathname);
      if (match && method === 'GET') {
        const status = url.searchParams.get('status') || undefined;
        const docs = store.listTopicDocuments(actor.actorKey, match[1], { status });
        json(res, 200, { data: docs });
        return;
      }
      if (match && method === 'POST') {
        const body = await readJson(req);
        const input = topicDocumentInput(body, actor.session);
        const resource = store.addTopicDocument(actor.actorKey, match[1], input);
        json(res, 201, { data: resource }, { ETag: etag(resource.version) });
        return;
      }

      match = /^\/canvas\/topic-documents\/([0-9a-f-]+)$/.exec(pathname);
      if (match && method === 'GET') {
        const resource = store.getTopicDocument(actor.actorKey, match[1]);
        if (!resource) throw new CanvasNotFoundError('topic document not found');
        json(res, 200, { data: resource }, { ETag: etag(resource.version) });
        return;
      }
      if (match && ['PATCH', 'DELETE'].includes(method)) {
        const version = versionFromIfMatch(req);
        if (version === null) {
          error(res, 428, 'precondition_required', 'A valid If-Match header is required');
          return;
        }
        if (method === 'DELETE') {
          store.removeTopicDocument(actor.actorKey, match[1], version);
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        const body = await readJson(req);
        const changes = topicDocumentChanges(body);
        const resource = store.updateTopicDocument(actor.actorKey, match[1], version, changes);
        json(res, 200, { data: resource }, { ETag: etag(resource.version) });
        return;
      }

      match = /^\/canvas\/workspaces\/([0-9a-f-]+)\/collection-bindings$/.exec(pathname);
      if (match) {
        error(res, 410, 'feature_retired', 'Collection 绑定已于 M4 退役；主题成员关系请使用文库主题归类接口');
        return;
      }

      match = /^\/canvas\/collection-bindings\/([0-9a-f-]+)$/.exec(pathname);
      if (match) {
        error(res, 410, 'feature_retired', 'Collection 绑定已于 M4 退役');
        return;
      }

      match = /^\/canvas\/collection-bindings\/([0-9a-f-]+)\/sync$/.exec(pathname);
      if (match) {
        error(res, 410, 'feature_retired', 'Collection 同步已于 M4 退役；文库内容请使用原始文件扫描');
        return;
      }

      match = /^\/canvas\/workspaces\/([0-9a-f-]+)\/provenance$/.exec(pathname);
      if (match && method === 'GET') {
        const events = store.listProvenanceEvents(actor.actorKey, {
          workspaceId: match[1],
          limit: url.searchParams.get('limit')
        });
        json(res, 200, { data: events });
        return;
      }

      match = /^\/canvas\/workspaces\/([0-9a-f-]+)\/boards$/.exec(pathname);
      if (match && method === 'GET') {
        json(res, 200, { data: store.listBoards(actor.actorKey, match[1]) });
        return;
      }
      if (match && method === 'POST') {
        const body = await readJson(req);
        const resource = store.createBoard(actor.actorKey, match[1], {
          name: string(body.name, 'name', { min: 1, max: 200 })
        });
        json(res, 201, { data: resource }, { ETag: etag(resource.version) });
        return;
      }

      match = /^\/canvas\/workspaces\/([0-9a-f-]+)\/boards\/import$/.exec(pathname);
      if (match && method === 'POST') {
        const body = await readJson(req);
        const name = body.name !== undefined ? string(body.name, 'name', { min: 1, max: 200 }) : undefined;
        const bundle = normalizedImportBundle(body.bundle || body, actor.session);
        const snapshot = store.importBoard(actor.actorKey, match[1], bundle, { name });
        json(res, 201, { data: snapshot }, { ETag: etag(snapshot.board.version) });
        return;
      }

      match = /^\/canvas\/boards\/([0-9a-f-]+)\/export$/.exec(pathname);
      if (match && method === 'GET') {
        const exported = store.exportBoard(actor.actorKey, match[1]);
        json(res, 200, { data: exported });
        return;
      }

      match = /^\/canvas\/boards\/([0-9a-f-]+)\/provenance$/.exec(pathname);
      if (match && method === 'GET') {
        const events = store.listProvenanceEvents(actor.actorKey, {
          boardId: match[1],
          limit: url.searchParams.get('limit')
        });
        json(res, 200, { data: events });
        return;
      }

      match = /^\/canvas\/boards\/([0-9a-f-]+)\/ai\/generate$/.exec(pathname);
      if (match && method === 'POST') {
        const boardId = match[1];
        const body = await readJson(req);
        const task = body.task || 'synthesize';
        if (!AI_TASKS.has(task)) throw new TypeError('task is invalid');
        const customPrompt = body.prompt === undefined ? '' : string(body.prompt, 'prompt', { max: 5000 });
        if (!Array.isArray(body.inputNodeIds) || body.inputNodeIds.length < 1 || body.inputNodeIds.length > 50) {
          throw new TypeError('inputNodeIds must contain between 1 and 50 node IDs');
        }
        const inputNodeIds = [...new Set(body.inputNodeIds.map(nodeId => key(nodeId, 'inputNodeIds', false)))];

        const board = store.requireBoard(actor.actorKey, boardId);
        const snapshot = store.snapshot(actor.actorKey, boardId);
        const inputNodes = snapshot.nodes.filter(n => inputNodeIds.includes(n.id));

        if (inputNodes.length !== inputNodeIds.length) throw new TypeError('one or more input nodes are invalid');
        const privateConfig = store.getAiSettings(actor.actorKey);
        const publicConfig = aiPublicConfig(privateConfig);
        if (!publicConfig.configured) {
          error(res, 503, 'ai_not_configured', 'AI 模型尚未在服务器端配置');
          return;
        }
        const model = publicConfig.model;

        const sourceMap = new Map(snapshot.sources.map(s => [s.id, s]));
        const cardContexts = inputNodes.map((n, idx) => {
          const s = n.sourceRefId ? sourceMap.get(n.sourceRefId) : null;
          const pageInfo = s?.pageLabel ? ` (p.${s.pageLabel})` : '';
          const quote = s?.quoteSnapshot ? `\n摘录快照: ${s.quoteSnapshot}` : '';
          return `【卡片 ${idx + 1}: ${n.title || '未命名卡片'}${pageInfo}】\n卡片内容: ${n.body || '空白'}${quote}`;
        }).join('\n\n');

        let systemPrompt = '';
        let userMessage = '';
        let generatedTitle = '';

        if (task === 'translate') {
          systemPrompt = [
            '你是一位严谨的专业学术文献翻译专家。',
            '你的任务是将用户提供的学术文献摘录/卡片内容逐句忠实翻译为中文。',
            '【严格准则】',
            '1. 逐句直译，严守原文的所有细节、论述与逻辑关系，严禁任何形式的删减、省略或过度概括；',
            '2. 保持客观中立，严禁添加原文中不存在的个人见解、修饰性套话或二次加工解读；',
            '3. 专业术语务必符合学术标准规范，语言严谨通顺。直接输出高质量中文译文。'
          ].join('\n');
          userMessage = `请忠实将以下学术卡片内容翻译为中文：\n\n${cardContexts}${customPrompt ? `\n\n【特殊翻译要求】:\n${customPrompt}` : ''}`;
          generatedTitle = `AI 忠实中译: ${inputNodes[0]?.title || '文献摘录'}`;
        } else if (task === 'synthesize') {
          systemPrompt = [
            '你是一位严谨的学术研究助手。',
            '请基于用户提供的多张文献卡片与摘录，梳理核心论点、内在逻辑关联与共性结论。',
            '【要求】结构清晰、论证客观严谨，明确注明涉及的卡片来源（如 [卡片1]）。'
          ].join('\n');
          userMessage = `请综合分析以下卡片：\n\n${cardContexts}${customPrompt ? `\n\n【重点关注方向】:\n${customPrompt}` : ''}`;
          generatedTitle = `AI 综合总结`;
        } else if (task === 'compare') {
          systemPrompt = [
            '你是一位严谨的学术研究助手。',
            '请对用户提供的多张文献卡片进行深度对比分析。',
            '【要求】',
            '1. 明确指出各卡片在研究假设、方法论、实验结论或理论视角上的异同与分歧点；',
            '2. 结构化呈现对比维度与核心启示。'
          ].join('\n');
          userMessage = `请对比分析以下卡片：\n\n${cardContexts}${customPrompt ? `\n\n【对比侧重点】:\n${customPrompt}` : ''}`;
          generatedTitle = `AI 观点对比分析`;
        } else {
          systemPrompt = [
            '你是一位严谨的学术研究助手。',
            '请基于提供的文献卡片与背景摘录，深入回答用户的问题或解释相关学术概念。',
            '【要求】结合提供的文献卡片内容进行回答，论述严谨，条理清晰。'
          ].join('\n');
          userMessage = `【参考卡片】:\n${cardContexts}\n\n【用户问题/指令】:\n${customPrompt || '请深入分析和解释上述文献卡片的核心概念与方法。'}`;
          generatedTitle = `AI 深度解读: ${customPrompt ? customPrompt.slice(0, 16) : inputNodes[0]?.title || ''}`;
        }

        let responseText = '';
        try {
          responseText = await aiCompletion({
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage }
            ],
            temperature: task === 'translate' ? 0.1 : 0.4,
          }, privateConfig);
        } catch (fetchErr) {
          error(res, fetchErr?.name === 'AbortError' ? 504 : 502, 'ai_gateway_error', `连接 AI 端点失败: ${fetchErr.message}`);
          return;
        }

        const maxX = Math.max(...inputNodes.map(n => n.x + n.width));
        const minY = Math.min(...inputNodes.map(n => n.y));
        const newX = maxX + 40;
        const newY = minY;
        const textLen = (responseText || '').trim().length;
        const width = textLen > 300 ? 440 : 380;
        const charsPerLine = Math.floor(width / 13);
        const height = Math.min(500, Math.max(88, 76 + Math.ceil(textLen / charsPerLine) * 18));

        const result = store.createAiSynthesisNode(actor.actorKey, boardId, {
          task,
          model,
          promptVersion: AI_PROMPT_VERSION,
          prompt: customPrompt,
          inputNodeIds: inputNodes.map(n => n.id),
          title: generatedTitle,
          body: responseText.trim(),
          x: newX,
          y: newY,
          width,
          height
        });

        json(res, 201, { data: result });
        return;
      }

      match = /^\/canvas\/boards\/([0-9a-f-]+)$/.exec(pathname);
      if (match && method === 'GET') {
        const resource = store.getBoard(actor.actorKey, match[1]);
        if (!resource) throw new CanvasNotFoundError();
        json(res, 200, { data: resource }, { ETag: etag(resource.version) });
        return;
      }
      if (match && ['PATCH', 'DELETE'].includes(method)) {
        const version = versionFromIfMatch(req);
        if (version === null) {
          error(res, 428, 'precondition_required', 'A valid If-Match header is required');
          return;
        }
        if (method === 'DELETE') {
          store.deleteBoard(actor.actorKey, match[1], version);
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        const body = await readJson(req);
        const changes = {};
        if (body.name !== undefined) changes.name = string(body.name, 'name', { min: 1, max: 200 });
        if (body.viewport !== undefined) changes.viewport = viewport(body.viewport);
        if (!Object.keys(changes).length) throw new TypeError('no supported board changes');
        const resource = store.updateBoard(actor.actorKey, match[1], version, changes);
        json(res, 200, { data: resource }, { ETag: etag(resource.version) });
        return;
      }

      match = /^\/canvas\/boards\/([0-9a-f-]+)\/snapshot$/.exec(pathname);
      if (match && method === 'GET') {
        const snapshot = store.snapshot(actor.actorKey, match[1]);
        json(res, 200, { data: snapshot }, { ETag: etag(snapshot.board.version) });
        return;
      }

      match = /^\/canvas\/boards\/([0-9a-f-]+)\/nodes$/.exec(pathname);
      if (match && method === 'POST') {
        const body = await readJson(req);
        const resource = store.createNode(actor.actorKey, match[1], nodeInput(body, actor.session));
        json(res, 201, { data: resource }, { ETag: etag(resource.version) });
        return;
      }

      match = /^\/canvas\/nodes\/([0-9a-f-]+)$/.exec(pathname);
      if (match && ['PATCH', 'DELETE'].includes(method)) {
        const version = versionFromIfMatch(req);
        if (version === null) {
          error(res, 428, 'precondition_required', 'A valid If-Match header is required');
          return;
        }
        if (method === 'DELETE') {
          store.deleteNode(actor.actorKey, match[1], version);
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        const resource = store.updateNode(actor.actorKey, match[1], version, nodeChanges(await readJson(req)));
        json(res, 200, { data: resource }, { ETag: etag(resource.version) });
        return;
      }

      match = /^\/canvas\/nodes\/([0-9a-f-]+)\/source$/.exec(pathname);
      if (match && method === 'PATCH') {
        const version = versionFromIfMatch(req);
        if (version === null) {
          error(res, 428, 'precondition_required', 'A valid If-Match header is required');
          return;
        }
        const body = await readJson(req);
        const nextSource = source(body.source, actor.session);
        if (!nextSource?.attachmentKey || !nextSource?.annotationKey) {
          throw new TypeError('source attachmentKey and annotationKey are required');
        }
        const resource = store.replaceNodeSource(actor.actorKey, match[1], version, nextSource);
        json(res, 200, { data: resource }, { ETag: etag(resource.node.version) });
        return;
      }

      match = /^\/canvas\/nodes\/([0-9a-f-]+)\/restore$/.exec(pathname);
      if (match && method === 'PATCH') {
        const version = versionFromIfMatch(req);
        if (version === null) {
          error(res, 428, 'precondition_required', 'A valid If-Match header is required');
          return;
        }
        const resource = store.restoreNode(actor.actorKey, match[1], version);
        json(res, 200, { data: resource }, { ETag: etag(resource.version) });
        return;
      }

      match = /^\/canvas\/boards\/([0-9a-f-]+)\/edges$/.exec(pathname);
      if (match && method === 'POST') {
        const body = await readJson(req);
        if (!canvasEdgeRelations.has(body.relation)) throw new TypeError('relation is invalid');
        const resource = store.createEdge(actor.actorKey, match[1], {
          sourceNodeId: key(body.sourceNodeId, 'sourceNodeId', false),
          targetNodeId: key(body.targetNodeId, 'targetNodeId', false),
          relation: body.relation,
          label: body.label === undefined ? '' : string(body.label, 'label', { max: 500 })
        });
        json(res, 201, { data: resource }, { ETag: etag(resource.version) });
        return;
      }

      match = /^\/canvas\/edges\/([0-9a-f-]+)$/.exec(pathname);
      if (match && ['PATCH', 'DELETE'].includes(method)) {
        const version = versionFromIfMatch(req);
        if (version === null) {
          error(res, 428, 'precondition_required', 'A valid If-Match header is required');
          return;
        }
        if (method === 'DELETE') {
          store.deleteEdge(actor.actorKey, match[1], version);
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        const body = await readJson(req);
        const changes = {};
        if (body.relation !== undefined) {
          if (!canvasEdgeRelations.has(body.relation)) throw new TypeError('relation is invalid');
          changes.relation = body.relation;
        }
        if (body.label !== undefined) changes.label = string(body.label, 'label', { max: 500 });
        if (!Object.keys(changes).length) throw new TypeError('no supported edge changes');
        const resource = store.updateEdge(actor.actorKey, match[1], version, changes);
        json(res, 200, { data: resource }, { ETag: etag(resource.version) });
        return;
      }

      match = /^\/canvas\/boards\/([0-9a-f-]+)\/layout$/.exec(pathname);
      if (match && method === 'PATCH') {
        const version = versionFromIfMatch(req);
        if (version === null) {
          error(res, 428, 'precondition_required', 'A valid If-Match header is required');
          return;
        }
        const body = await readJson(req);
        if (!Array.isArray(body.nodes) || body.nodes.length > 500) throw new TypeError('nodes must be an array of at most 500 items');
        const nodes = body.nodes.map(item => ({
          id: key(item.id, 'nodes.id', false),
          version: number(item.version, 'nodes.version', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true }),
          x: number(item.x, 'nodes.x'), y: number(item.y, 'nodes.y'),
          width: number(item.width, 'nodes.width', { min: 80, max: 5000 }),
          height: number(item.height, 'nodes.height', { min: 40, max: 5000 }),
          zIndex: number(item.zIndex, 'nodes.zIndex', { min: -100_000, max: 100_000, integer: true })
        }));
        const snapshot = store.updateLayout(actor.actorKey, match[1], version, {
          viewport: viewport(body.viewport), nodes
        });
        json(res, 200, { data: snapshot }, { ETag: etag(snapshot.board.version) });
        return;
      }

      error(res, 404, 'not_found', 'Canvas resource not found');
    } catch (err) {
      if (err instanceof CanvasNotFoundError) error(res, 404, 'not_found', 'Canvas resource not found');
      else if (err instanceof CanvasConflictError) error(res, 412, 'version_conflict', 'The resource has changed; reload and retry');
      else if (err instanceof FileOpError) error(res, err.status, err.code, err.message);
      else if (err instanceof NativePathError) {
        const status = err.code === 'library_root_unavailable' ? 503
          : err.code === 'file_not_found' || err.code === 'directory_not_found' ? 404
            : 400;
        error(res, status, err.code, err.message);
      }
      else if (err instanceof TypeError || err.status === 400) error(res, 400, 'invalid_request', err.message);
      else if (err.status === 403) error(res, 403, 'source_forbidden', err.message);
      else if (err.status === 413) error(res, 413, 'payload_too_large', err.message);
      else if (typeof err.status === 'number' && err.status >= 400 && err.status < 600) {
        error(res, err.status, err.code || 'request_failed', err.message);
      } else {
        console.error('Canvas API error:', err);
        error(res, 500, 'internal_error', 'Canvas request failed');
      }
    }
  };
}

export function getCanvasStore() {
  defaultStore ||= new CanvasStore();
  return defaultStore;
}

export async function handleCanvasApi(req, res, url) {
  defaultStore ||= new CanvasStore();
  return createCanvasHandler(defaultStore)(req, res, url);
}
