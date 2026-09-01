import assert from 'assert/strict';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CanvasConflictError, CanvasNotFoundError, CanvasStore, canvasActorKey } from '../server/canvas-store.mjs';
import { createCanvasHandler } from '../server/canvas-api.mjs';
import { createSession, getSessionIdFromRequest } from '../server/session.mjs';
import { getAuthMode, isLocalAuthAllowed, handleLocalSetup, handleLocalLogin, handleSession, handleLogout } from '../server/auth.mjs';

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

  write(chunk) {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
    this.emit('finish');
  }

  get buffer() {
    return Buffer.concat(this.chunks);
  }

  get text() {
    return this.buffer.toString('utf8');
  }

  get payload() {
    return this.text ? JSON.parse(this.text) : null;
  }
}

function request({ method = 'GET', cookie, headers = {}, body, streamChunks } = {}) {
  let chunks = [];
  if (streamChunks) {
    chunks = streamChunks;
  } else if (Buffer.isBuffer(body)) {
    chunks = [body];
  } else if (typeof body === 'string') {
    chunks = [Buffer.from(body)];
  } else if (body !== undefined && body !== null) {
    chunks = [Buffer.from(JSON.stringify(body))];
  }

  return {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    socket: { encrypted: false, remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    }
  };
}

async function call(handler, pathname, options = {}) {
  const response = new MockResponse();
  const finishedPromise = new Promise(resolve => response.once('finish', resolve));
  await handler(request(options), response, new URL(pathname, 'http://127.0.0.1:8088'));
  await Promise.race([
    finishedPromise,
    new Promise(resolve => setTimeout(resolve, 100))
  ]);
  return response;
}

console.log('🧪 Running AltCanvas Native M1 Minimal Loop Tests...');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-native-m1-test-'));
const dbPath = path.join(tempDir, 'native-canvas.sqlite');

