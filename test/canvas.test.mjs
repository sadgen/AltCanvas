import assert from 'assert/strict';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CanvasConflictError, CanvasStore, canvasActorKey } from '../server/canvas-store.mjs';
import { createCanvasHandler } from '../server/canvas-api.mjs';
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

  store.close();
  store = new CanvasStore(dbPath);
  snapshot = store.snapshot(actor, board.id);
  assert.equal(snapshot.nodes.find(node => node.id === note.id).body, 'Updated interpretation');
  assert.equal(snapshot.edges[0].id, edge.id, 'edges must survive database reopen');

  const aiCalls = [];
  const handler = createCanvasHandler(store, {
    aiPublicConfig: () => ({ configured: true, provider: 'mock.example', model: 'mock-model' }),
    aiCompletion: async request => {
      aiCalls.push(request);
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
  assert.deepEqual(aiConfigResponse.payload.data, { configured: true, provider: 'mock.example', model: 'mock-model' });
  const aiTestResponse = await call(handler, '/canvas/ai/test', { method: 'POST', cookie, body: {} });
  assert.equal(aiTestResponse.statusCode, 200);

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
  assert.equal('endpoint' in aiCalls.at(-1), false, 'browser endpoint must never reach the AI client');

  const badAiRes = await call(handler, `/canvas/boards/${apiBoard.id}/ai/generate`, {
    method: 'POST', cookie, body: { task: 'synthesize', inputNodeIds: [] }
  });
  assert.equal(badAiRes.statusCode, 400);

  const eventTypes = store.db.prepare('SELECT event_type FROM provenance_events ORDER BY created_at').all()
    .map(row => row.event_type);
  assert.ok(eventTypes.includes('workspace.created'));
  assert.ok(eventTypes.includes('node.created'));
  assert.ok(eventTypes.includes('board.layout_updated'));
  assert.ok(eventTypes.includes('board.imported'));
  assert.ok(eventTypes.includes('ai.translated'));
  assert.ok(eventTypes.includes('ai.synthesized'));

  destroySession(session.id);
  console.log('✅ Canvas persistence, ownership, sources, CRUD, provenance, export/import, C5 AI synthesis, limits, and atomic conflicts passed');
} finally {
  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('🎉 AltCanvas Canvas tests passed');
