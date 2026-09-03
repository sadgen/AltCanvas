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

async function executeImportJob(store, actorKey, job, session = null) {
  if (!job || job.jobType !== 'import_document') return null;
  store.updateJobState(job.id, { state: 'running', startedAt: new Date().toISOString() });

  try {
    const payload = job.payload || {};
    let resolved = payload.resolved;
    if (!resolved && (payload.input || payload.url || payload.identifier)) {
      resolved = await resolveImportInput(payload.input || payload.url || payload.identifier);
    }
    if (!resolved) {
      throw new Error('No import metadata could be resolved');
    }

    const deterministicHash = crypto.createHash('sha256').update(job.id).digest('hex').slice(0, 10).toUpperCase();
    const itemKey = payload.itemKey || job.resultSummary?.itemKey || `IMP_${deterministicHash}`;
    const tags = [resolved.sourceType, resolved.doi ? 'doi' : '', resolved.arxivId ? 'arxiv' : ''].filter(Boolean);

    const libraryType = payload.libraryType || (session ? 'user' : null);
    const libraryId = payload.libraryId || (session ? String(session.userId) : null);
    if (!libraryType || !libraryId) {
      throw new Error('Import job is missing libraryType/libraryId context');
    }

    const entryInput = {
      libraryType,
      libraryId,
      itemKey,
      detectedFrom: 'import',
      title: string(resolved.title || '未命名导入文献', 'title', { max: 500 }),
      creators: Array.isArray(resolved.creators) ? resolved.creators : [],
      year: resolved.year ? Number(resolved.year) : null,
      abstractNote: string(resolved.abstractNote || '', 'abstractNote', { max: 20_000 }),
      tags,
      doi: resolved.doi ? String(resolved.doi).trim() : null
    };

    const upserted = store.upsertInboxEntries(actorKey, [entryInput]);
    const entry = upserted[0];

    let topicDocument = null;
    if (payload.targetWorkspaceId && entry) {
      topicDocument = store.addTopicDocument(actorKey, payload.targetWorkspaceId, {
        libraryType: entry.libraryType,
        libraryId: entry.libraryId,
        itemKey: entry.itemKey,
        status: 'accepted',
        origin: 'canvas_import'
      });
    }

    const updatedJob = store.updateJobState(job.id, {
      state: 'completed',
      finishedAt: new Date().toISOString(),
      errorCode: null,
      resultSummary: {
        entryId: entry?.id,
        itemKey,
        targetWorkspaceId: payload.targetWorkspaceId || null,
        topicDocumentId: topicDocument?.id || null
      }
    });

    return { job: updatedJob, entry, topicDocument };
  } catch (err) {
    const failedJob = store.updateJobState(job.id, {
      state: 'failed',
      finishedAt: new Date().toISOString(),
      errorCode: 'import_failed',
      resultSummary: { error: err.message }
    });
    return { job: failedJob, error: err.message };
  }
}

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
        setImmediate(() => {
          executeImportJob(store, actorKey, job).catch(() => {});
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

function inboxEntryInput(item, session) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('inbox entry must be an object');
  const { libraryType, libraryId } = validateLibraryAccess(item.libraryType, item.libraryId, session);
  const itemKey = key(item.itemKey, 'inboxEntry.itemKey', false);

  let attachmentKey = undefined;
  let attachmentVersion = undefined;

  const hasAttachmentKey = item.attachmentKey !== undefined;
  const hasAttachmentVersion = item.attachmentVersion !== undefined;

  if (hasAttachmentKey || hasAttachmentVersion) {
    if (item.attachmentKey === null && item.attachmentVersion === null) {
      attachmentKey = null;
      attachmentVersion = null;
    } else if (item.attachmentKey && item.attachmentVersion !== null && item.attachmentVersion !== undefined) {
      attachmentKey = key(item.attachmentKey, 'inboxEntry.attachmentKey');
      attachmentVersion = number(item.attachmentVersion, 'inboxEntry.attachmentVersion', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
    } else {
      throw new TypeError('attachmentKey and attachmentVersion must be provided together as an atomic pair or both omitted/null');
    }
  }

  const detectedFrom = item.detectedFrom !== undefined ? string(item.detectedFrom, 'inboxEntry.detectedFrom', { max: 128 }) : 'scan';
  const title = item.title !== undefined ? string(item.title, 'inboxEntry.title', { max: 500 }) : '';
  const abstractNote = item.abstractNote !== undefined ? string(item.abstractNote, 'inboxEntry.abstractNote', { max: 20_000 }) : '';
  const year = item.year === undefined || item.year === null ? null : number(item.year, 'inboxEntry.year', { min: 0, max: 3000, integer: true });
  const itemVersion = item.itemVersion === undefined || item.itemVersion === null
    ? null : number(item.itemVersion, 'inboxEntry.itemVersion', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
  const creators = Array.isArray(item.creators) ? item.creators.slice(0, 100).map(c => {
    if (typeof c === 'string') return string(c, 'inboxEntry.creators', { max: 200 });
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const creator = {};
      if (c.creatorType !== undefined) creator.creatorType = string(c.creatorType, 'inboxEntry.creators.creatorType', { max: 64 });
      if (c.firstName !== undefined) creator.firstName = string(c.firstName, 'inboxEntry.creators.firstName', { max: 200 });
      if (c.lastName !== undefined) creator.lastName = string(c.lastName, 'inboxEntry.creators.lastName', { max: 200 });
      if (c.name !== undefined) creator.name = string(c.name, 'inboxEntry.creators.name', { max: 200 });
      return creator;
    }
    return '';
  }).filter(c => (typeof c === 'string' ? Boolean(c) : Object.keys(c).length > 0)) : [];
  const collectionKeys = Array.isArray(item.collectionKeys)
    ? item.collectionKeys.slice(0, 100).map(k => key(k, 'inboxEntry.collectionKeys'))
    : [];
  const tags = Array.isArray(item.tags)
    ? item.tags.slice(0, 100).map(t => {
      if (typeof t === 'string') return string(t, 'inboxEntry.tags', { max: 200 });
      if (t && typeof t === 'object' && !Array.isArray(t) && t.tag !== undefined) {
        return string(t.tag, 'inboxEntry.tags.tag', { max: 200 });
      }
      return '';
    }).filter(Boolean)
    : [];

  const entry = {
    libraryType,
    libraryId,
    itemKey,
    detectedFrom,
    title,
    creators,
    year,
    abstractNote,
    collectionKeys,
    tags,
    itemVersion
  };
  if (attachmentKey !== undefined) entry.attachmentKey = attachmentKey;
  if (attachmentVersion !== undefined) entry.attachmentVersion = attachmentVersion;
  return entry;
}

export function normalizeZoteroItemToInboxEntry(item, libraryType, libraryId) {
  if (!item || typeof item !== 'object') return null;
  const itemData = item.data && typeof item.data === 'object' ? item.data : item;
  const itemKey = itemData.key || item.key;
  if (!itemKey) return null;
  const itemType = itemData.itemType;
  if (itemType === 'annotation' || itemType === 'note') return null;

  const isAttachment = itemType === 'attachment';
  const isPdfAttachment = isAttachment && (
    itemData.contentType === 'application/pdf' ||
    String(itemData.filename || '').toLowerCase().endsWith('.pdf')
  );
  if (isAttachment && !isPdfAttachment) return null;

  let title = String(itemData.title || itemData.name || '').slice(0, 500);
  if (!title && isAttachment && itemData.filename) {
    title = String(itemData.filename).replace(/\.[pP][dD][fF]$/, '').slice(0, 500);
  }
  if (!title) {
    title = isAttachment ? '无标题研报' : '无标题文档';
  }
  const creators = Array.isArray(itemData.creators) ? itemData.creators.slice(0, 100).map(c => {
    if (typeof c === 'string') return c.slice(0, 200);
    if (c && typeof c === 'object') {
      const res = {};
      if (c.creatorType) res.creatorType = String(c.creatorType).slice(0, 64);
      if (c.firstName) res.firstName = String(c.firstName).slice(0, 200);
      if (c.lastName) res.lastName = String(c.lastName).slice(0, 200);
      if (c.name) res.name = String(c.name).slice(0, 200);
      return res;
    }
    return '';
  }).filter(c => (typeof c === 'string' ? Boolean(c) : Object.keys(c).length > 0)) : [];

  let year = null;
  if (itemData.date) {
    const m = /\b(\d{4})\b/.exec(String(itemData.date));
    if (m) year = Number(m[1]);
  }

  const abstractNote = String(itemData.abstractNote || itemData.abstract || '').slice(0, 20000);
  const collectionKeys = Array.isArray(itemData.collections) ? itemData.collections.slice(0, 100).map(String) : [];
  const tags = Array.isArray(itemData.tags) ? itemData.tags.slice(0, 100).map(t => (typeof t === 'string' ? t.slice(0, 200) : String(t?.tag || '').slice(0, 200))).filter(Boolean) : [];
  const itemVersion = itemData.version !== undefined ? Number(itemData.version) : (item.version !== undefined ? Number(item.version) : null);

  let attachmentKey = itemData.attachmentKey || item.attachmentKey || null;
  let attachmentVersion = itemData.attachmentVersion !== undefined ? Number(itemData.attachmentVersion) : (item.attachmentVersion !== undefined ? Number(item.attachmentVersion) : null);

  if (isPdfAttachment) {
    attachmentKey = attachmentKey || itemKey;
    if (attachmentVersion === null) {
      attachmentVersion = itemVersion;
    }
  } else if (!attachmentKey && Array.isArray(item.children)) {
    const pdfChild = item.children.find(c => (c?.data?.itemType || c?.itemType) === 'attachment' && (c?.data?.contentType === 'application/pdf' || String(c?.data?.filename || '').toLowerCase().endsWith('.pdf')));
    if (pdfChild) {
      attachmentKey = pdfChild.key || pdfChild.data?.key || null;
      const childVer = pdfChild.data?.version ?? pdfChild.version;
      if (childVer !== undefined) attachmentVersion = Number(childVer);
    }
  }

  return {
    libraryType: libraryType === 'group' ? 'group' : 'user',
    libraryId: String(libraryId),
    itemKey: String(itemKey),
    attachmentKey: attachmentKey ? String(attachmentKey) : null,
    attachmentVersion: Number.isFinite(attachmentVersion) ? attachmentVersion : null,
    detectedFrom: 'scan',
    title,
    creators,
    year: Number.isFinite(year) ? year : null,
    abstractNote,
    collectionKeys,
    tags,
    itemVersion: Number.isFinite(itemVersion) ? itemVersion : null
  };
}

export async function resolveItemAttachment(fetchFn, session, libraryType, libraryId, item) {
  if (!item || typeof item !== 'object') return item;
  const itemData = item.data && typeof item.data === 'object' ? item.data : item;
  const itemKey = itemData.key || item.key;
  if (!itemKey) return item;

  let attachmentKey = itemData.attachmentKey || item.attachmentKey || null;
  let attachmentVersion = itemData.attachmentVersion !== undefined ? Number(itemData.attachmentVersion) : (item.attachmentVersion !== undefined ? Number(item.attachmentVersion) : null);

  if (attachmentKey && attachmentVersion !== null) {
    return { ...item, attachmentKey, attachmentVersion };
  }

  if (itemData.itemType === 'attachment') {
    const isPdf = itemData.contentType === 'application/pdf' || String(itemData.filename || '').toLowerCase().endsWith('.pdf');
    if (isPdf) {
      const version = itemData.version !== undefined ? Number(itemData.version) : (item.version !== undefined ? Number(item.version) : null);
      return {
        ...item,
        attachmentKey: itemKey,
        attachmentVersion: Number.isFinite(version) ? version : null
      };
    }
    return item;
  }

  // Fetch children from Altero upstream
  const prefix = libraryType === 'group' ? 'groups' : 'users';
  const childrenRes = await fetchFn(session, `/${prefix}/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(itemKey)}/children`);
  if (!childrenRes || !childrenRes.ok) {
    const status = childrenRes ? childrenRes.status : 'no response';
    throw new Error(`Failed to fetch child attachments for item ${itemKey}: upstream returned HTTP ${status}`);
  }

  const children = await childrenRes.json();
  if (!Array.isArray(children)) {
    throw new Error(`Invalid child attachments response for item ${itemKey}: expected array`);
  }

  const pdfChild = children.find(c => (c?.data?.itemType || c?.itemType) === 'attachment' && (c?.data?.contentType === 'application/pdf' || String(c?.data?.filename || '').toLowerCase().endsWith('.pdf')));
  if (pdfChild) {
    attachmentKey = pdfChild.key || pdfChild.data?.key || null;
    const childVer = pdfChild.data?.version ?? pdfChild.version;
    if (childVer !== undefined) attachmentVersion = Number(childVer);
    return { ...item, attachmentKey, attachmentVersion };
  }

  return item;
}

async function defaultFetchAltero(session, path, options = {}) {
  const alteroApi = (session.alteroApi || process.env.ALTERO_API || 'http://localhost:8000').replace(/\/$/, '');
  const url = `${alteroApi}${path}`;
  const headers = {
    'Accept': 'application/json',
    'Zotero-API-Version': '3',
    ...(session.accessToken ? { 'Authorization': `Bearer ${session.accessToken}` } : {})
  };
  return fetch(url, { headers, ...options });
}

export async function fetchAllUpstreamItems(fetchFn, session, basePath, {
  since = undefined,
  limitPerPage = 100,
  maxSafetyPages = 500,
  onPage = null
} = {}) {
  let start = 0;
  const allItems = onPage ? null : [];
  let lastModifiedVersion = 0;
  const seenItemKeys = new Set();
  let completed = false;

  for (let page = 0; page < maxSafetyPages; page++) {
    const separator = basePath.includes('?') ? '&' : '?';
    let path = `${basePath}${separator}limit=${limitPerPage}&start=${start}`;
    if (since !== undefined && Number.isFinite(since) && since > 0) {
      path += `&since=${since}`;
    }

    const res = await fetchFn(session, path);
    if (!res.ok) {
      if (res.status === 304) {
        if (start === 0) {
          return { items: [], lastModifiedVersion: since || 0, totalScanned: 0 };
        }
        throw new Error(`Unexpected 304 Not Modified received on page offset ${start}`);
      }
      throw new Error(`Upstream fetch failed: HTTP ${res.status}`);
    }

    const headerVersion = Number(res.headers?.get ? res.headers.get('Last-Modified-Version') : 0) || 0;
    if (headerVersion > lastModifiedVersion) lastModifiedVersion = headerVersion;

    const totalResultsHeader = res.headers?.get ? res.headers.get('Total-Results') : null;
    const totalResults = totalResultsHeader !== null && !isNaN(Number(totalResultsHeader)) ? Number(totalResultsHeader) : null;

    let itemsChunk;
    try {
      itemsChunk = await res.json();
    } catch (parseErr) {
      throw new Error(`Upstream returned non-JSON body: ${parseErr.message}`);
    }

    if (!Array.isArray(itemsChunk)) {
      throw new Error('Upstream returned non-array items chunk');
    }

    if (itemsChunk.length === 0) {
      if (totalResults !== null && start < totalResults) {
        throw new Error(`Premature end of upstream stream: expected ${totalResults} items, received ${start} at offset ${start}`);
      }
      completed = true;
      break;
    }

    for (const item of itemsChunk) {
      const k = item?.key || item?.data?.key;
      if (k) {
        if (seenItemKeys.has(k)) {
          throw new Error(`Upstream pagination overlap/loop detected: duplicate item key ${k} received at offset ${start}`);
        }
        seenItemKeys.add(k);
      }
    }

    if (onPage) {
      await onPage(itemsChunk, { start, totalResults, headerVersion });
    } else {
      allItems.push(...itemsChunk);
    }
    start += itemsChunk.length;

    if (totalResults !== null && start < totalResults && itemsChunk.length < limitPerPage) {
      throw new Error(`Premature end of upstream stream: expected ${totalResults} items, received ${start}`);
    }

    if (itemsChunk.length < limitPerPage || (totalResults !== null && start >= totalResults)) {
      completed = true;
      break;
    }
  }

  if (!completed) {
    throw new Error(`Upstream pagination exceeded safety limit of ${maxSafetyPages} pages; sync halted to prevent incomplete scan`);
  }

  return { items: allItems || [], lastModifiedVersion, totalScanned: start };
}

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

  const FIELD_LIMITS = { abstract: 20_000, pdfUrl: 2000, isbn: 64, arxivId: 64, doi: 2000, url: 2000, sourceType: 64, input: 2000 };
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
async function executeNativeImportItem(store, actorKey, normalized, {
  downloadPdfFn,
  promoteBlobFn = defaultPromoteBlob,
  fallbackTargetWorkspaceId = null
}) {
  let resolved = normalized.resolved;
  if (!resolved && normalized.input) {
    try {
      resolved = await resolveImportInput(normalized.input);
    } catch (resolveErr) {
      resolveErr.code = 'resolve_error';
      resolveErr.status = 400;
      throw resolveErr;
    }
  }
  if (!resolved && !normalized.title) {
    throw new TypeError('resolved metadata or a title is required');
  }

  const title = resolved?.title || normalized.title;
  const abstract = resolved?.abstractNote || normalized.abstract || '';
  const creators = Array.isArray(resolved?.creators) && resolved.creators.length ? resolved.creators : normalized.creators;
  const year = resolved?.year || normalized.year || null;
  const doi = resolved?.doi || normalized.doi || null;
  const url = resolved?.url || normalized.url || null;
  const arxivId = resolved?.arxivId || resolved?.arXivId || normalized.arxivId || null;
  const externalRefs = normalized.externalRefs;
  const targetWorkspaceId = normalized.targetWorkspaceId || fallbackTargetWorkspaceId;

  // PDF acquisition: explicit item.pdfUrl failures are fatal; resolver-derived failures degrade with warning.
  let warning = null;
  let attachment = null;
  let tempFilePath = null;
  const explicitPdfUrl = normalized.pdfUrl && normalized.pdfUrl.trim() ? normalized.pdfUrl.trim() : null;
  const pdfUrl = explicitPdfUrl || resolved?.pdfUrl || null;

  if (pdfUrl && typeof pdfUrl === 'string' && /^https?:\/\//i.test(pdfUrl)) {
    try {
      const tempDir = path.join(store.getBlobStorageDir(), 'tmp');
      const downloadResult = await downloadPdfFn(pdfUrl, tempDir);
      tempFilePath = downloadResult.tempFilePath;
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
  }

  const cleanupTemp = () => {
    try { if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch {}
  };

  const precheckInput = {
    title, year, doi,
    isbn: normalized.isbn,
    arxivId,
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

  // Phase 2: promote temp file to content-addressed storage (exclusive, atomic rename).
  let promotion = null;
  if (attachment && tempFilePath) {
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
  let result;
  try {
    result = store.importNativeDocument(actorKey, {
      sourceType: resolved?.sourceType || normalized.sourceType || 'manual',
      title,
      abstract,
      creators,
      year,
      doi,
      url,
      isbn: normalized.isbn,
      arxivId,
      externalRefs,
      attachment,
      targetWorkspaceId,
      forceNew: normalized.forceNew,
      confirmFuzzy: normalized.confirmFuzzy
    });
  } catch (dbErr) {
    if (promotion?.newlyCreated) {
      compensatePromotedBlob(store, attachment.sha256, promotion.targetBlobPath);
    }
    throw dbErr;
  }

  // Write-time decision diverged (concurrent import raced the precheck): compensate file.
  if (result.outcome !== 'created' && result.outcome !== 'reused' && promotion?.newlyCreated) {
    compensatePromotedBlob(store, attachment.sha256, promotion.targetBlobPath);
  }

  return { result, warning };
}

// Exported for direct concurrency testing of the exclusive promotion primitive.
export { defaultPromoteBlob };

export function createCanvasHandler(store, {
  aiCompletion = requestAiCompletion,
  aiPublicConfig = getAiPublicConfig,
  aiEndpointValidator = validateAiEndpoint,
  fetchAltero = defaultFetchAltero,
  downloadPdfFn = safeDownloadPdfFile,
  promoteBlobFn = defaultPromoteBlob,
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
      if (pathname === '/canvas/imports/native' && method === 'POST') {
        const body = await readJson(req);
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

        let outcome;
        try {
          outcome = await executeNativeImportItem(store, actor.actorKey, normalized, {
            downloadPdfFn,
            promoteBlobFn
          });
        } catch (execErr) {
          if (execErr.code === 'pdf_download_failed' || execErr.code === 'blob_persist_failed') {
            error(res, execErr.status || 502, execErr.code, execErr.message);
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

        json(res, result.outcome === 'reused' ? 200 : 201, {
          data: warning ? { ...result, warning } : result
        });
        return;
      }

      if (pathname === '/canvas/imports/native/batch' && method === 'POST') {
        const body = await readJson(req);
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
          try {
            const { result, warning } = await executeNativeImportItem(store, actor.actorKey, normalized, {
              downloadPdfFn,
              promoteBlobFn,
              fallbackTargetWorkspaceId: targetWorkspaceId
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

      // --- Native Documents List & CRUD ---
      if (pathname === '/canvas/native/documents' && method === 'GET') {
        const search = url.searchParams.get('search') || undefined;
        const year = url.searchParams.get('year') || undefined;
        const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50;
        const offset = url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0;
        const docs = store.listDocuments(actor.actorKey, { search, year, limit, offset });
        json(res, 200, { data: docs });
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
          store.deleteDocument(actor.actorKey, match[1], version);
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        const body = await readJson(req);
        const doc = store.updateDocument(actor.actorKey, match[1], version, body);
        json(res, 200, { data: doc }, { ETag: etag(doc.version) });
        return;
      }

      // --- Native Attachment File Streaming with HTTP Range ---
      match = /^\/canvas\/native\/attachments\/([0-9a-f-]+)\/file$/.exec(pathname);
      if (match && ['GET', 'HEAD'].includes(method)) {
        const attachmentId = match[1];
        const attWithBlob = store.getAttachmentWithBlob(actor.actorKey, attachmentId);
        if (!attWithBlob) {
          error(res, 404, 'not_found', 'Attachment not found');
          return;
        }

        const blobFilePath = path.resolve(store.getBlobStorageDir(), attWithBlob.blob.relativePath);
        if (!fs.existsSync(blobFilePath)) {
          error(res, 404, 'file_not_found', 'Attachment file not found on disk');
          return;
        }

        const stat = fs.statSync(blobFilePath);
        const fileSize = stat.size;
        const blobEtag = `W/"${attWithBlob.blob.sha256}"`;

        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch && (ifNoneMatch === blobEtag || ifNoneMatch === `"${attWithBlob.blob.sha256}"` || ifNoneMatch === '*')) {
          res.writeHead(304, {
            'ETag': blobEtag,
            'Cache-Control': 'private, max-age=86400',
            'Accept-Ranges': 'bytes'
          });
          res.end();
          return;
        }

        const rangeHeader = req.headers['range'];
        if (!rangeHeader) {
          res.writeHead(200, {
            'Content-Type': attWithBlob.blob.mimeType || 'application/pdf',
            'Content-Length': fileSize,
            'Accept-Ranges': 'bytes',
            'ETag': blobEtag,
            'Cache-Control': 'private, max-age=86400',
            'Content-Disposition': `inline; filename="${encodeURIComponent(attWithBlob.attachment.originalFilename || 'document.pdf')}"`
          });
          if (method === 'HEAD') {
            res.end();
            return;
          }
          fs.createReadStream(blobFilePath).pipe(res);
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
          'Content-Type': attWithBlob.blob.mimeType || 'application/pdf',
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': chunkLength,
          'Accept-Ranges': 'bytes',
          'ETag': blobEtag,
          'Cache-Control': 'private, max-age=86400',
          'Content-Disposition': `inline; filename="${encodeURIComponent(attWithBlob.attachment.originalFilename || 'document.pdf')}"`
        });
        if (method === 'HEAD') {
          res.end();
          return;
        }
        fs.createReadStream(blobFilePath, { start, end }).pipe(res);
        return;
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
        const state = url.searchParams.get('state') || undefined;
        const collectionKey = url.searchParams.get('collectionKey') || undefined;
        const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 100;
        const cursor = url.searchParams.get('cursor') || undefined;
        const entries = store.listInboxEntries(actor.actorKey, { state, collectionKey, limit, cursor });
        const unreadCount = store.countInboxEntries(actor.actorKey, { state: 'new' });
        const totalCount = store.countInboxEntries(actor.actorKey, { state, collectionKey });
        const lastEntry = entries.length === limit ? entries[entries.length - 1] : null;
        const nextCursor = lastEntry ? `${lastEntry.updatedAt}|${lastEntry.id}` : null;
        json(res, 200, {
          data: entries,
          meta: {
            unreadCount,
            totalCount,
            nextCursor
          }
        });
        return;
      }
      if (pathname === '/canvas/inbox/scan' && method === 'POST') {
        const body = await readJson(req);
        if (body && (typeof body !== 'object' || Array.isArray(body))) {
          throw new TypeError('request body must be an object');
        }
        const libType = body?.libraryType !== undefined ? string(body.libraryType, 'libraryType') : (actor.session.authMode === 'local' ? 'native' : 'user');
        const libId = body?.libraryId !== undefined ? string(body.libraryId, 'libraryId', { max: 128 }) : (libType === 'native' ? 'local' : actor.session.userId);
        const targetLib = validateLibraryAccess(libType, libId, actor.session);

        if (targetLib.libraryType === 'native') {
          json(res, 200, {
            data: {
              scanned: 0,
              upsertedCount: 0,
              lastLibraryVersion: 0
            }
          });
          return;
        }
        const since = body?.since === undefined || body?.since === null
          ? undefined
          : number(body.since, 'since', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });

        const prefix = targetLib.libraryType === 'group' ? 'groups' : 'users';
        const basePath = `/${prefix}/${encodeURIComponent(targetLib.libraryId)}/items/top`;

        let scannedCount = 0;
        let upsertedCount = 0;
        let fetchResult;
        try {
          fetchResult = await fetchAllUpstreamItems(fetchAltero, actor.session, basePath, {
            since,
            limitPerPage: 100,
            onPage: async (itemsChunk) => {
              const enrichedChunk = await mapWithConcurrency(itemsChunk, 6, item => resolveItemAttachment(fetchAltero, actor.session, targetLib.libraryType, targetLib.libraryId, item));
              const entries = enrichedChunk
                .map(item => normalizeZoteroItemToInboxEntry(item, targetLib.libraryType, targetLib.libraryId))
                .filter(Boolean);
              scannedCount += entries.length;
              if (entries.length) {
                const upserted = store.upsertInboxEntries(actor.actorKey, entries);
                upsertedCount += upserted.length;
              }
            }
          });
        } catch (upstreamErr) {
          error(res, 502, 'upstream_error', `Altero items scan failed: ${upstreamErr.message}`);
          return;
        }

        json(res, 200, {
          data: {
            scanned: scannedCount,
            upsertedCount,
            lastLibraryVersion: fetchResult.lastModifiedVersion
          }
        });
        return;
      }
      if (pathname === '/canvas/inbox/entries' && method === 'POST') {
        const body = await readJson(req);
        if (!Array.isArray(body.entries) || body.entries.length > 500) {
          throw new TypeError('entries must be an array of at most 500 items');
        }
        const validatedEntries = body.entries.map(entry => inboxEntryInput(entry, actor.session));
        const results = store.upsertInboxEntries(actor.actorKey, validatedEntries);
        json(res, 201, { data: results });
        return;
      }
      if (pathname === '/canvas/inbox/batch-action' && method === 'POST') {
        const body = await readJson(req);
        if (!Array.isArray(body.entryIds) || !body.entryIds.length) throw new TypeError('entryIds must be a non-empty array');
        const action = string(body.action, 'action');
        if (!['accept', 'add_to_topics', 'defer', 'ignore', 'reopen'].includes(action)) throw new TypeError('action is invalid');
        const targetWorkspaceIds = Array.isArray(body.targetWorkspaceIds) ? body.targetWorkspaceIds.map(String) : [];
        const result = store.batchActionInbox(actor.actorKey, {
          entryIds: body.entryIds.map(String),
          action,
          targetWorkspaceIds
        });
        json(res, 200, { data: result });
        return;
      }
      if (pathname === '/canvas/imports/resolve' && method === 'POST') {
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new TypeError('request body must be an object');
        }
        const rawInput = string(body.input, 'input', { min: 1, max: 2000 });
        let resolved;
        try {
          resolved = await resolveImportInput(rawInput);
        } catch (err) {
          error(res, 400, 'resolve_error', `Failed to resolve input: ${err.message}`);
          return;
        }

        const duplicateCandidates = findDuplicateCandidates(store, actor.actorKey, resolved);
        json(res, 200, {
          data: {
            resolved,
            duplicateCandidates
          }
        });
        return;
      }
      if (pathname === '/canvas/imports' && method === 'POST') {
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new TypeError('request body must be an object');
        }

        let resolved = body.resolved;
        if (!resolved) {
          const rawInput = string(body.input, 'input', { min: 1, max: 2000 });
          try {
            resolved = await resolveImportInput(rawInput);
          } catch (err) {
            error(res, 400, 'resolve_error', `Failed to resolve input: ${err.message}`);
            return;
          }
        }

        const targetWorkspaceId = body.targetWorkspaceId ? string(body.targetWorkspaceId, 'targetWorkspaceId', { max: 128 }) : null;
        if (targetWorkspaceId) {
          store.requireWorkspace(actor.actorKey, targetWorkspaceId);
        }

        const importJob = store.enqueueJob(actor.actorKey, {
          jobType: 'import_document',
          resourceType: 'inbox_entry',
          resourceId: 'pending',
          payload: {
            input: body.input,
            url: body.url,
            identifier: body.identifier,
            resolved,
            targetWorkspaceId: targetWorkspaceId || null,
            autoAccept: Boolean(body.autoAccept),
            libraryType: 'user',
            libraryId: String(actor.session.userId)
          }
        });

        const execResult = await executeImportJob(store, actor.actorKey, importJob, actor.session);
        if (execResult.error && !execResult.entry) {
          json(res, 500, { error: { code: 'import_failed', message: execResult.error }, data: { job: execResult.job } });
          return;
        }

        json(res, 201, {
          data: {
            job: execResult.job,
            entry: execResult.entry,
            topicDocument: execResult.topicDocument
          }
        });
        return;
      }
      match = /^\/canvas\/imports\/([0-9a-f-]+)\/retry$/.exec(pathname);
      if (match && method === 'POST') {
        const job = store.getJob(actor.actorKey, match[1]);
        if (!job || job.jobType !== 'import_document') {
          throw new CanvasNotFoundError('Import job not found');
        }
        if (job.state !== 'failed') {
          json(res, 200, { data: job, message: 'Job is not in failed state' });
          return;
        }
        const retried = store.updateJobState(job.id, {
          state: 'queued',
          errorCode: null,
          incrementAttempts: true
        });
        if (job.payload) {
          setImmediate(() => {
            executeImportJob(store, actor.actorKey, retried, actor.session).catch(() => {});
          });
        }
        json(res, 200, { data: retried });
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
        if (body?.entryIds !== undefined) {
          if (!Array.isArray(body.entryIds) || body.entryIds.length > 100) {
            throw new TypeError('entryIds must be an array of at most 100 items');
          }
          for (const id of body.entryIds) {
            const entryId = string(id, 'entryIds.id', { max: 128 });
            const entry = store.getInboxEntry(actor.actorKey, entryId);
            if (entry) targetEntries.push(entry);
          }
        } else {
          targetEntries = store.listInboxEntries(actor.actorKey, { state: 'new', limit: 20 });
        }

        if (!targetEntries.length) {
          json(res, 200, { data: { classifications: {} } });
          return;
        }

        const privateConfig = store.getAiSettings(actor.actorKey);
        const publicConfig = aiPublicConfig(privateConfig);
        if (!publicConfig.configured) {
          error(res, 503, 'ai_not_configured', 'AI 模型尚未配置');
          return;
        }

        try {
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

          const documentMetas = saveClassificationDocumentMetas(store, actor.actorKey, targetEntries, parsed);
          json(res, 200, { data: { classifications, documentMetas } });
        } catch (aiErr) {
          error(res, aiErr?.name === 'AbortError' ? 504 : 502, 'ai_gateway_error', aiErr.message);
        }
        return;
      }

      if (pathname === '/canvas/inbox/generate-topics' && method === 'POST') {
        const body = await readJson(req);
        if (body && (typeof body !== 'object' || Array.isArray(body))) {
          throw new TypeError('request body must be an object');
        }

        let targetEntries = [];
        if (body?.entryIds !== undefined) {
          if (!Array.isArray(body.entryIds) || body.entryIds.length > 100) {
            throw new TypeError('entryIds must be an array of at most 100 items');
          }
          for (const id of body.entryIds) {
            const entryId = string(id, 'entryIds.id', { max: 128 });
            const entry = store.getInboxEntry(actor.actorKey, entryId);
            if (entry) targetEntries.push(entry);
          }
        } else {
          targetEntries = store.listInboxEntries(actor.actorKey, { limit: 50 });
        }

        if (!targetEntries.length) {
          json(res, 200, { data: { createdWorkspaces: [], workspaces: store.listWorkspaces(actor.actorKey), classifications: {}, message: '文献库或收件箱暂无可供提炼的文献' } });
          return;
        }

        const privateConfig = store.getAiSettings(actor.actorKey);
        const publicConfig = aiPublicConfig(privateConfig);
        if (!publicConfig.configured) {
          error(res, 503, 'ai_not_configured', 'AI 模型尚未配置');
          return;
        }

        const existingWorkspaces = store.listWorkspaces(actor.actorKey);
        const maxTopics = typeof body?.maxTopics === 'number' ? Math.max(2, Math.min(8, Math.floor(body.maxTopics))) : 5;

        try {
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

            const ws = store.createWorkspace(actor.actorKey, {
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

          const documentMetas = saveClassificationDocumentMetas(store, actor.actorKey, targetEntries, parsed);

          json(res, 200, {
            data: {
              createdWorkspaces,
              workspaces: store.listWorkspaces(actor.actorKey),
              classifications,
              documentMetas
            }
          });
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
      if (match && method === 'GET') {
        const bindings = store.listCollectionBindings(actor.actorKey, match[1]);
        json(res, 200, { data: bindings });
        return;
      }
      if (match && method === 'POST') {
        const body = await readJson(req);
        const input = collectionBindingInput(body, actor.session);
        const resource = store.addCollectionBinding(actor.actorKey, match[1], input);
        json(res, 201, { data: resource }, { ETag: etag(resource.version) });
        return;
      }

      match = /^\/canvas\/collection-bindings\/([0-9a-f-]+)$/.exec(pathname);
      if (match && method === 'GET') {
        const resource = store.getCollectionBinding(actor.actorKey, match[1]);
        if (!resource) throw new CanvasNotFoundError('collection binding not found');
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
          store.removeCollectionBinding(actor.actorKey, match[1], version);
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        const body = await readJson(req);
        const changes = collectionBindingChanges(body);
        const resource = store.updateCollectionBinding(actor.actorKey, match[1], version, changes);
        json(res, 200, { data: resource }, { ETag: etag(resource.version) });
        return;
      }

      match = /^\/canvas\/collection-bindings\/([0-9a-f-]+)\/sync$/.exec(pathname);
      if (match && method === 'POST') {
        const binding = store.getCollectionBinding(actor.actorKey, match[1]);
        if (!binding) throw new CanvasNotFoundError('collection binding not found');

        if (binding.libraryType === 'native') {
          error(res, 400, 'unsupported', 'Collection bindings are not supported for native library');
          return;
        }

        const prefix = binding.libraryType === 'group' ? 'groups' : 'users';
        const basePath = `/${prefix}/${encodeURIComponent(binding.libraryId)}/collections/${encodeURIComponent(binding.collectionKey)}/items`;
        const since = binding.lastLibraryVersion ? Number(binding.lastLibraryVersion) : undefined;

        let scannedCount = 0;
        let addedToTopic = 0;
        let fetchResult;
        try {
          fetchResult = await fetchAllUpstreamItems(fetchAltero, actor.session, basePath, {
            since,
            limitPerPage: 100,
            onPage: async (itemsChunk) => {
              const enrichedChunk = await mapWithConcurrency(itemsChunk, 6, item => resolveItemAttachment(fetchAltero, actor.session, binding.libraryType, binding.libraryId, item));
              const entries = enrichedChunk
                .map(item => normalizeZoteroItemToInboxEntry(item, binding.libraryType, binding.libraryId))
                .filter(Boolean);
              scannedCount += entries.length;
              if (entries.length) {
                store.transaction(() => {
                  const upserted = store.upsertInboxEntries(actor.actorKey, entries);
                  if (binding.mode === 'inbound') {
                    for (const entry of upserted) {
                      store.addTopicDocument(actor.actorKey, binding.workspaceId, {
                        libraryType: entry.libraryType,
                        libraryId: entry.libraryId,
                        itemKey: entry.itemKey,
                        attachmentKey: entry.attachmentKey,
                        status: 'inbox',
                        origin: 'collection_sync',
                        itemVersion: entry.itemVersion,
                        attachmentVersion: entry.attachmentVersion
                      });
                      store.syncTopicDocumentAttachment(actor.actorKey, binding.workspaceId, {
                        libraryType: entry.libraryType,
                        libraryId: entry.libraryId,
                        itemKey: entry.itemKey,
                        attachmentKey: entry.attachmentKey,
                        attachmentVersion: entry.attachmentVersion
                      });
                      addedToTopic += 1;
                    }
                  }
                });
              }
            }
          });
        } catch (upstreamErr) {
          error(res, 502, 'upstream_error', `Collection sync failed: ${upstreamErr.message}`);
          return;
        }

        const lastVersion = fetchResult.lastModifiedVersion || binding.lastLibraryVersion || 0;
        const updatedBinding = store.updateCollectionBinding(actor.actorKey, binding.id, binding.version, {
          lastLibraryVersion: lastVersion,
          lastSyncedAt: new Date().toISOString()
        });

        json(res, 200, {
          data: {
            binding: updatedBinding,
            syncedCount: scannedCount,
            addedToTopicCount: addedToTopic,
            lastLibraryVersion: lastVersion
          }
        });
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
      else if (err instanceof TypeError || err.status === 400) error(res, 400, 'invalid_request', err.message);
      else if (err.status === 403) error(res, 403, 'source_forbidden', err.message);
      else if (err.status === 413) error(res, 413, 'payload_too_large', err.message);
      else {
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
