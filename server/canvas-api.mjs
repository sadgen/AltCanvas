import { CanvasConflictError, CanvasNotFoundError, CanvasStore, canvasEdgeRelations, canvasNodeTypes, canvasActorKey } from './canvas-store.mjs';
import { getSession, getSessionIdFromRequest } from './session.mjs';
import { getAiPublicConfig, requestAiCompletion, validateAiEndpoint } from './ai-provider.mjs';

const MAX_BODY_BYTES = Number(process.env.MAX_CANVAS_BODY_BYTES || 512 * 1024);
const MAX_DOCUMENT_BODY_BYTES = Number(process.env.MAX_AI_DOCUMENT_BODY_BYTES || 768 * 1024);
const MAX_DOCUMENT_TEXT_CHARS = Number(process.env.MAX_AI_DOCUMENT_TEXT_CHARS || 600_000);
const AI_DOCUMENT_CHUNK_CHARS = Number(process.env.AI_DOCUMENT_CHUNK_CHARS || 30_000);
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const AI_TASKS = new Set(['translate', 'synthesize', 'compare', 'explain']);
const AI_PROMPT_VERSION = 'altcanvas-ai-v1';
const MAX_IMPORT_NODES = 500;
const MAX_IMPORT_EDGES = 1000;
let defaultStore;

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
  // A hallucinated quote must not sink the whole graph: keep the card without
  // evidence instead of failing the generation the user already waited for.
  if (!best || best.similarity <= 0) return { evidenceQuote: null, evidencePage: null };
  return { evidenceQuote: best.text, evidencePage: best.pageNumber };
}

function normalizeDocumentGraph(raw, evidenceIndex, pageCount, fallbackTitle) {
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
  const validIds = new Set(['overview', ...sections.map(x => x.id), ...concepts.map(x => x.id), ...claims.map(x => x.id)]);
  const relations = (Array.isArray(raw?.relations) ? raw.relations : []).slice(0, 60).flatMap(item => {
    const from = String(item?.from || '');
    const to = String(item?.to || '');
    if (!validIds.has(from) || !validIds.has(to) || from === to) return [];
    const relation = canvasEdgeRelations.has(item?.relation) ? item.relation : 'related';
    return [{ from, to, relation, label: string(item?.label || '', 'relation.label', { max: 120 }) }];
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

function source(value, session) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('source must be an object');
  const libraryType = value.libraryType;
  if (!['user', 'group'].includes(libraryType)) throw new TypeError('source.libraryType is invalid');
  const libraryId = key(value.libraryId, 'source.libraryId', false);
  const allowed = libraryType === 'user'
    ? libraryId === String(session.userId)
    : (session.groupIds || []).map(String).includes(libraryId);
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
    itemKey: key(value.itemKey, 'source.itemKey'),
    attachmentKey: key(value.attachmentKey, 'source.attachmentKey'),
    annotationKey: key(value.annotationKey, 'source.annotationKey'),
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
  const actorKey = canvasActorKey(session.issuer, session.subject);
  return actorKey ? { actorKey, session } : null;
}

export function createCanvasHandler(store, {
  aiCompletion = requestAiCompletion,
  aiPublicConfig = getAiPublicConfig,
  aiEndpointValidator = validateAiEndpoint,
} = {}) {
  return async function handleCanvasApi(req, res, url) {
    const actor = actorFromRequest(req);
    if (!actor) {
      error(res, 401, 'authentication_required', 'Canvas requires an OIDC-authenticated session');
      return;
    }

    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';
    let match;
    try {
      if (pathname === '/canvas/workspaces' && method === 'GET') {
        json(res, 200, { data: store.listWorkspaces(actor.actorKey) });
        return;
      }
      if (pathname === '/canvas/workspaces' && method === 'POST') {
        const body = await readJson(req);
        const resource = store.createWorkspace(actor.actorKey, {
          name: string(body.name, 'name', { min: 1, max: 200 })
        });
        json(res, 201, { data: resource }, { ETag: etag(resource.version) });
        return;
      }

      if (pathname === '/canvas/ai/config' && method === 'GET') {
        const personal = store.getAiSettings(actor.actorKey);
        json(res, 200, { data: {
          ...aiPublicConfig(personal),
          baseUrl: personal?.baseUrl || '',
          userConfigured: Boolean(personal),
          hasApiKey: Boolean(personal?.apiKey)
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

        const privateConfig = store.getAiSettings(actor.actorKey);
        const publicConfig = aiPublicConfig(privateConfig);
        if (!publicConfig.configured) {
          error(res, 503, 'ai_not_configured', 'AI 模型尚未配置');
          return;
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
                'relation 只能是 related/supports/contradicts/causes/cites/custom。',
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
          const graph = normalizeDocumentGraph(parseAiJson(synthesis), buildEvidenceIndex(pages), body.pages.length, title);
          const result = store.createAiDocumentMap(actor.actorKey, boardId, {
            model: publicConfig.model,
            promptVersion: 'altcanvas-document-map-v1',
            document: { ...documentSource, title, pageCount: body.pages.length },
            graph
          });
          json(res, 201, { data: result });
        } catch (aiError) {
          error(res, aiError?.name === 'AbortError' ? 504 : 502, 'ai_gateway_error', aiError.message);
        }
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
        const resource = store.updateWorkspace(actor.actorKey, match[1], version, {
          name: string(body.name, 'name', { min: 1, max: 200 })
        });
        json(res, 200, { data: resource }, { ETag: etag(resource.version) });
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
        const width = 320;
        const height = task === 'translate' ? 220 : 260;

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

export async function handleCanvasApi(req, res, url) {
  defaultStore ||= new CanvasStore();
  return createCanvasHandler(defaultStore)(req, res, url);
}
