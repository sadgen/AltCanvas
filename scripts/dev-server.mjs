import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function contentHash(value) {
  return `'sha256-${crypto.createHash('sha256').update(value).digest('base64')}'`;
}

function buildIndexContentSecurityPolicy() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => contentHash(match[1]));
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map(match => contentHash(match[1]));
  return [
    "default-src 'self'",
    `script-src 'self' ${scripts.join(' ')}`,
    "style-src 'self'",
    `style-src-elem 'self' ${styles.join(' ')}`,
    // Canvas coordinates, sizes, colors, and viewport transforms are dynamic.
    // Script execution remains hash-restricted; only style attributes need inline values.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
}

const indexContentSecurityPolicy = buildIndexContentSecurityPolicy();

// Load .env configuration before importing server modules
const envPath = path.resolve(root, '.env');
if (fs.existsSync(envPath)) {
  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    });
  } catch (err) {
    console.warn('Notice: could not load .env file:', err.message);
  }
}

if (process.env.NODE_ENV === 'production') {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET (at least 32 characters) is required in production');
  }
  if (!process.env.PUBLIC_ORIGIN) {
    throw new Error('PUBLIC_ORIGIN is required in production');
  }
  if (!process.env.PUBLIC_ORIGIN.startsWith('https://') && process.env.ALLOW_INSECURE_OAUTH !== 'true') {
    throw new Error('PUBLIC_ORIGIN must use HTTPS in production');
  }
}

const {
  devLoggingEnabled,
  handleBrowserLog,
  handleDebugConfig,
  installDevLogging,
  writeDevLog,
} = await import('../server/dev-logger.mjs');
installDevLogging();

const {
  getAuthMode,
  handleLogin,
  handleCallback,
  handleSession,
  handleLogout,
  handleLocalSetup,
  handleLocalLogin
} = await import('../server/auth.mjs');
const { handleApiProxy } = await import('../server/proxy-api.mjs');
const { handleFilesProxy } = await import('../server/proxy-files.mjs');
const { handleCanvasApi, getCanvasStore } = await import('../server/canvas-api.mjs');
const { consumeRateLimit, getRequestOrigin, isSameOriginRequest } = await import('../server/security.mjs');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
};

const routes = [
  ['/styles/', path.join(root, 'styles')],
  ['/reader/', path.join(root, 'vendor/reader/build/web')],
  ['/web-library/', path.join(root, 'vendor/web-library/build')],
  ['/static/', path.join(root, 'vendor/web-library/build/static')],
];
const rootPublicFiles = new Set(['index.html', 'test-reader.html']);

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