try {
  // 1. Verify default Auth Mode without Altero env is 'local'
  const originalAlteroApi = process.env.ALTERO_API;
  const originalAuthMode = process.env.AUTH_MODE;
  const originalAllowLocalInAltero = process.env.ALLOW_LOCAL_AUTH_IN_ALTERO;

  delete process.env.ALTERO_API;
  delete process.env.AUTH_MODE;
  delete process.env.ALLOW_LOCAL_AUTH_IN_ALTERO;
  assert.equal(getAuthMode(), 'local', 'Default auth mode must be local when no Altero config is present');
  assert.equal(isLocalAuthAllowed(), true);

  const store = new CanvasStore(dbPath);
  const handler = createCanvasHandler(store);

  // [P0 Regression] Test AUTH_MODE=altero blocking local setup and login
  process.env.AUTH_MODE = 'altero';
  assert.equal(getAuthMode(), 'altero');
  assert.equal(isLocalAuthAllowed(), false);

  const blockedSetupRes = await call((req, res) => handleLocalSetup(req, res, store), '/auth/setup', {
    method: 'POST',
    body: { username: 'admin', password: 'SecurePassword123!' }
  });
  assert.equal(blockedSetupRes.statusCode, 403, 'Altero mode must reject /auth/setup with 403');
  assert.equal(blockedSetupRes.payload.error, 'local_auth_disabled');

  const blockedLoginRes = await call((req, res) => handleLocalLogin(req, res, store), '/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'SecurePassword123!' }
  });
  assert.equal(blockedLoginRes.statusCode, 403, 'Altero mode must reject POST /auth/login with 403');
  assert.equal(blockedLoginRes.payload.error, 'local_auth_disabled');

  // Reset to local mode for M1 testing
  delete process.env.AUTH_MODE;

  // 2. Authentication & Admin Setup in local mode
  assert.equal(store.hasUsers(), false, 'Fresh database must have no users');
  const sessionStatusPre = await call((req, res) => handleSession(req, res, store), '/auth/session');
  assert.equal(sessionStatusPre.statusCode, 200);
  assert.equal(sessionStatusPre.payload.authenticated, false);
  assert.equal(sessionStatusPre.payload.needsSetup, true);

  // Attempt setup with weak password (rejected)
  const weakSetupRes = await call((req, res) => handleLocalSetup(req, res, store), '/auth/setup', {
    method: 'POST',
    body: { username: 'admin', password: '123' }
  });
  assert.equal(weakSetupRes.statusCode, 400);
  assert.match(weakSetupRes.payload.message, /8/);

  // Valid setup
  const setupRes = await call((req, res) => handleLocalSetup(req, res, store), '/auth/setup', {
    method: 'POST',
    body: { username: 'AdminUser', password: 'SecurePassword123!' }
  });
  assert.equal(setupRes.statusCode, 201);
  assert.equal(setupRes.payload.data.user.username, 'adminuser');
  assert.equal(setupRes.payload.data.user.role, 'admin');

  // Second setup attempt must be blocked
  const secondSetupRes = await call((req, res) => handleLocalSetup(req, res, store), '/auth/setup', {
    method: 'POST',
    body: { username: 'attacker', password: 'Password123!' }
  });
  assert.equal(secondSetupRes.statusCode, 400);
  assert.equal(secondSetupRes.payload.error, 'already_initialized');

  // Verify session cookie was set
  const setCookieHeader = setupRes.getHeader('set-cookie');
  assert.ok(setCookieHeader, 'Session cookie must be set upon setup');
  const sessionCookieMatch = /altcanvas_session=([^;]+)/.exec(setCookieHeader);
  assert.ok(sessionCookieMatch);
  const adminCookie = `altcanvas_session=${sessionCookieMatch[1]}`;

  // Session check after login
  const sessionStatusPost = await call((req, res) => handleSession(req, res, store), '/auth/session', {
    cookie: adminCookie
  });
  assert.equal(sessionStatusPost.statusCode, 200);
  assert.equal(sessionStatusPost.payload.authenticated, true);
  assert.equal(sessionStatusPost.payload.user.username, 'adminuser');
  assert.equal(sessionStatusPost.payload.needsSetup, false);

  // Logout
  const logoutRes = await call((req, res) => handleLogout(req, res), '/auth/logout', {
    method: 'POST',
    cookie: adminCookie
  });
  assert.equal(logoutRes.statusCode, 200);

  // Session after logout must be unauthenticated
  const sessionAfterLogout = await call((req, res) => handleSession(req, res, store), '/auth/session', {
    cookie: adminCookie
  });
  assert.equal(sessionAfterLogout.payload.authenticated, false);

  // Login again
  const badLoginRes = await call((req, res) => handleLocalLogin(req, res, store), '/auth/login', {
    method: 'POST',
    body: { username: 'adminuser', password: 'WrongPassword' }
  });
  assert.equal(badLoginRes.statusCode, 401);

  const goodLoginRes = await call((req, res) => handleLocalLogin(req, res, store), '/auth/login', {
    method: 'POST',
    body: { username: 'adminuser', password: 'SecurePassword123!' }
  });
  assert.equal(goodLoginRes.statusCode, 200);
  const newCookie = `altcanvas_session=${/altcanvas_session=([^;]+)/.exec(goodLoginRes.getHeader('set-cookie'))[1]}`;

  // 3. User B (for cross-user isolation tests)
  const userB = store.createUser({ username: 'researcher_b', password: 'Password456!' });
  const userBSession = createSession({
    userId: userB.id,
    subject: userB.id,
    username: userB.username,
    role: userB.role,
    authMode: 'local',
    issuer: 'local',
    actorKey: canvasActorKey('local', userB.id)
  });
  const userBCookie = `altcanvas_session=${userBSession.id}`;

  // 4. Native PDF Upload
  const samplePdfContent = Buffer.from(
    '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n' +
    '4 0 obj\n<< /Length 55 >>\nstream\nBT /F1 12 Tf 72 712 Td (AltCanvas Native M1 Architecture) Tj ET\nendstream\nendobj\n' +
    'xref\n0 5\n0000000000 65535 f \n0000000010 00000 n \n0000000060 00000 n \n0000000117 00000 n \n0000000207 00000 n \n' +
    'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n314\n%%EOF'
  );
  const expectedSha256 = crypto.createHash('sha256').update(samplePdfContent).digest('hex');

  // Test rejecting non-PDF
  const nonPdfRes = await call(handler, '/canvas/native/upload', {
    method: 'POST',
    cookie: newCookie,
    headers: { 'content-type': 'application/pdf', 'x-filename': 'fake.pdf' },
    body: Buffer.from('NOT A PDF FILE AT ALL')
  });
  assert.equal(nonPdfRes.statusCode, 400);
  assert.match(nonPdfRes.payload.error.message, /PDF/);

  // Test successful PDF upload via raw stream
  const uploadRes = await call(handler, '/canvas/native/upload', {
    method: 'POST',
    cookie: newCookie,
    headers: { 'content-type': 'application/pdf', 'x-filename': 'robotics_deep_dive_2026.pdf' },
    body: samplePdfContent
  });
  assert.equal(uploadRes.statusCode, 201);
  assert.ok(uploadRes.payload.data.document);
  assert.equal(uploadRes.payload.data.document.title, 'robotics_deep_dive_2026');
  assert.ok(uploadRes.payload.data.attachment);
  assert.equal(uploadRes.payload.data.attachment.blobHash, expectedSha256);
  assert.equal(uploadRes.payload.data.blob.sha256, expectedSha256);
  assert.equal(uploadRes.payload.data.blob.referenceCount, 1, 'Initial upload must set reference_count = 1');

  const uploadedDoc = uploadRes.payload.data.document;
  const uploadedAtt = uploadRes.payload.data.attachment;

  // Verify blob file exists on disk with 0600 permissions
  const blobPath = store.resolveBlobPath(expectedSha256, '.pdf');
  assert.ok(fs.existsSync(blobPath), 'Blob file must exist on disk in designated sha256 directory');
  assert.equal(fs.statSync(blobPath).mode & 0o777, 0o600, 'Blob file must have 0600 permissions');
  assert.equal(fs.readFileSync(blobPath).equals(samplePdfContent), true, 'Blob file content must match byte-for-byte');

  // [P1 Regression] Verify content deduplication on identical PDF upload does NOT increment reference count
  const secondUploadRes = await call(handler, '/canvas/native/upload', {
    method: 'POST',
    cookie: newCookie,
    headers: { 'content-type': 'application/pdf', 'x-filename': 'another_name_same_content.pdf' },
    body: samplePdfContent
  });
  assert.equal(secondUploadRes.statusCode, 200);
  assert.equal(secondUploadRes.payload.duplicate, true);
  assert.equal(secondUploadRes.payload.data.document.id, uploadedDoc.id);

  // Verify blob reference count was NOT falsely incremented
  const blobRowAfterDup = store.getBlob(expectedSha256);
  assert.equal(blobRowAfterDup.referenceCount, 1, 'Duplicate upload for same user must not falsely increase blob reference count');

  // 5. Native Document Retrieval, Query & [P1 Regression] Creator Updates
  const docGetRes = await call(handler, `/canvas/native/documents/${uploadedDoc.id}`, { cookie: newCookie });
  assert.equal(docGetRes.statusCode, 200);
  assert.equal(docGetRes.payload.data.id, uploadedDoc.id);
  assert.equal(docGetRes.payload.data.attachments.length, 1);

  // [P1 Regression] Test Document Update with Creators (must not throw docId ReferenceError)
  const patchDocRes = await call(handler, `/canvas/native/documents/${uploadedDoc.id}`, {
    method: 'PATCH',
    cookie: newCookie,
    headers: { 'if-match': `W/"${uploadedDoc.version}"` },
    body: {
      title: 'Robotics Deep Dive (Updated)',
      creators: [
        { creatorType: 'author', firstName: 'Alice', lastName: 'Zhang', name: 'Alice Zhang' },
        { creatorType: 'author', firstName: 'Bob', lastName: 'Li', name: 'Bob Li' }
      ]
    }
  });
  assert.equal(patchDocRes.statusCode, 200);
  assert.equal(patchDocRes.payload.data.title, 'Robotics Deep Dive (Updated)');
  assert.equal(patchDocRes.payload.data.creators.length, 2);
  assert.equal(patchDocRes.payload.data.creators[0].firstName, 'Alice');
  assert.equal(patchDocRes.payload.data.creators[1].firstName, 'Bob');

  const docListRes = await call(handler, '/canvas/native/documents', { cookie: newCookie });
  assert.equal(docListRes.statusCode, 200);
  assert.ok(docListRes.payload.data.some(d => d.id === uploadedDoc.id));

  // 6. Native HTTP Range File Streaming
  // 6.1 Full GET (200 OK)
  const fullGetRes = await call(handler, `/canvas/native/attachments/${uploadedAtt.id}/file`, { cookie: newCookie });
  assert.equal(fullGetRes.statusCode, 200);
  assert.equal(fullGetRes.getHeader('content-type'), 'application/pdf');
  assert.equal(fullGetRes.getHeader('accept-ranges'), 'bytes');
  assert.equal(fullGetRes.getHeader('content-length'), samplePdfContent.length);
  assert.equal(fullGetRes.getHeader('etag'), `W/"${expectedSha256}"`);
  assert.equal(fullGetRes.buffer.equals(samplePdfContent), true);

  // 6.2 HEAD Request (200 OK without body)
  const headRes = await call(handler, `/canvas/native/attachments/${uploadedAtt.id}/file`, {
    method: 'HEAD',
    cookie: newCookie
  });
  assert.equal(headRes.statusCode, 200);
  assert.equal(headRes.getHeader('content-length'), samplePdfContent.length);
  assert.equal(headRes.chunks.length, 0);

  // 6.3 If-None-Match (304 Not Modified)
  const ifNoneMatchRes = await call(handler, `/canvas/native/attachments/${uploadedAtt.id}/file`, {
    cookie: newCookie,
    headers: { 'if-none-match': `W/"${expectedSha256}"` }
  });
  assert.equal(ifNoneMatchRes.statusCode, 304);

  // 6.4 Range bytes=0-100 (206 Partial Content)
  const range1Res = await call(handler, `/canvas/native/attachments/${uploadedAtt.id}/file`, {
    cookie: newCookie,
    headers: { 'range': 'bytes=0-100' }
  });
  assert.equal(range1Res.statusCode, 206);
  assert.equal(range1Res.getHeader('content-range'), `bytes 0-100/${samplePdfContent.length}`);
  assert.equal(range1Res.getHeader('content-length'), 101);
  assert.equal(range1Res.buffer.equals(samplePdfContent.subarray(0, 101)), true);

  // 6.5 Range bytes=100- (206 Partial Content from 100 to end)
  const range2Res = await call(handler, `/canvas/native/attachments/${uploadedAtt.id}/file`, {
    cookie: newCookie,
    headers: { 'range': 'bytes=100-' }
  });
  assert.equal(range2Res.statusCode, 206);
  assert.equal(range2Res.getHeader('content-range'), `bytes 100-${samplePdfContent.length - 1}/${samplePdfContent.length}`);
  assert.equal(range2Res.getHeader('content-length'), samplePdfContent.length - 100);
  assert.equal(range2Res.buffer.equals(samplePdfContent.subarray(100)), true);

  // 6.6 Suffix Range bytes=-50 (206 Partial Content last 50 bytes)
  const range3Res = await call(handler, `/canvas/native/attachments/${uploadedAtt.id}/file`, {
    cookie: newCookie,
    headers: { 'range': 'bytes=-50' }
  });
  assert.equal(range3Res.statusCode, 206);
  assert.equal(range3Res.getHeader('content-range'), `bytes ${samplePdfContent.length - 50}-${samplePdfContent.length - 1}/${samplePdfContent.length}`);
  assert.equal(range3Res.getHeader('content-length'), 50);
  assert.equal(range3Res.buffer.equals(samplePdfContent.subarray(samplePdfContent.length - 50)), true);

  // 6.7 Invalid Range bytes=999999- (416 Range Not Satisfiable)
  const invalidRangeRes = await call(handler, `/canvas/native/attachments/${uploadedAtt.id}/file`, {
    cookie: newCookie,
    headers: { 'range': 'bytes=999999-' }
  });
  assert.equal(invalidRangeRes.statusCode, 416);
  assert.equal(invalidRangeRes.getHeader('content-range'), `bytes */${samplePdfContent.length}`);

  // 7. Cross-User Isolation (User B cannot access User A's data)
  const userBDocRes = await call(handler, `/canvas/native/documents/${uploadedDoc.id}`, { cookie: userBCookie });
  assert.equal(userBDocRes.statusCode, 404, 'User B must not see User A document');

  const userBFileRes = await call(handler, `/canvas/native/attachments/${uploadedAtt.id}/file`, { cookie: userBCookie });
  assert.equal(userBFileRes.statusCode, 404, 'User B must not download User A attachment');

  // 8. Native Annotations Lifecycle & Optimistic Concurrency
  // 8.1 Create Annotation
  const createAnnRes = await call(handler, `/canvas/native/attachments/${uploadedAtt.id}/annotations`, {
    method: 'POST',
    cookie: newCookie,
    body: {
      annotationType: 'highlight',
      pageLabel: '1',
      position: { pageIndex: 0, rects: [[72, 712, 200, 724]] },
      quote: 'AltCanvas Native M1 Architecture',
      comment: 'Core design breakthrough',
      color: '#ffd400',
      sortIndex: 0
    }
  });
  assert.equal(createAnnRes.statusCode, 201);
  assert.equal(createAnnRes.payload.data.quote, 'AltCanvas Native M1 Architecture');
  assert.equal(createAnnRes.payload.data.version, 1);
  const annId = createAnnRes.payload.data.id;

  // User B cannot list or access User A's annotation
  const userBAnnList = await call(handler, `/canvas/native/attachments/${uploadedAtt.id}/annotations`, { cookie: userBCookie });
  assert.equal(userBAnnList.statusCode, 404);

  // 8.2 List Annotations
  const listAnnRes = await call(handler, `/canvas/native/attachments/${uploadedAtt.id}/annotations`, { cookie: newCookie });
  assert.equal(listAnnRes.statusCode, 200);
  assert.equal(listAnnRes.payload.data.length, 1);
  assert.equal(listAnnRes.payload.data[0].id, annId);

  // 8.3 Update Annotation - Missing If-Match (428)
  const missingIfMatchRes = await call(handler, `/canvas/native/annotations/${annId}`, {
    method: 'PATCH',
    cookie: newCookie,
    body: { comment: 'Updated Comment' }
  });
  assert.equal(missingIfMatchRes.statusCode, 428);

  // 8.4 Update Annotation - Stale If-Match (412)
  const staleIfMatchRes = await call(handler, `/canvas/native/annotations/${annId}`, {
    method: 'PATCH',
    cookie: newCookie,
    headers: { 'if-match': 'W/"99"' },
    body: { comment: 'Updated Comment' }
  });
  assert.equal(staleIfMatchRes.statusCode, 412);

  // 8.5 Update Annotation - Valid If-Match (200 OK)
  const updateAnnRes = await call(handler, `/canvas/native/annotations/${annId}`, {
    method: 'PATCH',
    cookie: newCookie,
    headers: { 'if-match': 'W/"1"' },
    body: { comment: 'Updated and Verified Note', color: '#ff6b6b' }
  });
  assert.equal(updateAnnRes.statusCode, 200);
  assert.equal(updateAnnRes.payload.data.comment, 'Updated and Verified Note');
  assert.equal(updateAnnRes.payload.data.color, '#ff6b6b');
  assert.equal(updateAnnRes.payload.data.version, 2);

  // 8.6 Delete Annotation (204)
  const deleteAnnRes = await call(handler, `/canvas/native/annotations/${annId}`, {
    method: 'DELETE',
    cookie: newCookie,
    headers: { 'if-match': 'W/"2"' }
  });
  assert.equal(deleteAnnRes.statusCode, 204);

  const listAfterDelete = await call(handler, `/canvas/native/attachments/${uploadedAtt.id}/annotations`, { cookie: newCookie });
  assert.equal(listAfterDelete.payload.data.length, 0);

  // 8.7 [P2 Regression] Restore Annotation (Must enforce If-Match: 428 on missing, 412 on stale)
  const restoreMissingIfMatch = await call(handler, `/canvas/native/annotations/${annId}/restore`, {
    method: 'POST',
    cookie: newCookie
  });
  assert.equal(restoreMissingIfMatch.statusCode, 428, 'Restore must reject missing If-Match with 428');

  const restoreStaleIfMatch = await call(handler, `/canvas/native/annotations/${annId}/restore`, {
    method: 'POST',
    cookie: newCookie,
    headers: { 'if-match': 'W/"99"' }
  });
  assert.equal(restoreStaleIfMatch.statusCode, 412, 'Restore must reject stale If-Match with 412');

  const restoreAnnRes = await call(handler, `/canvas/native/annotations/${annId}/restore`, {
    method: 'POST',
    cookie: newCookie,
    headers: { 'if-match': 'W/"3"' }
  });
  assert.equal(restoreAnnRes.statusCode, 200);
  assert.equal(restoreAnnRes.payload.data.version, 4);

  const listAfterRestore = await call(handler, `/canvas/native/attachments/${uploadedAtt.id}/annotations`, { cookie: newCookie });
  assert.equal(listAfterRestore.payload.data.length, 1);

  // 9. Document Map with Native Document Source
  const adminActorKey = canvasActorKey('local', setupRes.payload.data.user.id);
  const testWorkspace = store.createWorkspace(adminActorKey, { name: 'Native Research Workspace' });
  const testBoard = store.createBoard(adminActorKey, testWorkspace.id, { name: 'Analysis Board' });

  const mockAiCompletion = async ({ messages }) => {
    const isSynthesis = messages.some(m => typeof m.content === 'string' && m.content.includes('逐段阅读笔记组织成'));
    if (isSynthesis) {
      return JSON.stringify({
        title: 'Native Robotics Synthesis',
        overview: 'Complete overview of native robotics.',
        evidenceQuote: 'AltCanvas Native M1 Architecture',
        evidencePage: 1,
        sections: [{ title: 'Core Mechanics', body: 'Section details', pageStart: 1, pageEnd: 1, evidenceQuote: 'AltCanvas Native M1 Architecture', evidencePage: 1 }],
        concepts: [{ title: 'Native PDF', body: 'Local storage', pageStart: 1, pageEnd: 1, evidenceQuote: 'AltCanvas Native M1 Architecture', evidencePage: 1 }],
        claims: [{ title: 'Zero Dependency', body: 'Altero-free execution', pageStart: 1, pageEnd: 1, evidenceQuote: 'AltCanvas Native M1 Architecture', evidencePage: 1 }],
        relations: []
      });
    }
    return 'Summary chunk: AltCanvas Native M1 Architecture. Full text content extracted from native reader.';
  };

  const aiHandler = createCanvasHandler(store, {
    aiCompletion: mockAiCompletion,
    aiPublicConfig: () => ({ configured: true, model: 'test-model' }),
    aiEndpointValidator: async (url) => url
  });

  const docMapRes = await call(aiHandler, `/canvas/boards/${testBoard.id}/ai/document-map`, {
    method: 'POST',
    cookie: newCookie,
    body: {
      title: 'Native Document Analysis',
      document: {
        libraryType: 'native',
        libraryId: 'local',
        itemKey: uploadedDoc.id,
        attachmentKey: uploadedAtt.id,
        pageCount: 1
      },
      pages: [{ pageNumber: 1, text: 'AltCanvas Native M1 Architecture. Full text content extracted from native reader.' }]
    }
  });
  assert.equal(docMapRes.statusCode, 201);
  assert.ok(docMapRes.payload.data.nodes.length >= 4);

  // 10. Persistence across Store & Process Restart & [P1 Regression] Blob Reference Count on Delete
  store.close();
  const reopenedStore = new CanvasStore(dbPath);
  const reopenedDoc = reopenedStore.getDocument(adminActorKey, uploadedDoc.id);
  assert.ok(reopenedDoc, 'Document must persist across database re-instantiation');
  assert.equal(reopenedDoc.title, 'Robotics Deep Dive (Updated)');
  assert.equal(reopenedDoc.attachments.length, 1);
  assert.equal(reopenedDoc.creators.length, 2);

  const reopenedBlob = reopenedStore.getBlob(expectedSha256);
  assert.ok(reopenedBlob, 'Blob metadata must persist');
  assert.equal(reopenedBlob.referenceCount, 1);

  const reopenedAnns = reopenedStore.listAnnotations(adminActorKey, uploadedAtt.id);
  assert.equal(reopenedAnns.length, 1);
  assert.equal(reopenedAnns[0].comment, 'Updated and Verified Note');

  // [P1 Regression] Verify deleting Document decrements reference_count to 0
  reopenedStore.deleteDocument(adminActorKey, uploadedDoc.id, reopenedDoc.version);
  const blobAfterDelete = reopenedStore.getBlob(expectedSha256);
  assert.equal(blobAfterDelete.referenceCount, 0, 'Deleting document and its attachment must decrement blob reference count to 0');

  reopenedStore.close();

  if (originalAlteroApi) process.env.ALTERO_API = originalAlteroApi;
  if (originalAuthMode) process.env.AUTH_MODE = originalAuthMode;
  if (originalAllowLocalInAltero) process.env.ALLOW_LOCAL_AUTH_IN_ALTERO = originalAllowLocalInAltero;

  console.log('✅ All Native M1 Minimal Loop & Audit Regression Tests Passed Successfully!');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
