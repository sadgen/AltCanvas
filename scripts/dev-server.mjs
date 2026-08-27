import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { handleLogin, handleCallback, handleSession, handleLogout } from '../server/auth.mjs';
import { handleApiProxy } from '../server/proxy-api.mjs';
import { handleFilesProxy } from '../server/proxy-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Load .env configuration if present
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

// Allow self-signed TLS certificates for self-hosted Altero instances unless explicitly configured
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

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
    const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:8088';
    url = new URL(req.url, `${proto}://${host}`);
  } catch {
    send(res, 400, '400 Bad Request');
    return;
  }

  const selfOrigin = `${url.protocol}//${url.host}`;
  const pathname = decodeURIComponent(url.pathname);

  // --- BFF Router: Authentication Endpoints ---
  if (pathname === '/auth/login' && ['GET', 'HEAD'].includes(req.method)) {
    return await handleLogin(req, res, url, selfOrigin);
  }
  if (pathname === '/auth/callback' && ['GET', 'HEAD'].includes(req.method)) {
    return await handleCallback(req, res, url, selfOrigin);
  }
  if (pathname === '/auth/session' && ['GET', 'HEAD'].includes(req.method)) {
    return await handleSession(req, res);
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
      'X-Frame-Options': 'SAMEORIGIN',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on('clientError', (_err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

const PORT = process.env.PORT || 8088;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AltCanvas BFF & Web Workspace running at http://0.0.0.0:${PORT}`);
});
