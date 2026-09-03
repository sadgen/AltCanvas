import http from 'node:http';
import https from 'node:https';
import { validateExternalUrl } from './import-resolver.mjs';

// M3.1 Translation Server adapter.
//
// Security contract (audited):
//  - The server address comes ONLY from server-side configuration
//    (TRANSLATION_SERVER_URL). Callers supply input text, never an address.
//  - Loopback and Unix-socket targets are the trusted default; any remote
//    target additionally requires ALLOW_REMOTE_TRANSLATION_SERVER=true and
//    passes the shared SSRF gate (DNS pinning, private-network block).
//  - Redirects are NEVER followed: a 3xx response is an error.
//  - Connect, response, and total-task timeouts apply; request and response
//    bodies are size-capped.
//  - This module only PARSES. It performs no database or Blob writes; its
//    output is a DTO intended for normalizeNativeImportItem + the M2 executor.

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;       // 1 MiB bibliography input
const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;  // 2 MiB parsed metadata

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class TranslationError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'TranslationError';
    this.code = code;
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getTranslationServerConfig(env = process.env) {
  const rawUrl = String(env.TRANSLATION_SERVER_URL || '').trim();
  return {
    url: rawUrl || null,
    connectTimeoutMs: positiveInt(env.TRANSLATION_CONNECT_TIMEOUT_MS, 5_000),
    responseTimeoutMs: positiveInt(env.TRANSLATION_RESPONSE_TIMEOUT_MS, 30_000),
    totalTimeoutMs: positiveInt(env.TRANSLATION_TOTAL_TIMEOUT_MS, 60_000),
    allowRemote: env.ALLOW_REMOTE_TRANSLATION_SERVER === 'true',
    allowPrivate: env.ALLOW_PRIVATE_TRANSLATION_HOSTS === 'true'
  };
}

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || '').toLowerCase());
}

