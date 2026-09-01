import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// In-memory Session & Transaction Stores with auto-cleanup
const sessions = new Map(); // sessionHash -> session object
const authTransactions = new Map(); // stateHash -> transaction object

const SESSION_COOKIE_NAME = 'altcanvas_session';
const HOST_SESSION_COOKIE_NAME = '__Host-altcanvas_session';
const SESSION_IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours idle
const SESSION_ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days max
const TRANSACTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for OAuth transactions
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null;
const SESSION_FILE = DATA_DIR ? path.join(DATA_DIR, 'sessions.enc.json') : null;
const SESSION_SECRET = process.env.SESSION_SECRET || '';
let persistTimer = null;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encryptionKey() {
  return crypto.createHash('sha256').update(SESSION_SECRET).digest();
}

function encryptStore(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64')
  });
}

function decryptStore(serialized) {
  const payload = JSON.parse(serialized);
  if (payload.version !== 1) throw new Error('unsupported session store version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

function persistNow() {
  if (!SESSION_FILE || !SESSION_SECRET) return;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporaryFile = `${SESSION_FILE}.${process.pid}.tmp`;
  const payload = encryptStore({
    sessions: [...sessions.entries()],
    authTransactions: [...authTransactions.entries()]
  });
  fs.writeFileSync(temporaryFile, payload, { mode: 0o600 });
  fs.renameSync(temporaryFile, SESSION_FILE);
}

function schedulePersist() {
  if (!SESSION_FILE || !SESSION_SECRET || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      persistNow();
    } catch (err) {
      console.error('Session store persistence failed:', err.message);
    }
  }, 50);
  persistTimer.unref();
}

function loadPersistedStore() {
  if (!SESSION_FILE || !SESSION_SECRET || !fs.existsSync(SESSION_FILE)) return;
  try {
    const payload = decryptStore(fs.readFileSync(SESSION_FILE, 'utf8'));
    for (const [key, value] of payload.sessions || []) sessions.set(key, value);
    for (const [key, value] of payload.authTransactions || []) authTransactions.set(key, value);
  } catch (err) {
    console.error('Encrypted session store could not be loaded:', err.message);
  }
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
      try {
        list[name] = decodeURIComponent(val);
      } catch {
        // Ignore malformed cookie values rather than failing the whole request.
      }
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

function appendSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  const cookies = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  res.setHeader('Set-Cookie', [...cookies, value]);
}

/**
 * Set Session Cookie on response
 */
export function setSessionCookie(res, sessionId, req) {
  const trustProxy = process.env.TRUST_PROXY === 'true';
  const publicOriginIsSecure = process.env.PUBLIC_ORIGIN?.startsWith('https://');
  const isSecure = publicOriginIsSecure || req.socket?.encrypted
    || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
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

  appendSetCookie(res, cookieParts.join('; '));
}

/**
 * Clear Session Cookie on response
 */
export function clearSessionCookie(res, req) {
  const trustProxy = process.env.TRUST_PROXY === 'true';
  const publicOriginIsSecure = process.env.PUBLIC_ORIGIN?.startsWith('https://');
  const isSecure = publicOriginIsSecure || req.socket?.encrypted
    || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
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

  appendSetCookie(res, cookieParts.join('; '));
}

/**
 * Create a new user session
 */
export function createSession({ userId, subject, username, displayName, role, authMode, actorKey, accessToken, refreshToken, expiresAt, scopes = [], alteroApi, issuer, groupIds = [] }) {
  const sessionId = generateRandomToken(32);
  const sessionHash = hash(sessionId);
  const now = Date.now();

  const session = {
    userId: String(userId),
    subject: subject || null,
    username: username || String(userId),
    displayName: displayName || username || `User ${userId}`,
    role: role || 'admin',
    authMode: authMode || 'altero',
    actorKey: actorKey || null,
    accessToken,
    refreshToken,
    tokenExpiresAt: expiresAt || now + 3600 * 1000,
    scopes: Array.isArray(scopes) ? scopes : (typeof scopes === 'string' ? scopes.split(' ') : []),
    groupIds: Array.isArray(groupIds) ? groupIds.map(String) : [],
    alteroApi: (alteroApi || process.env.ALTERO_API || 'http://localhost:8000').replace(/\/$/, ''),
    issuer: issuer || null,
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt: now + SESSION_IDLE_TIMEOUT_MS,
    absoluteExpiresAt: now + SESSION_ABSOLUTE_TIMEOUT_MS
  };

  sessions.set(sessionHash, session);
  schedulePersist();
  return { ...session, id: sessionId };
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
    schedulePersist();
    return null;
  }

  session.lastSeenAt = now;
  session.idleExpiresAt = now + SESSION_IDLE_TIMEOUT_MS;
  schedulePersist();
  return session;
}

/**
 * Update active session data (e.g. refreshed tokens)
 */
export function updateSession(sessionId, updates) {
  const session = getSession(sessionId);
  if (!session) return null;

  Object.assign(session, updates, { lastSeenAt: Date.now() });
  schedulePersist();
  return session;
}

/**
 * Destroy active session
 */
export function destroySession(sessionId) {
  if (!sessionId) return false;
  const sessionHash = hash(sessionId);
  const deleted = sessions.delete(sessionHash);
  if (deleted) schedulePersist();
  return deleted;
}

/**
 * Store an in-flight OAuth transaction
 */
export function storeAuthTransaction({ state, nonce, codeVerifier, returnTo = '/', alteroApi, issuer, bindingHash }) {
  const stateHash = hash(state);
  const now = Date.now();

  authTransactions.set(stateHash, {
    nonce,
    codeVerifier,
    returnTo,
    alteroApi,
    issuer,
    bindingHash,
    expiresAt: now + TRANSACTION_TIMEOUT_MS
  });
  schedulePersist();
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
  schedulePersist();
  if (Date.now() > tx.expiresAt) return null;
  return tx;
}

// Periodic cleanup of expired sessions and transactions every 5 minutes
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [key, session] of sessions.entries()) {
    if (now > session.idleExpiresAt || now > session.absoluteExpiresAt) {
      sessions.delete(key);
      changed = true;
    }
  }
  for (const [key, tx] of authTransactions.entries()) {
    if (now > tx.expiresAt) {
      authTransactions.delete(key);
      changed = true;
    }
  }
  if (changed) schedulePersist();
}, 5 * 60 * 1000).unref();

loadPersistedStore();
