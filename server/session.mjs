import crypto from 'crypto';

// In-memory Session & Transaction Stores with auto-cleanup
const sessions = new Map(); // sessionHash -> session object
const authTransactions = new Map(); // stateHash -> transaction object

const SESSION_COOKIE_NAME = 'altcanvas_session';
const HOST_SESSION_COOKIE_NAME = '__Host-altcanvas_session';
const SESSION_IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours idle
const SESSION_ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days max
const TRANSACTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for OAuth transactions

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Generate cryptographically secure random identifier
 */
export function generateRandomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Parse Cookie header from HTTP request
 */
export function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (!rc) return list;

  rc.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      list[name] = decodeURIComponent(val);
    }
  });
  return list;
}

/**
 * Extract Session ID from request cookies
 */
export function getSessionIdFromRequest(req) {
  const cookies = parseCookies(req);
  return cookies[HOST_SESSION_COOKIE_NAME] || cookies[SESSION_COOKIE_NAME] || null;
}

/**
 * Set Session Cookie on response
 */
export function setSessionCookie(res, sessionId, req) {
  const isSecure = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
  const cookieName = isSecure ? HOST_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
  
  const cookieParts = [
    `${cookieName}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_ABSOLUTE_TIMEOUT_MS / 1000)}`
  ];
  if (isSecure) {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

/**
 * Clear Session Cookie on response
 */
export function clearSessionCookie(res, req) {
  const isSecure = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
  const cookieName = isSecure ? HOST_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
  
  const cookieParts = [
    `${cookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ];
  if (isSecure) {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

/**
 * Create a new user session
 */
export function createSession({ userId, username, displayName, accessToken, refreshToken, expiresAt, scopes = [], alteroApi }) {
  const sessionId = generateRandomToken(32);
  const sessionHash = hash(sessionId);
  const now = Date.now();

  const session = {
    id: sessionId,
    sessionHash,
    userId: String(userId),
    username: username || String(userId),
    displayName: displayName || username || `User ${userId}`,
    accessToken,
    refreshToken,
    tokenExpiresAt: expiresAt || now + 3600 * 1000,
    scopes: Array.isArray(scopes) ? scopes : (typeof scopes === 'string' ? scopes.split(' ') : []),
    alteroApi: (alteroApi || process.env.ALTERO_API || 'http://localhost:8000').replace(/\/$/, ''),
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt: now + SESSION_IDLE_TIMEOUT_MS,
    absoluteExpiresAt: now + SESSION_ABSOLUTE_TIMEOUT_MS
  };

  sessions.set(sessionHash, session);
  return session;
}

/**
 * Get active session by raw session ID
 */
export function getSession(sessionId) {
  if (!sessionId) return null;
  const sessionHash = hash(sessionId);
  const session = sessions.get(sessionHash);
  if (!session) return null;

  const now = Date.now();
  if (now > session.idleExpiresAt || now > session.absoluteExpiresAt) {
    sessions.delete(sessionHash);
    return null;
  }

  session.lastSeenAt = now;
  session.idleExpiresAt = now + SESSION_IDLE_TIMEOUT_MS;
  return session;
}

/**
 * Update active session data (e.g. refreshed tokens)
 */
export function updateSession(sessionId, updates) {
  const session = getSession(sessionId);
  if (!session) return null;

  Object.assign(session, updates, { lastSeenAt: Date.now() });
  return session;
}

/**
 * Destroy active session
 */
export function destroySession(sessionId) {
  if (!sessionId) return false;
  const sessionHash = hash(sessionId);
  return sessions.delete(sessionHash);
}

/**
 * Store an in-flight OAuth transaction
 */
export function storeAuthTransaction({ state, nonce, codeVerifier, returnTo = '/' }) {
  const stateHash = hash(state);
  const now = Date.now();

  authTransactions.set(stateHash, {
    state,
    nonce,
    codeVerifier,
    returnTo,
    expiresAt: now + TRANSACTION_TIMEOUT_MS
  });
}

/**
 * Retrieve and consume an in-flight OAuth transaction
 */
export function consumeAuthTransaction(state) {
  if (!state) return null;
  const stateHash = hash(state);
  const tx = authTransactions.get(stateHash);
  if (!tx) return null;

  authTransactions.delete(stateHash);
  if (Date.now() > tx.expiresAt) return null;
  return tx;
}

// Periodic cleanup of expired sessions and transactions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions.entries()) {
    if (now > session.idleExpiresAt || now > session.absoluteExpiresAt) {
      sessions.delete(key);
    }
  }
  for (const [key, tx] of authTransactions.entries()) {
    if (now > tx.expiresAt) {
      authTransactions.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();