// Resolve the configured target into a transport description.
//   { kind: 'disabled' }
//   { kind: 'socket', socketPath }
//   { kind: 'loopback', parsed }
//   { kind: 'remote', parsed, pinnedAddresses }   // after full SSRF validation
export async function resolveTranslationTarget(config, { lookupFn } = {}) {
  if (!config.url) return { kind: 'disabled' };

  if (config.url.startsWith('unix://')) {
    const socketPath = decodeURIComponent(new URL(config.url).pathname);
    if (!socketPath || socketPath === '/') {
      throw new TranslationError('invalid_target', 'unix:// translation target requires a socket path');
    }
    return { kind: 'socket', socketPath };
  }

  let parsed;
  try {
    parsed = new URL(config.url);
  } catch {
    throw new TranslationError('invalid_target', 'TRANSLATION_SERVER_URL is not a valid URL');
  }
  if (parsed.username || parsed.password) {
    throw new TranslationError('invalid_target', 'embedded credentials are not allowed in TRANSLATION_SERVER_URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TranslationError('invalid_target', 'translation target must be http(s) or unix://');
  }

  if (isLoopbackHost(parsed.hostname)) {
    return { kind: 'loopback', parsed };
  }

  if (!config.allowRemote) {
    throw new TranslationError(
      'remote_target_forbidden',
      'remote translation server requires ALLOW_REMOTE_TRANSLATION_SERVER=true; prefer a loopback or unix:// target'
    );
  }

  // Full SSRF gate for remote targets: DNS resolution with private-network
  // blocking (unless explicitly allowed) and pinned addresses for dialing.
  const validation = await validateExternalUrl(parsed.toString(), {
    allowPrivate: config.allowPrivate,
    ...(lookupFn ? { lookupFn } : {})
  });
  return { kind: 'remote', parsed: validation.parsed, pinnedAddresses: validation.validatedAddresses };
}

// Single-shot HTTP(S) request with socketPath support, pinned dialing for
// remote targets, hard total timeout, and response size capping.
// `transportFn` injection keeps this deterministic in tests.
async function httpJsonRequest(target, payload, config, { transportFn } = {}) {
  if (typeof transportFn === 'function') {
    // Injected transports must obey the same hard total-task timeout as the
    // real transport; otherwise a hanging test/adapter could stall forever.
    let timer;
    try {
      return await Promise.race([
        transportFn(target, payload, config),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(
            new TranslationError('total_timeout', `translation task exceeded total timeout of ${config.totalTimeoutMs}ms`)
          ), config.totalTimeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  const bodyBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
  const isHttps = target.kind !== 'socket' && target.parsed.protocol === 'https:';
  const requester = isHttps ? https.request : http.request;

  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': bodyBuffer.length
    },
    timeout: config.connectTimeoutMs
  };
  if (target.kind === 'socket') {
    options.socketPath = target.socketPath;
  } else if (target.kind === 'loopback') {
    options.hostname = target.parsed.hostname;
    options.port = target.parsed.port || (isHttps ? 443 : 80);
    options.path = `${target.parsed.pathname}${target.parsed.search}`;
    options.servername = target.parsed.hostname;
  } else {
    options.hostname = target.parsed.hostname;
    options.port = target.parsed.port || (isHttps ? 443 : 80);
    options.path = `${target.parsed.pathname}${target.parsed.search}`;
    options.servername = target.parsed.hostname;
    const pinned = target.pinnedAddresses?.[0];
    if (pinned?.address) {
      options.lookup = (h, opt, cb) => cb(null, pinned.address, pinned.family || 4);
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, ...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(responseTimer);
      fn(...args);
    };

    const totalTimer = setTimeout(() => {
      req?.destroy();
      finish(reject, new TranslationError('total_timeout', `translation task exceeded total timeout of ${config.totalTimeoutMs}ms`));
    }, config.totalTimeoutMs);

    let responseTimer = null;
    const req = requester(options, (res) => {
      responseTimer = setTimeout(() => {
        res.destroy();
        finish(reject, new TranslationError('response_timeout', `translation response exceeded timeout of ${config.responseTimeoutMs}ms`));
      }, config.responseTimeoutMs);

      const chunks = [];
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BODY_BYTES) {
          res.destroy();
          finish(reject, new TranslationError('response_too_large', `translation response exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(resolve, {
        status: res.statusCode || 0,
        headers: res.headers || {},
        body: Buffer.concat(chunks).toString('utf8')
      }));
      res.on('error', (err) => finish(reject, new TranslationError('transport_error', err.message)));
    });

    req.on('timeout', () => {
      req.destroy();
      finish(reject, new TranslationError('connect_timeout', `translation connection exceeded ${config.connectTimeoutMs}ms`));
    });
    req.on('error', (err) => finish(reject, new TranslationError('transport_error', err.message)));
    req.end(bodyBuffer);
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Strict validation of the translation server payload. Unknown fields are
// dropped; every retained field is type- and length-checked.
export function validateTranslationPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TranslationError('invalid_payload', 'translation response must be a JSON object');
  }
  if (data.ok === false) {
    return { ok: false, error: String(data.error || 'translation failed').slice(0, 500) };
  }
  if (data.ok !== true) {
    throw new TranslationError('invalid_payload', 'translation response must carry an explicit ok flag');
  }

  const out = { ok: true, sourceType: '', title: '' };

  if (typeof data.sourceType !== 'string' || !data.sourceType || data.sourceType.length > 64) {
    throw new TranslationError('invalid_payload', 'sourceType must be a non-empty string of at most 64 characters');
  }
  out.sourceType = data.sourceType;

  if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 500) {
    throw new TranslationError('invalid_payload', 'title must be a non-empty string of at most 500 characters');
  }
  out.title = data.title.trim();

  if (data.creators !== undefined && data.creators !== null) {
    if (!Array.isArray(data.creators)) {
      throw new TranslationError('invalid_payload', 'creators must be an array');
    }
    out.creators = data.creators.map(c => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        throw new TranslationError('invalid_payload', 'creators entries must be objects');
      }
      const entry = {};
      for (const field of ['creatorType', 'firstName', 'lastName', 'name']) {
        if (c[field] !== undefined && c[field] !== null) {
          if (typeof c[field] !== 'string' || c[field].length > 200) {
            throw new TranslationError('invalid_payload', `creators.${field} must be a string of at most 200 characters`);
          }
          entry[field] = c[field];
        }
      }
      return entry;
    });
  }

  if (data.year !== undefined && data.year !== null) {
    if (typeof data.year !== 'number' || !Number.isInteger(data.year) || data.year < 1400 || data.year > 2200) {
      throw new TranslationError('invalid_payload', 'year must be an integer between 1400 and 2200');
    }
    out.year = data.year;
  }

  const STRING_FIELDS = { doi: 2000, url: 2000, isbn: 64, arxivId: 64, abstractNote: 20_000, pdfUrl: 2000 };
  for (const [field, maxLen] of Object.entries(STRING_FIELDS)) {
    if (data[field] === undefined || data[field] === null) continue;
    if (typeof data[field] !== 'string' || data[field].length > maxLen) {
      throw new TranslationError('invalid_payload', `${field} must be a string of at most ${maxLen} characters`);
    }
    if (data[field]) out[field] = data[field];
  }
  if (out.pdfUrl && !/^https?:\/\//i.test(out.pdfUrl)) {
    throw new TranslationError('invalid_payload', 'pdfUrl must be an http(s) URL');
  }

  return out;
}

// Convert a validated translation result into an import-item DTO that flows
// through normalizeNativeImportItem and the M2 unified executor.
export function translationResultToImportItem(result) {
  if (!result || result.ok !== true) {
    throw new TypeError('translationResultToImportItem requires an ok:true result');
  }
  return {
    sourceType: result.sourceType,
    title: result.title,
    abstract: result.abstractNote || null,
    creators: result.creators || [],
    year: result.year ?? null,
    doi: result.doi || null,
    url: result.url || null,
    isbn: result.isbn || null,
    arxivId: result.arxivId || null,
    pdfUrl: result.pdfUrl || null
  };
}

// Primary entry: parse an input via the configured Translation Server.
// Never writes to the database or Blob storage.
export async function callTranslationServer({ input, format = null }, {
  config = getTranslationServerConfig(),
  lookupFn = null,
  transportFn = null
} = {}) {
  const target = await resolveTranslationTarget(config, lookupFn ? { lookupFn } : {});
  if (target.kind === 'disabled') {
    return { available: false, reason: 'translation_server_not_configured' };
  }

  if (typeof input !== 'string' || !input.trim()) {
    throw new TranslationError('invalid_input', 'input must be a non-empty string');
  }
  if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BODY_BYTES) {
    throw new TranslationError('request_too_large', `input exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
  }
  if (format !== null && format !== undefined) {
    if (typeof format !== 'string' || format.length > 32) {
      throw new TranslationError('invalid_input', 'format must be a string of at most 32 characters');
    }
  }

  const response = await httpJsonRequest(target, { input, format }, config, { transportFn });

  // Belt-and-braces: the real transport enforces the cap while streaming; any
  // returned body (including injected transports) is re-checked here.
  if (Buffer.byteLength(response.body || '', 'utf8') > MAX_RESPONSE_BODY_BYTES) {
    throw new TranslationError('response_too_large', `translation response exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`);
  }

  if (REDIRECT_STATUSES.has(response.status) || response.headers?.location) {
    throw new TranslationError(
      'redirect_not_allowed',
      `translation server attempted a redirect to ${String(response.headers?.location || '').slice(0, 200)}; redirects are forbidden`
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new TranslationError('upstream_error', `translation server returned HTTP ${response.status}`);
  }

  let data;
  try {
    data = JSON.parse(response.body);
  } catch {
    throw new TranslationError('invalid_payload', 'translation server returned non-JSON body');
  }

  const result = validateTranslationPayload(data);
  if (result.ok === false) {
    return { available: true, ok: false, error: result.error };
  }
  return { available: true, ok: true, item: translationResultToImportItem(result) };
}
