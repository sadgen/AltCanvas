import assert from 'assert/strict';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { CanvasConflictError, CanvasNotFoundError, CanvasStore, canvasActorKey } from '../server/canvas-store.mjs';
import { createCanvasHandler, recoverQueuedAndRunningJobs, defaultPromoteBlob, normalizeResolvedImportMetadata } from '../server/canvas-api.mjs';
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

  const handler = createCanvasHandler(store, {
    aiPublicConfig: () => ({ configured: true, provider: 'mock.example', model: 'mock-model' }),
    aiEndpointValidator: async endpoint => {
      aiValidatedEndpoints.push(endpoint);
      return `${endpoint.replace(/\/+$/, '')}/chat/completions`;
    },
    aiCompletion: async (request, privateConfig) => {
      aiCalls.push(request);
      aiPrivateConfigs.push(privateConfig);
      const system = String(request.messages?.[0]?.content || '');
      if (system.includes('学术关联')) {
        const content = String(request.messages?.at(-1)?.content || '');
        const boardPart = content.split('当前画板已有卡片')[1] || '';
        const matchExisting = /\[([0-9a-f-]+)\]/i.exec(boardPart);
        const targetId = matchExisting ? matchExisting[1] : null;
        if (targetId) {
          return JSON.stringify([
            { from: 'section-0', to: `existing:${targetId}`, relation: 'extends', label: '扩展既有卡片' }
          ]);
        }
        return '[]';
      }
      if (system.includes('空间画板')) {
        if (String(request.messages?.at(-1)?.content || '').includes('文档标题：坏结构')) return 'not-json';
        if (String(request.messages?.at(-1)?.content || '').includes('文档标题：关联已有节点论文')) {
          const matchExisting = /\[([0-9a-f-]+)\]/i.exec(String(request.messages?.at(-1)?.content || ''));
          const targetId = matchExisting ? matchExisting[1] : 'unknown-id';
          return JSON.stringify({
            title: '关联已有节点论文',
            overview: '探讨跨文献关系与扩展。',
            evidenceQuote: '第一页研究问题和方法。', evidencePage: 1,
            sections: [{ title: '关联论述', body: '扩展既有卡片的分析方法。', pageStart: 1, pageEnd: 1,
              evidenceQuote: '第一页研究问题和方法。', evidencePage: 1 }],
            concepts: [{ title: '扩展概念', body: '在原有基础上发展的新概念。', pageStart: 1, pageEnd: 1,
              evidenceQuote: '第一页研究问题和方法。', evidencePage: 1 }],
            claims: [{ title: '实证结果', body: '实验支持该方法。', pageStart: 1, pageEnd: 1,
              evidenceQuote: '第一页研究问题和方法。', evidencePage: 1 }],
            relations: [
              { from: 'section-0', to: `existing:${targetId}`, relation: 'extends', label: '扩展既有卡片' }
            ]
          });
        }
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
    },
    downloadPdfFn: async (url, targetDir) => {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      const tempFileName = `download-mock-${crypto.randomBytes(8).toString('hex')}.tmp`;
      const tempFilePath = path.join(targetDir, tempFileName);
      const pdfContent = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
      fs.writeFileSync(tempFilePath, pdfContent, { mode: 0o600 });
      const sha256 = crypto.createHash('sha256').update(pdfContent).digest('hex');
      return {
        tempFilePath,
        sha256,
        sizeBytes: pdfContent.length,
        mimeType: 'application/pdf'
      };
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

  // [M4] Altero group libraries are no longer accessible to any session:
  // group 8 and formerly-allowed group 7 must both be rejected with 403.
  const forbiddenSource = await call(handler, `/canvas/boards/${apiBoard.id}/nodes`, {
    method: 'POST', cookie,
    body: {
      type: 'annotation', x: 0, y: 0, width: 240, height: 120,
      source: { libraryType: 'group', libraryId: '8', annotationKey: 'ANN00002' }
    }
  });
  assert.equal(forbiddenSource.statusCode, 403);

  const forbiddenGroupSevenSource = await call(handler, `/canvas/boards/${apiBoard.id}/nodes`, {
    method: 'POST', cookie,
    body: {
      type: 'annotation', x: 0, y: 0, width: 240, height: 120,
      source: { libraryType: 'group', libraryId: '7', annotationKey: 'ANN00003' }
    }
  });
  assert.equal(forbiddenGroupSevenSource.statusCode, 403,
    'M4 removed group membership from sessions, so even former in-group libraries must be rejected');

  // Native-library sources remain allowed for the local session.
  const nativeLibraryNodeResponse = await call(handler, `/canvas/boards/${apiBoard.id}/nodes`, {
    method: 'POST', cookie,
    body: {
      type: 'annotation', x: 0, y: 0, width: 240, height: 120,
      title: 'Native source',
      source: { libraryType: 'native', libraryId: 'local', annotationKey: 'ANN00004' }
    }
  });
  assert.equal(nativeLibraryNodeResponse.statusCode, 201);

  const deletedGroupNodeResponse = await call(handler, `/canvas/nodes/${nativeLibraryNodeResponse.payload.data.id}`, {
    method: 'DELETE', cookie, headers: { 'if-match': 'W/"1"' }
  });
  assert.equal(deletedGroupNodeResponse.statusCode, 204);
  const restoredGroupNodeResponse = await call(handler, `/canvas/nodes/${nativeLibraryNodeResponse.payload.data.id}/restore`, {
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
      sourceNodeId: nativeLibraryNodeResponse.payload.data.id,
      targetNodeId: manualNodeResponse.payload.data.id,
      relation: 'related'
    }
  });
  assert.equal(edgeResponse.statusCode, 201);

  const apiSnapshotResponse = await call(handler, `/canvas/boards/${apiBoard.id}/snapshot`, { cookie });
  assert.equal(apiSnapshotResponse.statusCode, 200);
  assert.equal(apiSnapshotResponse.payload.data.nodes.length, 2);
  assert.equal(apiSnapshotResponse.payload.data.edges.length, 1);
  assert.equal(apiSnapshotResponse.payload.data.sources[0].libraryId, 'local');

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

  const nativeNodeAfterLayout = afterConflict.nodes.find(node => node.id === nativeLibraryNodeResponse.payload.data.id);
  const relinkedSourceResponse = await call(handler, `/canvas/nodes/${nativeNodeAfterLayout.id}/source`, {
    method: 'PATCH', cookie, headers: { 'if-match': `W/"${nativeNodeAfterLayout.version}"` },
    body: {
      source: {
        libraryType: 'native', libraryId: 'local', itemKey: 'ITEM0001',
        attachmentKey: 'ATTACH02', annotationKey: 'ANNREST1', annotationVersion: 11,
        pageLabel: '9', position: { pageIndex: 8, rects: [[8, 10, 10, 40, 20]] },
        quoteSnapshot: 'Restored quoted evidence'
      }
    }
  });
  assert.equal(relinkedSourceResponse.statusCode, 200);
  assert.equal(relinkedSourceResponse.payload.data.node.version, nativeNodeAfterLayout.version + 1);
  assert.equal(relinkedSourceResponse.payload.data.source.annotationKey, 'ANNREST1');
  assert.equal(relinkedSourceResponse.payload.data.source.quoteSnapshot, 'Restored quoted evidence');

  const staleRelinkResponse = await call(handler, `/canvas/nodes/${nativeNodeAfterLayout.id}/source`, {
    method: 'PATCH', cookie, headers: { 'if-match': `W/"${nativeNodeAfterLayout.version}"` },
    body: {
      source: {
        libraryType: 'native', libraryId: 'local', attachmentKey: 'ATTACH02',
        annotationKey: 'ANNDUPE1'
      }
    }
  });
  assert.equal(staleRelinkResponse.statusCode, 412, 'source relinking must reject stale card versions');

  const forbiddenRelinkResponse = await call(handler, `/canvas/nodes/${nativeNodeAfterLayout.id}/source`, {
    method: 'PATCH', cookie, headers: { 'if-match': `W/"${nativeNodeAfterLayout.version + 1}"` },
    body: {
      source: {
        libraryType: 'group', libraryId: '8', attachmentKey: 'ATTACH02',
        annotationKey: 'ANNNOAUTH'
      }
    }
  });
  assert.equal(forbiddenRelinkResponse.statusCode, 403, 'source relinking must enforce library access');

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
  assert.ok(!importedSnapshot.nodes.some(n => n.id === nativeLibraryNodeResponse.payload.data.id));
  assert.ok(!importedSnapshot.nodes.some(n => n.id === manualNodeResponse.payload.data.id));
  // Verify edge connects the newly generated node IDs correctly
  const importedSourceNode = importedSnapshot.nodes.find(n => n.type === 'annotation');
  const importedTargetNode = importedSnapshot.nodes.find(n => n.type === 'manual_note');
  assert.equal(importedSnapshot.edges[0].sourceNodeId, importedSourceNode.id);
  assert.equal(importedSnapshot.edges[0].targetNodeId, importedTargetNode.id);

  const forbiddenImportBundle = structuredClone(bundle);
  forbiddenImportBundle.sources[0].libraryType = 'group';
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
    inputNodeIds: [nativeLibraryNodeResponse.payload.data.id],
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
    attachmentVersion: 2, model: 'mock-model', promptVersion: 'altcanvas-document-map-v2',
    status: 'ready', documentTitle: 'Version 2 Only', pageCount: 1, graph: { overview: 'Version 2 Analysis' }
  });

  const unversionedLookup = store.getDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', attachmentKey: 'PDF_V2_ONLY', attachmentVersion: null,
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v2'
  });
  assert.equal(unversionedLookup, null, 'Unversioned lookup must not match versioned cache record');

  const mismatchedVersionLookup = store.getDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', attachmentKey: 'PDF_V2_ONLY', attachmentVersion: 3,
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v2'
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

  // --- In-place Update & Deduplication on Same Board ---
  const board1NodesBeforeRepeat = store.snapshot(canvasActorKey('https://issuer.example', 'api-subject'), apiBoard.id).nodes.length;
  const repeatMapResponse = await call(handler, `/canvas/boards/${apiBoard.id}/ai/document-map`, {
    method: 'POST', cookie, body: {
      title: '测试论文 (Repeat understanding)',
      document: {
        libraryType: 'user', libraryId: '42', itemKey: 'DOC1', attachmentKey: 'PDF1', attachmentVersion: 1
      },
      pages: [
        { pageNumber: 1, text: '第一页研究问题和方法。' },
        { pageNumber: 2, text: '第二页主要发现和限制。' }
      ]
    }
  });
  assert.equal(repeatMapResponse.statusCode, 201);
  assert.equal(repeatMapResponse.payload.data.inPlaceUpdated, true, 'Repeat document-map on same board must update in-place without duplicating cards');
  const board1NodesAfterRepeat = store.snapshot(canvasActorKey('https://issuer.example', 'api-subject'), apiBoard.id).nodes.length;
  assert.equal(board1NodesAfterRepeat, board1NodesBeforeRepeat, 'Total node count on board must NOT increase on repeated document-map');

  // checkOnly returns alreadyOnBoard: true
  const checkOnlyOnBoardRes = await call(handler, `/canvas/boards/${apiBoard.id}/ai/document-map`, {
    method: 'POST', cookie, body: {
      checkOnly: true,
      document: { libraryType: 'user', libraryId: '42', itemKey: 'DOC1', attachmentKey: 'PDF1', attachmentVersion: 1 }
    }
  });
  assert.equal(checkOnlyOnBoardRes.statusCode, 200);
  assert.equal(checkOnlyOnBoardRes.payload.data.cached, true);
  assert.equal(checkOnlyOnBoardRes.payload.data.alreadyOnBoard, true, 'checkOnly must report alreadyOnBoard = true');

  // --- Context Injection & existing:<nodeId> Edge Generation ---
  // Create an existing note on boardInTopic2
  const existingNoteRes = await call(handler, `/canvas/boards/${boardInTopic2.id}/nodes`, {
    method: 'POST', cookie, body: {
      type: 'manual_note', x: 100, y: 100, width: 240, height: 100, title: '基准先验观点', body: '先前研究表明推理计算量与效果成正比。'
    }
  });
  assert.equal(existingNoteRes.statusCode, 201);
  const existingNoteNode = existingNoteRes.payload.data;

  // Run document map for a new document that references existingNoteNode
  const crossMapResponse = await call(handler, `/canvas/boards/${boardInTopic2.id}/ai/document-map`, {
    method: 'POST', cookie, body: {
      title: '关联已有节点论文',
      document: {
        libraryType: 'user', libraryId: '42', itemKey: 'DOC_CROSS', attachmentKey: 'PDF_CROSS', attachmentVersion: 1
      },
      pages: [
        { pageNumber: 1, text: '第一页研究问题和方法。' }
      ]
    }
  });
  assert.equal(crossMapResponse.statusCode, 201);
  assert.equal(crossMapResponse.payload.data.cached, false);
  const crossNodes = crossMapResponse.payload.data.nodes;

  // Verify that the prompt sent to AI contained the existing card context
  const lastAiCall = aiCalls.at(-1);
  const userContent = String(lastAiCall.messages?.find(m => m.role === 'user')?.content || '');
  assert.match(userContent, /当前画板已有卡片/, 'Synthesis prompt must inject current board card context');
  assert.match(userContent, new RegExp(existingNoteNode.id), 'Synthesis prompt must include existing card ID');

  // Verify that an edge connecting to the existing card was saved to SQLite
  const boardInTopic2Edges = store.snapshot(canvasActorKey('https://issuer.example', 'api-subject'), boardInTopic2.id).edges;
  const crossEdge = boardInTopic2Edges.find(e => e.targetNodeId === existingNoteNode.id || e.sourceNodeId === existingNoteNode.id);
  assert.ok(crossEdge, 'existing:<nodeId> must create a real persistent edge in SQLite DB');
  assert.equal(crossEdge.relation, 'extends', 'Edge relation extends must be preserved');
  assert.equal(crossEdge.targetNodeId, existingNoteNode.id);

  // --- Repeat Full-text Understanding on boardInTopic2 must NOT accumulate duplicate edges or self-relations ---
  const edgesCountBeforeRepeat = store.snapshot(canvasActorKey('https://issuer.example', 'api-subject'), boardInTopic2.id).edges.length;
  const repeatCrossMapResponse = await call(handler, `/canvas/boards/${boardInTopic2.id}/ai/document-map`, {
    method: 'POST', cookie, body: {
      title: '关联已有节点论文 (Repeat)',
      document: { libraryType: 'user', libraryId: '42', itemKey: 'DOC_CROSS', attachmentKey: 'PDF_CROSS', attachmentVersion: 1 }
    }
  });
  assert.equal(repeatCrossMapResponse.statusCode, 201);
  const edgesCountAfterRepeat = store.snapshot(canvasActorKey('https://issuer.example', 'api-subject'), boardInTopic2.id).edges.length;
  assert.equal(edgesCountAfterRepeat, edgesCountBeforeRepeat, 'Edge count must NOT increase on repeated document-map (idempotent edge deduplication)');

  // Verify Stage 2 prompt excluded DOC_CROSS's own nodes (no pseudo self-relations)
  const repeatAiCall = aiCalls.at(-1);
  const repeatUserPrompt = String(repeatAiCall.messages?.find(m => m.role === 'user')?.content || '');
  const existingCardsPart = repeatUserPrompt.split('当前画板已有卡片')[1] || '';
  assert.doesNotMatch(existingCardsPart, /关联已有节点论文/, 'Stage 2 existingNodes must strictly exclude focal document nodes');

  // Verify active edges connect active nodes without dangling endpoints
  const snapCheck = store.snapshot(canvasActorKey('https://issuer.example', 'api-subject'), boardInTopic2.id);
  const activeNodeIds = new Set(snapCheck.nodes.map(n => n.id));
  assert.ok(snapCheck.edges.every(e => activeNodeIds.has(e.sourceNodeId) && activeNodeIds.has(e.targetNodeId)),
    'All active edges on board must strictly connect existing active nodes without dangling endpoints');

  // --- Test Edge Ownership Protection: Manual user edge must NOT be overwritten by AI Stage 2 ---
  const crossSectionNode = crossNodes.find(n => n.title.includes('章节'));
  const crossOverviewInitial = crossNodes.find(n => n.title.includes('全文概览'));
  assert.ok(crossSectionNode);
  assert.ok(crossOverviewInitial);

  // 1. External manual edge
  const userManualEdge = store.createEdge(canvasActorKey('https://issuer.example', 'api-subject'), boardInTopic2.id, {
    sourceNodeId: crossSectionNode.id,
    targetNodeId: existingNoteNode.id,
    relation: 'supports',
    label: '用户手工核验证据'
  });
  assert.equal(userManualEdge.origin, 'manual');
  assert.equal(userManualEdge.label, '用户手工核验证据');
  assert.equal(userManualEdge.version, 1);

  // 2. Internal manual edge between document nodes
  const userInternalManualEdge = store.createEdge(canvasActorKey('https://issuer.example', 'api-subject'), boardInTopic2.id, {
    sourceNodeId: crossOverviewInitial.id,
    targetNodeId: crossSectionNode.id,
    relation: 'cites',
    label: '用户内部手工批注边'
  });
  assert.equal(userInternalManualEdge.origin, 'manual');

  // Re-run document map which outputs relation between crossSectionNode and existingNoteNode
  await call(handler, `/canvas/boards/${boardInTopic2.id}/ai/document-map`, {
    method: 'POST', cookie, body: {
      title: '关联已有节点论文 (Protect Manual Edge)',
      document: { libraryType: 'user', libraryId: '42', itemKey: 'DOC_CROSS', attachmentKey: 'PDF_CROSS', attachmentVersion: 1 }
    }
  });

  const checkedManualEdge = store.getEdge(canvasActorKey('https://issuer.example', 'api-subject'), userManualEdge.id);
  assert.equal(checkedManualEdge.origin, 'manual', 'Manual edge origin must remain manual');
  assert.equal(checkedManualEdge.label, '用户手工核验证据', 'Manual edge label must NEVER be overwritten by AI document map');
  assert.equal(checkedManualEdge.version, 1, 'Manual edge version must not be changed');

  // Verify internal manual edge was preserved during in-place update
  const checkedInternalManualEdge = store.getEdge(canvasActorKey('https://issuer.example', 'api-subject'), userInternalManualEdge.id);
  assert.ok(checkedInternalManualEdge, 'Internal manual edge inside document must be preserved during in-place update');
  assert.equal(checkedInternalManualEdge.origin, 'manual');
  assert.equal(checkedInternalManualEdge.label, '用户内部手工批注边');

  // --- Test P2 Edge Migration with Manual-Wins Conflict Priority when old nodes are reduced ---
  // Create a 2nd external note
  const extNote2 = store.createNode(canvasActorKey('https://issuer.example', 'api-subject'), boardInTopic2.id, {
    type: 'manual_note', x: 200, y: 500, width: 200, height: 100, title: '外部笔记 2', body: '外部关联观点'
  });
  const crossClaimNode = crossNodes.find(n => n.title.includes('论点'));
  assert.ok(crossClaimNode);

  // Pre-create an AI context edge at (crossOverviewInitial, extNote2) with relation 'related'
  const preExistingAiEdge = store.createEdge(canvasActorKey('https://issuer.example', 'api-subject'), boardInTopic2.id, {
    sourceNodeId: crossOverviewInitial.id,
    targetNodeId: extNote2.id,
    relation: 'related',
    label: 'AI 自动关联观点',
    origin: 'document_map_context'
  });

  // Create a manual edge from old claim node to extNote2 with same relation 'related'
  const manualEdgeToClaim = store.createEdge(canvasActorKey('https://issuer.example', 'api-subject'), boardInTopic2.id, {
    sourceNodeId: crossClaimNode.id,
    targetNodeId: extNote2.id,
    relation: 'related',
    label: '重要人工关联结论',
    origin: 'manual'
  });
  assert.equal(manualEdgeToClaim.version, 1);

  // Now project a reduced analysis for DOC_CROSS with 0 claims (so crossClaimNode is soft-deleted)
  const reducedAnalysis = store.projectDocumentAnalysisToBoard(canvasActorKey('https://issuer.example', 'api-subject'), boardInTopic2.id, {
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v2',
    document: { libraryType: 'user', libraryId: '42', itemKey: 'DOC_CROSS', attachmentKey: 'PDF_CROSS', pageCount: 1 },
    graph: {
      title: '关联已有节点论文 (Reduced)', overview: '精简版概览', evidenceQuote: '原文', evidencePage: 1,
      sections: [{ title: '单一章节', body: '保留章节', pageStart: 1, pageEnd: 1, evidenceQuote: '原文', evidencePage: 1 }],
      concepts: [], claims: [], relations: []
    },
    cached: true
  });

  // Verify old claim node is soft deleted
  assert.equal(store.getNode(canvasActorKey('https://issuer.example', 'api-subject'), crossClaimNode.id), null);

  // Manual-wins verification: the AI edge preExistingAiEdge should be replaced/deleted, and the manual edge should survive retargeted to Overview
  assert.equal(store.getEdge(canvasActorKey('https://issuer.example', 'api-subject'), preExistingAiEdge.id), null,
    'When manual edge retargets to existing AI edge position, manual edge must win and replace the AI edge');

  const retargetedEdge = store.getEdge(canvasActorKey('https://issuer.example', 'api-subject'), manualEdgeToClaim.id);
  assert.ok(retargetedEdge, 'Retargeted manual edge must survive');
  const crossOverviewNode = reducedAnalysis.nodes.find(n => n.title.includes('全文概览'));
  assert.equal(retargetedEdge.sourceNodeId, crossOverviewNode.id, 'Edge source must be retargeted to Overview');
  assert.equal(retargetedEdge.targetNodeId, extNote2.id);
  assert.equal(retargetedEdge.origin, 'manual', 'Retargeted edge origin must remain manual');
  assert.equal(retargetedEdge.label, '重要人工关联结论', 'Retargeted edge must preserve user label');
  assert.equal(retargetedEdge.version, 2, 'Retargeted edge version must increment');

  // Verify provenance event was recorded
  const provEvents = store.listProvenanceEvents(canvasActorKey('https://issuer.example', 'api-subject'), { boardId: boardInTopic2.id });
  const retargetEvent = provEvents.find(p => p.type === 'edge.retargeted' && p.payload?.edgeId === manualEdgeToClaim.id);
  assert.ok(retargetEvent, 'edge.retargeted provenance event must be recorded');
  assert.equal(retargetEvent.payload.oldNodeId, crossClaimNode.id);
  assert.equal(retargetEvent.payload.retargetedNodeId, crossOverviewNode.id);

  // Verify global document analysis cache is NOT polluted with board-specific existing:<nodeId> relations
  const globalAnalysis = store.getDocumentAnalysis(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', attachmentKey: 'PDF_CROSS', attachmentVersion: 1,
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v2'
  });
  assert.ok(globalAnalysis);
  assert.ok(globalAnalysis.graph.relations.every(r => !String(r.from || '').startsWith('existing:') && !String(r.to || '').startsWith('existing:')),
    'Global document analysis cache must strictly decouple from board context and NOT contain existing:<nodeId> relations');

  // Verify projecting from cache to a 3rd board works cleanly without passing pages
  const topic3WsRes = await call(handler, '/canvas/workspaces', {
    method: 'POST', cookie, body: { name: 'Topic 3' }
  });
  const boardInTopic3Res = await call(handler, `/canvas/workspaces/${topic3WsRes.payload.data.id}/boards`, {
    method: 'POST', cookie, body: { name: 'Board in Topic 3' }
  });
  const boardInTopic3 = boardInTopic3Res.payload.data;
  const cacheProjectRes = await call(handler, `/canvas/boards/${boardInTopic3.id}/ai/document-map`, {
    method: 'POST', cookie, body: {
      title: 'Topic 3 Cached Projection',
      document: { libraryType: 'user', libraryId: '42', itemKey: 'DOC_CROSS', attachmentKey: 'PDF_CROSS', attachmentVersion: 1 }
    }
  });
  assert.equal(cacheProjectRes.statusCode, 201);
  assert.equal(cacheProjectRes.payload.data.cached, true);
  assert.equal(cacheProjectRes.payload.data.nodes.length, 4);

  // Non-overlapping placement: newly created nodes must be offset from existing cards
  assert.ok(crossNodes.every(n => n.x >= 300), 'New document map nodes must be positioned with positive X offset from existing cards');

  const aiApiRes = await call(handler, `/canvas/boards/${apiBoard.id}/ai/generate`, {
    method: 'POST',
    cookie,
    body: {
      task: 'synthesize',
      prompt: '提取共同点',
      inputNodeIds: [nativeLibraryNodeResponse.payload.data.id, manualNodeResponse.payload.data.id],
      modelConfig: { endpoint: 'http://127.0.0.1:1', apiKey: 'must-be-ignored', model: 'untrusted-model' }
    }
  });
  assert.equal(aiApiRes.statusCode, 201);
  assert.equal(aiApiRes.payload.data.node.type, 'ai_output');
  assert.match(aiApiRes.payload.data.node.body, /【学术分析】/);
  assert.equal(aiApiRes.payload.data.edges.length, 2);
  assert.ok(aiApiRes.payload.data.edges.every(e => e.origin === 'ai_synthesis'), 'AI synthesis edges must have origin ai_synthesis');
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
    assert.equal(maxV, 13, 'Database must be upgraded to schema v13');

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
    assert.equal(maxV, 13, 'Database must be upgraded from v5 to v13');

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
    assert.equal(maxV, 13, 'Database must be upgraded from v7 to v13');

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

  // --- Schema v10 -> v11 Migration Test (edges origin and projection_key backfill) ---
  const v10Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-v10-migration-test-'));
  const v10DbPath = path.join(v10Dir, 'canvas-v10.sqlite');
  try {
    const rawV10 = new DatabaseSync(v10DbPath);
    rawV10.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-08-30T00:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (10, '2026-08-31T00:00:00.000Z');

      CREATE TABLE workspaces (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT) STRICT;
      CREATE TABLE boards (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, viewport_x REAL NOT NULL DEFAULT 0, viewport_y REAL NOT NULL DEFAULT 0, viewport_zoom REAL NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT) STRICT;
      CREATE TABLE nodes (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, node_type TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, z_index INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', color TEXT, source_ref_id TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT) STRICT;
      CREATE TABLE edges (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, source_node_id TEXT NOT NULL, target_node_id TEXT NOT NULL, relation TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT) STRICT;

      INSERT INTO workspaces (id, owner_key, name, created_at, updated_at) VALUES ('ws-v10', '${actor}', 'V10 Workspace', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO boards (id, workspace_id, name, created_at, updated_at) VALUES ('board-v10', 'ws-v10', 'V10 Board', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO nodes (id, board_id, node_type, x, y, width, height, created_at, updated_at) VALUES ('n1', 'board-v10', 'manual_note', 0, 0, 100, 100, '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO nodes (id, board_id, node_type, x, y, width, height, created_at, updated_at) VALUES ('n2', 'board-v10', 'manual_note', 200, 0, 100, 100, '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO edges (id, board_id, source_node_id, target_node_id, relation, label, created_at, updated_at) VALUES ('e-v10-1', 'board-v10', 'n1', 'n2', 'supports', 'Legacy Edge', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
    `);
    rawV10.close();

    const migratedV10Store = new CanvasStore(v10DbPath);
    const maxV10 = migratedV10Store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    assert.equal(maxV10, 13, 'Database must be upgraded from v10 to v13');

    const migratedEdge = migratedV10Store.getEdge(actor, 'e-v10-1');
    assert.ok(migratedEdge);
    assert.equal(migratedEdge.origin, 'manual', 'Legacy edges must default to origin manual');
    assert.equal(migratedEdge.projectionKey, null);
    assert.equal(migratedEdge.label, 'Legacy Edge');

    // Verify sqlite_master contains origin CHECK constraint
    const tableSql = migratedV10Store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='edges'").get().sql;
    assert.match(tableSql, /CHECK \(origin IN \('manual', 'document_map_internal', 'document_map_context', 't3_expand', 'ai_synthesis'\)\)/);

    // Verify Store method rejects illegal origin
    assert.throws(() => {
      migratedV10Store.createEdge(actor, 'board-v10', {
        sourceNodeId: 'n1', targetNodeId: 'n2', relation: 'supports', origin: 'bogus_origin'
      });
    }, /invalid edge origin/);

    // Verify SQLite directly rejects illegal origin with CHECK constraint failure
    assert.throws(() => {
      migratedV10Store.db.prepare(`
        INSERT INTO edges (id, board_id, source_node_id, target_node_id, relation, origin, created_at, updated_at)
        VALUES ('e-illegal', 'board-v10', 'n1', 'n2', 'supports', 'illegal_raw_origin', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')
      `).run();
    }, /CHECK constraint failed/);

    migratedV10Store.close();
  } finally {
    fs.rmSync(v10Dir, { recursive: true, force: true });
  }

  // --- Lineage Test 2: Genuine Mainline Schema v11 DB -> v12 ---
  const v11LineageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-v11-lineage-test-'));
  const v11LineageDbPath = path.join(v11LineageDir, 'canvas-v11.sqlite');
  try {
    const rawV11 = new DatabaseSync(v11LineageDbPath);
    rawV11.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-08-30T00:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (2, '2026-08-30T01:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (3, '2026-08-31T00:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (4, '2026-08-31T01:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (5, '2026-08-31T02:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (6, '2026-08-31T03:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (7, '2026-08-31T04:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (8, '2026-08-31T05:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (9, '2026-08-31T06:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (10, '2026-08-31T07:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (11, '2026-08-31T08:00:00.000Z');

      CREATE TABLE ai_settings (
        owner_key TEXT PRIMARY KEY,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key_encrypted TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE provenance_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        board_id TEXT,
        node_id TEXT,
        actor_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX provenance_workspace_idx ON provenance_events(workspace_id, created_at);

      -- Genuine v11 tables with strict ('user', 'group') library_type constraints
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        description TEXT NOT NULL DEFAULT '', research_question TEXT NOT NULL DEFAULT '',
        inclusion_rules TEXT NOT NULL DEFAULT '', exclusion_rules TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      ) STRICT;
      CREATE INDEX workspaces_owner_idx ON workspaces(owner_key, deleted_at, updated_at);

      CREATE TABLE boards (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL,
        viewport_x REAL NOT NULL DEFAULT 0, viewport_y REAL NOT NULL DEFAULT 0, viewport_zoom REAL NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      ) STRICT;
      CREATE INDEX boards_workspace_idx ON boards(workspace_id, deleted_at, updated_at);

      CREATE TABLE source_refs (
        id TEXT PRIMARY KEY, owner_key TEXT NOT NULL,
        library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group')),
        library_id TEXT NOT NULL, item_key TEXT, attachment_key TEXT, attachment_version INTEGER,
        annotation_key TEXT, annotation_version INTEGER, page_label TEXT, position_json TEXT,
        quote_snapshot TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX source_refs_owner_idx ON source_refs(owner_key, library_type, library_id);
      CREATE INDEX source_refs_target_idx ON source_refs(library_type, library_id, item_key, annotation_key);

      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id), node_type TEXT NOT NULL,
        x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, z_index INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', color TEXT,
        source_ref_id TEXT REFERENCES source_refs(id), version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      ) STRICT;
      CREATE INDEX nodes_board_idx ON nodes(board_id, deleted_at, z_index);

      CREATE TABLE edges (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id),
        source_node_id TEXT NOT NULL REFERENCES nodes(id), target_node_id TEXT NOT NULL REFERENCES nodes(id),
        relation TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'document_map_internal', 'document_map_context', 't3_expand', 'ai_synthesis')),
        projection_key TEXT, version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
        CHECK (source_node_id <> target_node_id)
      ) STRICT;
      CREATE INDEX edges_board_idx ON edges(board_id, deleted_at);
      CREATE INDEX edges_projection_idx ON edges(board_id, projection_key, origin) WHERE deleted_at IS NULL;

      CREATE TABLE topic_documents (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), owner_key TEXT NOT NULL,
        library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group')), library_id TEXT NOT NULL, item_key TEXT NOT NULL,
        attachment_key TEXT, status TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox', 'accepted', 'deferred', 'ignored', 'removed')),
        analysis_status TEXT NOT NULL DEFAULT 'not_started' CHECK (analysis_status IN ('not_started', 'queued', 'running', 'ready', 'failed', 'stale')),
        origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('collection_sync', 'canvas_import', 'manual', 'ai_suggestion')),
        classification_confidence REAL, classification_reason TEXT, item_version INTEGER, attachment_version INTEGER,
        version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX topic_documents_unique_active_idx ON topic_documents(workspace_id, library_type, library_id, item_key) WHERE deleted_at IS NULL;
      CREATE INDEX topic_documents_owner_idx ON topic_documents(owner_key, workspace_id, status, deleted_at);
      CREATE INDEX topic_documents_lookup_idx ON topic_documents(library_type, library_id, item_key);

      CREATE TABLE collection_bindings (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), owner_key TEXT NOT NULL,
        library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group')), library_id TEXT NOT NULL,
        collection_key TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'inbound' CHECK (mode IN ('inbound', 'confirm_both')),
        last_library_version INTEGER NOT NULL DEFAULT 0, last_synced_at TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX collection_bindings_unique_active_idx ON collection_bindings(workspace_id, library_type, library_id, collection_key) WHERE deleted_at IS NULL;
      CREATE INDEX collection_bindings_owner_idx ON collection_bindings(owner_key, workspace_id, deleted_at);

      CREATE TABLE inbox_entries (
        id TEXT PRIMARY KEY, owner_key TEXT NOT NULL,
        library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group')), library_id TEXT NOT NULL, item_key TEXT NOT NULL,
        attachment_key TEXT, detected_from TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '', creators_json TEXT NOT NULL DEFAULT '[]', year INTEGER,
        abstract_note TEXT NOT NULL DEFAULT '', collection_keys_json TEXT NOT NULL DEFAULT '[]', tags_json TEXT NOT NULL DEFAULT '[]',
        item_version INTEGER, state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'classifying', 'ready', 'accepted', 'deferred', 'ignored', 'failed')),
        first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
        clean_title TEXT, institution TEXT, attachment_version INTEGER, doi TEXT
      ) STRICT;
      CREATE UNIQUE INDEX inbox_entries_unique_active_idx ON inbox_entries(owner_key, library_type, library_id, item_key) WHERE deleted_at IS NULL;
      CREATE INDEX inbox_entries_owner_state_idx ON inbox_entries(owner_key, state, deleted_at, updated_at);

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, job_type TEXT NOT NULL,
        resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        error_code TEXT, result_summary_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT
      ) STRICT;
      CREATE INDEX jobs_runner_idx ON jobs(state, available_at, attempts);
      CREATE INDEX jobs_owner_idx ON jobs(owner_key, job_type, state);

      CREATE TABLE document_analyses (
        id TEXT PRIMARY KEY, owner_key TEXT NOT NULL,
        library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group')), library_id TEXT NOT NULL, item_key TEXT NOT NULL,
        attachment_key TEXT NOT NULL, attachment_version INTEGER, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('queued', 'running', 'ready', 'failed', 'stale')),
        document_title TEXT NOT NULL DEFAULT '', page_count INTEGER NOT NULL DEFAULT 1, graph_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX document_analyses_unique_cache_idx ON document_analyses(owner_key, library_type, library_id, attachment_key, COALESCE(attachment_version, 0), model, prompt_version);
      CREATE INDEX document_analyses_lookup_idx ON document_analyses(owner_key, library_type, library_id, item_key, status);

      CREATE TABLE document_metas (
        id TEXT PRIMARY KEY, owner_key TEXT NOT NULL,
        library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group')), library_id TEXT NOT NULL, item_key TEXT NOT NULL,
        attachment_key TEXT, attachment_version INTEGER, clean_title TEXT NOT NULL, institution TEXT,
        report_title TEXT, subtitle TEXT, year TEXT, doi TEXT, summary TEXT, source TEXT NOT NULL DEFAULT 'ai',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX document_metas_unique_idx ON document_metas(owner_key, library_type, library_id, item_key);
      CREATE INDEX document_metas_owner_idx ON document_metas(owner_key, library_type, library_id);

      CREATE TABLE knowledge_units (
        id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, analysis_id TEXT NOT NULL REFERENCES document_analyses(id),
        type TEXT NOT NULL CHECK (type IN ('overview', 'section', 'concept', 'claim')),
        library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group')), library_id TEXT NOT NULL, item_key TEXT NOT NULL,
        attachment_key TEXT, document_title TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
        page_start INTEGER NOT NULL DEFAULT 1, page_end INTEGER NOT NULL DEFAULT 1, evidence_page INTEGER NOT NULL DEFAULT 1,
        evidence_quote TEXT NOT NULL DEFAULT '', position_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX knowledge_units_owner_item_idx ON knowledge_units(owner_key, library_type, library_id, item_key);
      CREATE INDEX knowledge_units_analysis_idx ON knowledge_units(owner_key, analysis_id);

      -- Genuine v11 knowledge_relations without unique constraint on pair
      CREATE TABLE knowledge_relations (
        id TEXT PRIMARY KEY, owner_key TEXT NOT NULL,
        source_unit_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
        target_unit_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL CHECK (relation_type IN ('supports', 'contradicts', 'extends', 'same_method', 'context_differs', 'related')),
        confidence REAL NOT NULL DEFAULT 0.5, reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'confirmed', 'rejected')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK (source_unit_id <> target_unit_id)
      ) STRICT;
      CREATE INDEX knowledge_relations_source_idx ON knowledge_relations(owner_key, source_unit_id, status);
      CREATE INDEX knowledge_relations_target_idx ON knowledge_relations(owner_key, target_unit_id, status);

      -- Insert representative baseline v11 data including MULTIPLE historical soft-deleted records for same item
      INSERT INTO workspaces (id, owner_key, name, created_at, updated_at) VALUES ('ws-v11', '${actor}', 'V11 Workspace', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO boards (id, workspace_id, name, created_at, updated_at) VALUES ('board-v11', 'ws-v11', 'V11 Board', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO source_refs (id, owner_key, library_type, library_id, item_key, attachment_key, attachment_version, created_at, updated_at) VALUES ('sr-v11-1', '${actor}', 'user', '42', 'ITEM_V11', 'ATT_V11', 1, '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO nodes (id, board_id, node_type, x, y, width, height, source_ref_id, created_at, updated_at) VALUES ('n1-v11', 'board-v11', 'manual_note', 0, 0, 100, 100, 'sr-v11-1', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO nodes (id, board_id, node_type, x, y, width, height, source_ref_id, created_at, updated_at) VALUES ('n2-v11', 'board-v11', 'manual_note', 200, 0, 100, 100, NULL, '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO edges (id, board_id, source_node_id, target_node_id, relation, origin, created_at, updated_at) VALUES ('e1-v11', 'board-v11', 'n1-v11', 'n2-v11', 'supports', 'manual', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');

      -- Soft-deleted historical entries (same workspace_id, library_type, library_id, item_key)
      INSERT INTO topic_documents (id, workspace_id, owner_key, library_type, library_id, item_key, status, origin, created_at, updated_at, deleted_at) VALUES ('td-v11-old-1', 'ws-v11', '${actor}', 'user', '42', 'ITEM_V11', 'removed', 'manual', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z');
      INSERT INTO topic_documents (id, workspace_id, owner_key, library_type, library_id, item_key, status, origin, created_at, updated_at, deleted_at) VALUES ('td-v11-old-2', 'ws-v11', '${actor}', 'user', '42', 'ITEM_V11', 'removed', 'manual', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      -- Active entry
      INSERT INTO topic_documents (id, workspace_id, owner_key, library_type, library_id, item_key, status, origin, created_at, updated_at, deleted_at) VALUES ('td-v11-1', 'ws-v11', '${actor}', 'user', '42', 'ITEM_V11', 'accepted', 'manual', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', NULL);

      INSERT INTO collection_bindings (id, workspace_id, owner_key, library_type, library_id, collection_key, mode, created_at, updated_at, deleted_at) VALUES ('cb-v11-old', 'ws-v11', '${actor}', 'user', '42', 'COL_V11', 'inbound', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO collection_bindings (id, workspace_id, owner_key, library_type, library_id, collection_key, mode, created_at, updated_at, deleted_at) VALUES ('cb-v11-1', 'ws-v11', '${actor}', 'user', '42', 'COL_V11', 'inbound', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', NULL);

      -- Multiple historical soft-deleted inbox entries + 1 active entry
      INSERT INTO inbox_entries (id, owner_key, library_type, library_id, item_key, detected_from, title, clean_title, doi, first_seen_at, updated_at, deleted_at) VALUES ('inbox-v11-old-1', '${actor}', 'user', '42', 'ITEM_V11', 'scan', 'Old Raw Title', 'Old Clean Title', '10.1000/v11doi', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z');
      INSERT INTO inbox_entries (id, owner_key, library_type, library_id, item_key, detected_from, title, clean_title, doi, first_seen_at, updated_at, deleted_at) VALUES ('inbox-v11-old-2', '${actor}', 'user', '42', 'ITEM_V11', 'scan', 'Old Raw Title 2', 'Old Clean Title 2', '10.1000/v11doi', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO inbox_entries (id, owner_key, library_type, library_id, item_key, detected_from, title, clean_title, doi, first_seen_at, updated_at, deleted_at) VALUES ('inbox-v11-1', '${actor}', 'user', '42', 'ITEM_V11', 'scan', 'Raw Paper Title', 'Clean Title V11', '10.1000/v11doi', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', NULL);

      INSERT INTO jobs (id, owner_key, job_type, resource_type, resource_id, payload_json, available_at, created_at, updated_at) VALUES ('job-v11', '${actor}', 'import_document', 'library', '42', '{"libraryType":"user","libraryId":"42"}', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO document_analyses (id, owner_key, library_type, library_id, item_key, attachment_key, attachment_version, model, prompt_version, document_title, graph_json, created_at, updated_at) VALUES ('ana-v11-1', '${actor}', 'user', '42', 'ITEM_V11', 'ATT_V11', 1, 'gpt-4o', 'v1', 'Paper Analysis', '{"overview":{"title":"Overview","body":"Text"}}', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO document_metas (id, owner_key, library_type, library_id, item_key, clean_title, doi, created_at, updated_at) VALUES ('meta-v11-1', '${actor}', 'user', '42', 'ITEM_V11', 'Clean Title V11', '10.1000/v11doi', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO knowledge_units (id, owner_key, analysis_id, type, library_type, library_id, item_key, title, evidence_page, created_at, updated_at) VALUES ('ku-v11-1', '${actor}', 'ana-v11-1', 'overview', 'user', '42', 'ITEM_V11', 'Overview Unit', 3, '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO knowledge_units (id, owner_key, analysis_id, type, library_type, library_id, item_key, title, evidence_page, created_at, updated_at) VALUES ('ku-v11-2', '${actor}', 'ana-v11-1', 'claim', 'user', '42', 'ITEM_V11', 'Claim Unit', 4, '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');

      -- Insert DUPLICATE relations triples in reverse time order (earlier rowid has LATER updated_at, later rowid has OLDER updated_at)
      INSERT INTO knowledge_relations (id, owner_key, source_unit_id, target_unit_id, relation_type, confidence, created_at, updated_at) VALUES ('kr-v11-earlier-rowid', '${actor}', 'ku-v11-1', 'ku-v11-2', 'supports', 0.99, '2026-08-31T00:00:00.000Z', '2026-08-31T12:00:00.000Z');
      INSERT INTO knowledge_relations (id, owner_key, source_unit_id, target_unit_id, relation_type, confidence, created_at, updated_at) VALUES ('kr-v11-later-rowid-stale-time', '${actor}', 'ku-v11-1', 'ku-v11-2', 'supports', 0.40, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
    `);
    rawV11.close();

    const migratedV11Store = new CanvasStore(v11LineageDbPath);
    const maxV11 = migratedV11Store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    assert.equal(maxV11, 13, 'Genuine V11 DB must upgrade to schema v13 without errors on soft-deleted history');

    // 1. Assert foreign key consistency across entire migrated schema
    const fkCheck = migratedV11Store.db.prepare('PRAGMA foreign_key_check').all();
    assert.equal(fkCheck.length, 0, 'No foreign key violations must exist after migration');

    // 2. Assert ALL critical business indexes exist and were not dropped
    const indexRows = migratedV11Store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all().map(r => r.name);
    const expectedIndexes = [
      'topic_documents_unique_active_idx', 'topic_documents_owner_idx', 'topic_documents_lookup_idx',
      'collection_bindings_unique_active_idx', 'collection_bindings_owner_idx',
      'inbox_entries_unique_active_idx', 'inbox_entries_owner_state_idx',
      'jobs_runner_idx', 'jobs_owner_idx',
      'document_analyses_unique_cache_idx', 'document_analyses_lookup_idx',
      'document_metas_unique_idx', 'document_metas_owner_idx',
      'knowledge_units_owner_item_idx', 'knowledge_units_analysis_idx',
      'knowledge_relations_source_idx', 'knowledge_relations_target_idx',
      'knowledge_relations_pair_idx', 'knowledge_relations_owner_idx',
      'source_refs_owner_idx', 'source_refs_target_idx',
      'edges_board_idx', 'edges_projection_idx',
      'users_username_idx', 'documents_owner_idx', 'attachments_doc_idx', 'annotations_attachment_idx', 'external_refs_identity_idx'
    ];
    for (const expectedIdx of expectedIndexes) {
      assert.ok(indexRows.includes(expectedIdx), `Index ${expectedIdx} must be preserved in migrated v12 database`);
    }

    // 3. Assert full data fidelity for all entities including soft-deleted entries
    assert.equal(migratedV11Store.getWorkspace(actor, 'ws-v11').name, 'V11 Workspace');
    assert.equal(migratedV11Store.getEdge(actor, 'e1-v11').origin, 'manual');
    assert.equal(migratedV11Store.getTopicDocument(actor, 'td-v11-1').status, 'accepted');
    assert.equal(migratedV11Store.getCollectionBinding(actor, 'cb-v11-1').collectionKey, 'COL_V11');
    assert.equal(migratedV11Store.getInboxEntry(actor, 'inbox-v11-1').doi, '10.1000/v11doi');
    assert.equal(migratedV11Store.getDocumentMeta(actor, { libraryType: 'user', libraryId: '42', itemKey: 'ITEM_V11' }).cleanTitle, 'Clean Title V11');
    assert.equal(migratedV11Store.getKnowledgeUnit(actor, 'ku-v11-1').evidencePage, 3);
    assert.equal(migratedV11Store.getJob(actor, 'job-v11').payload.libraryType, 'user');

    // Assert duplicate relations were deduplicated deterministically by updated_at (NOT rowid)
    const rels = migratedV11Store.db.prepare('SELECT * FROM knowledge_relations WHERE source_unit_id = ? AND target_unit_id = ?').all('ku-v11-1', 'ku-v11-2');
    assert.equal(rels.length, 1, 'Duplicate knowledge relation triples must be deduplicated to 1 record');
    assert.equal(rels[0].id, 'kr-v11-earlier-rowid', 'Record with latest updated_at must be retained even if rowid is lower');
    assert.equal(rels[0].confidence, 0.99, 'Latest relation record confidence must be preserved');

    // 4. Assert partial unique constraint behavior for topic_documents, collection_bindings, and inbox_entries
    assert.throws(() => {
      migratedV11Store.db.prepare(`
        INSERT INTO topic_documents (id, workspace_id, owner_key, library_type, library_id, item_key, created_at, updated_at, deleted_at)
        VALUES ('td-dup-active', 'ws-v11', '${actor}', 'user', '42', 'ITEM_V11', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', NULL)
      `).run();
    }, /UNIQUE constraint failed/, 'Partial unique index must block duplicate ACTIVE topic document');

    assert.throws(() => {
      migratedV11Store.db.prepare(`
        INSERT INTO inbox_entries (id, owner_key, library_type, library_id, item_key, detected_from, title, first_seen_at, updated_at, deleted_at)
        VALUES ('inbox-dup-active', '${actor}', 'user', '42', 'ITEM_V11', 'scan', 'Dup Active', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', NULL)
      `).run();
    }, /UNIQUE constraint failed/, 'Partial unique index must block duplicate ACTIVE inbox entry');

    // Soft-deleted entries with same key MUST be allowed
    assert.doesNotThrow(() => {
      migratedV11Store.db.prepare(`
        INSERT INTO topic_documents (id, workspace_id, owner_key, library_type, library_id, item_key, created_at, updated_at, deleted_at)
        VALUES ('td-another-deleted', 'ws-v11', '${actor}', 'user', '42', 'ITEM_V11', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')
      `).run();
      migratedV11Store.db.prepare(`
        INSERT INTO inbox_entries (id, owner_key, library_type, library_id, item_key, detected_from, title, first_seen_at, updated_at, deleted_at)
        VALUES ('inbox-another-deleted', '${actor}', 'user', '42', 'ITEM_V11', 'scan', 'Another Deleted', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')
      `).run();
    }, 'Partial unique index must allow inserting soft-deleted records with same itemKey');

    // 5. Assert native tables and native library types work on the upgraded database
    const nativeDoc = migratedV11Store.createDocument(actor, { title: 'Native Doc in Migrated V11' });
    assert.equal(nativeDoc.title, 'Native Doc in Migrated V11');
    const nativeTopicDoc = migratedV11Store.addTopicDocument(actor, 'ws-v11', {
      libraryType: 'native',
      libraryId: 'local',
      itemKey: nativeDoc.id,
      status: 'accepted',
      origin: 'native_upload'
    });
    assert.equal(nativeTopicDoc.origin, 'native_upload');

    // 6. Assert reopening is completely idempotent
    migratedV11Store.close();
    const reopenedV11Store = new CanvasStore(v11LineageDbPath);
    const reopenedMaxV = reopenedV11Store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    assert.equal(reopenedMaxV, 13, 'Reopening must maintain version 13');
    reopenedV11Store.close();
  } finally {
    fs.rmSync(v11LineageDir, { recursive: true, force: true });
  }

  // --- Lineage Test 2b: Future Schema v14 DB must be rejected BEFORE any modifications ---
  const v13Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-v13-future-test-'));
  const v13DbPath = path.join(v13Dir, 'canvas-v13.sqlite');
  try {
    const rawV13 = new DatabaseSync(v13DbPath);
    rawV13.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-08-30T00:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (14, '2026-09-02T00:00:00.000Z');
      CREATE TABLE custom_future_table (id TEXT PRIMARY KEY) STRICT;
    `);
    rawV13.close();

    // CanvasStore must reject without executing DDL
    assert.throws(() => {
      new CanvasStore(v13DbPath);
    }, /Canvas database schema 14 is newer than this server supports/);

    // Verify DB was NOT modified
    const inspectV13 = new DatabaseSync(v13DbPath);
    const tablesAfter = inspectV13.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(!tablesAfter.includes('users'), 'Future schema DB must not have native users table added');
    assert.ok(!tablesAfter.includes('documents'), 'Future schema DB must not have native documents table added');
    inspectV13.close();
  } finally {
    fs.rmSync(v13Dir, { recursive: true, force: true });
  }

  // --- Lineage Test 3: Native v10 DB -> v12 ---
  const nativeV10Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-native-v10-lineage-test-'));
  const nativeV10DbPath = path.join(nativeV10Dir, 'canvas-native-v10.sqlite');
  try {
    const rawNativeV10 = new DatabaseSync(nativeV10DbPath);
    rawNativeV10.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-08-30T00:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at) VALUES (10, '2026-08-31T00:00:00.000Z');

      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE blobs (sha256 TEXT PRIMARY KEY, relative_path TEXT NOT NULL, size_bytes INTEGER NOT NULL, mime_type TEXT NOT NULL, created_at TEXT NOT NULL, reference_count INTEGER NOT NULL DEFAULT 1) STRICT;
      CREATE TABLE documents (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT 'journalArticle', title TEXT NOT NULL, abstract TEXT NOT NULL DEFAULT '', publication_title TEXT NOT NULL DEFAULT '', publisher TEXT NOT NULL DEFAULT '', date TEXT NOT NULL DEFAULT '', year INTEGER, doi TEXT, isbn TEXT, url TEXT, language TEXT NOT NULL DEFAULT '', rights TEXT NOT NULL DEFAULT '', extra_json TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT) STRICT;
      CREATE TABLE attachments (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), blob_hash TEXT NOT NULL REFERENCES blobs(sha256), mime_type TEXT NOT NULL DEFAULT 'application/pdf', original_filename TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', source_url TEXT, size_bytes INTEGER NOT NULL DEFAULT 0, page_count INTEGER, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT) STRICT;
      CREATE TABLE annotations (id TEXT PRIMARY KEY, attachment_id TEXT NOT NULL REFERENCES attachments(id), annotation_type TEXT NOT NULL DEFAULT 'highlight', page_label TEXT NOT NULL DEFAULT '', position_json TEXT NOT NULL DEFAULT '{}', quote TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#ffd400', sort_index INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT) STRICT;
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, description TEXT NOT NULL DEFAULT '', research_question TEXT NOT NULL DEFAULT '', inclusion_rules TEXT NOT NULL DEFAULT '', exclusion_rules TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT) STRICT;
      CREATE TABLE boards (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, viewport_x REAL NOT NULL DEFAULT 0, viewport_y REAL NOT NULL DEFAULT 0, viewport_zoom REAL NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT) STRICT;
      CREATE TABLE nodes (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id), node_type TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, z_index INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', color TEXT, source_ref_id TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT) STRICT;
      CREATE TABLE edges (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id), source_node_id TEXT NOT NULL REFERENCES nodes(id), target_node_id TEXT NOT NULL REFERENCES nodes(id), relation TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT) STRICT;
      CREATE TABLE jobs (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, job_type TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', progress INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, result_json TEXT, error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT) STRICT;
      CREATE TABLE inbox_entries (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, library_type TEXT NOT NULL, library_id TEXT NOT NULL, item_key TEXT NOT NULL, attachment_key TEXT, detected_from TEXT NOT NULL DEFAULT 'scan', title TEXT NOT NULL, year TEXT, creators_json TEXT NOT NULL DEFAULT '[]', abstract_note TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'unread', created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;

      INSERT INTO users (id, username, password_hash, password_salt, role, created_at, updated_at) VALUES ('u-native-v10', 'native_admin', 'hash', 'salt', 'admin', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO blobs (sha256, relative_path, size_bytes, mime_type, created_at, reference_count) VALUES ('blobhash123', 'sha256/bl/ob/blobhash123.pdf', 1024, 'application/pdf', '2026-08-31T00:00:00.000Z', 1);
      INSERT INTO documents (id, owner_key, title, created_at, updated_at) VALUES ('doc-native-v10', '${actor}', 'Native V10 Document', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO attachments (id, document_id, blob_hash, original_filename, created_at, updated_at) VALUES ('att-native-v10', 'doc-native-v10', 'blobhash123', 'paper.pdf', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO annotations (id, attachment_id, quote, created_at, updated_at) VALUES ('ann-native-v10', 'att-native-v10', 'Native Annotation Quote', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO workspaces (id, owner_key, name, created_at, updated_at) VALUES ('ws-native-v10', '${actor}', 'Native V10 Workspace', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO boards (id, workspace_id, name, created_at, updated_at) VALUES ('board-native-v10', 'ws-native-v10', 'Native Board', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO nodes (id, board_id, node_type, x, y, width, height, created_at, updated_at) VALUES ('n1-native', 'board-native-v10', 'manual_note', 0, 0, 100, 100, '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO nodes (id, board_id, node_type, x, y, width, height, created_at, updated_at) VALUES ('n2-native', 'board-native-v10', 'manual_note', 200, 0, 100, 100, '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      INSERT INTO edges (id, board_id, source_node_id, target_node_id, relation, label, created_at, updated_at) VALUES ('e1-native', 'board-native-v10', 'n1-native', 'n2-native', 'supports', 'Native Edge', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
    `);
    rawNativeV10.close();

    const migratedNativeStore = new CanvasStore(nativeV10DbPath);
    const maxNativeV10 = migratedNativeStore.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    assert.equal(maxNativeV10, 13, 'Native V10 DB must upgrade to schema v13');

    // Verify native data preserved
    assert.equal(migratedNativeStore.getDocument(actor, 'doc-native-v10').title, 'Native V10 Document');
    assert.equal(migratedNativeStore.getAttachment(actor, 'att-native-v10').blobHash, 'blobhash123');
    assert.equal(migratedNativeStore.getAnnotation(actor, 'ann-native-v10').quote, 'Native Annotation Quote');

    // Verify edges migrated to v11/v12 model with default origin manual
    const edge = migratedNativeStore.getEdge(actor, 'e1-native');
    assert.equal(edge.origin, 'manual');

    // Verify missing columns added
    const jobCols = migratedNativeStore.db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
    assert.ok(jobCols.includes('payload_json'), 'jobs table must include payload_json');

    const inboxCols = migratedNativeStore.db.prepare('PRAGMA table_info(inbox_entries)').all().map(c => c.name);
    assert.ok(inboxCols.includes('doi'), 'inbox_entries table must include doi');
    assert.ok(inboxCols.includes('attachment_version'), 'inbox_entries table must include attachment_version');

    migratedNativeStore.close();
  } finally {
    fs.rmSync(nativeV10Dir, { recursive: true, force: true });
  }

  // --- Lineage Test 4: Repeated startup on v12 DB (Idempotency) ---
  const v12IdemDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-v12-idem-test-'));
  const v12IdemDbPath = path.join(v12IdemDir, 'canvas-v12.sqlite');
  try {
    const store1 = new CanvasStore(v12IdemDbPath);
    const v1 = store1.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    const migCount1 = store1.db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;
    assert.equal(v1, 13);
    store1.createUser({ username: 'idem_user', password: 'Password123!' });
    store1.createWorkspace(actor, { name: 'Idempotency Workspace' });
    store1.close();

    // Reopen store on same file
    const store2 = new CanvasStore(v12IdemDbPath);
    const v2 = store2.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    const migCount2 = store2.db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;
    assert.equal(v2, 13, 'Version must remain 13 after restart');
    assert.equal(migCount2, migCount1, 'Migrations count must remain identical');
    assert.ok(store2.hasUsers());
    assert.equal(store2.listWorkspaces(actor).length, 1);
    store2.close();
  } finally {
    fs.rmSync(v12IdemDir, { recursive: true, force: true });
  }

  // --- Schema v12: Topics, Topic Documents, Collection Bindings, Inbox, Jobs, Document Analyses, Document Metas, Knowledge Units & Relations, Edge Origins, Native Core ---
  const currentMigration = store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  assert.equal(currentMigration, 13, 'Schema migration version 13 must be applied');

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

  // [M4] Retired inbox & collection endpoints answer 410 Gone
  const retiredChecks = [
    ['/canvas/workspaces/' + apiTopic.id + '/collection-bindings', 'POST', { libraryType: 'user', libraryId: '42', collectionKey: 'C', mode: 'inbound' }],
    ['/canvas/collection-bindings/00000000-0000-4000-8000-000000000001', 'PATCH', { mode: 'confirm_both' }],
    ['/canvas/collection-bindings/00000000-0000-4000-8000-000000000001/sync', 'POST', {}],
    ['/canvas/inbox', 'GET', undefined],
    ['/canvas/inbox/scan', 'POST', { libraryType: 'native', libraryId: 'local' }],
    ['/canvas/inbox/entries', 'POST', { entries: [] }],
    ['/canvas/inbox/batch-action', 'POST', { entryIds: ['x'], action: 'accept' }],
    ['/canvas/inbox/classify', 'POST', {}],
    ['/canvas/inbox/generate-topics', 'POST', {}]
  ];
  for (const [pathname, method, body] of retiredChecks) {
    const res = await call(handler, pathname, { method, cookie, body });
    assert.equal(res.statusCode, 410, pathname + ' must answer 410 Gone');
    assert.equal(res.payload.error.code, 'feature_retired');
  }

  // [M4] Native library AI classification (re-homed from the retired inbox)
  const classifyDoc = store.createDocument(canvasActorKey('https://issuer.example', 'api-subject'), {
    title: 'Vision-Language Models Survey', year: 2025, abstract: 'A survey of vision-language models.'
  });
  const nativeClassifyHandler = createCanvasHandler(store, {
    aiPublicConfig: () => ({ configured: true, provider: 'mock.example', model: 'mock-model' }),
    aiCompletion: async () => JSON.stringify({
      classifications: {
        [classifyDoc.id]: [
          { workspaceId: 'ws-hallucinated-999', workspaceName: 'Non-existent Topic', confidence: 0.99, reason: 'Hallucination' },
          { workspaceId: apiTopic.id, workspaceName: 'API Research Topic', confidence: 0.88, reason: 'Valid Topic' }
        ]
      },
      documentMetadata: {
        [classifyDoc.id]: {
          cleanTitle: '【测试研究院】视觉语言模型综述（2025）',
          institution: '测试研究院',
          reportTitle: '视觉语言模型综述',
          year: '2025',
          summary: '分类与中文标题在同一次模型调用中完成。'
        }
      }
    })
  });
  const classifyRes = await call(nativeClassifyHandler, '/canvas/native/documents/classify', {
    method: 'POST', cookie, body: { documentIds: [classifyDoc.id] }
  });
  assert.equal(classifyRes.statusCode, 200);
  const filteredRecs = classifyRes.payload.data.classifications[classifyDoc.id];
  assert.equal(filteredRecs.length, 1, 'Hallucinated workspace IDs must be filtered out');
  assert.equal(filteredRecs[0].workspaceId, apiTopic.id);
  assert.equal(filteredRecs[0].workspaceName, 'API Research Topic');
  assert.equal(filteredRecs[0].confidence, 0.88);
  assert.equal(classifyRes.payload.data.documentMetas.length, 1);
  assert.equal(classifyRes.payload.data.documentMetas[0].cleanTitle, '【测试研究院】视觉语言模型综述（2025）');
  assert.equal(store.getDocumentMeta(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'native', libraryId: 'local', itemKey: classifyDoc.id
  }).cleanTitle, '【测试研究院】视觉语言模型综述（2025）',
    'AI classification must persist the Chinese display name in the same request');

  // [M4 UX] AI placeholder garbage (【未注明机构】…（未知年份）) must never reach
  // the display name: decorations are stripped, placeholder fields come back
  // empty, and a fully-stripped title falls back to the document title.
  const placeholderDoc = store.createDocument(canvasActorKey('https://issuer.example', 'api-subject'), {
    title: 'Deep Learning Basics'
  });
  const placeholderHandler = createCanvasHandler(store, {
    aiPublicConfig: () => ({ configured: true, provider: 'mock.example', model: 'mock-model' }),
    aiCompletion: async () => JSON.stringify({
      classifications: {},
      documentMetadata: {
        [placeholderDoc.id]: {
          cleanTitle: '【未注明机构】深度学习基础（未知年份）',
          institution: '未注明机构',
          year: '未知'
        }
      }
    })
  });
  const placeholderRes = await call(placeholderHandler, '/canvas/native/documents/classify', {
    method: 'POST', cookie, body: { documentIds: [placeholderDoc.id] }
  });
  assert.equal(placeholderRes.statusCode, 200);
  const placeholderMeta = placeholderRes.payload.data.documentMetas[0];
  assert.equal(placeholderMeta.cleanTitle, '深度学习基础',
    'placeholder decorations must be stripped from the display name');
  assert.equal(placeholderMeta.institution, '', 'placeholder institution must be stored empty');
  assert.equal(placeholderMeta.year, '', 'placeholder year must be stored empty');

  // [M4 UX] Classification must record WHICH attachment (id + version) the
  // recognition ran against — the incremental ✨ run skips only documents
  // whose meta marks the CURRENT attachment as recognized. Legacy rows with
  // null attachment_version are re-recognized (with real content) once.
  store.db.prepare(`
    INSERT INTO attachments
      (id, document_id, blob_hash, mime_type, original_filename, title, size_bytes, storage_kind, version, created_at, updated_at)
    VALUES (?, ?, NULL, 'application/pdf', 'vision-survey.pdf', 'Vision Survey', 10, 'managed_blob', 4, ?, ?)
  `).run('att-versioned-1', classifyDoc.id, new Date().toISOString(), new Date().toISOString());
  const versionedHandler = createCanvasHandler(store, {
    aiPublicConfig: () => ({ configured: true, provider: 'mock.example', model: 'mock-model' }),
    aiCompletion: async () => JSON.stringify({
      classifications: {},
      documentMetadata: { [classifyDoc.id]: { cleanTitle: '视觉语言模型综述', institution: '测试研究院', year: '2025' } }
    })
  });
  const versionedRes = await call(versionedHandler, '/canvas/native/documents/classify', {
    method: 'POST', cookie, body: { documentIds: [classifyDoc.id] }
  });
  assert.equal(versionedRes.statusCode, 200);
  const versionedMeta = store.getDocumentMeta(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'native', libraryId: 'local', itemKey: classifyDoc.id
  });
  assert.equal(versionedMeta.attachmentKey, 'att-versioned-1',
    'classification must bind the meta to the recognized attachment id');
  assert.equal(versionedMeta.attachmentVersion, 4,
    'classification must record the recognized attachment version (null means "never content-recognized")');

  // [M4 UX] Classification accepts client-extracted PDF text (documentTexts)
  // and feeds it into the AI prompt: classification and title recognition run
  // on REAL page content, matching the per-document 识别标题 depth.
  let classifyPromptText = '';
  const textClassifyHandler = createCanvasHandler(store, {
    aiPublicConfig: () => ({ configured: true, provider: 'mock.example', model: 'mock-model' }),
    aiCompletion: async ({ messages }) => {
      classifyPromptText = messages.map(m => m.content).join('\n');
      return JSON.stringify({ classifications: {}, documentMetadata: {} });
    }
  });
  const textRes = await call(textClassifyHandler, '/canvas/native/documents/classify', {
    method: 'POST', cookie,
    body: {
      documentIds: [classifyDoc.id],
      documentTexts: {
        [classifyDoc.id]: '--- Page 1 ---\nBERT: Pre-training of Deep Bidirectional Transformers for Language Understanding. Google AI Language.'
      }
    }
  });
  assert.equal(textRes.statusCode, 200);
  assert.ok(classifyPromptText.includes('正文节选'), 'the AI prompt must carry the PDF text excerpt section');
  assert.ok(classifyPromptText.includes('Bidirectional Transformers'),
    'the AI prompt must include the real first-page text');
  assert.ok(!classifyPromptText.includes('【未注明机构】'), 'placeholder text must not be fabricated');
  // text values are hard-capped before they reach the prompt
  await assert.rejects(
    call(textClassifyHandler, '/canvas/native/documents/classify', {
      method: 'POST', cookie,
      body: { documentIds: [classifyDoc.id], documentTexts: { [classifyDoc.id]: 42 } }
    }),
    /documentTexts values must be strings/
  );

  // Native classify rejects oversized document id lists before any AI call
  const oversizedIds = Array.from({ length: 201 }, () => '00000000-0000-4000-8000-000000000000');
  const oversizedRes = await call(nativeClassifyHandler, '/canvas/native/documents/classify', {
    method: 'POST', cookie, body: { documentIds: oversizedIds }
  });
  assert.equal(oversizedRes.statusCode, 400);

  // [M4] Native library AI topic generation (re-homed from the retired inbox)
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
        [classifyDoc.id]: [
          { topicName: '具身智能与大模型控制', confidence: 0.96, reason: '核心契合具身控制方向' }
        ]
      },
      documentMetadata: {
        [classifyDoc.id]: { cleanTitle: '【测试研究院】具身智能控制综述（2025）', institution: '测试研究院' }
      }
    })
  });
  const generateTopicsRes = await call(autoTopicHandler, '/canvas/native/classify/generate-topics', {
    method: 'POST', cookie, body: { documentIds: [classifyDoc.id], maxTopics: 5 }
  });
  assert.equal(generateTopicsRes.statusCode, 200);
  assert.ok(generateTopicsRes.payload.data.createdWorkspaces);
  assert.equal(generateTopicsRes.payload.data.createdWorkspaces.length, 2);
  assert.equal(generateTopicsRes.payload.data.createdWorkspaces[0].name, '具身智能与大模型控制');
  assert.ok(generateTopicsRes.payload.data.classifications[classifyDoc.id]);
  assert.equal(generateTopicsRes.payload.data.classifications[classifyDoc.id][0].workspaceName, '具身智能与大模型控制');
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
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v2', status: 'ready',
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
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v2', status: 'ready',
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
  assert.equal(expandRes.payload.data.createdEdges[0].origin, 't3_expand', 'T3 expand edge must have origin t3_expand');
  assert.equal(expandRes.payload.data.createdEdges[0].projectionKey, `t3:${focalCard.id}`, 'T3 expand edge must have projectionKey');

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
      model: 'mock-model', promptVersion: 'altcanvas-document-map-v2', status: 'ready',
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
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v2', status: 'ready',
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
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v2', status: 'ready', documentTitle: 'Other WS Doc',
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
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v2', status: 'ready', documentTitle: 'Old Version Doc',
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
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v2', status: 'ready', documentTitle: 'New Version Doc',
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
  // [M4] Pin the focal unit to the session-accessible user:42 DOC_A; the
  // group:7 twin is store-seeded only and is no longer reachable over HTTP.
  const docAUnits = store.listTopicKnowledgeUnits(canvasActorKey('https://issuer.example', 'api-subject'), apiTopic.id);
  const docAUnit1 = docAUnits.find(u => u.itemKey === 'DOC_A' && u.libraryType === 'user' && String(u.libraryId) === '42');
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
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v2', status: 'ready',
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
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v2', status: 'ready',
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
    model: 'mock-model', promptVersion: 'altcanvas-document-map-v2', status: 'ready',
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

  // [M4] The Altero upstream scan/sync hardening suites (multi-page traversal,
  // premature empty stream, unexpected 304, duplicate-loop, children 500/JSON)
  // were retired together with /canvas/inbox/scan and collection sync in M4.
  // The full historical coverage lives on the archive/last-altero-compatible tag;
  // fetchAllUpstreamItems itself no longer exists, so no direct unit tests remain.

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

  // [M4] Cross-library isolation with same itemKey: group libraries are no
  // longer reachable over HTTP, so the group metadata is seeded at store level.
  const groupMetaHttpRes = await call(handler, '/canvas/documents/extract-metadata', {
    method: 'POST', cookie,
    body: {
      libraryType: 'group', libraryId: '7', itemKey: 'META_ITEM_1',
      filename: 'group_report.pdf', rawTitle: '群组报告'
    }
  });
  assert.equal(groupMetaHttpRes.statusCode, 403,
    'M4 removed group membership, so group-library metadata extraction must be rejected');
  store.saveDocumentMeta(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'group', libraryId: '7', itemKey: 'META_ITEM_1',
    cleanTitle: '群组报告'
  });
  const userMeta = store.getDocumentMeta(canvasActorKey('https://issuer.example', 'api-subject'), { libraryType: 'user', libraryId: '42', itemKey: 'META_ITEM_1' });
  const groupMeta = store.getDocumentMeta(canvasActorKey('https://issuer.example', 'api-subject'), { libraryType: 'group', libraryId: '7', itemKey: 'META_ITEM_1' });
  assert.ok(userMeta && groupMeta);
  assert.notEqual(userMeta.id, groupMeta.id, 'Group and User libraries must have isolated document metadata');

  // --- T4 Import & SSRF Protection Tests ---
  const {
    validateExternalUrl,
    resolveDoi,
    resolveArxiv,
    resolveHtmlUrl,
    resolveImportInput,
    detectInputFormat,
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

  // Duplicate detection test — [M4] dedupe now targets native library documents
  store.createDocument(canvasActorKey('https://issuer.example', 'api-subject'), {
    title: 'Kimi k1.5: Scaling Reinforcement Learning with LLMs', year: 2025
  });
  const dupCandidates = findDuplicateCandidates(store, canvasActorKey('https://issuer.example', 'api-subject'), {
    title: 'Kimi k1.5',
    doi: null
  });
  assert.ok(dupCandidates.length > 0, 'findDuplicateCandidates must match an existing library document with similar title');
  assert.equal(dupCandidates[0].targetType, 'document');

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
  // [M4 final] The legacy inbox-era /canvas/imports endpoint and its job
  // runner are retired (they wrote the retired inbox_entries table).
  const importExecRes = await call(handler, '/canvas/imports', {
    method: 'POST', cookie,
    body: { resolved: resolvedDoi, targetWorkspaceId: apiTopic.id }
  });
  assert.equal(importExecRes.statusCode, 410);
  assert.equal(importExecRes.payload.error.code, 'feature_retired');

  const failedJobWithPayload = store.enqueueJob(canvasActorKey('https://issuer.example', 'api-subject'), {
    jobType: 'import_document',
    resourceType: 'inbox_entry',
    resourceId: 'pending',
    payload: { resolved: resolvedDoi, targetWorkspaceId: apiTopic.id }
  });
  store.updateJobState(failedJobWithPayload.id, { state: 'queued' });
  // Startup recovery fails retired inbox-era jobs instead of executing them.
  const retryJobRes = await call(handler, `/canvas/imports/${failedJobWithPayload.id}/retry`, { method: 'POST', cookie });
  assert.equal(retryJobRes.statusCode, 410);
  assert.equal(retryJobRes.payload.error.code, 'feature_retired');
  const queuedRetiredJob = store.getJob(canvasActorKey('https://issuer.example', 'api-subject'), failedJobWithPayload.id);
  assert.equal(queuedRetiredJob.state, 'queued', 'retry endpoint must not resurrect retired jobs');

  // Verify DOI duplicate candidate search — [M4 final] against a native
  // document carrying the DOI (the inbox is retired).
  store.createDocument(canvasActorKey('https://issuer.example', 'api-subject'), {
    title: 'Retried Paper Title', doi: '10.1000/retry-test', year: 2024
  });
  const doiDupCandidates = findDuplicateCandidates(store, canvasActorKey('https://issuer.example', 'api-subject'), {
    title: 'Different Title',
    doi: '10.1000/retry-test'
  });
  assert.ok(doiDupCandidates.length > 0, 'findDuplicateCandidates must match by persisted DOI column');
  assert.equal(doiDupCandidates[0].doi, '10.1000/retry-test');
  assert.equal(doiDupCandidates[0].targetType, 'document');

  // Verify DOI in document_metas
  const metaWithDoi = store.saveDocumentMeta(canvasActorKey('https://issuer.example', 'api-subject'), {
    libraryType: 'user', libraryId: '42', itemKey: 'META_DOI_TEST',
    doi: '10.2000/meta-doi-test', cleanTitle: 'Meta DOI Report'
  });
  assert.equal(metaWithDoi.doi, '10.2000/meta-doi-test');
  const metaDupCandidates = findDuplicateCandidates(store, canvasActorKey('https://issuer.example', 'api-subject'), {
    title: 'Random Title',
    doi: '10.2000/meta-doi-test'
  });
  assert.ok(metaDupCandidates.some(c => c.targetType === 'document_meta' && c.doi === '10.2000/meta-doi-test'));

  // --- Test recoverQueuedAndRunningJobs without active session ---
  const orphanJob = store.enqueueJob(canvasActorKey('https://issuer.example', 'api-subject'), {
    jobType: 'import_document',
    resourceType: 'inbox_entry',
    resourceId: 'pending',
    payload: {
      resolved: {
        sourceType: 'doi',
        title: 'Crash Recovery Paper',
        creators: [{ name: 'Crash Author' }],
        year: 2026,
        doi: '10.9999/crash-recovery-test'
      },
      targetWorkspaceId: apiTopic.id,
      libraryType: 'user',
      libraryId: '42'
    }
  });
  store.updateJobState(orphanJob.id, { state: 'running' }); // left in running by process crash

  // Trigger cold startup recovery — [M4 final] retired inbox-era jobs are
  // FAILED at startup, never executed (they would write the retired table).
  recoverQueuedAndRunningJobs(store);
  await new Promise(resolve => setTimeout(resolve, 60));

  const recoveredJob = store.getJob(canvasActorKey('https://issuer.example', 'api-subject'), orphanJob.id);
  assert.equal(recoveredJob.state, 'failed', 'Retired inbox-era jobs must fail at startup, never execute');
  assert.equal(recoveredJob.errorCode, 'feature_retired');
  assert.equal(store.getInboxEntry(canvasActorKey('https://issuer.example', 'api-subject'), 'IMP_ANY'), null,
    'no inbox entry may be created by the retired job path');

  // --- Edge & Knowledge Relations extended types: extends, same_method, context_differs ---
  const activeKUs = store.listTopicKnowledgeUnits(canvasActorKey('https://issuer.example', 'api-subject'), apiTopic.id);
  assert.ok(activeKUs.length >= 3, 'Must have active knowledge units');
  const savedExtendsRel = store.saveKnowledgeRelation(canvasActorKey('https://issuer.example', 'api-subject'), {
    sourceUnitId: activeKUs[0].id, targetUnitId: activeKUs[1].id, relationType: 'extends', confidence: 0.88, reason: '扩展了核心方法'
  });
  assert.equal(savedExtendsRel.relationType, 'extends');

  const savedSameMethodRel = store.saveKnowledgeRelation(canvasActorKey('https://issuer.example', 'api-subject'), {
    sourceUnitId: activeKUs[1].id, targetUnitId: activeKUs[2].id, relationType: 'same_method', confidence: 0.92, reason: '使用相同基线'
  });
  assert.equal(savedSameMethodRel.relationType, 'same_method');

  const savedContextDiffRel = store.saveKnowledgeRelation(canvasActorKey('https://issuer.example', 'api-subject'), {
    sourceUnitId: activeKUs[0].id, targetUnitId: activeKUs[2].id, relationType: 'context_differs', confidence: 0.75, reason: '语境不同'
  });
  assert.equal(savedContextDiffRel.relationType, 'context_differs');

  // =========================================================================
  // --- M2 Unified Native Import Pipeline & Dedup Priority Chain Tests ---
  // =========================================================================
  const m2Actor = canvasActorKey('https://issuer.example', 'api-subject');

  // 1. Initial import via DOI (new native document created + external_refs written)
  const initialDoiImport = store.importNativeDocument(m2Actor, {
    sourceType: 'doi',
    title: 'Self-Attention in Deep Transformers',
    abstract: 'Attention is all you need for sequence models.',
    creators: [{ firstName: 'Ashish', lastName: 'Vaswani' }],
    year: 2017,
    doi: '10.5555/transformer-initial',
    url: 'https://doi.org/10.5555/transformer-initial',
    targetWorkspaceId: apiTopic.id
  });
  assert.equal(initialDoiImport.outcome, 'created');
  assert.ok(initialDoiImport.document.id);
  assert.equal(initialDoiImport.document.doi, '10.5555/transformer-initial');
  assert.equal(initialDoiImport.document.creators.length, 1);
  assert.equal(initialDoiImport.inboxEntry, null, '[M4] inbox retired — imports must not create inbox entries');
  assert.ok(initialDoiImport.topicDocument);

  // External ref verification
  const externalRefs = store.listExternalRefs(m2Actor, initialDoiImport.document.id);
  assert.ok(externalRefs.some(r => r.provider === 'doi' && r.externalItemId === '10.5555/transformer-initial'));

  // 2. Exact match priority level 1: normalized DOI auto-reuses and backfills metadata
  const doiReusedImport = store.importNativeDocument(m2Actor, {
    sourceType: 'doi',
    title: 'Attention Mechanism in Transformers (Alternate Title)',
    abstract: 'Updated abstract note for backfill.',
    year: 2017,
    doi: '10.5555/TRANSFORMER-INITIAL', // Case insensitive normalized
    isbn: '978-0-123456-78-9'
  });
  assert.equal(doiReusedImport.outcome, 'reused');
  assert.equal(doiReusedImport.match.strategy, 'doi');
  assert.equal(doiReusedImport.document.id, initialDoiImport.document.id, 'Same document must be reused via DOI match');
  assert.equal(doiReusedImport.document.isbn, '978-0-123456-78-9', 'Missing ISBN must be backfilled');
  assert.equal(doiReusedImport.document.title, 'Self-Attention in Deep Transformers', 'Original title must be preserved');

  // 3. Exact match priority level 2: external_refs match (with external_library_id isolation)
  const customProviderUserImport = store.importNativeDocument(m2Actor, {
    sourceType: 'zotero',
    title: 'User-library paper',
    externalRefs: [{ provider: 'zotero', externalItemId: 'ZOTERO_ITEM_100', externalLibraryId: 'user_42' }]
  });
  assert.equal(customProviderUserImport.outcome, 'created');

  // Same provider and item key but DIFFERENT external_library_id (group_99) must NOT merge with user_42 paper
  const customProviderGroupImport = store.importNativeDocument(m2Actor, {
    sourceType: 'zotero',
    title: 'Group-library paper',
    externalRefs: [{ provider: 'zotero', externalItemId: 'ZOTERO_ITEM_100', externalLibraryId: 'group_99' }]
  });
  assert.equal(customProviderGroupImport.outcome, 'created', 'Different external_library_id must create distinct document');
  assert.notEqual(customProviderGroupImport.document.id, customProviderUserImport.document.id, 'Cross-library same key must remain separated');

  // Matching same provider, same libraryId and same itemId correctly reuses
  const zoteroReusedImport = store.importNativeDocument(m2Actor, {
    sourceType: 'zotero',
    title: 'User-library paper (Updated Title)',
    externalRefs: [{ provider: 'zotero', externalItemId: 'ZOTERO_ITEM_100', externalLibraryId: 'user_42' }]
  });
  assert.equal(zoteroReusedImport.outcome, 'reused');
  assert.equal(zoteroReusedImport.match.strategy, 'external_ref');
  assert.equal(zoteroReusedImport.document.id, customProviderUserImport.document.id);

  // 3b. Conflicting exact identities: DOI points to Doc A, externalRef points to Doc B -> return conflicting_identities
  const conflictIdentitiesResult = store.importNativeDocument(m2Actor, {
    sourceType: 'mixed',
    title: 'Conflicting Paper',
    doi: '10.5555/transformer-initial', // points to initialDoiImport
    externalRefs: [{ provider: 'zotero', externalItemId: 'ZOTERO_ITEM_100', externalLibraryId: 'user_42' }] // points to customProviderUserImport
  });
  assert.equal(conflictIdentitiesResult.outcome, 'conflicting_identities');
  assert.equal(conflictIdentitiesResult.conflicts.length, 2);

  // 4. Exact match priority level 3: arXiv ID match
  const arxivInitial = store.importNativeDocument(m2Actor, {
    sourceType: 'arxiv',
    title: 'Large Language Models as Tool Users',
    arxivId: '2305.12345'
  });
  assert.equal(arxivInitial.outcome, 'created');

  const arxivReused = store.importNativeDocument(m2Actor, {
    sourceType: 'arxiv',
    title: 'LLMs Tool Use (Alternate Title)',
    arxivId: '2305.12345'
  });
  assert.equal(arxivReused.outcome, 'reused');
  assert.equal(arxivReused.match.strategy, 'arxiv');
  assert.equal(arxivReused.document.id, arxivInitial.document.id);

  // 5. Fuzzy tier: fuzzy duplicate candidate requires explicit confirmation and NEVER merges silently
  const fuzzyCandidateCheck = store.importNativeDocument(m2Actor, {
    sourceType: 'manual',
    title: 'Large Language Models as Tool Users (Slight Variant)',
    year: null,
    confirmFuzzy: false
  });
  assert.equal(fuzzyCandidateCheck.outcome, 'requires_confirmation');
  assert.ok(fuzzyCandidateCheck.candidates.length > 0);
  assert.equal(fuzzyCandidateCheck.candidates[0].documentId, arxivInitial.document.id);

  // 6. Confirmed fuzzy import creates a distinct document when confirmFuzzy=true
  const fuzzyConfirmed = store.importNativeDocument(m2Actor, {
    sourceType: 'manual',
    title: 'Large Language Models as Tool Users (Slight Variant)',
    confirmFuzzy: true
  });
  assert.equal(fuzzyConfirmed.outcome, 'created');
  assert.notEqual(fuzzyConfirmed.document.id, arxivInitial.document.id, 'Confirmed fuzzy duplicate must create a distinct native document');

  // 7. HTTP API: POST /canvas/imports/native (Single entry import)
  const nativeHttpImportRes = await call(handler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      sourceType: 'doi',
      title: 'HTTP Native Imported Paper',
      doi: '10.7777/http-native-import',
      targetWorkspaceId: apiTopic.id
    }
  });
  assert.equal(nativeHttpImportRes.statusCode, 201);
  assert.equal(nativeHttpImportRes.payload.data.outcome, 'created');
  assert.equal(nativeHttpImportRes.payload.data.document.doi, '10.7777/http-native-import');
  assert.equal(nativeHttpImportRes.payload.data.inboxEntry ?? null, null, '[M4] inbox retired');

  // [M4 final] Web imports archive obtained PDFs into a configured library
  // root (default 网页导入). Configure one for the M2 actor.
  const [m2LibraryRoot] = store.ensureLibraryRootsFromConfig(m2Actor, [
    { absolutePath: path.join(tempDir, 'm2-library-root'), displayName: 'M2 研究文库' }
  ]);
  fs.mkdirSync(path.join(tempDir, 'm2-library-root'), { recursive: true, mode: 0o700 });

  // 7b. HTTP API: POST /canvas/imports/native with real PDF download and SHA-256 attachment creation
  const mockPdfServer = async (url) => {
    return {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF')
    };
  };

  const pdfDownloadHttpRes = await call(handler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      sourceType: 'arxiv',
      title: 'HTTP Native Arxiv Paper with PDF',
      arxivId: '2501.99999',
      pdfUrl: 'https://arxiv.org/pdf/2501.99999.pdf',
      targetWorkspaceId: apiTopic.id
    }
  });
  assert.equal(pdfDownloadHttpRes.statusCode, 201, pdfDownloadHttpRes.text);
  assert.ok(pdfDownloadHttpRes.payload.data.document);
  assert.ok(pdfDownloadHttpRes.payload.data.attachment, 'Attachment must be created from safe PDF download');
  // [M4 final] The PDF is archived into the library root, not left blob-only.
  assert.equal(pdfDownloadHttpRes.payload.data.attachment.storageKind, 'source_file');
  assert.equal(pdfDownloadHttpRes.payload.data.attachment.blobHash ?? null, null);
  assert.ok(pdfDownloadHttpRes.payload.data.sourceFile, 'source_files row must exist');
  assert.equal(pdfDownloadHttpRes.payload.data.sourceFile.relativePath.startsWith('网页导入/'), true,
    'web import PDFs land in the 网页导入 directory by default');
  assert.equal(
    fs.existsSync(path.join(tempDir, 'm2-library-root', pdfDownloadHttpRes.payload.data.sourceFile.relativePath)),
    true, 'the archived PDF must exist on disk inside the library root');

  // Verify second import of exact same PDF via SHA-256 detects duplicate / reuses
  const pdfSha256 = pdfDownloadHttpRes.payload.data.sourceFile.sha256;
  const samePdfReusedRes = await call(handler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      sourceType: 'manual',
      title: 'Same PDF Different Source',
      pdfUrl: 'https://arxiv.org/pdf/2501.99999.pdf'
    }
  });
  // [M4 UX upgrade] same SHA-256 re-import now succeeds with 200 reused:
  // no second file, missing metadata backfilled, document reused cleanly.
  assert.equal(samePdfReusedRes.statusCode, 200, samePdfReusedRes.text);
  assert.equal(samePdfReusedRes.payload.data.outcome, 'reused');
  assert.equal(samePdfReusedRes.payload.data.match.strategy, 'sha256');
  assert.equal(samePdfReusedRes.payload.data.document.id, pdfDownloadHttpRes.payload.data.document.id);
  assert.equal(samePdfReusedRes.payload.data.reusedSourceFile, true);

  // 7c. HTTP API: explicit body.pdfUrl download failure must FAIL the request (non-silent)
  const explicitFailHandler = createCanvasHandler(store, {
    downloadPdfFn: async () => { throw new Error('Forbidden address: private host'); }
  });
  const explicitPdfFailRes = await call(explicitFailHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      sourceType: 'manual',
      title: 'Explicit PDF Failure Paper',
      pdfUrl: 'http://192.168.1.1/paper.pdf'
    }
  });
  assert.equal(explicitPdfFailRes.statusCode, 502, 'Explicit body.pdfUrl failure must fail the request');
  assert.equal(explicitPdfFailRes.payload.error.code, 'pdf_download_failed');

  // Verify document was NOT created for the failed explicit PDF import
  const explicitFailDoc = store.listDocuments(m2Actor, { search: 'Explicit PDF Failure Paper' });
  assert.equal(explicitFailDoc.length, 0, 'No document should be created when explicit PDF download fails');

  // 7d. HTTP API: resolver-derived pdfUrl failure degrades to metadata-only WITH warning
  const degradeHandler = createCanvasHandler(store, {
    downloadPdfFn: async () => { throw new Error('network unreachable'); }
  });
  const degradeRes = await call(degradeHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      resolved: { sourceType: 'arxiv', title: 'Resolver Derived PDF Degrade Paper', arxivId: '2401.55555', pdfUrl: 'https://arxiv.org/pdf/2401.55555.pdf' }
    }
  });
  assert.equal(degradeRes.statusCode, 201, 'Resolver-derived pdfUrl failure degrades to success');
  assert.ok(degradeRes.payload.data.warning, 'Degrade response must carry explicit warning');
  assert.match(degradeRes.payload.data.warning, /PDF 附件下载失败/);

  // 8. HTTP API: POST /canvas/imports/native 409 conflict when fuzzy duplicate detected
  const fuzzyHttpRes = await call(handler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      sourceType: 'manual',
      title: 'HTTP Native Imported Paper (Similar)'
    }
  });
  assert.equal(fuzzyHttpRes.statusCode, 409);
  assert.equal(fuzzyHttpRes.payload.error.code, 'duplicate_confirmation_required');
  assert.ok(fuzzyHttpRes.payload.data.candidates.length > 0);

  // 8a. HTTP API: conflicting identities must return 409 identity_conflict
  const identityConflictRes = await call(handler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      sourceType: 'mixed',
      title: 'HTTP Identity Conflict Paper',
      doi: '10.5555/transformer-initial',
      externalRefs: [{ provider: 'zotero', externalItemId: 'ZOTERO_ITEM_100', externalLibraryId: 'user_42' }]
    }
  });
  assert.equal(identityConflictRes.statusCode, 409);
  assert.equal(identityConflictRes.payload.error.code, 'identity_conflict');
  assert.equal(identityConflictRes.payload.data.conflicts.length, 2);
  assert.ok(identityConflictRes.payload.data.conflicts.every(c => c.documentId && c.title));

  // 8b. P2 validation: batch request with invalid non-object item rejected BEFORE creating any job
  const jobsCountBefore = store.db.prepare('SELECT COUNT(*) AS c FROM import_jobs').get().c;
  const invalidBatchRes = await call(handler, '/canvas/imports/native/batch', {
    method: 'POST', cookie,
    body: {
      sourceType: 'batch_invalid',
      items: [
        { title: 'Valid 1' },
        'invalid_string_item'
      ]
    }
  });
  assert.equal(invalidBatchRes.statusCode, 400);
  const jobsCountAfter = store.db.prepare('SELECT COUNT(*) AS c FROM import_jobs').get().c;
  assert.equal(jobsCountAfter, jobsCountBefore, 'No orphaned pending import_jobs should be created on validation failure');

  // 9. HTTP API: POST /canvas/imports/native/batch with per-item report and atomic counters
  const batchImportRes = await call(handler, '/canvas/imports/native/batch', {
    method: 'POST', cookie,
    body: {
      sourceType: 'batch_csl',
      targetWorkspaceId: apiTopic.id,
      items: [
        { title: 'Batch Paper Alpha', doi: '10.8888/alpha' },
        { title: 'Batch Paper Beta', doi: '10.8888/beta' },
        { title: '', doi: 'invalid' } // intentional failure
      ]
    }
  });
  assert.equal(batchImportRes.statusCode, 201);
  assert.ok(batchImportRes.payload.data.job);
  assert.equal(batchImportRes.payload.data.job.totalCount, 3);
  assert.equal(batchImportRes.payload.data.job.completedCount, 2);
  assert.equal(batchImportRes.payload.data.job.failedCount, 1);
  assert.equal(batchImportRes.payload.data.job.state, 'completed_with_errors');
  assert.equal(batchImportRes.payload.data.job.report.items.length, 3);
  assert.equal(batchImportRes.payload.data.job.report.items[0].ok, true);
  assert.equal(batchImportRes.payload.data.job.report.items[2].ok, false);

  // 9b. Batch state machine: appendImportJobItemReport keeps running; finalize sets terminal state
  {
    const smJob = store.createImportJob(m2Actor, { sourceType: 'sm_test', totalCount: 2 });
    assert.equal(smJob.state, 'pending');

    const afterFirst = store.appendImportJobItemReport(m2Actor, smJob.id, { ok: true, title: 'SM Item 1' });
    assert.equal(afterFirst.state, 'running', 'After first item the job must be running, NOT completed');
    assert.equal(afterFirst.completedAt, null, 'completedAt must not be set while running');

    const afterSecond = store.appendImportJobItemReport(m2Actor, smJob.id, { ok: false, title: 'SM Item 2', error: 'fail' });
    assert.equal(afterSecond.state, 'running', 'After second item the job must still be running');
    assert.equal(afterSecond.completedAt, null);

    const finalized = store.finalizeImportJob(m2Actor, smJob.id);
    assert.equal(finalized.state, 'completed_with_errors', 'Finalize must set terminal state based on failures');
    assert.ok(finalized.completedAt, 'Finalize must set completedAt');
    assert.equal(finalized.completedCount, 1);
    assert.equal(finalized.failedCount, 1);

    // Cancel is no longer possible after terminal state
    const cancelTerminal = store.cancelImportJob(m2Actor, smJob.id);
    assert.equal(cancelTerminal.state, 'completed_with_errors', 'Cancel after finalize must be a no-op');
  }

  // 9c. Batch structured conflicting identities report
  const conflictBatchRes = await call(handler, '/canvas/imports/native/batch', {
    method: 'POST', cookie,
    body: {
      sourceType: 'batch_conflict',
      items: [
        { title: 'Conflict Batch Paper', doi: '10.5555/transformer-initial', externalRefs: [{ provider: 'zotero', externalItemId: 'ZOTERO_ITEM_100', externalLibraryId: 'user_42' }] }
      ]
    }
  });
  assert.equal(conflictBatchRes.statusCode, 201);
  const conflictItem = conflictBatchRes.payload.data.job.report.items[0];
  assert.equal(conflictItem.ok, false);
  assert.equal(conflictItem.outcome, 'identity_conflict');
  assert.ok(Array.isArray(conflictItem.conflicts) && conflictItem.conflicts.length === 2,
    'Batch report must retain structured conflicts list');

  // 9d. Cross-library external ref write path: group_99 ref is persisted so future imports reuse
  {
    const groupDoc2 = store.importNativeDocument(m2Actor, {
      sourceType: 'zotero',
      title: 'Group-library paper (second import)',
      externalRefs: [{ provider: 'zotero', externalItemId: 'ZOTERO_ITEM_100', externalLibraryId: 'group_99' }]
    });
    assert.equal(groupDoc2.outcome, 'reused', 'Second group_99 import must reuse via persisted group external ref');
    assert.equal(groupDoc2.match.strategy, 'external_ref');
    assert.equal(groupDoc2.document.id, customProviderGroupImport.document.id);
  }

  // 9e. Unified batch pipeline imports PDFs: batch item with pdfUrl produces a real attachment
  {
    const batchPdfRes = await call(handler, '/canvas/imports/native/batch', {
      method: 'POST', cookie,
      body: {
        sourceType: 'batch_pdf',
        items: [{ title: 'Batch PDF Unified Paper', pdfUrl: 'https://example.org/batch.pdf' }]
      }
    });
    assert.equal(batchPdfRes.statusCode, 201);
    assert.equal(batchPdfRes.payload.data.job.state, 'completed');
    assert.equal(batchPdfRes.payload.data.job.completedCount, 1);
    const batchItem = batchPdfRes.payload.data.job.report.items[0];
    // The mock downloader returns the same PDF bytes as the earlier single-import test,
    // so the SHA-256 tier must engage: a sha256 match is only possible when the batch
    // pipeline actually downloaded and hashed the PDF attachment.
    assert.equal(batchItem.matchStrategy, 'sha256', 'Batch item must go through the PDF download + hash pipeline');
    // [M4 final] The duplicate lands as a recorded duplicate_content item —
    // a resolved dedupe decision, not a failure.
    assert.equal(batchItem.ok, true);
    assert.equal(batchItem.outcome, 'reused', 'same PDF bytes reuse document and backfill metadata (never a second file)');
    const batchDoc = store.getDocument(m2Actor, batchItem.documentId);
    assert.ok(batchDoc, 'Batch report must reference the matched document');
    assert.ok(batchDoc.attachments.some(a => a.storageKind === 'source_file'),
      'the matched document already carries the archived source_file attachment');
    // No second file: the 网页导入 archive contains exactly the earlier PDF.
    const archiveDir = path.join(tempDir, 'm2-library-root', '网页导入');
    assert.equal(fs.readdirSync(archiveDir).length, 1, 'reuse must not place a second file');
    assert.equal(batchPdfRes.payload.data.job.failedCount, 0);
  }

  // 9f. [M4 final] Compensation direction 1: placement refusal (symlinked
  // target parent) -> request fails, no DB writes, nothing on disk.
  {
    // The M2 root's 网页导入 parent is replaced by a symlink to an outside dir;
    // any import attempt must be refused before a single byte moves.
    fs.mkdirSync(path.join(tempDir, 'm2-library-root'), { recursive: true });
    const archiveParent = path.join(tempDir, 'm2-library-root', '网页导入');
    if (fs.existsSync(archiveParent)) fs.rmSync(archiveParent, { recursive: true, force: true });
    const outsideDir9f = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-m2-9f-out-'));
    fs.symlinkSync(outsideDir9f, archiveParent);
    const refusalHandler = createCanvasHandler(store, {
      downloadPdfFn: async (url, targetDir) => {
        fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
        const tempFilePath = path.join(targetDir, `refuse-${Math.random().toString(36).slice(2, 8)}.tmp`);
        const content = Buffer.from(`%PDF-1.7 placement-refusal-${Date.now()}`);
        fs.writeFileSync(tempFilePath, content, { mode: 0o600 });
        return {
          tempFilePath,
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
          sizeBytes: content.length,
          mimeType: 'application/pdf'
        };
      }
    });
    const symlinkImportRes = await call(refusalHandler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: {
        sourceType: 'manual',
        title: 'Placement Refusal Paper',
        pdfUrl: 'https://example.org/refuse-unique-content.pdf'
      }
    });
    assert.equal(symlinkImportRes.statusCode, 400, 'Placement refusal must fail the request: ' + symlinkImportRes.text);
    assert.equal(symlinkImportRes.payload.error.code, 'symlink_rejected');
    assert.equal(store.listDocuments(m2Actor, { search: 'Placement Refusal Paper' }).length, 0,
      'No document row may exist after placement refusal');
    assert.equal(fs.readdirSync(outsideDir9f).length, 0, 'Nothing may be written through the symlink');
    fs.unlinkSync(archiveParent);
    fs.rmSync(outsideDir9f, { recursive: true, force: true });
  }

  // 9g. [M4 final] Compensation direction 2: DB write failure -> the placed
  // directory file is removed (双向无孤儿 for the source_file model).
  {
    const failingStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'importNativeDocumentToSourceFile') {
          return () => { throw new Error('simulated DB transaction failure'); };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const dbFailHandler = createCanvasHandler(failingStore, {
      downloadPdfFn: async (url, targetDir) => {
        fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
        const tempFilePath = path.join(targetDir, 'db-fail.tmp');
        const content = Buffer.from('%PDF-1.7 db-fail');
        fs.writeFileSync(tempFilePath, content, { mode: 0o600 });
        return {
          tempFilePath,
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
          sizeBytes: content.length,
          mimeType: 'application/pdf'
        };
      }
    });
    const dbFailRes = await call(dbFailHandler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: { sourceType: 'manual', title: 'DB Failure Paper', pdfUrl: 'https://example.org/dbfail.pdf' }
    });
    assert.equal(dbFailRes.statusCode, 500, 'DB failure must surface as 500');
    const dbFailHash = crypto.createHash('sha256').update(Buffer.from('%PDF-1.7 db-fail')).digest('hex');
    const archivedFile = path.join(tempDir, 'm2-library-root', '网页导入', 'DB-Failure-Paper.pdf');
    assert.ok(!fs.existsSync(archivedFile), 'Placed archive file must be removed after DB write failure');
    assert.equal(store.getBlob(dbFailHash), null, 'No blob row may remain after DB write failure');
    assert.equal(store.getSourceFileByPath(m2Actor, m2LibraryRoot.id, '网页导入/DB-Failure-Paper.pdf'), null,
      'No source_files row may remain after DB write failure');
  }

  // 9h. Startup blob/DB consistency recovery (isolated data directory):
  // business-layer cleanup + orphan grace period + in-flight interleave safety
  {
    const consistencyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-blob-consistency-'));
    const consistencyStore = new CanvasStore(path.join(consistencyDir, 'consistency.sqlite'));
    const cActor = canvasActorKey('https://issuer.example', 'consistency-actor');

    // Workspace + document + dangling attachment whose blob file does not exist
    const cWs = consistencyStore.createWorkspace(cActor, { name: 'Consistency Topic' });
    const doc = consistencyStore.createDocument(cActor, { title: 'Dangling Doc' });
    const ghostHash = 'a'.repeat(64);
    consistencyStore.db.prepare(`
      INSERT INTO blobs (sha256, relative_path, size_bytes, mime_type, created_at, reference_count)
      VALUES (?, 'sha256/aa/aa/ghost.pdf', 10, 'application/pdf', '2026-09-02T00:00:00.000Z', 1)
    `).run(ghostHash);
    consistencyStore.db.prepare(`
      INSERT INTO attachments (id, document_id, blob_hash, mime_type, original_filename, title, size_bytes, version, created_at, updated_at)
      VALUES ('att-dangling', ?, ?, 'application/pdf', 'ghost.pdf', 'Ghost', 10, 1, '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z')
    `).run(doc.id, ghostHash);

    // Business bindings referencing the dangling attachment
    consistencyStore.upsertInboxEntries(cActor, [{
      libraryType: 'native', libraryId: 'local', itemKey: doc.id,
      attachmentKey: 'att-dangling', attachmentVersion: 3,
      detectedFrom: 'import:doi', title: 'Dangling Doc'
    }]);
    consistencyStore.addTopicDocument(cActor, cWs.id, {
      libraryType: 'native', libraryId: 'local', itemKey: doc.id,
      attachmentKey: 'att-dangling', attachmentVersion: 3,
      status: 'accepted', origin: 'canvas_import'
    });
    consistencyStore.db.prepare(`
      UPDATE topic_documents SET analysis_status = 'ready' WHERE item_key = ?
    `).run(doc.id);

    // Orphan files: one AGED (must be reaped), one FRESH (must be spared by grace period)
    const agedOrphanPath = consistencyStore.resolveBlobPath('b'.repeat(64), '.pdf');
    fs.mkdirSync(path.dirname(agedOrphanPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(agedOrphanPath, '%PDF-1.7 aged orphan', { mode: 0o600 });
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(agedOrphanPath, oldTime, oldTime);

    const freshOrphanPath = consistencyStore.resolveBlobPath('c'.repeat(64), '.pdf');
    fs.mkdirSync(path.dirname(freshOrphanPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(freshOrphanPath, '%PDF-1.7 fresh orphan', { mode: 0o600 });

    const summary = consistencyStore.recoverBlobConsistency();
    assert.equal(summary.danglingAttachments, 1, 'Dangling attachment must be detected');
    assert.equal(summary.zeroedBlobRows, 1, 'Ghost blob with soft-deleted FK holder must be zeroed (not hard-deleted)');
    assert.equal(consistencyStore.getBlob(ghostHash).referenceCount, 0, 'Zeroed blob must report refcount 0');
    assert.equal(summary.clearedInboxBindings, 1, 'Inbox attachment pair must be cleared');
    assert.equal(summary.clearedTopicBindings, 1, 'Topic attachment pair must be cleared');
    assert.equal(summary.staledTopicAnalyses, 1, 'Ready analysis must be marked stale');
    assert.equal(summary.deletedOrphanFiles, 1, 'AGED orphan file must be deleted');
    assert.equal(summary.sparedRecentOrphans, 1, 'FRESH orphan file must be spared by grace period');
    assert.ok(!fs.existsSync(agedOrphanPath), 'Aged orphan must be gone');
    assert.ok(fs.existsSync(freshOrphanPath), 'Fresh orphan must survive the grace period');

    const attAfter = consistencyStore.getAttachment(cActor, 'att-dangling');
    assert.equal(attAfter, null, 'Soft-deleted dangling attachment must no longer be returned');
    const inboxAfter = consistencyStore.listInboxEntries(cActor, { limit: 10 })
      .find(e => e.itemKey === doc.id);
    assert.equal(inboxAfter.attachmentKey, null, 'Inbox entry must lose the dangling attachment binding');
    const topicAfter = consistencyStore.listTopicDocuments(cActor, cWs.id)[0];
    assert.equal(topicAfter.attachmentKey, null, 'Topic document must lose the dangling attachment binding');
    assert.equal(topicAfter.analysisStatus, 'stale', 'Analysis status must become stale after recovery');

    // In-flight interleave safety: promote a file, run a concurrent recovery scan
    // (file present, DB row absent), then commit the DB write. Both must survive.
    const inflightContent = Buffer.from('%PDF-1.7 in-flight import');
    const inflightHash = crypto.createHash('sha256').update(inflightContent).digest('hex');
    const inflightTemp = path.join(consistencyStore.getBlobStorageDir(), 'tmp', 'inflight.tmp');
    fs.mkdirSync(path.dirname(inflightTemp), { recursive: true, mode: 0o700 });
    fs.writeFileSync(inflightTemp, inflightContent, { mode: 0o600 });
    const promotion = defaultPromoteBlob(consistencyStore, inflightTemp, inflightHash);
    assert.equal(promotion.newlyCreated, true);

    const raceScan = consistencyStore.recoverBlobConsistency();
    const inflightPath = consistencyStore.resolveBlobPath(inflightHash, '.pdf');
    assert.ok(fs.existsSync(inflightPath), 'Concurrent scan must NOT reap an in-flight (grace-period) promoted file');
    assert.equal(raceScan.deletedOrphanFiles, 0, 'No deletions allowed during the race window');

    const inflightResult = consistencyStore.importNativeDocument(cActor, {
      sourceType: 'manual',
      title: 'In-flight Import Paper',
      attachment: {
        sha256: inflightHash,
        relativePath: promotion.relativePath,
        sizeBytes: inflightContent.length,
        mimeType: 'application/pdf',
        originalFilename: 'inflight.pdf'
      }
    });
    assert.equal(inflightResult.outcome, 'created');
    assert.ok(inflightResult.attachment, 'Attachment must be linked after the interleaved write');
    assert.ok(fs.existsSync(inflightPath), 'File and DB reference must BOTH survive the interleaving');

    // Exclusive promotion: a second promoter of the same content must lose the race
    const secondTemp = path.join(consistencyStore.getBlobStorageDir(), 'tmp', 'second.tmp');
    fs.writeFileSync(secondTemp, inflightContent, { mode: 0o600 });
    const secondPromotion = defaultPromoteBlob(consistencyStore, secondTemp, inflightHash);
    assert.equal(secondPromotion.newlyCreated, false, 'Exactly one concurrent promoter may win');
    assert.ok(!fs.existsSync(secondTemp), 'Losing promoter temp file must be removed');
    assert.ok(fs.existsSync(inflightPath), 'Winning file must remain intact');

    // Idempotency: a final scan finds nothing actionable
    const finalScan = consistencyStore.recoverBlobConsistency();
    assert.equal(finalScan.danglingAttachments + finalScan.removedBlobRows + finalScan.zeroedBlobRows + finalScan.deletedOrphanFiles, 0);
    consistencyStore.close();
    fs.rmSync(consistencyDir, { recursive: true, force: true });
  }

  // 9i-bis. Contract bypass closures: non-http pdfUrl, invalid years, oversized resolved fields
  {
    const docsBefore = store.listDocuments(m2Actor, {}).length;
    const jobsBefore = store.db.prepare('SELECT COUNT(*) AS c FROM import_jobs').get().c;
    const badSinglePayloads = [
      { sourceType: 'manual', title: 'File Protocol Paper', pdfUrl: 'file:///etc/passwd' },
      { sourceType: 'manual', title: 'FTP Protocol Paper', pdfUrl: 'ftp://example.org/x.pdf' },
      { sourceType: 'manual', title: 'Bad Year Paper', year: 99999 },
      { sourceType: 'manual', title: 'Bad Year Type', year: 'twenty' },
      { sourceType: 'manual', title: 'Bad Resolved Year', resolved: { sourceType: 'doi', title: 'R', year: 'abc' } },
      { sourceType: 'manual', title: 'Bad Resolved Abstract', resolved: { sourceType: 'doi', title: 'R', abstractNote: 'x'.repeat(20_001) } },
      { sourceType: 'manual', title: 'Bad Resolved PdfUrl', resolved: { sourceType: 'doi', title: 'R', pdfUrl: 'gopher://x' } },
      { sourceType: 'manual', title: 'Bad Resolved ArXiv Casing', resolved: { sourceType: 'arxiv', title: 'R', arXivId: 'x'.repeat(100) } },
      { sourceType: 'manual', title: 'Bad Ref Version', externalRefs: [{ provider: 'zotero', externalItemId: 'V1', externalVersion: 'abc' }] },
      { sourceType: 'manual', title: 'Bad Ref Version Negative', externalRefs: [{ provider: 'zotero', externalItemId: 'V2', externalVersion: -1 }] },
      { sourceType: 'manual', title: 'Bad Ref SourceUrl', externalRefs: [{ provider: 'zotero', externalItemId: 'S1', sourceUrl: 'file:///etc/passwd' }] },
      { sourceType: 'manual', title: 'Bad Ref AttId Type', externalRefs: [{ provider: 'zotero', externalItemId: 'A1', externalAttachmentId: 123 }] }
    ];
    for (const payload of badSinglePayloads) {
      const res = await call(handler, '/canvas/imports/native', { method: 'POST', cookie, body: payload });
      assert.equal(res.statusCode, 400, `Contract bypass must 400: ${JSON.stringify(payload).slice(0, 90)}`);
    }
    const badBatchPayload = { items: [{ title: 'Batch File Protocol', pdfUrl: 'file:///etc/passwd' }] };
    const batchRes = await call(handler, '/canvas/imports/native/batch', { method: 'POST', cookie, body: badBatchPayload });
    assert.equal(batchRes.statusCode, 400, 'Batch non-http pdfUrl must 400');
    assert.equal(store.listDocuments(m2Actor, {}).length, docsBefore, 'No documents may be created by rejected payloads');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM import_jobs').get().c, jobsBefore, 'No jobs may be created by rejected payloads');

    // Positive: fully-populated externalRef passes and persists with normalized fields
    const fullRefRes = await call(handler, '/canvas/imports/native', {
      method: 'POST', cookie,
      body: {
        sourceType: 'zotero',
        title: 'Full External Ref Paper',
        externalRefs: [{
          provider: 'zotero',
          externalItemId: 'FULL_REF_1',
          externalLibraryId: 'user_42',
          externalAttachmentId: 'ATT_FULL_1',
          externalVersion: 7,
          sourceUrl: 'https://zotero.org/items/FULL_REF_1'
        }]
      }
    });
    assert.equal(fullRefRes.statusCode, 201);
    const persistedRef = store.listExternalRefs(m2Actor, fullRefRes.payload.data.document.id)
      .find(r => r.externalItemId === 'FULL_REF_1');
    assert.ok(persistedRef, 'Fully populated externalRef must persist');
    assert.equal(persistedRef.externalAttachmentId, 'ATT_FULL_1');
    assert.equal(persistedRef.externalVersion, 7);
    assert.equal(persistedRef.sourceUrl, 'https://zotero.org/items/FULL_REF_1');
  }

  // 9i. Deep pre-validation rejects malformed nested structures without creating any job
  {
    const jobsBefore = store.db.prepare('SELECT COUNT(*) AS c FROM import_jobs').get().c;
    const badPayloads = [
      { items: [{ title: 'Bad Creators', creators: [{ firstName: 123 }] }] },
      { items: [{ title: 'Bad Provider', externalRefs: [{ provider: '', externalItemId: 'X' }] }] },
      { items: [{ title: 'Bad ItemId', externalRefs: [{ provider: 'zotero', externalItemId: 'x'.repeat(300) }] }] },
      { items: [{ title: 'x'.repeat(600) }] },
      { items: [{ title: 'Bad Library', externalRefs: [{ provider: 'zotero', externalItemId: 'OK1', externalLibraryId: 42 }] }] }
    ];
    for (const payload of badPayloads) {
      const res = await call(handler, '/canvas/imports/native/batch', { method: 'POST', cookie, body: payload });
      assert.equal(res.statusCode, 400, `Deep pre-validation must reject: ${JSON.stringify(payload).slice(0, 80)}`);
    }
    const jobsAfter = store.db.prepare('SELECT COUNT(*) AS c FROM import_jobs').get().c;
    assert.equal(jobsAfter, jobsBefore, 'Deep pre-validation failures must not create import jobs');
  }

  // 10. HTTP API: Cancel import job
  const pendingBatchJob = store.createImportJob(m2Actor, { sourceType: 'batch_test', totalCount: 10 });
  const cancelRes = await call(handler, `/canvas/import-jobs/${pendingBatchJob.id}/cancel`, { method: 'POST', cookie });
  assert.equal(cancelRes.statusCode, 200);
  assert.equal(cancelRes.payload.data.state, 'cancelled');

  // 11. HTTP API: List import jobs
  const listJobsRes = await call(handler, '/canvas/import-jobs', { cookie });
  assert.equal(listJobsRes.statusCode, 200);
  assert.ok(Array.isArray(listJobsRes.payload.data));
  assert.ok(listJobsRes.payload.data.some(j => j.id === batchImportRes.payload.data.job.id));

  // =========================================================================
  // --- M3.2: Unified Parse & Import Workflow (Translation Server Pipeline) ---
  // =========================================================================

  // 12. Input format detection
  assert.equal(detectInputFormat('@article{vaswani2017,\n  title={Attention Is All You Need}\n}'), 'bibtex');
  assert.equal(detectInputFormat('@inproceedings{devlin2018bert,\n  title={BERT}\n}'), 'bibtex');
  assert.equal(detectInputFormat('@book{knuth1997taocp,\n  title={The Art of Computer Programming}\n}'), 'bibtex');
  assert.equal(detectInputFormat('TY  - JOUR\nTI  - Deep Residual Learning\nER  -'), 'ris');
  assert.equal(detectInputFormat('10.1038/s41586-020-2649-2'), 'doi');
  assert.equal(detectInputFormat('2301.12345'), 'arxiv');
  assert.equal(detectInputFormat('arxiv:2301.12345'), 'arxiv');
  assert.equal(detectInputFormat('https://arxiv.org/abs/2301.12345'), 'arxiv');
  assert.equal(detectInputFormat('https://doi.org/10.1038/s41586-020-2649-2'), 'doi');
  assert.equal(detectInputFormat('https://nature.com/articles/s41586-020-2649-2'), 'url');
  assert.equal(detectInputFormat('Random search string'), 'text');
  assert.equal(detectInputFormat(''), 'unknown');

  // 13. Mock Translation Server function for integration testing
  let tsCallCount = 0;
  const mockTsResolver = async ({ input, format }) => {
    tsCallCount++;
    if (input.includes('TIMEOUT_ERROR')) {
      const err = new Error('translation task exceeded total timeout of 60000ms');
      err.code = 'total_timeout';
      throw err;
    }
    if (input.includes('UPSTREAM_ERROR')) {
      const err = new Error('translation server returned HTTP 502');
      err.code = 'upstream_error';
      throw err;
    }
    if (input.includes('TOO_LARGE_ERROR')) {
      const err = new Error('translation response exceeded 2 MiB cap');
      err.code = 'response_too_large';
      throw err;
    }
    if (input.includes('SYNTAX_ERROR')) {
      return {
        available: true,
        ok: false,
        error: 'Syntax error in BibTeX entry at line 2'
      };
    }
    if (input.includes('TOO_MANY_CREATORS')) {
      return {
        available: true,
        ok: true,
        item: {
          sourceType: 'bibtex',
          title: 'Physics Mega Collaboration',
          creators: Array.from({ length: 101 }, (_, i) => ({ name: `Physicist ${i}` }))
        }
      };
    }
    if (input.includes('ISBN_BOOK')) {
      return {
        available: true,
        ok: true,
        item: {
          sourceType: 'ris',
          title: 'Operating Systems: Three Easy Pieces',
          abstract: 'A book about operating systems.',
          isbn: '978-1-4028-9462-6',
          year: 2018,
          creators: [{ firstName: 'Remzi', lastName: 'Arpaci-Dusseau' }]
        }
      };
    }
    if (format === 'bibtex' && input.includes('@article')) {
      return {
        available: true,
        ok: true,
        item: {
          sourceType: 'bibtex',
          title: 'BibTeX Transformer Paper',
          abstract: 'Parsed abstract from BibTeX entry.',
          creators: [{ firstName: 'Ashish', lastName: 'Vaswani' }],
          year: 2017,
          doi: '10.3333/bibtex-transformer',
          url: 'https://arxiv.org/abs/1706.03762',
          pdfUrl: 'https://arxiv.org/pdf/1706.03762.pdf'
        }
      };
    }
    if (format === 'ris' && input.includes('TY  -')) {
      return {
        available: true,
        ok: true,
        item: {
          sourceType: 'ris',
          title: 'RIS ResNet Paper',
          abstract: 'Deep residual learning for image recognition.',
          creators: [{ firstName: 'Kaiming', lastName: 'He' }],
          year: 2016,
          doi: '10.4444/ris-resnet'
        }
      };
    }
    return { available: false, reason: 'translation_server_not_configured' };
  };

  // 14. resolveImportInput with Translation Server
  const bibtexResolved = await resolveImportInput('@article{vaswani2017, title={BibTeX Transformer Paper}}', {
    translationServerFn: mockTsResolver
  });
  assert.equal(bibtexResolved.sourceType, 'bibtex');
  assert.equal(bibtexResolved.title, 'BibTeX Transformer Paper');
  assert.equal(bibtexResolved.doi, '10.3333/bibtex-transformer');
  assert.equal(bibtexResolved.resolvedBy, 'translation_server');
  assert.equal(bibtexResolved.pdfUrl, 'https://arxiv.org/pdf/1706.03762.pdf');

  const risResolved = await resolveImportInput('TY  - JOUR\nTI  - RIS ResNet Paper\nER  -', {
    translationServerFn: mockTsResolver
  });
  assert.equal(risResolved.sourceType, 'ris');
  assert.equal(risResolved.title, 'RIS ResNet Paper');
  assert.equal(risResolved.year, 2016);
  assert.equal(risResolved.resolvedBy, 'translation_server');

  // TS unavailable throws with translation_server_unavailable code
  await assert.rejects(
    () => resolveImportInput('@article{test, title={No TS}}', {
      translationServerFn: async () => ({ available: false })
    }),
    err => err.code === 'translation_server_unavailable' && err.message.includes('Translation Server 未配置')
  );

  // TS error throws with translation_server_error code
  await assert.rejects(
    () => resolveImportInput('@article{SYNTAX_ERROR, title={Error}}', {
      translationServerFn: mockTsResolver
    }),
    err => err.code === 'translation_server_error' && err.message.includes('Syntax error')
  );

  // Native DOI resolution continues to work directly with resolvedBy: 'native_resolver'
  const nativeDoiRes = await resolveImportInput('10.1038/s41586-020-2649-2', {
    fetchFn: mockDoiFetch,
    translationServerFn: mockTsResolver
  });
  assert.equal(nativeDoiRes.sourceType, 'doi');
  assert.equal(nativeDoiRes.resolvedBy, 'native_resolver');

  // 15. HTTP API: POST /canvas/imports/resolve with Translation Server integration
  const tsHandler = createCanvasHandler(store, {
    translationServerFn: mockTsResolver,
    downloadPdfFn: async (url, targetDir) => {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      const tempFilePath = path.join(targetDir, `ts-mock-${crypto.randomBytes(6).toString('hex')}.tmp`);
      // Unique bytes per download: each scenario represents a different
      // document; the identical-content duplicate gate has dedicated tests.
      const content = Buffer.from(`%PDF-1.7 ts-download-${crypto.randomBytes(8).toString('hex')}`);
      fs.writeFileSync(tempFilePath, content, { mode: 0o600 });
      return {
        tempFilePath,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        sizeBytes: content.length,
        mimeType: 'application/pdf'
      };
    }
  });

  const resolveBibtexHttpRes = await call(tsHandler, '/canvas/imports/resolve', {
    method: 'POST', cookie,
    body: { input: '@article{vaswani2017, title={Attention Is All You Need}}' }
  });
  assert.equal(resolveBibtexHttpRes.statusCode, 200);
  assert.equal(resolveBibtexHttpRes.payload.data.resolved.title, 'BibTeX Transformer Paper');
  assert.equal(resolveBibtexHttpRes.payload.data.parsedBy, 'translation_server');
  assert.ok(Array.isArray(resolveBibtexHttpRes.payload.data.duplicateCandidates));

  // HTTP API resolve with TS unavailable returns 503
  const noTsHandler = createCanvasHandler(store, {
    translationServerFn: async () => ({ available: false })
  });
  const unavailRes = await call(noTsHandler, '/canvas/imports/resolve', {
    method: 'POST', cookie,
    body: { input: '@article{vaswani2017, title={No TS}}' }
  });
  assert.equal(unavailRes.statusCode, 503);
  assert.equal(unavailRes.payload.error.code, 'translation_server_unavailable');

  // 16. Full M3.2 pipeline via POST /canvas/imports/native with BibTeX input (parse -> dedup -> PDF download -> native storage)
  const bibtexImportHttpRes = await call(tsHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      input: '@article{vaswani2017, title={Attention Is All You Need}}',
      targetWorkspaceId: apiTopic.id
    }
  });
  assert.equal(bibtexImportHttpRes.statusCode, 201);
  assert.equal(bibtexImportHttpRes.payload.data.outcome, 'created');
  assert.equal(bibtexImportHttpRes.payload.data.document.title, 'BibTeX Transformer Paper');
  assert.equal(bibtexImportHttpRes.payload.data.document.doi, '10.3333/bibtex-transformer');
  assert.equal(bibtexImportHttpRes.payload.data.inboxEntry ?? null, null, '[M4] inbox retired');
  assert.ok(bibtexImportHttpRes.payload.data.topicDocument);

  // 17. [M4 final] Re-import with a fresh PDF version: the DOI metadata
  // matches, but the NEW bytes hit the same target filename as the first
  // archive (different SHA) -> 409 filename_conflict; the original file and
  // its document identity stay untouched until the user renames and retries.
  const bibtexReimportRes = await call(tsHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      input: '@article{vaswani2017, title={Attention Is All You Need}}'
    }
  });
  assert.equal(bibtexReimportRes.statusCode, 409, bibtexReimportRes.text);
  assert.equal(bibtexReimportRes.payload.error.code, 'filename_conflict');
  assert.equal(bibtexReimportRes.payload.data.targetPath, '网页导入/1706.03762.pdf');
  assert.equal(store.getSourceFileByPath(
    canvasActorKey('https://issuer.example', 'api-subject'),
    m2LibraryRoot.id,
    bibtexImportHttpRes.payload.data.sourceFile.relativePath
  ).documentId, bibtexImportHttpRes.payload.data.document.id,
    'the first archived file remains bound to its document');
  assert.equal(
    fs.readFileSync(path.join(tempDir, 'm2-library-root', bibtexImportHttpRes.payload.data.sourceFile.relativePath))
      .equals(fs.readFileSync(path.join(tempDir, 'm2-library-root', bibtexImportHttpRes.payload.data.sourceFile.relativePath))),
    true);

  // 18. M3.2 Batch pipeline with mixed inputs (BibTeX parsed by TS + native DOI + invalid format + >2KB input)
  const longBibtexComment = '% '.repeat(2000) + '\n@article{vaswani2017, title={BibTeX Paper in Batch}}';
  assert.ok(longBibtexComment.length > 3000, 'Batch input should exceed 2KB');
  const mixedBatchRes = await call(tsHandler, '/canvas/imports/native/batch', {
    method: 'POST', cookie,
    body: {
      sourceType: 'batch_mixed',
      targetWorkspaceId: apiTopic.id,
      items: [
        { input: longBibtexComment },
        { title: 'Batch Standalone Paper', doi: '10.9999/batch-mixed-doi' },
        { title: '', input: '123_invalid_cannot_resolve' }
      ]
    }
  });
  assert.equal(mixedBatchRes.statusCode, 201);
  assert.equal(mixedBatchRes.payload.data.job.state, 'completed_with_errors');
  assert.equal(mixedBatchRes.payload.data.job.totalCount, 3);
  // [M4 final] Item 1 hits the same PDF URL as test 17 with different bytes:
  // the 网页导入 archive already holds 1706.03762.pdf, so it records a
  // filename_conflict instead of silently overwriting or inventing "(2)".
  assert.equal(mixedBatchRes.payload.data.job.completedCount, 1);
  assert.equal(mixedBatchRes.payload.data.job.failedCount, 2);
  assert.equal(mixedBatchRes.payload.data.job.report.items[0].ok, false);
  assert.equal(mixedBatchRes.payload.data.job.report.items[0].errorCode, 'filename_conflict');
  assert.equal(mixedBatchRes.payload.data.job.report.items[1].ok, true);
  assert.equal(mixedBatchRes.payload.data.job.report.items[2].ok, false);
  assert.equal(mixedBatchRes.payload.data.job.report.items[2].errorCode, 'unsupported_import_input');

  // 19. M3.2 Single import: >2KB input accepted (1 MiB support). The fresh
  // PDF bytes hit the same target filename (1706.03762.pdf) as test 17 ->
  // 409 filename_conflict, proving the 1 MiB path reaches the conflict rule
  // instead of failing on length.
  const singleLongInputRes = await call(tsHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      input: '% ' + 'x'.repeat(4000) + '\n@article{vaswani2017, title={Long Input Paper}}'
    }
  });
  assert.equal(singleLongInputRes.statusCode, 409, singleLongInputRes.text);
  assert.equal(singleLongInputRes.payload.error.code, 'filename_conflict');

  // 20. M3.2 ISBN flow: DTO persistence to document record and dedup reuse by ISBN
  const isbnImportRes = await call(tsHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      input: 'ISBN_BOOK',
      targetWorkspaceId: apiTopic.id
    }
  });
  assert.equal(isbnImportRes.statusCode, 201);
  assert.equal(isbnImportRes.payload.data.outcome, 'created');
  assert.equal(isbnImportRes.payload.data.document.title, 'Operating Systems: Three Easy Pieces');
  assert.equal(isbnImportRes.payload.data.document.isbn, '978-1-4028-9462-6', 'ISBN must be persisted into document');

  // Second import with identical ISBN but different title and no DOI/PDF -> matches by ISBN strategy
  const isbnReimportRes = await call(tsHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      title: 'OSTEP Second Edition',
      isbn: '978-1-4028-9462-6'
    }
  });
  assert.equal(isbnReimportRes.statusCode, 200);
  assert.equal(isbnReimportRes.payload.data.outcome, 'reused');
  assert.equal(isbnReimportRes.payload.data.match.strategy, 'isbn', 'Matches existing document by ISBN');
  assert.equal(isbnReimportRes.payload.data.document.id, isbnImportRes.payload.data.document.id);

  // 21. M3.2 Creators cap validation: creators > 100 rejected before DB write
  const tooManyCreatorsRes = await call(tsHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      input: 'TOO_MANY_CREATORS'
    }
  });
  assert.equal(tooManyCreatorsRes.statusCode, 400);
  assert.equal(tooManyCreatorsRes.payload.error.code, 'invalid_request');
  assert.ok(tooManyCreatorsRes.payload.error.message.includes('at most 100 entries'), 'Must enforce creators limit <= 100');

  // 22. M3.2 Translation Server error status code mapping
  // 22a. 504 total_timeout
  const timeoutRes = await call(tsHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: { input: 'TIMEOUT_ERROR' }
  });
  assert.equal(timeoutRes.statusCode, 504);
  assert.equal(timeoutRes.payload.error.code, 'total_timeout');

  // 22b. 502 upstream_error
  const upstreamRes = await call(tsHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: { input: 'UPSTREAM_ERROR' }
  });
  assert.equal(upstreamRes.statusCode, 502);
  assert.equal(upstreamRes.payload.error.code, 'upstream_error');

  // 22c. 400 translation_server_error
  const syntaxErrRes = await call(tsHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: { input: 'SYNTAX_ERROR' }
  });
  assert.equal(syntaxErrRes.statusCode, 400);
  assert.equal(syntaxErrRes.payload.error.code, 'translation_server_error');

  // 22d. 400 unsupported_import_input for unresolvable raw text
  const unsupportedRes = await call(tsHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: { input: 'unrecognized_plain_query_cannot_parse' }
  });
  assert.equal(unsupportedRes.statusCode, 400);
  assert.equal(unsupportedRes.payload.error.code, 'unsupported_import_input');

  // 23. M3.2 audit P1: pure structured (top-level) imports must pass the SAME unified
  // creators contract as resolver-sourced metadata — count cap AND non-blank names.
  const apiActorKey = canvasActorKey('https://issuer.example', 'api-subject');
  const docCountBefore23 = store.listDocuments(apiActorKey, { limit: 200, offset: 0 }).length;

  // 23a. top-level 101 creators -> 400 with zero documents written
  const topLevel101Res = await call(tsHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      title: 'Top-Level Mega Collaboration',
      creators: Array.from({ length: 101 }, (_, i) => ({ name: `Author ${i}` }))
    }
  });
  assert.equal(topLevel101Res.statusCode, 400);
  assert.equal(topLevel101Res.payload.error.code, 'invalid_request');
  assert.ok(topLevel101Res.payload.error.message.includes('at most 100 entries'), 'Top-level creators must be capped at 100');
  assert.equal(store.listDocuments(apiActorKey, { limit: 200, offset: 0 }).length, docCountBefore23, 'No document may be written for a rejected top-level payload');

  // 23b. top-level whitespace-only name creator -> 400
  const blankNameRes = await call(tsHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: { title: 'Blank Name Paper', creators: [{ name: '   ' }] }
  });
  assert.equal(blankNameRes.statusCode, 400);
  assert.ok(blankNameRes.payload.error.message.includes('non-blank name'), 'Whitespace-only creator names must be rejected');

  // 23c. top-level creator without any name field -> 400
  const noNameRes = await call(tsHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: { title: 'No Name Paper', creators: [{ creatorType: 'author' }] }
  });
  assert.equal(noNameRes.statusCode, 400);
  assert.ok(noNameRes.payload.error.message.includes('non-blank name'), 'Creators without name fields must be rejected');

  // 23d. valid top-level creators -> normal write with persisted creator rows
  const validTopLevelRes = await call(tsHandler, '/canvas/imports/native', {
    method: 'POST', cookie,
    body: {
      title: 'Top-Level Structured Paper',
      doi: '10.7777/top-level-structured',
      creators: [
        { creatorType: 'author', firstName: 'Grace', lastName: 'Hopper' },
        { creatorType: 'author', name: 'Alan Turing' }
      ]
    }
  });
  assert.equal(validTopLevelRes.statusCode, 201);
  assert.equal(validTopLevelRes.payload.data.outcome, 'created');
  assert.equal(validTopLevelRes.payload.data.document.creators.length, 2);
  assert.equal(validTopLevelRes.payload.data.document.creators[0].firstName, 'Grace');
  assert.equal(validTopLevelRes.payload.data.document.creators[1].name, 'Alan Turing');

  // 23e. batch pre-validation rejects 101 top-level creators BEFORE creating any job
  const jobCountBefore23e = store.listImportJobs(apiActorKey, { limit: 200 }).length;
  const batch101Res = await call(tsHandler, '/canvas/imports/native/batch', {
    method: 'POST', cookie,
    body: {
      sourceType: 'batch_structured',
      items: [
        { title: 'Batch 101 Creators', creators: Array.from({ length: 101 }, (_, i) => ({ name: `Author ${i}` })) }
      ]
    }
  });
  assert.equal(batch101Res.statusCode, 400);
  assert.equal(store.listImportJobs(apiActorKey, { limit: 200 }).length, jobCountBefore23e, 'Rejected batch must not leave a pending job behind');

  // 24. M3.2 audit P1: /canvas/imports/resolve must forward authoritative TS statuses
  // 24a. 504 total_timeout
  const resolveTimeoutRes = await call(tsHandler, '/canvas/imports/resolve', {
    method: 'POST', cookie,
    body: { input: 'TIMEOUT_ERROR' }
  });
  assert.equal(resolveTimeoutRes.statusCode, 504);
  assert.equal(resolveTimeoutRes.payload.error.code, 'total_timeout');

  // 24b. 502 upstream_error
  const resolveUpstreamRes = await call(tsHandler, '/canvas/imports/resolve', {
    method: 'POST', cookie,
    body: { input: 'UPSTREAM_ERROR' }
  });
  assert.equal(resolveUpstreamRes.statusCode, 502);
  assert.equal(resolveUpstreamRes.payload.error.code, 'upstream_error');

  // 24c. 413 response_too_large
  const resolveTooLargeRes = await call(tsHandler, '/canvas/imports/resolve', {
    method: 'POST', cookie,
    body: { input: 'TOO_LARGE_ERROR' }
  });
  assert.equal(resolveTooLargeRes.statusCode, 413);
  assert.equal(resolveTooLargeRes.payload.error.code, 'response_too_large');

  // 24d. 400 translation_server_error (syntax)
  const resolveSyntaxRes = await call(tsHandler, '/canvas/imports/resolve', {
    method: 'POST', cookie,
    body: { input: 'SYNTAX_ERROR' }
  });
  assert.equal(resolveSyntaxRes.statusCode, 400);
  assert.equal(resolveSyntaxRes.payload.error.code, 'translation_server_error');

  // 24e. 400 unsupported_import_input
  const resolveUnsupportedRes = await call(tsHandler, '/canvas/imports/resolve', {
    method: 'POST', cookie,
    body: { input: 'unrecognized_plain_query_cannot_parse' }
  });
  assert.equal(resolveUnsupportedRes.statusCode, 400);
  assert.equal(resolveUnsupportedRes.payload.error.code, 'unsupported_import_input');

  // 25. [M4 final] The legacy /canvas/imports entry is retired outright, so
  // it answers 410 before any resolver input handling.
  const legacyImportsTimeoutRes = await call(tsHandler, '/canvas/imports', {
    method: 'POST', cookie,
    body: { input: 'TIMEOUT_ERROR' }
  });
  assert.equal(legacyImportsTimeoutRes.statusCode, 410);
  assert.equal(legacyImportsTimeoutRes.payload.error.code, 'feature_retired');

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
