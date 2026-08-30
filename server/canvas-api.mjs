import { CanvasConflictError, CanvasNotFoundError, CanvasStore, canvasEdgeRelations, canvasNodeTypes, canvasActorKey } from './canvas-store.mjs';
import { getSession, getSessionIdFromRequest } from './session.mjs';
import { getAiPublicConfig, requestAiCompletion } from './ai-provider.mjs';

const MAX_BODY_BYTES = Number(process.env.MAX_CANVAS_BODY_BYTES || 512 * 1024);
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

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
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
  const session = getSession(getSessionIdFromRequest(req));
  if (!session) return null;
  const actorKey = canvasActorKey(session.issuer, session.subject);
  return actorKey ? { actorKey, session } : null;
}

export function createCanvasHandler(store, {
  aiCompletion = requestAiCompletion,
  aiPublicConfig = getAiPublicConfig,
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
        json(res, 200, { data: aiPublicConfig() });
        return;
      }
      if (pathname === '/canvas/ai/test' && method === 'POST') {
        const publicConfig = aiPublicConfig();
        if (!publicConfig.configured) {
          error(res, 503, 'ai_not_configured', 'AI 模型尚未在服务器端配置');
          return;
        }
        try {
          await aiCompletion({
            messages: [{ role: 'user', content: 'Reply with OK.' }],
            temperature: 0,
            maxTokens: 5,
          });
          json(res, 200, { data: { ok: true, ...publicConfig } });
        } catch (aiError) {
          error(res, 502, 'ai_gateway_error', aiError.message);
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
        const publicConfig = aiPublicConfig();
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
          });
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
