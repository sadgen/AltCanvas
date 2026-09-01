import assert from 'assert/strict';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { CanvasConflictError, CanvasNotFoundError, CanvasStore, canvasActorKey } from '../server/canvas-store.mjs';
import { createCanvasHandler, fetchAllUpstreamItems } from '../server/canvas-api.mjs';
import { createSession, destroySession } from '../server/session.mjs';

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = new Map();
    this.chunks = [];
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    return this;
  }

  end(chunk) {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
    this.emit('finish');
  }

  get text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  get payload() {
    return this.text ? JSON.parse(this.text) : null;
  }
}

function request({ method = 'GET', cookie, headers = {}, body } = {}) {
  const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    socket: { encrypted: false, remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (encoded) yield encoded;
    }
  };
}

async function call(handler, pathname, options) {
  const response = new MockResponse();
  await handler(request(options), response, new URL(pathname, 'http://canvas.test'));
  return response;
}

console.log('🧪 Running AltCanvas Canvas persistence and API tests...');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-canvas-test-'));
const dbPath = path.join(tempDir, 'canvas.sqlite');
const actor = canvasActorKey('https://issuer.example', 'subject-1');
const otherActor = canvasActorKey('https://issuer.example', 'subject-2');
let store = new CanvasStore(dbPath);

