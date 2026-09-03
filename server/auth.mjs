import {
  createSession,
  getSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  getSessionIdFromRequest
} from './session.mjs';
import { canvasActorKey } from './canvas-store.mjs';

// AltCanvas authenticates exclusively against its own local accounts
// (M4 decision). The Altero/Zotero OAuth flow, AUTH_MODE=altero and the
// upstream proxies were removed; the archived implementation lives on the
// archive/last-altero-compatible tag.

export function formatFetchError(err) {
  if (!err) return '未知错误';
  if (err.cause) {
    const cause = err.cause;
    if (cause instanceof Error) {
      return `${err.message} (${cause.message || cause.code || '网络/SSL连接异常'})`;
    }
    if (typeof cause === 'object') {
      if (Array.isArray(cause.errors) && cause.errors.length > 0) {
        const errDetails = cause.errors.map(e => e.message || e.code || String(e)).join('; ');
        return `${err.message} (${errDetails})`;
      }
      if (cause.code || cause.message) {
        return `${err.message} (${cause.code || cause.message})`;
      }
      try {
        return `${err.message} (${JSON.stringify(cause)})`;
      } catch {
        return `${err.message} (${String(cause)})`;
      }
    }
    return `${err.message} (${String(cause)})`;
  }
  return err.message || String(err);
}

// Kept for compatibility with callers that branch on the auth mode; AltCanvas
// is always local now.
export function getAuthMode() {
  return 'local';
}

// Always true since M4: local accounts are the only authentication method.
export function isLocalAuthAllowed() {
  return true;
}

async function readRequestBody(req, maxBytes = 65536) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      const err = new Error('Request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('Invalid JSON body');
    err.status = 400;
    throw err;
  }
}

/**
 * Handle POST /auth/setup (Local Admin Initialization)
 */
export async function handleLocalSetup(req, res, store) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (!store) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'store_unavailable', message: 'Storage not available' }));
    return;
  }

  if (store.hasUsers()) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'already_initialized', message: '系统已初始化，管理员账户已存在' }));
    return;
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    res.writeHead(err.status || 400);
    res.end(JSON.stringify({ error: 'invalid_request', message: err.message }));
    return;
  }

  const { username, password } = body || {};
  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'invalid_username', message: '用户名至少需要 3 个字符' }));
    return;
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'invalid_password', message: '密码至少需要 8 个字符' }));
    return;
  }

  let user;
  try {
    user = store.createUser({ username, password, role: 'admin' });
  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'creation_failed', message: err.message }));
    return;
  }

  const session = createSession({
    userId: user.id,
    subject: user.id,
    username: user.username,
    displayName: user.username,
    role: user.role,
    authMode: 'local',
    scopes: ['*'],
    expiresAt: Date.now() + 30 * 86400 * 1000,
    issuer: 'local',
    actorKey: canvasActorKey('local', user.id)
  });

  setSessionCookie(res, session.id, req);
  res.writeHead(201);
  res.end(JSON.stringify({
    data: {
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    }
  }));
}

/**
 * Handle POST /auth/login (Local Password Authentication)
 */
export async function handleLocalLogin(req, res, store) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (!store) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'store_unavailable', message: 'Storage not available' }));
    return;
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    res.writeHead(err.status || 400);
    res.end(JSON.stringify({ error: 'invalid_request', message: err.message }));
    return;
  }

  const { username, password } = body || {};
  if (!username || !password) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'missing_credentials', message: '请输入用户名和密码' }));
    return;
  }

  const user = store.verifyUserPassword(username, password);
  if (!user) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'invalid_credentials', message: '用户名或密码错误' }));
    return;
  }

  const session = createSession({
    userId: user.id,
    subject: user.id,
    username: user.username,
    displayName: user.username,
    role: user.role,
    authMode: 'local',
    scopes: ['*'],
    expiresAt: Date.now() + 30 * 86400 * 1000,
    issuer: 'local',
    actorKey: canvasActorKey('local', user.id)
  });

  setSessionCookie(res, session.id, req);
  res.writeHead(200);
  res.end(JSON.stringify({
    data: {
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    }
  }));
}

/**
 * Handle GET /auth/session
 */
export async function handleSession(req, res, store = null) {
  const sessionId = getSessionIdFromRequest(req);
  const session = getSession(sessionId);
  const needsSetup = store ? !store.hasUsers() : false;

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (!session) {
    res.writeHead(200);
    res.end(JSON.stringify({
      authenticated: false,
      authMode: 'local',
      needsSetup
    }));
    return;
  }

  const capabilities = {
    nativeUpload: true
  };

  res.writeHead(200);
  res.end(JSON.stringify({
    authenticated: true,
    authMode: 'local',
    capabilities,
    user: {
      id: session.userId,
      username: session.username,
      displayName: session.displayName || session.username,
      role: session.role || 'user'
    },
    library: {
      id: session.userId,
      type: 'native'
    },
    scopes: session.scopes || ['*'],
    needsSetup: false
  }));
}

/**
 * Handle POST /auth/logout
 */
export async function handleLogout(req, res) {
  const sessionId = getSessionIdFromRequest(req);
  if (sessionId) {
    destroySession(sessionId);
  }
  clearSessionCookie(res, req);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(200);
  res.end(JSON.stringify({ success: true }));
}
