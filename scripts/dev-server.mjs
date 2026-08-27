import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

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

const server = http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    send(res, 405, '405 Method Not Allowed', { Allow: 'GET, HEAD' });
    return;
  }

  let pathname;
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    send(res, 400, '400 Bad Request');
    return;
  }

  // Default routes
  if (pathname === '/' || pathname === '/index.html') {
    pathname = '/index.html';
  }

  const filePath = resolveFile(pathname);
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
  console.log(`🚀 AltCanvas Development Workspace running at http://0.0.0.0:${PORT}`);
});