try {
  assert.equal(fs.statSync(tempDir).mode & 0o777, 0o700, 'Canvas data directory must be owner-only');
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600, 'Canvas database must be owner-only');
  assert.equal(fs.statSync(path.join(tempDir, 'ai-settings.key')).mode & 0o777, 0o600,
    'AI settings encryption key must be owner-only');
  const workspace = store.createWorkspace(actor, { name: 'Research workspace' });
  const board = store.createBoard(actor, workspace.id, { name: 'Argument map' });
  const annotation = store.createNode(actor, board.id, {
    type: 'annotation', x: 10, y: 20, width: 260, height: 140, zIndex: 1,
    title: 'Evidence', body: 'Quoted evidence', color: 'yellow',
    source: {
      libraryType: 'user', libraryId: '42', itemKey: 'ITEM0001',
      attachmentKey: 'ATTACH01', annotationKey: 'ANN00001', annotationVersion: 7,
      pageLabel: '12', position: { pageIndex: 11 }, quoteSnapshot: 'Quoted evidence'
    }
  });
  const note = store.createNode(actor, board.id, {
    type: 'manual_note', x: 420, y: 30, width: 240, height: 120,
    title: 'Interpretation', body: 'This supports the claim.'
  });
  const edge = store.createEdge(actor, board.id, {
    sourceNodeId: annotation.id, targetNodeId: note.id, relation: 'supports', label: 'supports'
  });

  let snapshot = store.snapshot(actor, board.id);
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.edges.length, 1);
  assert.equal(snapshot.sources.length, 1);
  assert.equal(snapshot.sources[0].annotationKey, 'ANN00001');
  assert.equal(store.getWorkspace(otherActor, workspace.id), null, 'workspaces must be owner isolated');
  assert.equal(store.getBoard(otherActor, board.id), null, 'boards must be owner isolated');

  store.deleteNode(actor, annotation.id, 1);
  assert.equal(store.snapshot(actor, board.id).edges.length, 0, 'deleting a node must hide connected edges');
  const restoredAnnotation = store.restoreNode(actor, annotation.id, 2);
  assert.equal(restoredAnnotation.version, 3);
  assert.equal(store.snapshot(actor, board.id).edges.length, 1, 'restoring a node must restore edges deleted with it');

  const updatedNote = store.updateNode(actor, note.id, 1, { x: 500, body: 'Updated interpretation' });
  assert.equal(updatedNote.version, 2);
  assert.equal(updatedNote.x, 500);
  assert.throws(() => store.updateNode(actor, note.id, 1, { x: 501 }), CanvasConflictError);

  store.saveAiSettings(actor, {
    baseUrl: 'http://127.0.0.1:8317/v1/chat/completions',
    model: 'persistent-model',
    apiKey: 'persistent-secret-key'
  });
  assert.equal(store.getAiSettings(actor).apiKey, 'persistent-secret-key');
  assert.equal(store.getAiSettings(otherActor), null, 'AI settings must be isolated by Canvas owner');
  const encryptedAiRow = store.db.prepare('SELECT api_key_encrypted FROM ai_settings WHERE owner_key = ?').get(actor);
  assert.doesNotMatch(encryptedAiRow.api_key_encrypted, /persistent-secret-key/,
    'AI keys must be encrypted in the Canvas database');

  store.close();
  store = new CanvasStore(dbPath);
  snapshot = store.snapshot(actor, board.id);
  assert.equal(snapshot.nodes.find(node => node.id === note.id).body, 'Updated interpretation');
  assert.equal(snapshot.edges[0].id, edge.id, 'edges must survive database reopen');
  assert.equal(store.getAiSettings(actor).apiKey, 'persistent-secret-key',
    'personal AI settings must survive a database reopen');

  const aiCalls = [];
  const aiPrivateConfigs = [];
  const aiValidatedEndpoints = [];
  const alteroCalls = [];
  const mockAlteroItems = [
    {
      key: 'ALT_ITEM_1',
      version: 10,
      data: {
        key: 'ALT_ITEM_1',
        itemType: 'journalArticle',
        title: 'DeepSeek-V3 Technical Report',
        creators: [{ creatorType: 'author', name: 'DeepSeek-AI' }],
        date: '2024-12-27',
        abstractNote: 'We introduce DeepSeek-V3, a strong Mixture-of-Experts language model...',
        tags: [{ tag: 'llm' }, { tag: 'moe' }],
        collections: ['API_COL_1']
      }
    },
    {
      key: 'ALT_ITEM_2',
      version: 11,
      data: {
        key: 'ALT_ITEM_2',
        itemType: 'journalArticle',
        title: 'Kimi k1.5: Scaling Reinforcement Learning with LLMs',
        creators: [{ creatorType: 'author', name: 'Moonshot AI' }],
        date: '2025-01-20',
        abstractNote: 'Reinforcement learning scaling for long-context models...',
        tags: [{ tag: 'rl' }],
        collections: []
      }
    }
  ];

  const handler = createCanvasHandler(store, {
    aiPublicConfig: () => ({ configured: true, provider: 'mock.example', model: 'mock-model' }),
    aiEndpointValidator: async endpoint => {
      aiValidatedEndpoints.push(endpoint);
      return `${endpoint.replace(/\/+$/, '')}/chat/completions`;
    },
    fetchAltero: async (session, path, options) => {
      alteroCalls.push({ path, options });
      if (path.includes('/children')) {
        const itemKey = path.split('/items/')[1]?.split('/')[0] || 'ITEM';
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => [
            {
              key: `ATT_${itemKey}`,
              version: 5,
              data: {
                itemType: 'attachment',
                contentType: 'application/pdf',
                title: `${itemKey}.pdf`,
                key: `ATT_${itemKey}`,
                version: 5
              }
            }
          ]
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'Last-Modified-Version': '42',
          'Total-Results': String(mockAlteroItems.length)
        }),
        json: async () => mockAlteroItems
      };
    },
    aiCompletion: async (request, privateConfig) => {
      aiCalls.push(request);
      aiPrivateConfigs.push(privateConfig);
      const system = String(request.messages?.[0]?.content || '');
      if (system.includes('空间画板')) {
        if (String(request.messages?.at(-1)?.content || '').includes('文档标题：坏结构')) return 'not-json';
        return JSON.stringify({
          title: '测试论文理解图',
          overview: '研究问题、方法、发现与限制的完整概览。',
          evidenceQuote: '第一页研究问题和方法。', evidencePage: 1,
          sections: [{ title: '研究设计', body: '介绍研究问题与实验设计。', pageStart: 1, pageEnd: 1,
            evidenceQuote: '第一页研究问题和方法。', evidencePage: 1 }],
          concepts: [{ title: '核心概念', body: '定义核心概念及其意义。', pageStart: 1, pageEnd: 2,
            evidenceQuote: '模型改写而非逐字复制的主要发现', evidencePage: 2 }],
          claims: [{ title: '无关论点', body: '量子纠错码与蛋白质结构预测的交叉评述。', pageStart: 2, pageEnd: 2,
            evidenceQuote: '本句为杜撰示例并不存在于论文原文之中', evidencePage: 2 }],
          relations: [{ from: 'section-0', to: 'claim-0', relation: 'supports', label: '支撑' }]
        });
      }
      if (system.includes('逐段阅读') || system.includes('逐段阅读助手') || system.includes('结构化中间笔记')) {
        return '第 1–2 页：研究问题、方法、核心发现和限制。';
      }
      if (system.includes('分类') || system.includes('研究主题')) {
        return JSON.stringify({
          classifications: {
            'API_INBOX_1': [
              { workspaceId: 'ws-1', workspaceName: 'API Research Topic', confidence: 0.95, reason: '符合纳入规则：深入探讨推理机制' }
            ]
          }
        });
      }
      if (system.includes('研报元数据')) {
        return JSON.stringify({
          institution: '中金公司',
          reportTitle: '人形机器人产业链深度',
          subtitle: '从核心零部件到整机制造',
          year: '2024',
          cleanTitle: '【中金公司】人形机器人产业链深度：从核心零部件到整机制造（2024）',
          summary: '深度解析人形机器人产业链核心环节。'
        });
      }
      if (system.includes('跨文档关联') || system.includes('跨报告')) {
        return JSON.stringify({
          relations: [
            {
              unitId: 'unit-target-1',
              relationType: 'supports',
              confidence: 0.92,
              reason: '外部报告提供了相同的实证支持'
            },
            {
              unitId: 'unit-target-2',
              relationType: 'contradicts',
              confidence: 0.85,
              reason: '外部报告在小样本情境下得出了相反结论'
            }
          ]
        });
      }
      if (system.includes('学术翻译助手')) return '忠实的中文译文。';
      return '【学术分析】综合来看，两篇文献在核心假设上保持一致。';
    }
  });
  const unauthenticated = await call(handler, '/canvas/workspaces');
  assert.equal(unauthenticated.statusCode, 401);

  const session = createSession({
    userId: '42', subject: 'api-subject', issuer: 'https://issuer.example',
    username: 'researcher', accessToken: 'not-used-by-canvas',
    scopes: ['library.read'], groupIds: ['7']
  });
  const cookie = `altcanvas_session=${session.id}`;

  const createdWorkspaceResponse = await call(handler, '/canvas/workspaces', {
    method: 'POST', cookie, body: { name: 'API workspace' }
  });
  assert.equal(createdWorkspaceResponse.statusCode, 201);
  assert.equal(createdWorkspaceResponse.getHeader('etag'), 'W/"1"');
  const apiWorkspace = createdWorkspaceResponse.payload.data;

  const missingPrecondition = await call(handler, `/canvas/workspaces/${apiWorkspace.id}`, {
    method: 'PATCH', cookie, body: { name: 'No version' }
  });
  assert.equal(missingPrecondition.statusCode, 428);

  const updatedWorkspaceResponse = await call(handler, `/canvas/workspaces/${apiWorkspace.id}`, {
    method: 'PATCH', cookie, headers: { 'if-match': 'W/"1"' }, body: { name: 'Renamed workspace' }
  });
  assert.equal(updatedWorkspaceResponse.statusCode, 200);
  assert.equal(updatedWorkspaceResponse.payload.data.version, 2);

  const staleWorkspaceResponse = await call(handler, `/canvas/workspaces/${apiWorkspace.id}`, {
    method: 'PATCH', cookie, headers: { 'if-match': 'W/"1"' }, body: { name: 'Stale rename' }
  });
  assert.equal(staleWorkspaceResponse.statusCode, 412);

  const boardResponse = await call(handler, `/canvas/workspaces/${apiWorkspace.id}/boards`, {
    method: 'POST', cookie, body: { name: 'API board' }
  });
  assert.equal(boardResponse.statusCode, 201);
  const apiBoard = boardResponse.payload.data;

  const forbiddenSource = await call(handler, `/canvas/boards/${apiBoard.id}/nodes`, {
    method: 'POST', cookie,
    body: {
      type: 'annotation', x: 0, y: 0, width: 240, height: 120,
      source: { libraryType: 'group', libraryId: '8', annotationKey: 'ANN00002' }
    }
  });
  assert.equal(forbiddenSource.statusCode, 403);

  const groupNodeResponse = await call(handler, `/canvas/boards/${apiBoard.id}/nodes`, {
    method: 'POST', cookie,
    body: {
      type: 'annotation', x: 0, y: 0, width: 240, height: 120,
      title: 'Group source',
      source: { libraryType: 'group', libraryId: '7', annotationKey: 'ANN00003' }
    }
  });
  assert.equal(groupNodeResponse.statusCode, 201);

  const deletedGroupNodeResponse = await call(handler, `/canvas/nodes/${groupNodeResponse.payload.data.id}`, {
    method: 'DELETE', cookie, headers: { 'if-match': 'W/"1"' }
  });
  assert.equal(deletedGroupNodeResponse.statusCode, 204);
  const restoredGroupNodeResponse = await call(handler, `/canvas/nodes/${groupNodeResponse.payload.data.id}/restore`, {
    method: 'PATCH', cookie, headers: { 'if-match': 'W/"2"' }
  });
  assert.equal(restoredGroupNodeResponse.statusCode, 200);
  assert.equal(restoredGroupNodeResponse.payload.data.version, 3);

  const manualNodeResponse = await call(handler, `/canvas/boards/${apiBoard.id}/nodes`, {
    method: 'POST', cookie,
    body: { type: 'manual_note', x: 300, y: 0, width: 240, height: 120, body: 'Manual note' }
  });
  assert.equal(manualNodeResponse.statusCode, 201);

  const edgeResponse = await call(handler, `/canvas/boards/${apiBoard.id}/edges`, {
    method: 'POST', cookie,
    body: {
      sourceNodeId: groupNodeResponse.payload.data.id,
      targetNodeId: manualNodeResponse.payload.data.id,
      relation: 'related'
    }
  });
  assert.equal(edgeResponse.statusCode, 201);

  const apiSnapshotResponse = await call(handler, `/canvas/boards/${apiBoard.id}/snapshot`, { cookie });
  assert.equal(apiSnapshotResponse.statusCode, 200);
  assert.equal(apiSnapshotResponse.payload.data.nodes.length, 2);
  assert.equal(apiSnapshotResponse.payload.data.edges.length, 1);
  assert.equal(apiSnapshotResponse.payload.data.sources[0].libraryId, '7');

  const layoutResponse = await call(handler, `/canvas/boards/${apiBoard.id}/layout`, {
    method: 'PATCH', cookie, headers: { 'if-match': 'W/"1"' },
    body: {
      viewport: { x: 20, y: 30, zoom: 1.25 },
      nodes: apiSnapshotResponse.payload.data.nodes.map(node => ({
        id: node.id, version: node.version, x: node.x + 10, y: node.y + 10,
        width: node.width, height: node.height, zIndex: node.zIndex
      }))
    }
  });
  assert.equal(layoutResponse.statusCode, 200);
  assert.equal(layoutResponse.payload.data.board.viewport.zoom, 1.25);
  assert.deepEqual(layoutResponse.payload.data.nodes.map(node => node.version).sort(), [2, 4]);

  const layoutBeforeConflict = layoutResponse.payload.data;
  const conflictingLayoutResponse = await call(handler, `/canvas/boards/${apiBoard.id}/layout`, {
    method: 'PATCH', cookie, headers: { 'if-match': 'W/"2"' },
    body: {
      viewport: { x: 999, y: 999, zoom: 2 },
      nodes: layoutBeforeConflict.nodes.map((node, index) => ({
        id: node.id, version: index === 0 ? node.version : 1,
        x: node.x + 100, y: node.y + 100,
        width: node.width, height: node.height, zIndex: node.zIndex
      }))
    }
  });
  assert.equal(conflictingLayoutResponse.statusCode, 412);
  const afterConflict = store.snapshot(canvasActorKey('https://issuer.example', 'api-subject'), apiBoard.id);
  assert.deepEqual(afterConflict.board.viewport, layoutBeforeConflict.board.viewport, 'failed layout must roll back viewport');
  assert.deepEqual(afterConflict.nodes.map(node => node.version).sort(), [2, 4], 'failed layout must roll back every node');

  const groupNodeAfterLayout = afterConflict.nodes.find(node => node.id === groupNodeResponse.payload.data.id);
  const relinkedSourceResponse = await call(handler, `/canvas/nodes/${groupNodeAfterLayout.id}/source`, {
    method: 'PATCH', cookie, headers: { 'if-match': `W/"${groupNodeAfterLayout.version}"` },
    body: {
      source: {
        libraryType: 'group', libraryId: '7', itemKey: 'ITEM0001',
        attachmentKey: 'ATTACH02', annotationKey: 'ANNREST1', annotationVersion: 11,
        pageLabel: '9', position: { pageIndex: 8, rects: [[8, 10, 10, 40, 20]] },
        quoteSnapshot: 'Restored quoted evidence'
      }
    }
  });
  assert.equal(relinkedSourceResponse.statusCode, 200);
  assert.equal(relinkedSourceResponse.payload.data.node.version, groupNodeAfterLayout.version + 1);
  assert.equal(relinkedSourceResponse.payload.data.source.annotationKey, 'ANNREST1');
  assert.equal(relinkedSourceResponse.payload.data.source.quoteSnapshot, 'Restored quoted evidence');

  const staleRelinkResponse = await call(handler, `/canvas/nodes/${groupNodeAfterLayout.id}/source`, {
    method: 'PATCH', cookie, headers: { 'if-match': `W/"${groupNodeAfterLayout.version}"` },
    body: {
      source: {
        libraryType: 'group', libraryId: '7', attachmentKey: 'ATTACH02',
        annotationKey: 'ANNDUPE1'
      }
    }
  });
  assert.equal(staleRelinkResponse.statusCode, 412, 'source relinking must reject stale card versions');

  const forbiddenRelinkResponse = await call(handler, `/canvas/nodes/${groupNodeAfterLayout.id}/source`, {
    method: 'PATCH', cookie, headers: { 'if-match': `W/"${groupNodeAfterLayout.version + 1}"` },
    body: {
      source: {
        libraryType: 'group', libraryId: '8', attachmentKey: 'ATTACH02',
        annotationKey: 'ANNNOAUTH'
      }
    }
  });
  assert.equal(forbiddenRelinkResponse.statusCode, 403, 'source relinking must enforce library membership');

  const oversizedResponse = await call(handler, '/canvas/workspaces', {
    method: 'POST', cookie, body: { name: 'x'.repeat(600_000) }
  });
  assert.equal(oversizedResponse.statusCode, 413);

  // --- C3 tests: Export, Import, Provenance ---
  const exportResponse = await call(handler, `/canvas/boards/${apiBoard.id}/export`, { cookie });
  assert.equal(exportResponse.statusCode, 200);
  const bundle = exportResponse.payload.data;
  assert.equal(bundle.format, 'altcanvas-board-export');
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.board.id, apiBoard.id);
  assert.equal(bundle.nodes.length, 2);
  assert.equal(bundle.edges.length, 1);
  assert.equal(bundle.sources.length, 1);

  const importResponse = await call(handler, `/canvas/workspaces/${apiWorkspace.id}/boards/import`, {
    method: 'POST', cookie, body: { bundle, name: 'Cloned Research Board' }
  });
  assert.equal(importResponse.statusCode, 201);
  const importedSnapshot = importResponse.payload.data;
  assert.notEqual(importedSnapshot.board.id, apiBoard.id);
  assert.equal(importedSnapshot.board.name, 'Cloned Research Board');
  assert.equal(importedSnapshot.nodes.length, 2);
  assert.equal(importedSnapshot.edges.length, 1);
  assert.equal(importedSnapshot.sources.length, 1);
  // Verify that nodes received new IDs
  assert.ok(!importedSnapshot.nodes.some(n => n.id === groupNodeResponse.payload.data.id));
  assert.ok(!importedSnapshot.nodes.some(n => n.id === manualNodeResponse.payload.data.id));
  // Verify edge connects the newly generated node IDs correctly
  const importedSourceNode = importedSnapshot.nodes.find(n => n.type === 'annotation');
  const importedTargetNode = importedSnapshot.nodes.find(n => n.type === 'manual_note');
  assert.equal(importedSnapshot.edges[0].sourceNodeId, importedSourceNode.id);
  assert.equal(importedSnapshot.edges[0].targetNodeId, importedTargetNode.id);

  const forbiddenImportBundle = structuredClone(bundle);
  forbiddenImportBundle.sources[0].libraryId = '8';
  const forbiddenImport = await call(handler, `/canvas/workspaces/${apiWorkspace.id}/boards/import`, {
    method: 'POST', cookie, body: { bundle: forbiddenImportBundle }
  });
  assert.equal(forbiddenImport.statusCode, 403, 'import must re-check source library membership');

  const invalidImportBundle = structuredClone(bundle);
  invalidImportBundle.nodes[0].x = 'not-a-number';
  const invalidImport = await call(handler, `/canvas/workspaces/${apiWorkspace.id}/boards/import`, {
    method: 'POST', cookie, body: { bundle: invalidImportBundle }
  });
  assert.equal(invalidImport.statusCode, 400, 'import must reject invalid node geometry atomically');

  const boardProvenanceResponse = await call(handler, `/canvas/boards/${apiBoard.id}/provenance`, { cookie });
  assert.equal(boardProvenanceResponse.statusCode, 200);
  const boardEvents = boardProvenanceResponse.payload.data;
  assert.ok(boardEvents.length > 0);
  assert.ok(boardEvents.some(e => e.type === 'node.created'));
  assert.ok(boardEvents.some(e => e.type === 'node.source_relinked'));

  const workspaceProvenanceResponse = await call(handler, `/canvas/workspaces/${apiWorkspace.id}/provenance`, { cookie });
  assert.equal(workspaceProvenanceResponse.statusCode, 200);
  const wsEvents = workspaceProvenanceResponse.payload.data;
  assert.ok(wsEvents.some(e => e.type === 'board.imported'));

  // --- C5 AI Node Creation & Endpoint Tests ---
  const apiActor = canvasActorKey('https://issuer.example', 'api-subject');
  const directAiResult = store.createAiSynthesisNode(apiActor, apiBoard.id, {
    task: 'translate',
    model: 'mock-model',
    promptVersion: 'test-v1',
    prompt: '',
    inputNodeIds: [groupNodeResponse.payload.data.id],
    title: 'AI 忠实中译: 导言',
    body: '这是对原文献卡片的逐句忠实中文翻译内容。',
    x: 600,
    y: 100,
    width: 320,
    height: 220
  });
  assert.equal(directAiResult.node.type, 'ai_output');
  assert.equal(directAiResult.node.color, '#8b5cf6');
  assert.equal(directAiResult.edges.length, 1);
  assert.equal(directAiResult.edges[0].relation, 'cites');

  const aiConfigResponse = await call(handler, '/canvas/ai/config', { cookie });
  assert.equal(aiConfigResponse.statusCode, 200);
  assert.deepEqual(aiConfigResponse.payload.data, {
    configured: true, provider: 'mock.example', model: 'mock-model',
    baseUrl: '', userConfigured: false, hasApiKey: false
  });

  const savedAiConfigResponse = await call(handler, '/canvas/ai/config', {
    method: 'POST', cookie,
    body: { baseUrl: 'https://user-ai.example/v1', model: 'personal-model', apiKey: 'personal-secret-key' }
  });
  assert.equal(savedAiConfigResponse.statusCode, 200);
  assert.equal(savedAiConfigResponse.payload.data.userConfigured, true);
  assert.equal(savedAiConfigResponse.payload.data.hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(savedAiConfigResponse.payload), /personal-secret-key/);
  assert.deepEqual(aiValidatedEndpoints, ['https://user-ai.example/v1']);
  const savedPrivateAiConfig = store.getAiSettings(canvasActorKey('https://issuer.example', 'api-subject'));
  assert.equal(savedPrivateAiConfig.apiKey, 'personal-secret-key');

  const aiTestResponse = await call(handler, '/canvas/ai/test', { method: 'POST', cookie, body: {} });
  assert.equal(aiTestResponse.statusCode, 200);
  assert.equal(aiPrivateConfigs.at(-1).apiKey, 'personal-secret-key');

  const inlineTranslationResponse = await call(handler, '/canvas/ai/translate', {
    method: 'POST', cookie, body: { text: 'A carefully selected passage.' }
  });
  assert.equal(inlineTranslationResponse.statusCode, 200);
  assert.equal(inlineTranslationResponse.payload.data.translation, '忠实的中文译文。');

  const documentMapResponse = await call(handler, `/canvas/boards/${apiBoard.id}/ai/document-map`, {
    method: 'POST', cookie, body: {
      title: '测试论文',
      document: {
        libraryType: 'user', libraryId: '42', itemKey: 'DOC1', attachmentKey: 'PDF1', attachmentVersion: 1
      },
      pages: [
        { pageNumber: 1, text: '第一页研究问题和方法。' },
        { pageNumber: 2, text: '第二页主要发现和限制。' }
      ]
    }
  });
  assert.equal(documentMapResponse.statusCode, 201);
  assert.equal(documentMapResponse.payload.data.nodes.length, 4);
  assert.ok(documentMapResponse.payload.data.edges.length >= 3);
  const mappedSnapshot = store.snapshot(canvasActorKey('https://issuer.example', 'api-subject'), apiBoard.id);
  const mappedSources = new Map(mappedSnapshot.sources.map(item => [item.id, item]));
  assert.ok(documentMapResponse.payload.data.nodes.every(node => mappedSources.get(node.sourceRefId)?.attachmentKey === 'PDF1'));
  assert.ok(documentMapResponse.payload.data.nodes.every(node => mappedSources.get(node.sourceRefId)?.quoteSnapshot),
    'every document-map card must carry a verbatim PDF quote so it can be highlighted');
  const conceptNode = documentMapResponse.payload.data.nodes.find(node => node.title.startsWith('概念 · '));
  assert.equal(mappedSources.get(conceptNode.sourceRefId).quoteSnapshot, '第二页主要发现和限制。',
    'a paraphrased model citation must be repaired to an exact sentence from the PDF');
  const fabricatedClaimNode = documentMapResponse.payload.data.nodes.find(node => node.title.startsWith('论点 · '));
  assert.equal(mappedSources.get(fabricatedClaimNode.sourceRefId).quoteSnapshot, '第二页主要发现和限制。',
    'a fabricated citation must anchor to a real sentence within its claimed page range');
  assert.equal(mappedSources.get(fabricatedClaimNode.sourceRefId).pageLabel, '2',
    'a fabricated citation must stay inside its claimed page range');
  assert.ok(documentMapResponse.payload.data.nodes.some(node => node.title === '全文概览 · 测试论文理解图'));
  assert.ok(documentMapResponse.payload.data.nodes.some(node => node.title.startsWith('章节 · ')));
  assert.ok(documentMapResponse.payload.data.nodes.some(node => node.title.startsWith('概念 · ')));
  assert.ok(documentMapResponse.payload.data.nodes.some(node => node.title.startsWith('论点 · ')));

  // --- T2 Document Analysis Cache Reuse across Topics ---
  const topic2WsRes = await call(handler, '/canvas/workspaces', {
    method: 'POST', cookie, body: { name: 'Topic 2 for Analysis Reuse' }
  });
  const topic2Ws = topic2WsRes.payload.data;
  const boardInTopic2Res = await call(handler, `/canvas/workspaces/${topic2Ws.id}/boards`, {
    method: 'POST', cookie, body: { name: 'Board in Topic 2' }
  });
  const boardInTopic2 = boardInTopic2Res.payload.data;

  const aiCallsBeforeCachedMap = aiCalls.length;
  const cachedDocumentMapResponse = await call(handler, `/canvas/boards/${boardInTopic2.id}/ai/document-map`, {
    method: 'POST', cookie, body: {
      title: '测试论文理解图 (Topic 2)',
      document: {
        libraryType: 'user',
        libraryId: '42',
        itemKey: 'DOC1',
        attachmentKey: 'PDF1',
        attachmentVersion: 1
      },
      pages: [
        { pageNumber: 1, text: '第一页研究问题和方法。' },
        { pageNumber: 2, text: '第二页主要发现和限制。' }
      ]
    }
  });
  assert.equal(cachedDocumentMapResponse.statusCode, 201);
  assert.equal(cachedDocumentMapResponse.payload.data.cached, true, 'Second document-map call on same PDF must hit cache');
  assert.equal(aiCalls.length, aiCallsBeforeCachedMap, 'Cached document-map must NOT make additional AI model calls');
  assert.equal(cachedDocumentMapResponse.payload.data.nodes.length, 4);

  // Independent projection isolation: node IDs on board 2 are distinct from board 1
  const board1NodeIds = new Set(documentMapResponse.payload.data.nodes.map(n => n.id));
  assert.ok(cachedDocumentMapResponse.payload.data.nodes.every(n => !board1NodeIds.has(n.id)), 'Projected cards in second topic must have distinct node IDs');

  // Cache invalidation when attachmentVersion changes
  const aiCallsBeforeVersionUpdate = aiCalls.length;
  const updatedVersionMapResponse = await call(handler, `/canvas/boards/${boardInTopic2.id}/ai/document-map`, {
    method: 'POST', cookie, body: {
      title: '测试论文理解图 (Updated Version)',
      document: {
        libraryType: 'user',
        libraryId: '42',
        itemKey: 'DOC1',
        attachmentKey: 'PDF1',
        attachmentVersion: 2 // New version
      },
      pages: [
        { pageNumber: 1, text: '第一页研究问题和方法（更新版本）。' },
        { pageNumber: 2, text: '第二页主要发现和限制（更新版本）。' }
      ]
    }
  });
  assert.equal(updatedVersionMapResponse.statusCode, 201);
  assert.equal(updatedVersionMapResponse.payload.data.cached, false, 'Updated attachment version must bypass stale cache and regenerate');
  assert.ok(aiCalls.length > aiCallsBeforeVersionUpdate, 'Must call AI when attachmentVersion changes');

  // Strict unversioned cache isolation: unversioned request must NOT match a versioned cache record
  store.saveDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_VERSIONED', attachmentKey: 'PDF_V2_ONLY',
    attachmentVersion: 2, model: 'mock-model', promptVersion: 'altcanvas-document-map-v1',
    status: 'ready', documentTitle: 'Version 2 Only', pageCount: 1, graph: { overview: 'Version 2 Analysis' }
  });

  const unversionedLookup = store.getDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', attachmentKey: 'PDF_V2_ONLY', attachmentVersion: null,
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v1'
  });
  assert.equal(unversionedLookup, null, 'Unversioned lookup must not match versioned cache record');

  const mismatchedVersionLookup = store.getDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', attachmentKey: 'PDF_V2_ONLY', attachmentVersion: 3,
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v1'
  });
  assert.equal(mismatchedVersionLookup, null, 'Version 3 lookup must not match version 2 cache record');

  const beforeMalformedMap = store.snapshot(canvasActorKey('https://issuer.example', 'api-subject'), apiBoard.id);
  const malformedMapResponse = await call(handler, `/canvas/boards/${apiBoard.id}/ai/document-map`, {
    method: 'POST', cookie, body: {
      title: '坏结构',
      document: { libraryType: 'user', libraryId: '42', itemKey: 'DOC_MALFORMED', attachmentKey: 'PDF_MALFORMED' },
      pages: [{ pageNumber: 1, text: '有效的输入正文。' }]
    }
  });
  assert.equal(malformedMapResponse.statusCode, 502);
  const afterMalformedMap = store.snapshot(canvasActorKey('https://issuer.example', 'api-subject'), apiBoard.id);
  assert.equal(afterMalformedMap.nodes.length, beforeMalformedMap.nodes.length,
    'malformed AI graph output must not leave a partial document map');

  const aiApiRes = await call(handler, `/canvas/boards/${apiBoard.id}/ai/generate`, {
    method: 'POST',
    cookie,
    body: {
      task: 'synthesize',
      prompt: '提取共同点',
      inputNodeIds: [groupNodeResponse.payload.data.id, manualNodeResponse.payload.data.id],
      modelConfig: { endpoint: 'http://127.0.0.1:1', apiKey: 'must-be-ignored', model: 'untrusted-model' }
    }
  });
  assert.equal(aiApiRes.statusCode, 201);
  assert.equal(aiApiRes.payload.data.node.type, 'ai_output');
  assert.match(aiApiRes.payload.data.node.body, /【学术分析】/);
  assert.equal(aiApiRes.payload.data.edges.length, 2);
  assert.ok(aiCalls.at(-1).messages.length >= 2);
  assert.equal(aiPrivateConfigs.at(-1).model, 'personal-model');
  assert.equal('endpoint' in aiCalls.at(-1), false, 'browser endpoint must never reach the AI client');

  const badAiRes = await call(handler, `/canvas/boards/${apiBoard.id}/ai/generate`, {
    method: 'POST', cookie, body: { task: 'synthesize', inputNodeIds: [] }
  });
  assert.equal(badAiRes.statusCode, 400);

  // --- Schema v2 -> v3 Migration Test with Authentic DDL and Data Fidelity ---
  const v2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-v2-migration-test-'));
  const v2DbPath = path.join(v2Dir, 'canvas-v2.sqlite');
  try {
    const rawV2 = new DatabaseSync(v2DbPath);
    // Pre-create authentic ai-settings.key and AES-256-GCM encrypted secret
    const v2Key = crypto.randomBytes(32);
    fs.writeFileSync(path.join(v2Dir, 'ai-settings.key'), v2Key.toString('base64'), { mode: 0o600 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', v2Key, iv);
    const encryptedSecret = Buffer.concat([cipher.update('sk-migrated-secret-key-12345', 'utf8'), cipher.final()]);
    const encryptedPayload = JSON.stringify({
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encryptedSecret.toString('base64')
    });

    rawV2.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;

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

      CREATE TABLE ai_settings (
        owner_key TEXT PRIMARY KEY,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key_encrypted TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-08-30T00:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (2, '2026-08-30T01:00:00.000Z');

      INSERT INTO workspaces (id, owner_key, name, version, created_at, updated_at)
        VALUES ('v2-ws-1', '${actor}', 'V2 Legacy Workspace', 1, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO boards (id, workspace_id, name, viewport_x, viewport_y, viewport_zoom, version, created_at, updated_at)
        VALUES ('v2-board-1', 'v2-ws-1', 'V2 Board', 120.5, 240.0, 1.25, 1, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO source_refs (id, owner_key, library_type, library_id, item_key, attachment_key, annotation_key, annotation_version, page_label, position_json, quote_snapshot, created_at, updated_at)
        VALUES ('v2-src-1', '${actor}', 'user', '42', 'ITEM_V2', 'ATT_V2', 'ANN_V2', 1, 'p. 42', '{"rects":[[0,0,10,10]]}', 'Evidence quote from v2', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO nodes (id, board_id, node_type, x, y, width, height, z_index, title, body, color, source_ref_id, version, created_at, updated_at)
        VALUES ('v2-node-1', 'v2-board-1', 'annotation', 100, 200, 320, 240, 1, 'V2 Annotation Node', 'V2 Body', '#fef08a', 'v2-src-1', 1, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO nodes (id, board_id, node_type, x, y, width, height, z_index, title, body, color, source_ref_id, version, created_at, updated_at)
        VALUES ('v2-node-2', 'v2-board-1', 'manual_note', 450, 200, 320, 240, 2, 'V2 Note Node', 'V2 Note Body', NULL, NULL, 1, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO edges (id, board_id, source_node_id, target_node_id, relation, label, version, created_at, updated_at)
        VALUES ('v2-edge-1', 'v2-board-1', 'v2-node-1', 'v2-node-2', 'supports', 'supports finding', 1, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO provenance_events (id, workspace_id, board_id, node_id, actor_key, event_type, payload_json, created_at)
        VALUES ('v2-prov-1', 'v2-ws-1', 'v2-board-1', 'v2-node-1', '${actor}', 'node.created', '{"title":"V2 Annotation Node"}', '2026-08-30T00:00:00.000Z');
      INSERT INTO ai_settings (owner_key, base_url, model, api_key_encrypted, created_at, updated_at)
        VALUES ('${actor}', 'https://api.openai.com/v1', 'gpt-4o', '${encryptedPayload.replace(/'/g, "''")}', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
    `);
    rawV2.close();

    const migratedStore = new CanvasStore(v2DbPath);
    const maxV = migratedStore.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    assert.equal(maxV, 10, 'Database must be upgraded to schema v10');

    // Verify document_metas table and methods
    const savedMeta = migratedStore.saveDocumentMeta(actor, {
      libraryType: 'user', libraryId: '42', itemKey: 'MIG_ITEM_1',
      cleanTitle: '【中金公司】人形机器人深度研究（2024）', institution: '中金公司',
      reportTitle: '人形机器人深度研究', year: '2024', summary: '核心产业链全景'
    });
    assert.equal(savedMeta.cleanTitle, '【中金公司】人形机器人深度研究（2024）');
    const fetchedMeta = migratedStore.getDocumentMeta(actor, { libraryType: 'user', libraryId: '42', itemKey: 'MIG_ITEM_1' });
    assert.equal(fetchedMeta.cleanTitle, '【中金公司】人形机器人深度研究（2024）');

    // Verify document_analyses table and cache methods
    const savedAnalysis = migratedStore.saveDocumentAnalysis(actor, {
      libraryType: 'user', libraryId: '42', itemKey: 'MIG_ITEM_1', attachmentKey: 'ATT_1', attachmentVersion: 1,
      model: 'gpt-4o', promptVersion: 'v1', status: 'ready', documentTitle: 'Migrated Analysis',
      pageCount: 5, graph: { overview: 'Cached Overview' }
    });
    assert.equal(savedAnalysis.documentTitle, 'Migrated Analysis');
    const fetchedAnalysis = migratedStore.getDocumentAnalysis(actor, {
      libraryType: 'user', libraryId: '42', attachmentKey: 'ATT_1', attachmentVersion: 1, model: 'gpt-4o', promptVersion: 'v1'
    });
    assert.equal(fetchedAnalysis.graph.overview, 'Cached Overview');

    // Verify repeated unversioned analysis saving does not trigger UNIQUE constraint crash
    const unversioned1 = migratedStore.saveDocumentAnalysis(actor, {
      libraryType: 'user', libraryId: '42', itemKey: 'MIG_ITEM_2', attachmentKey: 'ATT_UNVERSIONED',
      attachmentVersion: null, model: 'gpt-4o', promptVersion: 'v1', status: 'ready',
      documentTitle: 'Unversioned 1', pageCount: 2, graph: { overview: 'Unversioned Overview 1' }
    });
    assert.equal(unversioned1.documentTitle, 'Unversioned 1');

    const unversioned2 = migratedStore.saveDocumentAnalysis(actor, {
      libraryType: 'user', libraryId: '42', itemKey: 'MIG_ITEM_2', attachmentKey: 'ATT_UNVERSIONED',
      attachmentVersion: null, model: 'gpt-4o', promptVersion: 'v1', status: 'ready',
      documentTitle: 'Unversioned 2 Updated', pageCount: 2, graph: { overview: 'Unversioned Overview 2' }
    });
    assert.equal(unversioned2.documentTitle, 'Unversioned 2 Updated');

    // 1. Workspace schema evolution & defaults
    const legacyWs = migratedStore.getWorkspace(actor, 'v2-ws-1');
    assert.equal(legacyWs.name, 'V2 Legacy Workspace');
    assert.equal(legacyWs.description, '', 'Upgraded workspace should have empty string description default');
    assert.equal(legacyWs.researchQuestion, '', 'Upgraded workspace should have empty string researchQuestion default');
    assert.equal(legacyWs.inclusionRules, '');
    assert.equal(legacyWs.exclusionRules, '');

    // 2. Board & viewport fidelity
    const boards = migratedStore.listBoards(actor, 'v2-ws-1');
    assert.equal(boards.length, 1);
    assert.equal(boards[0].viewport.x, 120.5);
    assert.equal(boards[0].viewport.y, 240.0);
    assert.equal(boards[0].viewport.zoom, 1.25);

    // 3. Nodes, Edges, and Source references fidelity
    const snap = migratedStore.snapshot(actor, 'v2-board-1');
    assert.equal(snap.nodes.length, 2);
    const annNode = snap.nodes.find(n => n.id === 'v2-node-1');
    const noteNode = snap.nodes.find(n => n.id === 'v2-node-2');
    assert.equal(annNode.type, 'annotation');
    assert.equal(annNode.title, 'V2 Annotation Node');
    assert.equal(annNode.sourceRefId, 'v2-src-1');
    assert.equal(noteNode.type, 'manual_note');

    assert.equal(snap.edges.length, 1);
    assert.equal(snap.edges[0].relation, 'supports');
    assert.equal(snap.edges[0].label, 'supports finding');

    const sourceObj = snap.sources.find(s => s.id === 'v2-src-1');
    assert.ok(sourceObj);
    assert.equal(sourceObj.quoteSnapshot, 'Evidence quote from v2');

    // 4. AI settings and encrypted key decryption fidelity
    const aiConfig = migratedStore.getAiSettings(actor);
    assert.equal(aiConfig.baseUrl, 'https://api.openai.com/v1');
    assert.equal(aiConfig.model, 'gpt-4o');
    assert.equal(aiConfig.apiKey, 'sk-migrated-secret-key-12345', 'Encrypted API key must be successfully decrypted after migration');

    // 5. Provenance events fidelity
    const provEvents = migratedStore.db.prepare('SELECT * FROM provenance_events WHERE workspace_id = ?').all('v2-ws-1');
    assert.equal(provEvents.length, 1);
    assert.equal(provEvents[0].actor_key, actor);
    assert.equal(provEvents[0].event_type, 'node.created');
    assert.equal(provEvents[0].node_id, 'v2-node-1');

    // 6. V3 Operations on migrated DB
    const updatedWs = migratedStore.updateWorkspace(actor, 'v2-ws-1', 1, {
      researchQuestion: 'Migrated question?'
    });
    assert.equal(updatedWs.researchQuestion, 'Migrated question?');
    assert.equal(updatedWs.version, 2);

    const migratedDoc = migratedStore.addTopicDocument(actor, 'v2-ws-1', {
      libraryType: 'user', libraryId: '42', itemKey: 'MIG_ITEM_1'
    });
    assert.equal(migratedDoc.itemKey, 'MIG_ITEM_1');
    assert.equal(migratedDoc.version, 1);

    migratedStore.close();
  } finally {
    fs.rmSync(v2Dir, { recursive: true, force: true });
  }

  // --- Schema v5 -> v6 Migration Test (Upgrading legacy document_analyses index) ---
  const v5Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-v5-migration-test-'));
  const v5DbPath = path.join(v5Dir, 'canvas-v5.sqlite');
  try {
    const rawV5 = new DatabaseSync(v5DbPath);
    rawV5.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-08-30T00:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (2, '2026-08-30T01:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (3, '2026-08-31T00:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (4, '2026-08-31T01:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (5, '2026-08-31T02:00:00.000Z');

      CREATE TABLE workspaces (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, description TEXT NOT NULL DEFAULT '', research_question TEXT NOT NULL DEFAULT '', inclusion_rules TEXT NOT NULL DEFAULT '', exclusion_rules TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT) STRICT;
      CREATE TABLE document_analyses (
        id TEXT PRIMARY KEY,
        owner_key TEXT NOT NULL,
        library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group')),
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
      -- Legacy v5 index (without COALESCE)
      CREATE UNIQUE INDEX document_analyses_unique_cache_idx
        ON document_analyses(owner_key, library_type, library_id, attachment_key, model, prompt_version);

      INSERT INTO document_analyses (id, owner_key, library_type, library_id, item_key, attachment_key, attachment_version, model, prompt_version, status, document_title, page_count, graph_json, created_at, updated_at)
        VALUES ('v5-analysis-1', '${actor}', 'user', '42', 'ITEM_V5', 'ATT_V5', 1, 'gpt-4o', 'v1', 'ready', 'V5 Title', 2, '{"overview":"V5 Overview"}', '2026-08-31T02:00:00.000Z', '2026-08-31T02:00:00.000Z');
    `);
    rawV5.close();

    const migratedV5Store = new CanvasStore(v5DbPath);
    const maxV = migratedV5Store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    assert.equal(maxV, 10, 'Database must be upgraded from v5 to v10');

    const v5Analysis = migratedV5Store.getDocumentAnalysis(actor, {
      libraryType: 'user', libraryId: '42', attachmentKey: 'ATT_V5', attachmentVersion: 1, model: 'gpt-4o', promptVersion: 'v1'
    });
    assert.ok(v5Analysis);
    assert.equal(v5Analysis.documentTitle, 'V5 Title');

    // Save another version under upgraded index
    migratedV5Store.saveDocumentAnalysis(actor, {
      libraryType: 'user', libraryId: '42', itemKey: 'ITEM_V5', attachmentKey: 'ATT_V5', attachmentVersion: 2,
      model: 'gpt-4o', promptVersion: 'v1', status: 'ready', documentTitle: 'V5 Version 2', pageCount: 2, graph: { overview: 'V5 V2' }
    });

    const v5V2Analysis = migratedV5Store.getDocumentAnalysis(actor, {
      libraryType: 'user', libraryId: '42', attachmentKey: 'ATT_V5', attachmentVersion: 2, model: 'gpt-4o', promptVersion: 'v1'
    });
    assert.ok(v5V2Analysis);
    assert.equal(v5V2Analysis.documentTitle, 'V5 Version 2');

    migratedV5Store.close();
  } finally {
    fs.rmSync(v5Dir, { recursive: true, force: true });
  }

  // --- Schema v7 -> v8 Migration Test (Preserving existing relations and updating in-place evidence_page) ---
  const v7Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-v7-migration-test-'));
  const v7DbPath = path.join(v7Dir, 'canvas-v7.sqlite');
  try {
    const rawV7 = new DatabaseSync(v7DbPath);
    rawV7.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-08-30T00:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (2, '2026-08-30T01:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (3, '2026-08-31T00:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (4, '2026-08-31T01:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (5, '2026-08-31T02:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (6, '2026-08-31T03:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (7, '2026-08-31T04:00:00.000Z');

      CREATE TABLE document_analyses (
        id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, library_type TEXT NOT NULL, library_id TEXT NOT NULL,
        item_key TEXT NOT NULL, attachment_key TEXT NOT NULL, attachment_version INTEGER, model TEXT NOT NULL,
        prompt_version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready', document_title TEXT NOT NULL DEFAULT '',
        page_count INTEGER NOT NULL DEFAULT 1, graph_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE knowledge_units (
        id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, analysis_id TEXT NOT NULL REFERENCES document_analyses(id),
        type TEXT NOT NULL, library_type TEXT NOT NULL, library_id TEXT NOT NULL, item_key TEXT NOT NULL,
        attachment_key TEXT, document_title TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '', page_start INTEGER NOT NULL DEFAULT 1, page_end INTEGER NOT NULL DEFAULT 1,
        evidence_quote TEXT NOT NULL DEFAULT '', position_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE knowledge_relations (
        id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, source_unit_id TEXT NOT NULL REFERENCES knowledge_units(id),
        target_unit_id TEXT NOT NULL REFERENCES knowledge_units(id), relation_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5, reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'suggested',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK (source_unit_id <> target_unit_id)
      ) STRICT;

      INSERT INTO document_analyses (id, owner_key, library_type, library_id, item_key, attachment_key, attachment_version, model, prompt_version, status, document_title, page_count, graph_json, created_at, updated_at)
        VALUES ('v7-analysis-1', '${actor}', 'user', '42', 'ITEM_V7', 'ATT_V7', 1, 'gpt-4o', 'v1', 'ready', 'V7 Report', 10,
          '{"overview":"Overview text","evidenceQuote":"Overview quote","evidencePage":4,"sections":[{"title":"Section 1","body":"Body 1","pageStart":2,"pageEnd":5,"evidenceQuote":"Section quote","evidencePage":3},{"title":"Section 1","body":"Body 2 with duplicate title","pageStart":6,"pageEnd":8,"evidenceQuote":"Section 2 quote","evidencePage":7}]}',
          '2026-08-31T04:00:00.000Z', '2026-08-31T04:00:00.000Z');

      INSERT INTO knowledge_units (id, owner_key, analysis_id, type, library_type, library_id, item_key, attachment_key, document_title, title, body, page_start, page_end, evidence_quote, created_at, updated_at)
        VALUES ('v7-unit-1', '${actor}', 'v7-analysis-1', 'overview', 'user', '42', 'ITEM_V7', 'ATT_V7', 'V7 Report', '全文概览 · V7 Report', 'Overview text', 1, 10, 'Overview quote', '2026-08-31T04:00:00.000Z', '2026-08-31T04:00:00.000Z');

      INSERT INTO knowledge_units (id, owner_key, analysis_id, type, library_type, library_id, item_key, attachment_key, document_title, title, body, page_start, page_end, evidence_quote, created_at, updated_at)
        VALUES ('v7-unit-2', '${actor}', 'v7-analysis-1', 'section', 'user', '42', 'ITEM_V7', 'ATT_V7', 'V7 Report', 'Section 1', 'Body 1', 2, 5, 'Section quote', '2026-08-31T04:00:00.000Z', '2026-08-31T04:00:00.000Z');

      INSERT INTO knowledge_units (id, owner_key, analysis_id, type, library_type, library_id, item_key, attachment_key, document_title, title, body, page_start, page_end, evidence_quote, created_at, updated_at)
        VALUES ('v7-unit-3', '${actor}', 'v7-analysis-1', 'section', 'user', '42', 'ITEM_V7', 'ATT_V7', 'V7 Report', 'Section 1', 'Body 2 with duplicate title', 6, 8, 'Section 2 quote', '2026-08-31T04:00:00.000Z', '2026-08-31T04:00:00.000Z');

      INSERT INTO knowledge_relations (id, owner_key, source_unit_id, target_unit_id, relation_type, confidence, reason, status, created_at, updated_at)
        VALUES ('v7-rel-1', '${actor}', 'v7-unit-1', 'v7-unit-2', 'supports', 0.95, 'Pre-existing relation before v8 migration', 'confirmed', '2026-08-31T04:00:00.000Z', '2026-08-31T04:00:00.000Z');
    `);
    rawV7.close();

    const migratedV7Store = new CanvasStore(v7DbPath);
    const maxV = migratedV7Store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    assert.equal(maxV, 10, 'Database must be upgraded from v7 to v10');

    // Assert existing knowledge relations were 100% preserved
    const rels = migratedV7Store.listKnowledgeRelations(actor);
    assert.equal(rels.length, 1);
    assert.equal(rels[0].id, 'v7-rel-1');
    assert.equal(rels[0].reason, 'Pre-existing relation before v8 migration');

    // Assert in-place evidencePage was backfilled accurately without duplicate title collisions
    const u1 = migratedV7Store.getKnowledgeUnit(actor, 'v7-unit-1');
    assert.equal(u1.evidencePage, 4, 'Overview evidencePage must be 4 from graph_json');

    const u2 = migratedV7Store.getKnowledgeUnit(actor, 'v7-unit-2');
    assert.equal(u2.evidencePage, 3, 'Section 1 (first duplicate) evidencePage must be 3 from graph_json');

    const u3 = migratedV7Store.getKnowledgeUnit(actor, 'v7-unit-3');
    assert.equal(u3.evidencePage, 7, 'Section 1 (second duplicate) evidencePage must be 7 from graph_json');

    migratedV7Store.close();
  } finally {
    fs.rmSync(v7Dir, { recursive: true, force: true });
  }

  // --- Schema v10: Topics, Topic Documents, Collection Bindings, Inbox, Jobs, Document Analyses, Document Metas, Knowledge Units & Relations, Native Core ---
  const currentMigration = store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  assert.equal(currentMigration, 10, 'Schema migration version 10 must be applied');

  // Topic workspace with metadata
  const topic1 = store.createWorkspace(actor, {
    name: 'Reasoning Models',
    description: 'LLM reasoning mechanisms',
    researchQuestion: 'How does search during inference improve reasoning?'
  });
  assert.equal(topic1.name, 'Reasoning Models');
  assert.equal(topic1.description, 'LLM reasoning mechanisms');
  assert.equal(topic1.researchQuestion, 'How does search during inference improve reasoning?');

  const topic2 = store.createWorkspace(actor, {
    name: 'Evaluation Benchmarks',
    description: 'Evaluation of LLM reasoning'
  });

  // 1 report into multiple topics
  const docTopic1 = store.addTopicDocument(actor, topic1.id, {
    libraryType: 'user', libraryId: '42', itemKey: 'PAPER001', attachmentKey: 'ATT001',
    status: 'accepted', origin: 'manual'
  });
  assert.equal(docTopic1.itemKey, 'PAPER001');
  assert.equal(docTopic1.status, 'accepted');
  assert.equal(docTopic1.version, 1);

  const docTopic2 = store.addTopicDocument(actor, topic2.id, {
    libraryType: 'user', libraryId: '42', itemKey: 'PAPER001', attachmentKey: 'ATT001',
    status: 'inbox', origin: 'collection_sync'
  });
  assert.equal(docTopic2.itemKey, 'PAPER001');
  assert.equal(docTopic2.status, 'inbox');
  assert.equal(docTopic2.version, 1);
  assert.notEqual(docTopic1.id, docTopic2.id, 'Same report in multiple topics has distinct topic document entries');

  // Update status with optimistic version check
  const updatedDoc1 = store.updateTopicDocument(actor, docTopic1.id, 1, { analysisStatus: 'ready' });
  assert.equal(updatedDoc1.analysisStatus, 'ready');
  assert.equal(updatedDoc1.version, 2);
  assert.equal(store.getTopicDocument(actor, docTopic2.id).analysisStatus, 'not_started');

  // Duplicate addTopicDocument on active document returns unmodified existing entity (does not bypass version control)
  const dupDocTopic1 = store.addTopicDocument(actor, topic1.id, {
    libraryType: 'user', libraryId: '42', itemKey: 'PAPER001', attachmentKey: 'ATT001_OVERWRITE',
    status: 'inbox', origin: 'collection_sync'
  });
  assert.equal(dupDocTopic1.id, docTopic1.id);
  assert.equal(dupDocTopic1.version, 2, 'Duplicate POST must not change version');
  assert.equal(dupDocTopic1.status, 'accepted', 'Duplicate POST must not overwrite status');
  assert.equal(dupDocTopic1.analysisStatus, 'ready', 'Duplicate POST must not overwrite analysisStatus');

  // Version conflict on stale version
  assert.throws(() => store.updateTopicDocument(actor, docTopic1.id, 1, { analysisStatus: 'failed' }), CanvasConflictError);
  assert.throws(() => store.removeTopicDocument(actor, docTopic1.id, 1), CanvasConflictError);

  // Owner isolation on topic documents
  assert.equal(store.getTopicDocument(otherActor, docTopic1.id), null);
  assert.throws(() => store.listTopicDocuments(otherActor, topic1.id), CanvasNotFoundError);

  // Successful removal with version 2
  store.removeTopicDocument(actor, docTopic1.id, 2);
  assert.equal(store.getTopicDocument(actor, docTopic1.id), null);
  assert.equal(store.getTopicDocument(actor, docTopic2.id).itemKey, 'PAPER001');

  // Collection Bindings
  const binding1 = store.addCollectionBinding(actor, topic1.id, {
    libraryType: 'user', libraryId: '42', collectionKey: 'COL_REASONING', mode: 'inbound'
  });
  assert.equal(binding1.collectionKey, 'COL_REASONING');
  assert.equal(binding1.mode, 'inbound');
  assert.equal(binding1.enabled, true);
  assert.equal(binding1.version, 1);

  const updatedBinding = store.updateCollectionBinding(actor, binding1.id, 1, {
    mode: 'confirm_both', lastLibraryVersion: 120, enabled: false
  });
  assert.equal(updatedBinding.mode, 'confirm_both');
  assert.equal(updatedBinding.lastLibraryVersion, 120);
  assert.equal(updatedBinding.enabled, false);
  assert.equal(updatedBinding.version, 2);

  // Duplicate addCollectionBinding on active binding returns unmodified existing entity
  const dupBinding1 = store.addCollectionBinding(actor, topic1.id, {
    libraryType: 'user', libraryId: '42', collectionKey: 'COL_REASONING', mode: 'inbound'
  });
  assert.equal(dupBinding1.id, binding1.id);
  assert.equal(dupBinding1.version, 2, 'Duplicate binding POST must not change version');
  assert.equal(dupBinding1.mode, 'confirm_both', 'Duplicate binding POST must not overwrite mode');
  assert.equal(dupBinding1.enabled, false, 'Duplicate binding POST must not overwrite enabled state');

  assert.throws(() => store.updateCollectionBinding(actor, binding1.id, 1, { mode: 'inbound' }), CanvasConflictError);
  assert.throws(() => store.removeCollectionBinding(actor, binding1.id, 1), CanvasConflictError);

  const bindingsList = store.listCollectionBindings(actor, topic1.id);
  assert.equal(bindingsList.length, 1);
  assert.equal(store.listCollectionBindings(actor, topic2.id).length, 0);

  // Inbox entries and batch action
  const upserted = store.upsertInboxEntries(actor, [
    { libraryType: 'user', libraryId: '42', itemKey: 'ITEM_NEW_1', title: 'DeepSeek R1', year: 2025, collectionKeys: ['COL_REASONING'] },
    { libraryType: 'user', libraryId: '42', itemKey: 'ITEM_NEW_2', title: 'OpenAI o3', year: 2025, collectionKeys: ['COL_EVAL'] }
  ]);
  assert.equal(upserted.length, 2);
  assert.equal(upserted[0].title, 'DeepSeek R1');

  const inboxList = store.listInboxEntries(actor, { state: 'new' });
  assert.equal(inboxList.length, 2);

  // Batch action: add DeepSeek R1 and OpenAI o3 to topic1 and topic2 simultaneously
  const batchRes = store.batchActionInbox(actor, {
    entryIds: [upserted[0].id, upserted[1].id],
    action: 'accept',
    targetWorkspaceIds: [topic1.id, topic2.id]
  });
  assert.equal(batchRes.processed, 2);
  assert.equal(store.listInboxEntries(actor, { state: 'new' }).length, 0);
  assert.equal(store.listInboxEntries(actor, { state: 'accepted' }).length, 2);
  assert.equal(store.listTopicDocuments(actor, topic1.id).length, 2);
  assert.equal(store.listTopicDocuments(actor, topic2.id).length, 3); // previous docTopic2 + 2 batch

  // Jobs
  const job = store.enqueueJob(actor, { jobType: 'scan_collection', resourceType: 'collection', resourceId: 'COL_REASONING' });
  assert.equal(job.jobType, 'scan_collection');
  assert.equal(job.state, 'queued');
  const updatedJob = store.updateJobState(job.id, { state: 'completed', resultSummary: { scanned: 2 } });
  assert.equal(updatedJob.state, 'completed');
  assert.equal(updatedJob.resultSummary.scanned, 2);

  // --- HTTP API Verification for Schema v3 Endpoints ---
  const topicCreateRes = await call(handler, '/canvas/workspaces', {
    method: 'POST', cookie,
    body: { name: 'API Research Topic', description: 'Topic via API', researchQuestion: 'Can API manage topics?' }
  });
  assert.equal(topicCreateRes.statusCode, 201);
  const apiTopic = topicCreateRes.payload.data;
  assert.equal(apiTopic.description, 'Topic via API');

  const topicDocAddRes = await call(handler, `/canvas/workspaces/${apiTopic.id}/documents`, {
    method: 'POST', cookie,
    body: { libraryType: 'user', libraryId: '42', itemKey: 'API_DOC_1', status: 'accepted' }
  });
  assert.equal(topicDocAddRes.statusCode, 201);
  assert.equal(topicDocAddRes.getHeader('etag'), 'W/"1"');
  const apiDoc = topicDocAddRes.payload.data;
  assert.equal(apiDoc.itemKey, 'API_DOC_1');
  assert.equal(apiDoc.version, 1);

  const topicDocListRes = await call(handler, `/canvas/workspaces/${apiTopic.id}/documents`, { cookie });
  assert.equal(topicDocListRes.statusCode, 200);
  assert.equal(topicDocListRes.payload.data.length, 1);

  // HTTP Preconditions for Topic Documents
  const patchMissingHeader = await call(handler, `/canvas/topic-documents/${apiDoc.id}`, {
    method: 'PATCH', cookie, body: { status: 'deferred' }
  });
  assert.equal(patchMissingHeader.statusCode, 428);

  const patchStaleHeader = await call(handler, `/canvas/topic-documents/${apiDoc.id}`, {
    method: 'PATCH', cookie, headers: { 'if-match': 'W/"999"' }, body: { status: 'deferred' }
  });
  assert.equal(patchStaleHeader.statusCode, 412);

  const topicDocPatchRes = await call(handler, `/canvas/topic-documents/${apiDoc.id}`, {
    method: 'PATCH', cookie, headers: { 'if-match': 'W/"1"' },
    body: { status: 'deferred' }
  });
  assert.equal(topicDocPatchRes.statusCode, 200);
  assert.equal(topicDocPatchRes.getHeader('etag'), 'W/"2"');
  assert.equal(topicDocPatchRes.payload.data.status, 'deferred');
  assert.equal(topicDocPatchRes.payload.data.version, 2);

  // Duplicate HTTP POST returns current entity with unchanged ETag and fields
  const dupTopicDocPost = await call(handler, `/canvas/workspaces/${apiTopic.id}/documents`, {
    method: 'POST', cookie,
    body: { libraryType: 'user', libraryId: '42', itemKey: 'API_DOC_1', status: 'accepted' }
  });
  assert.equal(dupTopicDocPost.statusCode, 201);
  assert.equal(dupTopicDocPost.getHeader('etag'), 'W/"2"');
  assert.equal(dupTopicDocPost.payload.data.status, 'deferred', 'Duplicate HTTP POST must not overwrite patched status');
  assert.equal(dupTopicDocPost.payload.data.version, 2);

  // DELETE Topic Document Preconditions
  const deleteMissingHeader = await call(handler, `/canvas/topic-documents/${apiDoc.id}`, {
    method: 'DELETE', cookie
  });
  assert.equal(deleteMissingHeader.statusCode, 428);

  const deleteStaleHeader = await call(handler, `/canvas/topic-documents/${apiDoc.id}`, {
    method: 'DELETE', cookie, headers: { 'if-match': 'W/"1"' }
  });
  assert.equal(deleteStaleHeader.statusCode, 412);

  const deleteOk = await call(handler, `/canvas/topic-documents/${apiDoc.id}`, {
    method: 'DELETE', cookie, headers: { 'if-match': 'W/"2"' }
  });
  assert.equal(deleteOk.statusCode, 204);

  // HTTP Collection Bindings Preconditions
  const bindingAddRes = await call(handler, `/canvas/workspaces/${apiTopic.id}/collection-bindings`, {
    method: 'POST', cookie,
    body: { libraryType: 'user', libraryId: '42', collectionKey: 'API_COL_1', mode: 'inbound' }
  });
  assert.equal(bindingAddRes.statusCode, 201);
  assert.equal(bindingAddRes.getHeader('etag'), 'W/"1"');
  const apiBinding = bindingAddRes.payload.data;
  assert.equal(apiBinding.collectionKey, 'API_COL_1');
  assert.equal(apiBinding.version, 1);

  const patchBindingMissing = await call(handler, `/canvas/collection-bindings/${apiBinding.id}`, {
    method: 'PATCH', cookie, body: { mode: 'confirm_both' }
  });
  assert.equal(patchBindingMissing.statusCode, 428);

  const patchBindingStale = await call(handler, `/canvas/collection-bindings/${apiBinding.id}`, {
    method: 'PATCH', cookie, headers: { 'if-match': 'W/"999"' }, body: { mode: 'confirm_both' }
  });
  assert.equal(patchBindingStale.statusCode, 412);

  const bindingPatchRes = await call(handler, `/canvas/collection-bindings/${apiBinding.id}`, {
    method: 'PATCH', cookie, headers: { 'if-match': 'W/"1"' },
    body: { mode: 'confirm_both', enabled: false }
  });
  assert.equal(bindingPatchRes.statusCode, 200);
  assert.equal(bindingPatchRes.getHeader('etag'), 'W/"2"');
  assert.equal(bindingPatchRes.payload.data.mode, 'confirm_both');
  assert.equal(bindingPatchRes.payload.data.enabled, false);
  assert.equal(bindingPatchRes.payload.data.version, 2);

  // Unauthorized libraryId in inbox -> 403
  const forbiddenUserInbox = await call(handler, '/canvas/inbox/entries', {
    method: 'POST', cookie,
    body: { entries: [{ libraryType: 'user', libraryId: '9999', itemKey: 'FORGE_1' }] }
  });
  assert.equal(forbiddenUserInbox.statusCode, 403);

  const forbiddenGroupInbox = await call(handler, '/canvas/inbox/entries', {
    method: 'POST', cookie,
    body: { entries: [{ libraryType: 'group', libraryId: '9999', itemKey: 'FORGE_2' }] }
  });
  assert.equal(forbiddenGroupInbox.statusCode, 403);

  const apiInboxUpsertRes = await call(handler, '/canvas/inbox/entries', {
    method: 'POST', cookie,
    body: {
      entries: [
        {
          libraryType: 'user', libraryId: '42', itemKey: 'API_INBOX_1', title: 'API Ingest 1', year: 2026,
          creators: [
            { creatorType: 'author', firstName: 'Alan', lastName: 'Turing', maliciousExtra: 'stripped' },
            'String Creator'
          ],
          tags: [{ tag: 'ai-reasoning' }, 'nlp']
        }
      ]
    }
  });
  assert.equal(apiInboxUpsertRes.statusCode, 201);
  assert.equal(apiInboxUpsertRes.payload.data.length, 1);
  const apiInboxEntry = apiInboxUpsertRes.payload.data[0];
  assert.deepEqual(apiInboxEntry.creators, [
    { creatorType: 'author', firstName: 'Alan', lastName: 'Turing' },
    'String Creator'
  ], 'Creator objects must be normalized and extra fields stripped');
  assert.deepEqual(apiInboxEntry.tags, ['ai-reasoning', 'nlp'], 'Tags must be normalized to array of strings');

  const inboxApiRes = await call(handler, '/canvas/inbox', { cookie });
  assert.equal(inboxApiRes.statusCode, 200);
  assert.ok(Array.isArray(inboxApiRes.payload.data));
  assert.equal(inboxApiRes.payload.data.length, 1);

  // Regression: Metadata-only HTTP upsert must preserve existing attachment key and version
  const initialAttachedRes = await call(handler, '/canvas/inbox/entries', {
    method: 'POST', cookie,
    body: {
      entries: [
        {
          libraryType: 'user', libraryId: '42', itemKey: 'API_INBOX_ATTACH_PRESERVE', title: 'Initial Title',
          attachmentKey: 'ATT_PRESERVE_1', attachmentVersion: 3
        }
      ]
    }
  });
  assert.equal(initialAttachedRes.statusCode, 201);
  const initialEntry = initialAttachedRes.payload.data[0];
  assert.equal(initialEntry.attachmentKey, 'ATT_PRESERVE_1');
  assert.equal(initialEntry.attachmentVersion, 3);

  // Perform metadata-only upsert (omitting attachmentKey & attachmentVersion)
  const metadataOnlyUpsertRes = await call(handler, '/canvas/inbox/entries', {
    method: 'POST', cookie,
    body: {
      entries: [
        {
          libraryType: 'user', libraryId: '42', itemKey: 'API_INBOX_ATTACH_PRESERVE', title: 'Updated Title Only',
          tags: ['updated-tag']
        }
      ]
    }
  });
  assert.equal(metadataOnlyUpsertRes.statusCode, 201);
  const preservedEntry = metadataOnlyUpsertRes.payload.data[0];
  assert.equal(preservedEntry.title, 'Updated Title Only');
  assert.equal(preservedEntry.attachmentKey, 'ATT_PRESERVE_1', 'Metadata-only upsert must preserve existing attachmentKey');
  assert.equal(preservedEntry.attachmentVersion, 3, 'Metadata-only upsert must preserve existing attachmentVersion');

  // Incomplete attachment pair (only attachmentKey or only attachmentVersion) must be rejected with 400
  const incompleteKeyRes = await call(handler, '/canvas/inbox/entries', {
    method: 'POST', cookie,
    body: {
      entries: [
        { libraryType: 'user', libraryId: '42', itemKey: 'API_INBOX_INCOMPLETE', attachmentKey: 'ATT_ONLY' }
      ]
    }
  });
  assert.equal(incompleteKeyRes.statusCode, 400, 'Incomplete attachmentKey without attachmentVersion must be rejected with 400');

  const incompleteVerRes = await call(handler, '/canvas/inbox/entries', {
    method: 'POST', cookie,
    body: {
      entries: [
        { libraryType: 'user', libraryId: '42', itemKey: 'API_INBOX_INCOMPLETE', attachmentVersion: 2 }
      ]
    }
  });
  assert.equal(incompleteVerRes.statusCode, 400, 'Incomplete attachmentVersion without attachmentKey must be rejected with 400');

  // Explicit unbinding (both attachmentKey and attachmentVersion set to null)
  const unbindRes = await call(handler, '/canvas/inbox/entries', {
    method: 'POST', cookie,
    body: {
      entries: [
        {
          libraryType: 'user', libraryId: '42', itemKey: 'API_INBOX_ATTACH_PRESERVE', title: 'Unbound Entry',
          attachmentKey: null, attachmentVersion: null
        }
      ]
    }
  });
  assert.equal(unbindRes.statusCode, 201);
  const unboundEntry = unbindRes.payload.data[0];
  assert.equal(unboundEntry.attachmentKey, null, 'Explicit unbinding must clear attachmentKey');
  assert.equal(unboundEntry.attachmentVersion, null, 'Explicit unbinding must clear attachmentVersion');

  // --- T2 AI Inbox Classification Service Test ---
  const classifyRes = await call(handler, '/canvas/inbox/classify', {
    method: 'POST', cookie,
    body: { entryIds: [apiInboxEntry.id] }
  });
  assert.equal(classifyRes.statusCode, 200);
  assert.ok(classifyRes.payload.data.classifications);
  assert.ok(classifyRes.payload.data.classifications[apiInboxEntry.id]);
  assert.equal(classifyRes.payload.data.classifications[apiInboxEntry.id][0].confidence, 0.95);
  assert.equal(classifyRes.payload.data.classifications[apiInboxEntry.id][0].workspaceName, 'API Research Topic');

  // Classification filtering of hallucinated/unknown workspaces
  const hallucinatedHandler = createCanvasHandler(store, {
    aiPublicConfig: () => ({ configured: true, provider: 'mock.example', model: 'mock-model' }),
    aiCompletion: async () => JSON.stringify({
      classifications: {
        [apiInboxEntry.id]: [
          { workspaceId: 'ws-hallucinated-999', workspaceName: 'Non-existent Topic', confidence: 0.99, reason: 'Hallucination' },
          { workspaceId: apiTopic.id, workspaceName: 'API Research Topic', confidence: 0.88, reason: 'Valid Topic' }
        ]
      },
      documentMetadata: {
        [apiInboxEntry.id]: {
          cleanTitle: '【测试研究院】人工智能推理研究（2025）',
          institution: '测试研究院',
          reportTitle: '人工智能推理研究',
          year: '2025',
          summary: '分类与中文标题在同一次模型调用中完成。'
        }
      }
    })
  });
  const hallucinatedRes = await call(hallucinatedHandler, '/canvas/inbox/classify', {
    method: 'POST', cookie, body: { entryIds: [apiInboxEntry.id] }
  });
  assert.equal(hallucinatedRes.statusCode, 200);
  const filteredRecs = hallucinatedRes.payload.data.classifications[apiInboxEntry.id];
  assert.equal(filteredRecs.length, 1, 'Hallucinated workspace IDs must be filtered out');
  assert.equal(filteredRecs[0].workspaceId, apiTopic.id);
  assert.equal(hallucinatedRes.payload.data.documentMetas.length, 1);
  assert.equal(hallucinatedRes.payload.data.documentMetas[0].cleanTitle, '【测试研究院】人工智能推理研究（2025）');
  assert.equal(store.getInboxEntry(canvasActorKey('https://issuer.example', 'api-subject'), apiInboxEntry.id).cleanTitle,
    '【测试研究院】人工智能推理研究（2025）', 'AI classification must persist the Chinese display name in the same request');

  // Classification of specific entry ID beyond top 100 entries in inbox
  const manyEntries = Array.from({ length: 110 }, (_, i) => ({
    libraryType: 'user', libraryId: '42', itemKey: `MANY_INBOX_${i}`, title: `Many Ingest ${i}`
  }));
  const upsertedMany = store.upsertInboxEntries(canvasActorKey('https://issuer.example', 'api-subject'), manyEntries);
  const oldestEntry = upsertedMany[0]; // first inserted
  const beyond100Res = await call(handler, '/canvas/inbox/classify', {
    method: 'POST', cookie, body: { entryIds: [oldestEntry.id] }
  });
  assert.equal(beyond100Res.statusCode, 200);
  assert.ok(beyond100Res.payload.data.classifications[oldestEntry.id] !== undefined);

  // --- AI Auto Topic Generation Service Test ---
  const autoTopicHandler = createCanvasHandler(store, {
    aiPublicConfig: () => ({ configured: true, provider: 'mock.example', model: 'mock-model' }),
    aiCompletion: async () => JSON.stringify({
      topics: [
        {
          name: '具身智能与大模型控制',
          researchQuestion: '端到端控制与多模态规划',
          inclusionRules: '包含机器人与控制任务',
          exclusionRules: '纯文本模型'
        },
        {
          name: '推理加速与量化架构',
          researchQuestion: '低比特推理与KV缓存优化',
          inclusionRules: '包含推理优化架构',
          exclusionRules: '纯应用产品'
        }
      ],
      classifications: {
        [apiInboxEntry.id]: [
          { topicName: '具身智能与大模型控制', confidence: 0.96, reason: '核心契合具身控制方向' }
        ]
      },
      documentMetadata: {
        [apiInboxEntry.id]: { cleanTitle: '【测试研究院】具身智能控制综述（2025）', institution: '测试研究院' }
      }
    })
  });
  const generateTopicsRes = await call(autoTopicHandler, '/canvas/inbox/generate-topics', {
    method: 'POST', cookie, body: { entryIds: [apiInboxEntry.id], maxTopics: 5 }
  });
  assert.equal(generateTopicsRes.statusCode, 200);
  assert.ok(generateTopicsRes.payload.data.createdWorkspaces);
  assert.equal(generateTopicsRes.payload.data.createdWorkspaces.length, 2);
  assert.equal(generateTopicsRes.payload.data.createdWorkspaces[0].name, '具身智能与大模型控制');
  assert.ok(generateTopicsRes.payload.data.classifications[apiInboxEntry.id]);
  assert.equal(generateTopicsRes.payload.data.classifications[apiInboxEntry.id][0].workspaceName, '具身智能与大模型控制');
  assert.equal(generateTopicsRes.payload.data.documentMetas[0].cleanTitle, '【测试研究院】具身智能控制综述（2025）');

  // --- T3 Cross-Report Relations & Progressive Expansion Verification ---
  // Create report A and report B document analyses in apiTopic
  store.addTopicDocument(canvasActorKey('https://issuer.example', 'api-subject'), apiTopic.id, {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_A', attachmentKey: 'PDF_A', status: 'accepted'
  });
  store.addTopicDocument(canvasActorKey('https://issuer.example', 'api-subject'), apiTopic.id, {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_B', attachmentKey: 'PDF_B', status: 'accepted'
  });

  store.saveDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_A', attachmentKey: 'PDF_A', attachmentVersion: 1,
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v1', status: 'ready',
    documentTitle: 'DeepSeek-V3 架构解析', pageCount: 10,
    graph: {
      title: 'DeepSeek-V3 架构解析', overview: 'MoE 架构与 MLA 注意力机制。', evidenceQuote: 'MLA 注意力大幅减少 KV 缓存。', evidencePage: 3,
      sections: [{ title: '模型架构', body: 'MLA 创新与多专家路由。', pageStart: 2, pageEnd: 4, evidenceQuote: 'MLA 压缩机制。', evidencePage: 3 }],
      concepts: [{ title: 'MLA 注意力', body: '低秩键值联合压缩。', pageStart: 3, pageEnd: 3, evidenceQuote: '低秩压缩公式。', evidencePage: 3 }],
      claims: [{ title: '推理吞吐提升', body: '相比 MHA 提升 3 倍推理吞吐。', pageStart: 4, pageEnd: 4, evidenceQuote: '吞吐提升 3.1 倍。', evidencePage: 4 }],
      relations: []
    }
  });

  store.saveDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_B', attachmentKey: 'PDF_B', attachmentVersion: 1,
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v1', status: 'ready',
    documentTitle: 'Kimi k1.5 强化学习技术报告', pageCount: 12,
    graph: {
      title: 'Kimi k1.5 强化学习技术报告', overview: '长上下文强化学习与推理扩展。', evidenceQuote: 'RL 驱动长链推理。', evidencePage: 2,
      sections: [{ title: '强化学习训练', body: '大模型推理扩展方法。', pageStart: 2, pageEnd: 5, evidenceQuote: '奖励模型设计。', evidencePage: 3 }],
      concepts: [{ title: '长链推理', body: '搜索与反思策略。', pageStart: 4, pageEnd: 4, evidenceQuote: '长思维链涌现。', evidencePage: 4 }],
      claims: [{ title: 'MLA 扩展验证', body: '在超长上下文中 MLA 能够维持吞吐优势。', pageStart: 6, pageEnd: 6, evidenceQuote: '长文本下吞吐优势明显。', evidencePage: 6 }],
      relations: []
    }
  });

  // Query related knowledge across reports
  const relatedKnowledgeRes = await call(handler, `/canvas/workspaces/${apiTopic.id}/related-knowledge`, {
    method: 'POST', cookie,
    body: {
      focalText: 'MLA 注意力机制在长文本推理中能大幅提升吞吐并降低 KV 缓存占用',
      focalItemKey: 'DOC_A',
      limit: 5
    }
  });
  assert.equal(relatedKnowledgeRes.statusCode, 200);
  assert.ok(Array.isArray(relatedKnowledgeRes.payload.data.relations));
  assert.ok(relatedKnowledgeRes.payload.data.relations.length >= 1);
  const matchedRel = relatedKnowledgeRes.payload.data.relations[0];
  assert.equal(matchedRel.relationType, 'supports');
  assert.equal(matchedRel.unit.documentTitle, 'Kimi k1.5 强化学习技术报告');
  assert.equal(matchedRel.unit.itemKey, 'DOC_B');

  // Progressive Expansion: Expand related card onto board
  const topicBoard = store.createBoard(canvasActorKey('https://issuer.example', 'api-subject'), apiTopic.id, {
    name: 'Topic Board for Relations'
  });
  const focalCard = store.createNode(canvasActorKey('https://issuer.example', 'api-subject'), topicBoard.id, {
    type: 'ai_output', x: 100, y: 100, width: 320, height: 200, title: 'MLA 吞吐结论', body: 'MLA 提升吞吐。'
  });

  const expandRes = await call(handler, `/canvas/boards/${topicBoard.id}/expand-related`, {
    method: 'POST', cookie,
    body: {
      focalNodeId: focalCard.id,
      relatedUnits: [{ unitId: matchedRel.unit.id, relationType: matchedRel.relationType, reason: matchedRel.reason }]
    }
  });
  assert.equal(expandRes.statusCode, 201);
  assert.equal(expandRes.payload.data.createdNodes.length, 1);
  assert.equal(expandRes.payload.data.createdEdges.length, 1);
  const expandedNode = expandRes.payload.data.createdNodes[0];
  assert.match(expandedNode.title, /Kimi k1\.5/);
  assert.equal(expandRes.payload.data.createdEdges[0].relation, 'supports');

  // Progressive Collapse: Remove expanded related cards
  const collapseRes = await call(handler, `/canvas/boards/${topicBoard.id}/collapse-related`, {
    method: 'POST', cookie,
    body: {
      focalNodeId: focalCard.id,
      nodeIds: [expandedNode.id]
    }
  });
  assert.equal(collapseRes.statusCode, 200);
  assert.equal(collapseRes.payload.data.collapsedCount, 1);
  assert.equal(store.getNode(canvasActorKey('https://issuer.example', 'api-subject'), expandedNode.id), null);

  // Security & Safety Tests:
  // 1. Foreign key constraint test: refresh document analysis when relations exist
  assert.doesNotThrow(() => {
    store.saveDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
      libraryType: 'user', libraryId: '42', itemKey: 'DOC_A', attachmentKey: 'PDF_A', attachmentVersion: 1,
      model: 'mock-model', promptVersion: 'altcanvas-document-map-v1', status: 'ready',
      documentTitle: 'DeepSeek-V3 架构解析（刷新分析）', pageCount: 10,
      graph: {
        title: 'DeepSeek-V3 架构解析（刷新分析）', overview: '刷新后的 MoE 概览。', evidenceQuote: 'MLA 创新说明。', evidencePage: 4,
        sections: [], concepts: [], claims: [], relations: []
      }
    });
  }, 'Refreshing document analysis with existing relations must safely clean up and not fail foreign key constraints');

  // 2. Full library identity isolation (cross-library same itemKey test)
  store.addTopicDocument(canvasActorKey('https://issuer.example', 'api-subject'), apiTopic.id, {
    libraryType: 'group', libraryId: '7', itemKey: 'DOC_A', attachmentKey: 'PDF_GROUP_A', status: 'accepted'
  });
  store.saveDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'group', libraryId: '7', itemKey: 'DOC_A', attachmentKey: 'PDF_GROUP_A', attachmentVersion: 1,
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v1', status: 'ready',
    documentTitle: 'Group 7 内部研报 DOC_A', pageCount: 5,
    graph: {
      title: 'Group 7 内部研报 DOC_A', overview: '组文库独有报告内容。', evidenceQuote: '组文库证据。', evidencePage: 2,
      sections: [], concepts: [], claims: [], relations: []
    }
  });

  const groupIsolatedRecall = store.listTopicKnowledgeUnits(canvasActorKey('https://issuer.example', 'api-subject'), apiTopic.id, {
    excludeFocal: { libraryType: 'user', libraryId: '42', itemKey: 'DOC_A' }
  });
  assert.ok(groupIsolatedRecall.some(u => u.libraryType === 'group' && u.libraryId === '7' && u.itemKey === 'DOC_A'),
    'Excluding user:42:DOC_A must NOT exclude group:7:DOC_A with same itemKey');

  // 3. Spoofed knowledge unit rejection in /expand-related
  const spoofedExpandRes = await call(handler, `/canvas/boards/${topicBoard.id}/expand-related`, {
    method: 'POST', cookie,
    body: {
      focalNodeId: focalCard.id,
      relatedUnits: [{
        unitId: 'non-existent-or-spoofed-unit-id',
        unit: {
          id: 'fake-unit',
          documentTitle: 'Fake Document',
          body: 'Spoofed Malicious Text',
          libraryType: 'user',
          libraryId: '42',
          itemKey: 'DOC_FAKE'
        }
      }]
    }
  });
  assert.equal(spoofedExpandRes.statusCode, 201);
  assert.equal(spoofedExpandRes.payload.data.createdNodes.length, 0, 'Spoofed or unverified knowledge units must be rejected');

  // 4. Protection against deleting unrelated nodes in /collapse-related
  const protectedManualCard = store.createNode(canvasActorKey('https://issuer.example', 'api-subject'), topicBoard.id, {
    type: 'manual_note', x: 200, y: 200, width: 300, height: 180, title: 'Protected Manual Note', body: 'Must not be deleted by collapse'
  });
  const unauthCollapseRes = await call(handler, `/canvas/boards/${topicBoard.id}/collapse-related`, {
    method: 'POST', cookie,
    body: {
      focalNodeId: focalCard.id,
      nodeIds: [protectedManualCard.id]
    }
  });
  assert.equal(unauthCollapseRes.statusCode, 200);
  assert.equal(unauthCollapseRes.payload.data.collapsedCount, 0);
  assert.ok(store.getNode(canvasActorKey('https://issuer.example', 'api-subject'), protectedManualCard.id) !== null, 'Unconnected card must not be deleted');

  // 5. Evidence page fidelity in expanded cards
  const reExpandRes = await call(handler, `/canvas/boards/${topicBoard.id}/expand-related`, {
    method: 'POST', cookie,
    body: {
      focalNodeId: focalCard.id,
      relatedUnits: [{ unitId: matchedRel.unit.id, relationType: matchedRel.relationType, reason: matchedRel.reason }]
    }
  });
  assert.equal(reExpandRes.statusCode, 201);
  const reExpandedSourceRef = store.getSourceRef(canvasActorKey('https://issuer.example', 'api-subject'), reExpandRes.payload.data.createdNodes[0].sourceRefId);
  assert.equal(reExpandedSourceRef.pageLabel, String(matchedRel.unit.evidencePage), 'Expanded sourceRef must preserve exact evidencePage from knowledge unit');

  // 6. Cross-owner and un-owned focalUnitId validation in /related-knowledge
  const unownedUnitRecallRes = await call(handler, `/canvas/workspaces/${apiTopic.id}/related-knowledge`, {
    method: 'POST', cookie,
    body: {
      focalText: 'MLA 注意力机制',
      focalUnitId: 'other-owner-untrusted-unit-uuid',
      focalDocument: { libraryType: 'user', libraryId: '42', itemKey: 'DOC_A' }
    }
  });
  assert.equal(unownedUnitRecallRes.statusCode, 400, 'Unowned/invalid focalUnitId must be rejected with 400');

  // Mismatched focalUnitId and focalDocument must be rejected with 400
  const docBUnitForMismatch = store.listTopicKnowledgeUnits(canvasActorKey('https://issuer.example', 'api-subject'), apiTopic.id).find(u => u.itemKey === 'DOC_B');
  if (docBUnitForMismatch) {
    const mismatchRes = await call(handler, `/canvas/workspaces/${apiTopic.id}/related-knowledge`, {
      method: 'POST', cookie,
      body: {
        focalText: 'MLA 注意力机制',
        focalUnitId: docBUnitForMismatch.id,
        focalDocument: { libraryType: 'user', libraryId: '42', itemKey: 'DOC_A' }
      }
    });
    assert.equal(mismatchRes.statusCode, 400, 'Mismatched focalUnitId and focalDocument must be rejected with 400');
  }

  // Cross-topic workspace focalUnitId rejection
  const otherTopicWs = store.createWorkspace(canvasActorKey('https://issuer.example', 'api-subject'), {
    name: 'Other Topic Workspace', description: 'Topic for cross-topic focalUnit validation'
  });
  store.addTopicDocument(canvasActorKey('https://issuer.example', 'api-subject'), otherTopicWs.id, {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_OTHER_WS', attachmentKey: 'ATT_OTHER_WS', attachmentVersion: 1
  });
  store.saveDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_OTHER_WS', attachmentKey: 'ATT_OTHER_WS', attachmentVersion: 1,
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v1', status: 'ready', documentTitle: 'Other WS Doc',
    pageCount: 3, graph: { overview: 'Other WS Overview', claims: [{ title: 'Other Claim', body: 'Other Body' }] }
  });
  const otherWsUnits = store.listTopicKnowledgeUnits(canvasActorKey('https://issuer.example', 'api-subject'), otherTopicWs.id);
  assert.ok(otherWsUnits.length > 0);
  const crossWsRecallRes = await call(handler, `/canvas/workspaces/${apiTopic.id}/related-knowledge`, {
    method: 'POST', cookie,
    body: {
      focalText: 'MLA 注意力机制',
      focalUnitId: otherWsUnits[0].id,
      focalDocument: { libraryType: 'user', libraryId: '42', itemKey: 'DOC_OTHER_WS' }
    }
  });
  assert.equal(crossWsRecallRes.statusCode, 400, 'focalUnitId from a different workspace must be rejected with 400');

  // Stale attachment/analysis focalUnitId rejection (when doc attachment has updated and old unit is inactive)
  const supersededAnalysis = store.saveDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_STALE_ATTACH_TEST', attachmentKey: 'ATT_SUPERSEDED', attachmentVersion: 1,
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v1', status: 'ready', documentTitle: 'Old Version Doc',
    pageCount: 2, graph: { overview: 'Old Overview' }
  });
  const supersededUnit = store.db.prepare('SELECT * FROM knowledge_units WHERE analysis_id = ?').get(supersededAnalysis.id);
  assert.ok(supersededUnit);
  // Add doc to otherTopicWs with new attachment version 2
  store.addTopicDocument(canvasActorKey('https://issuer.example', 'api-subject'), otherTopicWs.id, {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_STALE_ATTACH_TEST', attachmentKey: 'ATT_ACTIVE_NEW', attachmentVersion: 2
  });
  store.saveDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_STALE_ATTACH_TEST', attachmentKey: 'ATT_ACTIVE_NEW', attachmentVersion: 2,
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v1', status: 'ready', documentTitle: 'New Version Doc',
    pageCount: 2, graph: { overview: 'New Active Overview' }
  });
  const staleUnitRecallRes = await call(handler, `/canvas/workspaces/${otherTopicWs.id}/related-knowledge`, {
    method: 'POST', cookie,
    body: {
      focalText: 'MLA 注意力机制',
      focalUnitId: supersededUnit.id,
      focalDocument: { libraryType: 'user', libraryId: '42', itemKey: 'DOC_STALE_ATTACH_TEST' }
    }
  });
  assert.equal(staleUnitRecallRes.statusCode, 400, 'Stale/superseded focalUnitId from inactive analysis must be rejected with 400');

  // 7. Same-document pseudo cross-report relation rejection
  const docAUnits = store.listTopicKnowledgeUnits(canvasActorKey('https://issuer.example', 'api-subject'), apiTopic.id);
  const docAUnit1 = docAUnits.find(u => u.itemKey === 'DOC_A');
  const docAUnit2 = docAUnits.filter(u => u.libraryType === docAUnit1.libraryType && String(u.libraryId) === String(docAUnit1.libraryId) && u.itemKey === docAUnit1.itemKey)[1] || docAUnit1;
  if (docAUnit1) {
    const sameDocAIHandler = createCanvasHandler(store, {
      aiPublicConfig: () => ({ configured: true, provider: 'mock.example', model: 'mock-model' }),
      aiCompletion: async () => JSON.stringify({
        relations: [
          { unitId: docAUnit2.id, relationType: 'supports', confidence: 0.99, reason: 'Pseudo relation inside same doc' }
        ]
      })
    });

    const sameDocRecallRes = await call(sameDocAIHandler, `/canvas/workspaces/${apiTopic.id}/related-knowledge`, {
      method: 'POST', cookie,
      body: {
        focalText: 'MLA 相同文档测试',
        focalUnitId: docAUnit1.id,
        focalDocument: { libraryType: docAUnit1.libraryType, libraryId: docAUnit1.libraryId, itemKey: docAUnit1.itemKey }
      }
    });
    assert.equal(sameDocRecallRes.statusCode, 200);
    assert.equal(sameDocRecallRes.payload.data.relations.length, 0, 'Candidate units from same document must be filtered out');
    const savedSameDocRels = store.listKnowledgeRelations(canvasActorKey('https://issuer.example', 'api-subject'), { unitId: docAUnit1.id });
    assert.ok(savedSameDocRels.every(r => r.sourceUnitId !== r.targetUnitId), 'Must not save self or same-document pseudo relations');
  }

  // 8. Attachment switching on existing active topic document: new attachment version 1 overrides older attachment version 10
  // First, add topic document with PDF_OLD and mark analysisStatus ready
  const activeDocSwitch = store.addTopicDocument(canvasActorKey('https://issuer.example', 'api-subject'), apiTopic.id, {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_SWITCH', attachmentKey: 'PDF_OLD', attachmentVersion: 10, status: 'accepted'
  });
  store.updateTopicDocument(canvasActorKey('https://issuer.example', 'api-subject'), activeDocSwitch.id, activeDocSwitch.version, {
    analysisStatus: 'ready'
  });
  const readyDocSwitch = store.getTopicDocument(canvasActorKey('https://issuer.example', 'api-subject'), activeDocSwitch.id);
  assert.equal(readyDocSwitch.attachmentKey, 'PDF_OLD');
  assert.equal(readyDocSwitch.analysisStatus, 'ready');

  store.saveDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_SWITCH', attachmentKey: 'PDF_OLD', attachmentVersion: 10,
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v1', status: 'ready',
    documentTitle: '旧附件研报', pageCount: 5,
    graph: { title: '旧附件研报', overview: '旧附件内容。', evidenceQuote: '旧证据。', evidencePage: 1, sections: [], concepts: [], claims: [], relations: [] }
  });

  // Switch attachment on existing active topic document to PDF_NEW
  const updatedDocSwitch = store.syncTopicDocumentAttachment(canvasActorKey('https://issuer.example', 'api-subject'), apiTopic.id, {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_SWITCH', attachmentKey: 'PDF_NEW', attachmentVersion: 1
  });
  assert.equal(updatedDocSwitch.id, activeDocSwitch.id);
  assert.equal(updatedDocSwitch.attachmentKey, 'PDF_NEW');
  assert.equal(updatedDocSwitch.analysisStatus, 'stale', 'Analysis status must become stale on attachment switch');
  assert.equal(updatedDocSwitch.version, readyDocSwitch.version + 1, 'Version must increment when attachment switches');

  store.saveDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_SWITCH', attachmentKey: 'PDF_NEW', attachmentVersion: 1,
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v1', status: 'ready',
    documentTitle: '新附件研报', pageCount: 8,
    graph: { title: '新附件研报', overview: '新附件全新内容。', evidenceQuote: '新证据。', evidencePage: 2, sections: [], concepts: [], claims: [], relations: [] }
  });

  const recallAfterSwitch = store.listTopicKnowledgeUnits(canvasActorKey('https://issuer.example', 'api-subject'), apiTopic.id, {
    excludeFocal: { libraryType: 'user', libraryId: '42', itemKey: 'DOC_A' }
  });
  const switchedUnits = recallAfterSwitch.filter(u => u.itemKey === 'DOC_SWITCH');
  assert.ok(switchedUnits.length > 0);
  assert.ok(switchedUnits.every(u => u.attachmentKey === 'PDF_NEW'), 'When topic document switches attachment, must strictly recall new attachment');

  // 9. Version upgrade invalidates older knowledge units in topic recall
  store.saveDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', itemKey: 'DOC_B', attachmentKey: 'PDF_B', attachmentVersion: 2, // Upgrade to version 2
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v1', status: 'ready',
    documentTitle: 'Kimi k1.5 强化学习技术报告 (V2)', pageCount: 15,
    graph: {
      title: 'Kimi k1.5 强化学习技术报告 (V2)', overview: 'V2 全新长链强化学习与推理扩展。', evidenceQuote: 'V2 证据。', evidencePage: 5,
      sections: [{ title: 'V2 架构', body: 'V2 强化学习。', pageStart: 5, pageEnd: 8, evidenceQuote: 'V2 证据。', evidencePage: 5 }],
      concepts: [], claims: [], relations: []
    }
  });

  const recallAfterDocBUpgrade = store.listTopicKnowledgeUnits(canvasActorKey('https://issuer.example', 'api-subject'), apiTopic.id, {
    excludeFocal: { libraryType: 'user', libraryId: '42', itemKey: 'DOC_A' }
  });
  const docBUnits = recallAfterDocBUpgrade.filter(u => u.itemKey === 'DOC_B' && u.libraryType === 'user');
  assert.ok(docBUnits.every(u => u.documentTitle.includes('(V2)')),
    'Topic knowledge recall must only return units from the latest active analysis version, excluding stale older versions');

  // --- T1 Altero Incremental Scan & Collection Sync Verification ---
  const scanRes = await call(handler, '/canvas/inbox/scan', {
    method: 'POST', cookie, body: { since: 5 }
  });
  assert.equal(scanRes.statusCode, 200);
  assert.equal(scanRes.payload.data.scanned, 2);
  assert.equal(scanRes.payload.data.lastLibraryVersion, 42);
  assert.equal(alteroCalls.length, 3, 'Scan must fetch item list plus concurrent child attachments for each item');
  assert.match(alteroCalls[0].path, /since=5/);
  assert.ok(alteroCalls.some(c => c.path.includes('/items/ALT_ITEM_1/children')));
  assert.ok(alteroCalls.some(c => c.path.includes('/items/ALT_ITEM_2/children')));

  // Verify scanned inbox entries received resolved attachment keys and versions
  const scannedInboxEntry = store.listInboxEntries(canvasActorKey('https://issuer.example', 'api-subject')).find(e => e.itemKey === 'ALT_ITEM_1');
  assert.equal(scannedInboxEntry.attachmentKey, 'ATT_ALT_ITEM_1');
  assert.equal(scannedInboxEntry.attachmentVersion, 5);

  // Collection binding sync with inbound automatic topic linking
  const inboundBindingRes = await call(handler, `/canvas/workspaces/${apiTopic.id}/collection-bindings`, {
    method: 'POST', cookie,
    body: { libraryType: 'user', libraryId: '42', collectionKey: 'API_INBOUND_COL', mode: 'inbound' }
  });
  assert.equal(inboundBindingRes.statusCode, 201);
  const inboundBinding = inboundBindingRes.payload.data;
  assert.equal(inboundBinding.mode, 'inbound');

  const syncBindingRes = await call(handler, `/canvas/collection-bindings/${inboundBinding.id}/sync`, {
    method: 'POST', cookie
  });
  assert.equal(syncBindingRes.statusCode, 200);
  assert.equal(syncBindingRes.payload.data.binding.lastLibraryVersion, 42);
  assert.equal(syncBindingRes.payload.data.syncedCount, 2);
  assert.equal(syncBindingRes.payload.data.addedToTopicCount, 2);

  const topicDocsAfterSync = await call(handler, `/canvas/workspaces/${apiTopic.id}/documents`, { cookie });
  assert.equal(topicDocsAfterSync.statusCode, 200);
  const syncedDocKeys = topicDocsAfterSync.payload.data.map(d => d.itemKey);
  assert.ok(syncedDocKeys.includes('ALT_ITEM_1'));
  assert.ok(syncedDocKeys.includes('ALT_ITEM_2'));

  // Multi-topic batch assignment across multiple workspaces owned by user
  const topic2CreateRes = await call(handler, '/canvas/workspaces', {
    method: 'POST', cookie,
    body: { name: 'API Research Topic 2', description: 'Second topic for batch testing' }
  });
  assert.equal(topic2CreateRes.statusCode, 201);
  const apiTopic2 = topic2CreateRes.payload.data;

  const currentInboxEntries = store.listInboxEntries(canvasActorKey('https://issuer.example', 'api-subject'), { limit: 10 });
  const multiTopicBatchRes = await call(handler, '/canvas/inbox/batch-action', {
    method: 'POST', cookie,
    body: {
      entryIds: currentInboxEntries.slice(0, 2).map(e => e.id),
      action: 'accept',
      targetWorkspaceIds: [apiTopic.id, apiTopic2.id]
    }
  });
  assert.equal(multiTopicBatchRes.statusCode, 200);
  assert.equal(multiTopicBatchRes.payload.data.processed, 2);

  const topic1Docs = await call(handler, `/canvas/workspaces/${apiTopic.id}/documents`, { cookie });
  const topic2Docs = await call(handler, `/canvas/workspaces/${apiTopic2.id}/documents`, { cookie });
  assert.equal(topic1Docs.statusCode, 200);
  assert.equal(topic2Docs.statusCode, 200);
  assert.equal(topic1Docs.payload.data.length, 6);
  assert.equal(topic2Docs.payload.data.length, 2);

  const reopenedEntryId = currentInboxEntries[0].id;
  const reopenInboxRes = await call(handler, '/canvas/inbox/batch-action', {
    method: 'POST', cookie,
    body: { entryIds: [reopenedEntryId], action: 'reopen' }
  });
  assert.equal(reopenInboxRes.statusCode, 200);
  assert.equal(store.getInboxEntry(canvasActorKey('https://issuer.example', 'api-subject'), reopenedEntryId).state, 'new');
  const topic1DocsAfterReopen = await call(handler, `/canvas/workspaces/${apiTopic.id}/documents`, { cookie });
  const topic2DocsAfterReopen = await call(handler, `/canvas/workspaces/${apiTopic2.id}/documents`, { cookie });
  assert.equal(topic1DocsAfterReopen.payload.data.length, 6, 'Reprocessing an inbox entry must preserve existing topic membership');
  assert.equal(topic2DocsAfterReopen.payload.data.length, 2, 'Reprocessing must not silently remove the document from another topic');

  // --- Compound Cursor Pagination (Same-timestamp batch entries test) ---
  const batchSameTime = store.upsertInboxEntries(actor, [
    { libraryType: 'user', libraryId: '42', itemKey: 'CURSOR_1', title: 'Doc 1' },
    { libraryType: 'user', libraryId: '42', itemKey: 'CURSOR_2', title: 'Doc 2' },
    { libraryType: 'user', libraryId: '42', itemKey: 'CURSOR_3', title: 'Doc 3' },
    { libraryType: 'user', libraryId: '42', itemKey: 'CURSOR_4', title: 'Doc 4' },
    { libraryType: 'user', libraryId: '42', itemKey: 'CURSOR_5', title: 'Doc 5' }
  ]);
  assert.equal(batchSameTime.length, 5);

  const page1 = store.listInboxEntries(actor, { limit: 2 });
  assert.equal(page1.length, 2);
  const cursor1 = `${page1[1].updatedAt}|${page1[1].id}`;

  const page2 = store.listInboxEntries(actor, { limit: 2, cursor: cursor1 });
  assert.equal(page2.length, 2);
  assert.notEqual(page1[0].id, page2[0].id);
  assert.notEqual(page1[1].id, page2[0].id);
  assert.notEqual(page2[0].id, page2[1].id);

  const cursor2 = `${page2[1].updatedAt}|${page2[1].id}`;
  const page3 = store.listInboxEntries(actor, { limit: 2, cursor: cursor2 });
  assert.ok(page3.length >= 1);
  assert.notEqual(page2[1].id, page3[0].id);

  // --- Multi-page pagination traversal test (exceeding 1000 items without truncation) ---
  const multiPageCalls = [];
  const multiPageHandler = createCanvasHandler(store, {
    fetchAltero: async (session, path) => {
      multiPageCalls.push(path);
      if (path.includes('/children')) {
        return {
          ok: true, status: 200, headers: new Headers(), json: async () => []
        };
      }
      const url = new URL(path, 'http://localhost');
      const start = Number(url.searchParams.get('start') || 0);
      if (start < 1100) {
        return {
          ok: true, status: 200,
          headers: new Headers({ 'Last-Modified-Version': '100', 'Total-Results': '1150' }),
          json: async () => Array.from({ length: 100 }, (_, i) => ({
            key: `PAGE_${start}_${i}`, data: { key: `PAGE_${start}_${i}`, itemType: 'journalArticle', title: `Item ${start + i}` }
          }))
        };
      }
      return {
        ok: true, status: 200,
        headers: new Headers({ 'Last-Modified-Version': '100', 'Total-Results': '1150' }),
        json: async () => Array.from({ length: 50 }, (_, i) => ({
          key: `PAGE_${start}_${i}`, data: { key: `PAGE_${start}_${i}`, itemType: 'journalArticle', title: `Item ${start + i}` }
        }))
      };
    }
  });

  const multiPageScanRes = await call(multiPageHandler, '/canvas/inbox/scan', { method: 'POST', cookie });
  assert.equal(multiPageScanRes.statusCode, 200);
  assert.equal(multiPageScanRes.payload.data.scanned, 1150);
  assert.equal(multiPageScanRes.payload.data.lastLibraryVersion, 100);
  const itemPageCalls = multiPageCalls.filter(p => !p.includes('/children'));
  assert.equal(itemPageCalls.length, 12, 'Must have traversed all 12 pages past 1000 items');
  assert.match(itemPageCalls[0], /start=0/);
  assert.match(itemPageCalls[11], /start=1100/);

  // Scan input validation tests
  const invalidScanBody1 = await call(handler, '/canvas/inbox/scan', { method: 'POST', cookie, body: 'not-an-object' });
  assert.equal(invalidScanBody1.statusCode, 400);

  const invalidScanBody2 = await call(handler, '/canvas/inbox/scan', { method: 'POST', cookie, body: { since: -5 } });
  assert.equal(invalidScanBody2.statusCode, 400);

  const invalidScanBody3 = await call(handler, '/canvas/inbox/scan', { method: 'POST', cookie, body: { libraryType: 'invalid' } });
  assert.equal(invalidScanBody3.statusCode, 400);

  // Inbox meta verification
  const inboxWithMetaRes = await call(handler, '/canvas/inbox?limit=5', { cookie });
  assert.equal(inboxWithMetaRes.statusCode, 200);
  assert.ok(inboxWithMetaRes.payload.meta);
  assert.ok(typeof inboxWithMetaRes.payload.meta.unreadCount === 'number');
  assert.ok(typeof inboxWithMetaRes.payload.meta.totalCount === 'number');
  assert.ok(inboxWithMetaRes.payload.meta.nextCursor);

  // 1. Premature empty stream test (Total-Results says 200, page 1 returns 100 items, page 2 returns empty)
  const prematureEmptyHandler = createCanvasHandler(store, {
    fetchAltero: async (session, path) => {
      const url = new URL(path, 'http://localhost');
      const start = Number(url.searchParams.get('start') || 0);
      if (start === 0) {
        return {
          ok: true, status: 200,
          headers: new Headers({ 'Last-Modified-Version': '200', 'Total-Results': '200' }),
          json: async () => Array.from({ length: 100 }, (_, i) => ({ key: `PREM1_${i}`, data: { key: `PREM1_${i}`, itemType: 'journalArticle', title: `Item ${i}` } }))
        };
      }
      return {
        ok: true, status: 200,
        headers: new Headers({ 'Last-Modified-Version': '200', 'Total-Results': '200' }),
        json: async () => []
      };
    }
  });
  const prematureRes = await call(prematureEmptyHandler, '/canvas/inbox/scan', { method: 'POST', cookie });
  assert.equal(prematureRes.statusCode, 502, 'Premature stream end on page 2 must trigger 502');

  // 2. Unexpected 304 on subsequent page (Page 1 returns 100, page 2 returns 304)
  const unexpected304Handler = createCanvasHandler(store, {
    fetchAltero: async (session, path) => {
      const url = new URL(path, 'http://localhost');
      const start = Number(url.searchParams.get('start') || 0);
      if (start === 0) {
        return {
          ok: true, status: 200,
          headers: new Headers({ 'Last-Modified-Version': '200', 'Total-Results': '200' }),
          json: async () => Array.from({ length: 100 }, (_, i) => ({ key: `MID304_${i}`, data: { key: `MID304_${i}`, itemType: 'journalArticle', title: `Item ${i}` } }))
        };
      }
      return {
        ok: false, status: 304,
        headers: new Headers({ 'Last-Modified-Version': '200' }),
        json: async () => []
      };
    }
  });
  const mid304Res = await call(unexpected304Handler, '/canvas/inbox/scan', { method: 'POST', cookie });
  assert.equal(mid304Res.statusCode, 502, 'Unexpected mid-traversal 304 on page 2 must trigger 502');

  // 3. Duplicate page loop detection (Page 1 returns 100 items, page 2 at start=100 returns the exact same items)
  const duplicateLoopHandler = createCanvasHandler(store, {
    fetchAltero: async (session, path) => {
      return {
        ok: true, status: 200,
        headers: new Headers({ 'Last-Modified-Version': '200', 'Total-Results': '200' }),
        json: async () => Array.from({ length: 100 }, (_, i) => ({ key: `LOOP_KEY_${i}`, data: { key: `LOOP_KEY_${i}`, itemType: 'journalArticle', title: `Loop Item ${i}` } }))
      };
    }
  });
  const loopRes = await call(duplicateLoopHandler, '/canvas/inbox/scan', { method: 'POST', cookie });
  assert.equal(loopRes.statusCode, 502, 'Pagination loop with duplicate keys across pages must trigger 502');

  // 4. Missing Total-Results with safety page exhaustion test
  let safetyExhaustionThrew = false;
  try {
    await fetchAllUpstreamItems(
      async (session, path) => {
        const url = new URL(path, 'http://localhost');
        const start = Number(url.searchParams.get('start') || 0);
        return {
          ok: true, status: 200,
          headers: new Headers({ 'Last-Modified-Version': '200' }),
          json: async () => Array.from({ length: 100 }, (_, i) => ({ key: `EXHAUST_${start}_${i}`, data: { key: `EXHAUST_${start}_${i}`, itemType: 'journalArticle', title: `Item ${start + i}` } }))
        };
      },
      {}, '/users/42/items/top', { maxSafetyPages: 3, limitPerPage: 100 }
    );
  } catch (err) {
    safetyExhaustionThrew = true;
    assert.match(err.message, /exceeded safety limit/);
  }
  assert.ok(safetyExhaustionThrew, 'Safety limit exhaustion without stream end must throw error');

  // 5. Missing Total-Results with valid 2-page completion (100 on page 1, 1 on page 2 -> 101 total)
  const noTotalResultsResult = await fetchAllUpstreamItems(
    async (session, path) => {
      const url = new URL(path, 'http://localhost');
      const start = Number(url.searchParams.get('start') || 0);
      if (start === 0) {
        return {
          ok: true, status: 200,
          headers: new Headers({ 'Last-Modified-Version': '200' }),
          json: async () => Array.from({ length: 100 }, (_, i) => ({ key: `NOTOTAL1_${i}`, data: { key: `NOTOTAL1_${i}`, itemType: 'journalArticle', title: `Item ${i}` } }))
        };
      }
      return {
        ok: true, status: 200,
        headers: new Headers({ 'Last-Modified-Version': '200' }),
        json: async () => [{ key: 'NOTOTAL2_0', data: { key: 'NOTOTAL2_0', itemType: 'journalArticle', title: 'Item 100' } }]
      };
    },
    {}, '/users/42/collections/COL_1/items', { limitPerPage: 100 }
  );
  assert.equal(noTotalResultsResult.items.length, 101, 'Must gather all 101 items across 2 pages when Total-Results is missing');

  // Upstream failure isolation test
  const failingHandler = createCanvasHandler(store, {
    fetchAltero: async () => ({
      ok: false, status: 500,
      headers: new Headers(),
      json: async () => ({})
    })
  });

  const failingSyncRes = await call(failingHandler, `/canvas/collection-bindings/${inboundBinding.id}/sync`, {
    method: 'POST', cookie
  });
  assert.equal(failingSyncRes.statusCode, 502);
  const bindingAfterFail = store.getCollectionBinding(canvasActorKey('https://issuer.example', 'api-subject'), inboundBinding.id);
  assert.equal(bindingAfterFail.lastLibraryVersion, 42, 'Binding version must not advance on failure');

  // Regression: Child attachment lookup returns HTTP 500
  const children500Handler = createCanvasHandler(store, {
    fetchAltero: async (session, path) => {
      if (path.includes('/children')) {
        return {
          ok: false, status: 500, headers: new Headers(), json: async () => ({ error: 'Internal Server Error' })
        };
      }
      return {
        ok: true, status: 200,
        headers: new Headers({ 'Last-Modified-Version': '50', 'Total-Results': '1' }),
        json: async () => [{ key: 'ITEM_500_CHILD', data: { key: 'ITEM_500_CHILD', itemType: 'journalArticle', title: '500 Test' } }]
      };
    }
  });
  const scan500Res = await call(children500Handler, '/canvas/inbox/scan', { method: 'POST', cookie });
  assert.equal(scan500Res.statusCode, 502, 'Scan must abort with 502 when child attachment query returns 500');

  // Regression: Child attachment lookup returns malformed/illegal JSON
  const childrenBadJsonHandler = createCanvasHandler(store, {
    fetchAltero: async (session, path) => {
      if (path.includes('/children')) {
        return {
          ok: true, status: 200, headers: new Headers(),
          json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); }
        };
      }
      return {
        ok: true, status: 200,
        headers: new Headers({ 'Last-Modified-Version': '50', 'Total-Results': '1' }),
        json: async () => [{ key: 'ITEM_BAD_JSON_CHILD', data: { key: 'ITEM_BAD_JSON_CHILD', itemType: 'journalArticle', title: 'Bad JSON Test' } }]
      };
    }
  });
  const scanBadJsonRes = await call(childrenBadJsonHandler, '/canvas/inbox/scan', { method: 'POST', cookie });
  assert.equal(scanBadJsonRes.statusCode, 502, 'Scan must abort with 502 when child attachment returns illegal JSON');

  // Regression: Item with only non-PDF attachments must NOT bind non-PDF as attachmentKey
  const nonPdfOnlyHandler = createCanvasHandler(store, {
    fetchAltero: async (session, path) => {
      if (path.includes('/children')) {
        return {
          ok: true, status: 200, headers: new Headers(),
          json: async () => [
            {
              key: 'ATT_PNG_ONLY',
              version: 2,
              data: {
                key: 'ATT_PNG_ONLY',
                itemType: 'attachment',
                contentType: 'image/png',
                filename: 'screenshot.png',
                version: 2
              }
            },
            {
              key: 'ATT_HTML_ONLY',
              version: 2,
              data: {
                key: 'ATT_HTML_ONLY',
                itemType: 'attachment',
                contentType: 'text/html',
                filename: 'snapshot.html',
                version: 2
              }
            }
          ]
        };
      }
      return {
        ok: true, status: 200,
        headers: new Headers({ 'Last-Modified-Version': '60', 'Total-Results': '1' }),
        json: async () => [{ key: 'ITEM_NON_PDF_ONLY', data: { key: 'ITEM_NON_PDF_ONLY', itemType: 'journalArticle', title: 'Non-PDF Article' } }]
      };
    }
  });
  const scanNonPdfRes = await call(nonPdfOnlyHandler, '/canvas/inbox/scan', { method: 'POST', cookie });
  assert.equal(scanNonPdfRes.statusCode, 200);
  assert.equal(scanNonPdfRes.payload.data.scanned, 1);
  const nonPdfInboxEntry = store.listInboxEntries(canvasActorKey('https://issuer.example', 'api-subject')).find(e => e.itemKey === 'ITEM_NON_PDF_ONLY');
  assert.ok(nonPdfInboxEntry, 'Inbox entry must be created');
  assert.equal(nonPdfInboxEntry.attachmentKey, null, 'Non-PDF attachments must NOT be bound as attachmentKey');
  assert.equal(nonPdfInboxEntry.attachmentVersion, null, 'Non-PDF attachments must NOT set attachmentVersion');

  // --- Standalone PDF Attachment Scan Support ---
  const standalonePdfHandler = createCanvasHandler(store, {
    fetchAltero: async (_session, path) => {
      if (path.includes('/items/top')) {
        return {
          ok: true, status: 200,
          headers: new Headers({ 'Last-Modified-Version': '70', 'Total-Results': '4' }),
          json: async () => [
            { key: 'PDF_STANDALONE_1', version: 70, data: { key: 'PDF_STANDALONE_1', itemType: 'attachment', contentType: 'application/pdf', filename: 'cicc_strategy_report_2025.pdf', version: 70 } },
            { key: 'PDF_STANDALONE_UNTITLED', version: 70, data: { key: 'PDF_STANDALONE_UNTITLED', itemType: 'attachment', contentType: 'application/pdf', version: 70 } },
            { key: 'HTML_STANDALONE', version: 70, data: { key: 'HTML_STANDALONE', itemType: 'attachment', contentType: 'text/html', filename: 'snapshot.html', version: 70 } },
            { key: 'STANDALONE_NOTE', version: 70, data: { key: 'STANDALONE_NOTE', itemType: 'note', note: '<p>Some note</p>', version: 70 } }
          ]
        };
      }
      return { ok: true, status: 200, headers: new Headers(), json: async () => [] };
    }
  });
  const scanStandalonePdfRes = await call(standalonePdfHandler, '/canvas/inbox/scan', { method: 'POST', cookie });
  assert.equal(scanStandalonePdfRes.statusCode, 200);
  assert.equal(scanStandalonePdfRes.payload.data.scanned, 2, 'Only standalone PDF attachments must be scanned (HTML snapshot and note ignored)');
  const standaloneEntry = store.listInboxEntries(canvasActorKey('https://issuer.example', 'api-subject')).find(e => e.itemKey === 'PDF_STANDALONE_1');
  assert.ok(standaloneEntry, 'Standalone PDF inbox entry must be created');
  assert.equal(standaloneEntry.title, 'cicc_strategy_report_2025', 'Title should strip .pdf extension');
  assert.equal(standaloneEntry.attachmentKey, 'PDF_STANDALONE_1', 'AttachmentKey must point to standalone PDF itself');
  assert.equal(standaloneEntry.attachmentVersion, 70, 'AttachmentVersion must match standalone PDF version');

  const untitledStandaloneEntry = store.listInboxEntries(canvasActorKey('https://issuer.example', 'api-subject')).find(e => e.itemKey === 'PDF_STANDALONE_UNTITLED');
  assert.ok(untitledStandaloneEntry);
  assert.equal(untitledStandaloneEntry.title, '无标题研报');
  assert.equal(untitledStandaloneEntry.attachmentKey, 'PDF_STANDALONE_UNTITLED');

  const eventTypes = store.db.prepare('SELECT event_type FROM provenance_events ORDER BY created_at').all()
    .map(row => row.event_type);
  assert.ok(eventTypes.includes('workspace.created'));
  assert.ok(eventTypes.includes('workspace.updated'));
  assert.ok(eventTypes.includes('topic.document_added'));
  assert.ok(eventTypes.includes('topic.collection_bound'));
  assert.ok(eventTypes.includes('inbox.batch_action'));
  assert.ok(eventTypes.includes('node.created'));
  assert.ok(eventTypes.includes('board.layout_updated'));
  assert.ok(eventTypes.includes('board.imported'));
  assert.ok(eventTypes.includes('node.source_relinked'));
  assert.ok(eventTypes.includes('ai.translated'));
  assert.ok(eventTypes.includes('ai.synthesized'));
  assert.ok(eventTypes.includes('ai.document_mapped'));

  // --- Document Metadata AI Extraction, Query & Manual Override ---
  const extractMetaRes = await call(handler, '/canvas/documents/extract-metadata', {
    method: 'POST', cookie,
    body: {
      libraryType: 'user', libraryId: '42', itemKey: 'META_ITEM_1',
      attachmentKey: 'ATT_1', attachmentVersion: 1,
      filename: '20240315_cicc_report_99812.pdf', rawTitle: '专题报告',
      textSnippet: '中金公司 2024年3月 人形机器人产业链深度研究：从核心零部件到整机制造。核心摘要：本文系统性梳理人形机器人各大产业链环节。'
    }
  });
  assert.equal(extractMetaRes.statusCode, 200);
  assert.equal(extractMetaRes.payload.cached, false);
  assert.equal(extractMetaRes.payload.data.institution, '中金公司');
  assert.equal(extractMetaRes.payload.data.cleanTitle, '【中金公司】人形机器人产业链深度：从核心零部件到整机制造（2024）');
  assert.equal(extractMetaRes.payload.data.source, 'ai');

  // Verify caching on second call with same attachment & version
  const cachedMetaRes = await call(handler, '/canvas/documents/extract-metadata', {
    method: 'POST', cookie,
    body: {
      libraryType: 'user', libraryId: '42', itemKey: 'META_ITEM_1',
      attachmentKey: 'ATT_1', attachmentVersion: 1,
      filename: '20240315_cicc_report_99812.pdf'
    }
  });
  assert.equal(cachedMetaRes.statusCode, 200);
  assert.equal(cachedMetaRes.payload.cached, true);
  assert.equal(cachedMetaRes.payload.data.cleanTitle, '【中金公司】人形机器人产业链深度：从核心零部件到整机制造（2024）');

  // Query metadata via GET
  const getSingleMetaRes = await call(handler, '/canvas/documents/metadata?libraryType=user&libraryId=42&itemKey=META_ITEM_1', { cookie });
  assert.equal(getSingleMetaRes.statusCode, 200);
  assert.equal(getSingleMetaRes.payload.data.cleanTitle, '【中金公司】人形机器人产业链深度：从核心零部件到整机制造（2024）');

  const getListMetaRes = await call(handler, '/canvas/documents/metadata?libraryType=user&libraryId=42', { cookie });
  assert.equal(getListMetaRes.statusCode, 200);
  assert.ok(Array.isArray(getListMetaRes.payload.data));
  assert.ok(getListMetaRes.payload.data.some(m => m.itemKey === 'META_ITEM_1'));

  // Manual update via PATCH (true partial update preserving subtitle/year/summary)
  const patchMetaRes = await call(handler, '/canvas/documents/metadata', {
    method: 'PATCH', cookie,
    body: {
      libraryType: 'user', libraryId: '42', itemKey: 'META_ITEM_1',
      cleanTitle: '【中金公司】人形机器人产业链深度（修改版）',
      institution: '中金公司'
    }
  });
  assert.equal(patchMetaRes.statusCode, 200);
  assert.equal(patchMetaRes.payload.data.cleanTitle, '【中金公司】人形机器人产业链深度（修改版）');
  assert.equal(patchMetaRes.payload.data.subtitle, '从核心零部件到整机制造', 'Untouched subtitle must be preserved by partial PATCH');
  assert.equal(patchMetaRes.payload.data.year, '2024', 'Untouched year must be preserved');
  assert.equal(patchMetaRes.payload.data.source, 'manual');

  // Attachment version change invalidates stale cache
  const versionedExtractRes = await call(handler, '/canvas/documents/extract-metadata', {
    method: 'POST', cookie,
    body: {
      libraryType: 'user', libraryId: '42', itemKey: 'META_ITEM_1',
      attachmentKey: 'ATT_NEW', attachmentVersion: 2,
      filename: '20240315_cicc_report_99812_v2.pdf'
    }
  });
  assert.equal(versionedExtractRes.statusCode, 200);
  assert.equal(versionedExtractRes.payload.cached, false, 'New attachment version must invalidate metadata cache');

  // Cross-library isolation with same itemKey
  const groupMetaRes = await call(handler, '/canvas/documents/extract-metadata', {
    method: 'POST', cookie,
    body: {
      libraryType: 'group', libraryId: '7', itemKey: 'META_ITEM_1',
      filename: 'group_report.pdf', rawTitle: '群组报告'
    }
  });
  assert.equal(groupMetaRes.statusCode, 200);
  const userMeta = store.getDocumentMeta(canvasActorKey('https://issuer.example', 'api-subject'), { libraryType: 'user', libraryId: '42', itemKey: 'META_ITEM_1' });
  const groupMeta = store.getDocumentMeta(canvasActorKey('https://issuer.example', 'api-subject'), { libraryType: 'group', libraryId: '7', itemKey: 'META_ITEM_1' });
  assert.notEqual(userMeta.id, groupMeta.id, 'Group and User libraries must have isolated document metadata');

  // --- T4 Import & SSRF Protection Tests ---
  const {
    validateExternalUrl,
    resolveDoi,
    resolveArxiv,
    resolveHtmlUrl,
    resolveImportInput,
    findDuplicateCandidates
  } = await import('../server/import-resolver.mjs');

  // SSRF & URL validation
  await assert.rejects(
    async () => validateExternalUrl('http://127.0.0.1:8000'),
    /Forbidden address.*private or loopback/,
    'validateExternalUrl must reject loopback IP'
  );
  await assert.rejects(
    async () => validateExternalUrl('http://localhost:3000'),
    /Forbidden address.*private or loopback/,
    'validateExternalUrl must reject localhost'
  );
  await assert.rejects(
    async () => validateExternalUrl('http://10.0.0.1/paper.pdf'),
    /Forbidden address.*private or loopback/,
    'validateExternalUrl must reject private network 10.0.0.0/8'
  );
  await assert.rejects(
    async () => validateExternalUrl('ftp://example.com/paper.pdf'),
    /Only http: and https: protocols are permitted/,
    'validateExternalUrl must reject non-http(s) protocols'
  );
  await assert.rejects(
    async () => validateExternalUrl('http://user:pass@example.com'),
    /Embedded URL credentials are not allowed/,
    'validateExternalUrl must reject embedded credentials'
  );

  // Mock DOI resolution
  const mockDoiFetch = async (url) => {
    return JSON.stringify({
      title: 'Attention Is All You Need',
      author: [
        { given: 'Ashish', family: 'Vaswani' },
        { given: 'Noam', family: 'Shazeer' }
      ],
      issued: { 'date-parts': [[2017]] },
      abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks...',
      publisher: 'Advances in Neural Information Processing Systems',
      URL: 'https://doi.org/10.1038/s41586-020-2649-2'
    });
  };

  const resolvedDoi = await resolveDoi('10.1038/s41586-020-2649-2', { fetchFn: mockDoiFetch });
  assert.equal(resolvedDoi.sourceType, 'doi');
  assert.equal(resolvedDoi.title, 'Attention Is All You Need');
  assert.equal(resolvedDoi.year, 2017);
  assert.equal(resolvedDoi.creators.length, 2);
  assert.equal(resolvedDoi.creators[0].firstName, 'Ashish');
  assert.equal(resolvedDoi.creators[0].lastName, 'Vaswani');

  // Mock arXiv resolution
  const mockArxivFetch = async (url) => {
    return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning</title>
        <summary>We introduce DeepSeek-R1-Zero and DeepSeek-R1, reasoning models trained with large-scale RL...</summary>
        <published>2025-01-22T00:00:00Z</published>
        <author><name>DeepSeek-AI</name></author>
        <author><name>Daya Guo</name></author>
        <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1234/5678</arxiv:doi>
      </entry>
    </feed>`;
  };

  const resolvedArxiv = await resolveArxiv('2501.12948', { fetchFn: mockArxivFetch });
  assert.equal(resolvedArxiv.sourceType, 'arxiv');
  assert.match(resolvedArxiv.title, /DeepSeek-R1/);
  assert.equal(resolvedArxiv.year, 2025);
  assert.equal(resolvedArxiv.pdfUrl, 'https://arxiv.org/pdf/2501.12948.pdf');
  assert.equal(resolvedArxiv.creators.length, 2);

  // Duplicate detection test
  const dupCandidates = findDuplicateCandidates(store, canvasActorKey('https://issuer.example', 'api-subject'), {
    title: 'Kimi k1.5',
    doi: null
  });
  assert.ok(dupCandidates.length > 0, 'findDuplicateCandidates must match existing inbox entry with similar title');
  assert.equal(dupCandidates[0].itemKey, 'ALT_ITEM_2');
  assert.equal(dupCandidates[0].targetType, 'inbox');

  // HTTP API: POST /canvas/imports/resolve
  const resolveHttpRes = await call(handler, '/canvas/imports/resolve', {
    method: 'POST', cookie,
    body: { input: '10.1038/s41586-020-2649-2' }
  });
  // Note: in unit tests network is not mocked for default global fetch, but we test invalid SSRF input
  const ssrfHttpRes = await call(handler, '/canvas/imports/resolve', {
    method: 'POST', cookie,
    body: { input: 'http://127.0.0.1:8000/some/path' }
  });
  assert.equal(ssrfHttpRes.statusCode, 400, 'SSRF URL must be rejected with 400');
  assert.match(ssrfHttpRes.payload.error.message, /Forbidden address/);

  // HTTP API: POST /canvas/imports (Durable import execution)
  const importExecRes = await call(handler, '/canvas/imports', {
    method: 'POST', cookie,
    body: {
      resolved: resolvedDoi,
      targetWorkspaceId: apiTopic.id
    }
  });
  assert.equal(importExecRes.statusCode, 201);
  assert.ok(importExecRes.payload.data.job);
  assert.equal(importExecRes.payload.data.job.jobType, 'import_document');
  assert.equal(importExecRes.payload.data.job.state, 'completed');
  assert.ok(importExecRes.payload.data.entry);
  assert.equal(importExecRes.payload.data.entry.detectedFrom, 'import');
  assert.ok(importExecRes.payload.data.topicDocument);
  assert.equal(importExecRes.payload.data.topicDocument.status, 'accepted');

  const createdJobId = importExecRes.payload.data.job.id;
  const getJobRes = await call(handler, `/canvas/imports/${createdJobId}`, { cookie });
  assert.equal(getJobRes.statusCode, 200);
  assert.equal(getJobRes.payload.data.id, createdJobId);

  // Job retry on failed job test
  const failedJob = store.enqueueJob(canvasActorKey('https://issuer.example', 'api-subject'), {
    jobType: 'import_document',
    resourceType: 'inbox_entry',
    resourceId: 'fail-test'
  });
  store.updateJobState(failedJob.id, { state: 'failed', errorCode: 'network_timeout' });

  const retryJobRes = await call(handler, `/canvas/imports/${failedJob.id}/retry`, { method: 'POST', cookie });
  assert.equal(retryJobRes.statusCode, 200);
  assert.equal(retryJobRes.payload.data.state, 'queued');
  assert.equal(retryJobRes.payload.data.attempts, 1);

  const clearedAiConfigResponse = await call(handler, '/canvas/ai/config', { method: 'DELETE', cookie });
  assert.equal(clearedAiConfigResponse.statusCode, 200);
  assert.equal(clearedAiConfigResponse.payload.data.userConfigured, false);
  assert.equal(store.getAiSettings(canvasActorKey('https://issuer.example', 'api-subject')), null);

  destroySession(session.id);
  console.log('✅ Canvas persistence, ownership, sources, CRUD, provenance, export/import, C5 AI synthesis, Schema v3 topics & inbox, and atomic conflicts passed');
} finally {
  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('🎉 AltCanvas Canvas tests passed');
