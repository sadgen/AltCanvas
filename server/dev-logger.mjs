import fs from 'fs';
import path from 'path';
import util from 'util';
import { fileURLToPath } from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDirectory = path.resolve(process.env.DEBUG_LOG_DIR || path.join(projectRoot, '.debug'));
const enabled = process.env.NODE_ENV !== 'production' && process.env.DEBUG_LOGS !== 'false';
const sensitiveKeyPattern = /authorization|cookie|password|passwd|secret|token|api[-_]?key/i;
const recentBrowserEvents = new Map();
const maxLogBytes = Number(process.env.DEBUG_LOG_MAX_BYTES || 2 * 1024 * 1024);
let consoleCaptureInstalled = false;

export const devLoggingEnabled = enabled;
export const devLogPaths = {
  server: path.join(logDirectory, 'dev.log'),
  browser: path.join(logDirectory, 'browser.log'),
};

function redactText(value, maxLength = 4000) {
  return String(value ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:access_token|refresh_token|api_key|key|password)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/((?:authorization|cookie|password|secret|token|api[-_]?key)\s*[:=]\s*)(?!\[REDACTED\])[^,;\s}\]]+/gi, '$1[REDACTED]')
    .slice(0, maxLength);
}

function sanitize(value, depth = 0, key = '') {
  if (sensitiveKeyPattern.test(key)) return '[REDACTED]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (key === 'endpoint' || key === 'url') return scrubEndpoint(value);
    return redactText(value);
  }
  if (value instanceof Error) {
    return {
      name: redactText(value.name, 120),
      message: redactText(value.message),
      stack: redactText(value.stack || '', 8000),
    };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return '[binary omitted]';
  if (depth >= 4) return '[nested value omitted]';
  if (Array.isArray(value)) return value.slice(0, 25).map(item => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 40)
      .map(([childKey, childValue]) => [childKey, sanitize(childValue, depth + 1, childKey)]));
  }
  return redactText(value);
}

function appendJsonLine(filePath, entry) {
  if (!enabled) return;
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  try {
    if (fs.statSync(filePath).size >= maxLogBytes) {
      fs.renameSync(filePath, `${filePath}.1`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function scrubEndpoint(value) {
  const text = redactText(value || '', 500);
  try {
    const parsed = new URL(text, 'https://debug.invalid');
    const pathOnly = parsed.pathname
      .replace(/\/(users|groups)\/[^/]+/g, '/$1/:library')
      .replace(/\/items\/[^/]+/g, '/items/:item')
      .replace(/\/(workspaces|boards|nodes|edges)\/[0-9a-f-]{16,}/gi, '/$1/:id');
    return `${pathOnly}${parsed.search}`;
  } catch {
    return text;
  }
}

export function writeDevLog(level, source, message, details = {}) {
  appendJsonLine(devLogPaths.server, {
    timestamp: new Date().toISOString(),
    level,
    source,
    message: redactText(message),
    ...sanitize(details),
  });
}

function consoleMessage(args) {
  return redactText(util.format(...args), 8000);
}

export function installDevLogging() {
  if (!enabled || consoleCaptureInstalled) return;
  consoleCaptureInstalled = true;

  if (process.env.DEBUG_STDIO_CAPTURE !== 'true') {
    for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
      const original = console[method].bind(console);
      console[method] = (...args) => {
        original(...args);
        writeDevLog(level, 'server.console', consoleMessage(args), {
          stack: args.find(value => value instanceof Error)?.stack,
        });
      };
    }
  }

  process.on('unhandledRejection', reason => {
    writeDevLog('error', 'process.unhandledRejection', reason instanceof Error ? reason.message : String(reason), {
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
  process.on('uncaughtExceptionMonitor', error => {
    writeDevLog('error', 'process.uncaughtException', error.message, { stack: error.stack });
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Debug log payload is too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function normalizedBrowserEvent(event) {
  const request = event?.request && typeof event.request === 'object' ? {
    method: redactText(event.request.method || 'GET', 12),
    endpoint: scrubEndpoint(event.request.endpoint || ''),
    status: Number.isFinite(Number(event.request.status)) ? Number(event.request.status) : undefined,
    responseSummary: redactText(event.request.responseSummary || '', 1000),
  } : undefined;
  return sanitize({
    timestamp: event?.timestamp || new Date().toISOString(),
    level: ['debug', 'info', 'warn', 'error'].includes(event?.level) ? event.level : 'error',
    source: event?.source || 'browser',
    message: event?.message || 'Unknown browser error',
    stack: event?.stack || undefined,
    url: event?.url ? scrubEndpoint(event.url) : undefined,
    route: event?.route || undefined,
    request,
  });
}

export function handleDebugConfig(_req, res) {
  if (!enabled) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  sendJson(res, 200, { enabled: true });
}

export async function handleBrowserLog(req, res) {
  if (!enabled) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const events = (Array.isArray(body?.events) ? body.events : [body]).slice(0, 25);
    const now = Date.now();
    for (const rawEvent of events) {
      const event = normalizedBrowserEvent(rawEvent);
      const signature = `${event.level}|${event.source}|${event.message}|${event.route}|${event.request?.status || ''}`;
      const lastSeen = recentBrowserEvents.get(signature) || 0;
      if (now - lastSeen < 5000) continue;
      recentBrowserEvents.set(signature, now);
      appendJsonLine(devLogPaths.browser, event);
    }
    for (const [signature, timestamp] of recentBrowserEvents) {
      if (now - timestamp > 60_000) recentBrowserEvents.delete(signature);
    }
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
  } catch (error) {
    writeDevLog('warn', 'debug.browser-log', error.message);
    sendJson(res, error.status || 400, { error: error.message });
  }
}