function resolveFile(pathname) {
  let base = root;
  let relativePath = pathname.replace(/^\/+/, '');
  let matchedRoute = false;

  for (const [prefix, routeRoot] of routes) {
    if (pathname.startsWith(prefix)) {
      base = routeRoot;
      relativePath = pathname.slice(prefix.length);
      matchedRoute = true;
      break;
    }
  }

  if (!matchedRoute && !rootPublicFiles.has(relativePath)) return null;

  const resolvedBase = path.resolve(base);
  const filePath = path.resolve(resolvedBase, relativePath);
  if (filePath !== resolvedBase && !filePath.startsWith(`${resolvedBase}${path.sep}`)) {
    return null;
  }
  return filePath;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    const requestOrigin = getRequestOrigin(req);
    url = new URL(req.url, requestOrigin);
  } catch {
    send(res, 400, '400 Bad Request');
    return;
  }

  const selfOrigin = url.origin;
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    send(res, 400, '400 Bad Request');
    return;
  }

  const isUnsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const isCookieAuthenticatedRoute = pathname === '/auth/logout' || pathname === '/debug/browser-log'
    || pathname.startsWith('/api/') || pathname.startsWith('/canvas/');
  if (isUnsafe && isCookieAuthenticatedRoute && !isSameOriginRequest(req, selfOrigin)) {
    send(res, 403, '403 Forbidden: cross-origin request rejected');
    return;
  }

  if (pathname === '/auth/login' || pathname === '/auth/setup' || pathname === '/auth/callback') {
    const rate = consumeRateLimit(req, 'auth', { limit: 30, windowMs: 60 * 1000 });
    if (!rate.allowed) {
      send(res, 429, '429 Too Many Requests', { 'Retry-After': String(rate.retryAfter) });
      return;
    }
  }
  if (pathname.startsWith('/api/') || pathname.startsWith('/files/')) {
    const rate = consumeRateLimit(req, 'proxy', { limit: 600, windowMs: 60 * 1000 });
    if (!rate.allowed) {
      send(res, 429, '429 Too Many Requests', { 'Retry-After': String(rate.retryAfter) });
      return;
    }
  }
  if (pathname.startsWith('/canvas/')) {
    const rate = consumeRateLimit(req, 'canvas', { limit: 300, windowMs: 60 * 1000 });
    if (!rate.allowed) {
      send(res, 429, '429 Too Many Requests', { 'Retry-After': String(rate.retryAfter) });
      return;
    }
  }

  if (pathname === '/debug/config' && ['GET', 'HEAD'].includes(req.method)) {
    return handleDebugConfig(req, res);
  }
  if (pathname === '/debug/browser-log' && req.method === 'POST') {
    const rate = consumeRateLimit(req, 'browser-debug', { limit: 120, windowMs: 60 * 1000 });
    if (!rate.allowed) {
      send(res, 429, '429 Too Many Requests', { 'Retry-After': String(rate.retryAfter) });
      return;
    }
    return await handleBrowserLog(req, res);
  }

  // --- BFF Router: Authentication Endpoints ---
  const currentAuthMode = getAuthMode();
  const currentCanvasStore = getCanvasStore();

  if (pathname === '/auth/setup' && req.method === 'POST') {
    return await handleLocalSetup(req, res, currentCanvasStore);
  }
  if (pathname === '/auth/login') {
    if (req.method === 'POST') {
      return await handleLocalLogin(req, res, currentCanvasStore);
    }
    if (['GET', 'HEAD'].includes(req.method)) {
      if (currentAuthMode === 'local') {
        res.writeHead(302, { 'Location': '/', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      return await handleLogin(req, res, url, selfOrigin);
    }
  }
  if (pathname === '/auth/callback' && ['GET', 'HEAD'].includes(req.method)) {
    return await handleCallback(req, res, url, selfOrigin);
  }
  if (pathname === '/auth/session' && ['GET', 'HEAD'].includes(req.method)) {
    return await handleSession(req, res, currentCanvasStore);
  }
  if (pathname === '/auth/logout' && req.method === 'POST') {
    return await handleLogout(req, res);
  }

  // --- BFF Router: API Proxy ---
  if (pathname.startsWith('/api/')) {
    return await handleApiProxy(req, res, url);
  }

  // --- BFF Router: Streaming Files Proxy ---
  if (pathname.startsWith('/files/')) {
    return await handleFilesProxy(req, res, url);
  }

  // --- AltCanvas-owned persistent workspace API ---
  if (pathname.startsWith('/canvas/')) {
    return await handleCanvasApi(req, res, url);
  }

  // --- Static Asset Server ---
  if (!['GET', 'HEAD'].includes(req.method)) {
    send(res, 405, '405 Method Not Allowed', { Allow: 'GET, HEAD' });
    return;
  }

  let filePathName = pathname;
  if (filePathName === '/' || filePathName === '/index.html') {
    filePathName = '/index.html';
  }

  const filePath = resolveFile(filePathName);
  if (!filePath) {
    send(res, 403, '403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      send(res, 404, '404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'X-Frame-Options': 'SAMEORIGIN',
      ...(filePathName === '/index.html' ? {
        'Content-Security-Policy': process.env.NODE_ENV === 'production'
          ? indexContentSecurityPolicy
          : buildIndexContentSecurityPolicy()
      } : {}),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on('clientError', (err, socket) => {
  if (devLoggingEnabled) writeDevLog('warn', 'server.clientError', err.message);
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

const PORT = process.env.PORT || 8088;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AltCanvas BFF & Web Workspace running at http://0.0.0.0:${PORT}`);
});
