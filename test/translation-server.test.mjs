import assert from 'assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getTranslationServerConfig,
  resolveTranslationTarget,
  validateTranslationPayload,
  translationResultToImportItem,
  callTranslationServer,
  isLoopbackHost,
  TranslationError
} from '../server/translation-server.mjs';
import { normalizeNativeImportItem } from '../server/canvas-api.mjs';

const execFileAsync = promisify(execFile);

console.log('🧪 Running M3.1 Translation Server adapter tests...');

const baseEnv = { ...process.env };
const restoreEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in baseEnv)) delete process.env[key];
  }
  Object.assign(process.env, baseEnv);
};

const okResponse = (body) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});

const validPayload = {
  ok: true,
  sourceType: 'bibtex',
  title: 'Attention Is All You Need',
  creators: [{ firstName: 'Ashish', lastName: 'Vaswani' }],
  year: 2017,
  doi: '10.5555/3295222.3295349',
  url: 'https://arxiv.org/abs/1706.03762',
  isbn: '978-1-23456-789-0',
  arxivId: '1706.03762',
  abstractNote: 'The dominant sequence transduction models are based on recurrent networks.',
  pdfUrl: 'https://arxiv.org/pdf/1706.03762.pdf'
};

// --- 1. Config: disabled by default, server-side only ---
{
  const cfg = getTranslationServerConfig({});
  assert.equal(cfg.url, null, 'no TRANSLATION_SERVER_URL means disabled');
  assert.equal(cfg.allowRemote, false, 'remote targets disabled by default');
  assert.equal(cfg.connectTimeoutMs, 5000);
  assert.equal(cfg.responseTimeoutMs, 30000);
  assert.equal(cfg.totalTimeoutMs, 60000);

  const result = await callTranslationServer({ input: 'TY - JOUR' }, { config: cfg });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'translation_server_not_configured');
}
console.log('✅ Server-side-only config and disabled default passed');

// --- 2. Target resolution: loopback / unix / remote gating ---
{
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('translate.internal.corp'), false);

  const loopback = await resolveTranslationTarget({ url: 'http://127.0.0.1:1969/parse' });
  assert.equal(loopback.kind, 'loopback', 'loopback target needs no remote flag');

  const unix = await resolveTranslationTarget({ url: 'unix:///run/altcanvas/translation.sock' });
  assert.equal(unix.kind, 'socket');
  assert.equal(unix.socketPath, '/run/altcanvas/translation.sock');

  // Remote without the flag -> forbidden
  await assert.rejects(
    () => resolveTranslationTarget({ url: 'http://translate.example.com:1969/parse', allowRemote: false }),
    err => err.code === 'remote_target_forbidden'
  );

  // Remote with the flag -> full SSRF validation with pinned addresses
  const remoteLookup = async (hostname) => [{ address: '203.0.113.10', family: 4 }];
  const remote = await resolveTranslationTarget(
    { url: 'https://translate.example.com:1969/parse', allowRemote: true },
    { lookupFn: remoteLookup }
  );
  assert.equal(remote.kind, 'remote');
  assert.deepEqual(remote.pinnedAddresses, [{ address: '203.0.113.10', family: 4 }]);

  // Remote resolving to a private address -> blocked
  const privateLookup = async () => [{ address: '192.168.1.5', family: 4 }];
  await assert.rejects(
    () => resolveTranslationTarget(
      { url: 'https://translate.example.com/parse', allowRemote: true },
      { lookupFn: privateLookup }
    ),
    err => err.message.includes('Forbidden address') || err.message.includes('private')
  );

  // Bad schemes and embedded credentials
  await assert.rejects(
    () => resolveTranslationTarget({ url: 'ftp://x/y' }),
    err => err.code === 'invalid_target'
  );
  await assert.rejects(
    () => resolveTranslationTarget({ url: 'http://user:pass@127.0.0.1:1969/' }),
    err => err.code === 'invalid_target'
  );
  await assert.rejects(
    () => resolveTranslationTarget({ url: 'unix://' }),
    err => err.code === 'invalid_target'
  );
}
console.log('✅ Loopback/unix fast-path, remote SSRF gating, scheme/credential rejection passed');

// --- 3. Redirects are forbidden ---
{
  let transportCalls = 0;
  const result = callTranslationServer(
    { input: 'TY - JOUR' },
    {
      config: { ...getTranslationServerConfig({}), url: 'http://127.0.0.1:1969/parse', allowRemote: false },
      transportFn: async () => {
        transportCalls++;
        return { status: 302, headers: { location: 'http://evil.example.com/steal' }, body: '' };
      }
    }
  );
  await assert.rejects(result, err => err.code === 'redirect_not_allowed');
  assert.equal(transportCalls, 1, 'A redirect must never trigger a second request');
}
console.log('✅ Redirect rejection (single-shot transport) passed');

// --- 4. Timeouts: total task timeout fires on a hanging transport ---
{
  const hangConfig = {
    url: 'http://127.0.0.1:1969/parse',
    connectTimeoutMs: 50,
    responseTimeoutMs: 50,
    totalTimeoutMs: 80,
    allowRemote: false,
    allowPrivate: false
  };
  await assert.rejects(
    callTranslationServer(
      { input: 'TY - JOUR' },
      {
        config: hangConfig,
        transportFn: () => new Promise(() => {}) // never resolves
      }
    ),
    err => err.code === 'total_timeout'
  );
}
console.log('✅ Total-task timeout on hanging transport passed');

// --- 5. Request body size cap ---
{
  const bigInput = 'x'.repeat(1024 * 1024 + 1);
  await assert.rejects(
    callTranslationServer(
      { input: bigInput },
      {
        config: { ...getTranslationServerConfig({}), url: 'http://127.0.0.1:1969/parse' },
        transportFn: async () => { throw new Error('transport must not be called'); }
      }
    ),
    err => err.code === 'request_too_large'
  );
}
console.log('✅ Request body size cap passed');

// --- 6. Response body size cap ---
{
  await assert.rejects(
    callTranslationServer(
      { input: 'TY - JOUR' },
      {
        config: { ...getTranslationServerConfig({}), url: 'http://127.0.0.1:1969/parse' },
        transportFn: async () => ({
          status: 200,
          headers: {},
          body: 'y'.repeat(2 * 1024 * 1024 + 1)
        })
      }
    ),
    err => err.code === 'response_too_large'
  );
}
console.log('✅ Response body size cap passed');

// --- 7. Non-2xx, non-JSON, invalid schema ---
{
  const cfg = { ...getTranslationServerConfig({}), url: 'http://127.0.0.1:1969/parse' };

  await assert.rejects(
    callTranslationServer({ input: 'x' }, { config: cfg, transportFn: async () => ({ status: 500, headers: {}, body: 'oops' }) }),
    err => err.code === 'upstream_error'
  );
  await assert.rejects(
    callTranslationServer({ input: 'x' }, { config: cfg, transportFn: async () => okResponse('<html>not json</html>') }),
    err => err.code === 'invalid_payload'
  );
  await assert.rejects(
    callTranslationServer({ input: 'x' }, { config: cfg, transportFn: async () => okResponse({ title: 'missing ok and sourceType' }) }),
    err => err.code === 'invalid_payload'
  );
  await assert.rejects(
    callTranslationServer({ input: 'x' }, { config: cfg, transportFn: async () => okResponse({ ok: true, sourceType: 'ris', title: '' }) }),
    err => err.code === 'invalid_payload'
  );
  await assert.rejects(
    callTranslationServer({ input: 'x' }, { config: cfg, transportFn: async () => okResponse({ ok: true, sourceType: 'ris', title: 'T', year: 12345 }) }),
    err => err.code === 'invalid_payload'
  );
  await assert.rejects(
    callTranslationServer({ input: 'x' }, { config: cfg, transportFn: async () => okResponse({ ok: true, sourceType: 'ris', title: 'T', pdfUrl: 'gopher://x' }) }),
    err => err.code === 'invalid_payload'
  );

  // ok:false passes the structured error through
  const failResult = await callTranslationServer(
    { input: 'x' },
    { config: cfg, transportFn: async () => okResponse({ ok: false, error: 'unsupported format' }) }
  );
  assert.equal(failResult.available, true);
  assert.equal(failResult.ok, false);
  assert.equal(failResult.error, 'unsupported format');

  // Unknown fields are dropped by the validator
  const validated = validateTranslationPayload({ ...validPayload, injectedField: 'DROP ME', another: 42 });
  assert.equal('injectedField' in validated, false);
  assert.equal('another' in validated, false);
  assert.equal(validated.title, validPayload.title);
}
console.log('✅ Non-2xx / non-JSON / schema violations / unknown-field stripping passed');

// --- 8. DTO conversion feeds cleanly into the M2 normalizer ---
{
  const call = await callTranslationServer(
    { input: 'TY - JOUR\nTI - Attention Is All You Need', format: 'ris' },
    {
      config: { ...getTranslationServerConfig({}), url: 'http://127.0.0.1:1969/parse' },
      transportFn: async (target, payload) => {
        assert.equal(payload.format, 'ris', 'format hint must be forwarded to the server');
        assert.equal(payload.input.includes('TY - JOUR'), true);
        return okResponse(validPayload);
      }
    }
  );
  assert.equal(call.available, true);
  assert.equal(call.ok, true);

  // The DTO must pass the EXACT normalizer used by the M2 import executor.
  const normalized = normalizeNativeImportItem(call.item, 'translation.dto');
  assert.equal(normalized.title, 'Attention Is All You Need');
  assert.equal(normalized.sourceType, 'bibtex');
  assert.equal(normalized.year, 2017);
  assert.equal(normalized.doi, '10.5555/3295222.3295349');
  assert.equal(normalized.pdfUrl, 'https://arxiv.org/pdf/1706.03762.pdf');
  assert.equal(normalized.creators.length, 1);
  assert.equal(normalized.creators[0].lastName, 'Vaswani');

  // translationResultToImportItem rejects non-ok results
  assert.throws(() => translationResultToImportItem({ ok: false }), /ok:true/);
}
console.log('✅ DTO conversion and normalizeNativeImportItem contract passed');

// --- 9. Real transport over loopback HTTP: single-shot POST, JSON, no redirects ---
{
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'POST', 'adapter must POST');
    assert.equal((req.headers['content-type'] || '').includes('application/json'), true);
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(payload.input, 'TY - JOUR\nTI - Real Round Trip');
      assert.equal(payload.format, 'ris');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...validPayload,
        title: 'Real Round Trip'
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const call = await callTranslationServer(
      { input: 'TY - JOUR\nTI - Real Round Trip', format: 'ris' },
      { config: { ...getTranslationServerConfig({}), url: `http://127.0.0.1:${port}/parse`, totalTimeoutMs: 3000 } }
    );
    assert.equal(call.available, true);
    assert.equal(call.ok, true);
    assert.equal(call.item.title, 'Real Round Trip');
    const normalized = normalizeNativeImportItem(call.item, 'loopback.dto');
    assert.equal(normalized.title, 'Real Round Trip');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  // A redirecting loopback server must be rejected, and only ONE request made.
  let hits = 0;
  const redirector = http.createServer((req, res) => {
    hits++;
    res.writeHead(302, { Location: '/elsewhere' });
    res.end();
  });
  await new Promise(resolve => redirector.listen(0, '127.0.0.1', resolve));
  const redirectPort = redirector.address().port;
  try {
    await assert.rejects(
      callTranslationServer(
        { input: 'x' },
        { config: { ...getTranslationServerConfig({}), url: `http://127.0.0.1:${redirectPort}/parse`, totalTimeoutMs: 3000 } }
      ),
      err => err.code === 'redirect_not_allowed'
    );
    assert.equal(hits, 1, 'Redirect must abort after the single original request');
  } finally {
    await new Promise(resolve => redirector.close(resolve));
  }
}
console.log('✅ Real loopback HTTP round-trip and redirect abort passed');

// =========================================================================
// --- Audit round 2: real timeout semantics, DNS pinning, collection caps ---
// =========================================================================

const startServer = (handler) => new Promise(resolve => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});
const closeServer = (server) => new Promise(resolve => server.close(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- 10. Slow response SUCCEEDS under corrected timer lifecycle ---
// connectTimeout=20ms would falsely fire under the old (socket-inactivity)
// semantics; the connect timer must clear on connect and the 80ms response
// must succeed within responseTimeout=200ms.
{
  const { server, port } = await startServer(async (req, res) => {
    await sleep(80); // deliberate slow-but-valid response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(validPayload));
  });
  try {
    const call = await callTranslationServer(
      { input: 'TY - JOUR' },
      {
        config: {
          ...getTranslationServerConfig({}),
          url: `http://127.0.0.1:${port}/parse`,
          connectTimeoutMs: 20,
          responseTimeoutMs: 200,
          totalTimeoutMs: 2000
        }
      }
    );
    assert.equal(call.ok, true, 'Slow (80ms) response must succeed: connect timer clears on connect');
    assert.equal(call.item.title, validPayload.title);
  } finally {
    await closeServer(server);
  }
}
console.log('✅ Slow-response success under corrected timer lifecycle passed');

// --- 11. No response headers -> response_timeout (armed at connect) ---
{
  const { server, port } = await startServer(() => {
    // Accept the connection, read the body, never respond.
  });
  try {
    await assert.rejects(
      callTranslationServer(
        { input: 'TY - JOUR' },
        {
          config: {
            ...getTranslationServerConfig({}),
            url: `http://127.0.0.1:${port}/parse`,
            connectTimeoutMs: 1000,
            responseTimeoutMs: 150,
            totalTimeoutMs: 5000
          }
        }
      ),
      err => err.code === 'response_timeout',
      'Silent server must trip the response timer while waiting for headers'
    );
  } finally {
    await closeServer(server);
  }
}
console.log('✅ No-response-header response_timeout passed');

// --- 12. Slow body: within budget succeeds; over budget is a hard wall ---
{
  // 12a: headers immediate, body after 120ms, responseTimeout=400 -> success
  {
    const { server, port } = await startServer(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      await sleep(120);
      res.end(JSON.stringify(validPayload));
    });
    try {
      const call = await callTranslationServer(
        { input: 'TY - JOUR' },
        {
          config: {
            ...getTranslationServerConfig({}),
            url: `http://127.0.0.1:${port}/parse`,
            connectTimeoutMs: 1000,
            responseTimeoutMs: 400,
            totalTimeoutMs: 3000
          }
        }
      );
      assert.equal(call.ok, true, 'Slow body within the response budget must succeed');
    } finally {
      await closeServer(server);
    }
  }
  // 12b: body after 300ms, responseTimeout=150 -> response_timeout
  {
    const { server, port } = await startServer(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      await sleep(300);
      res.end(JSON.stringify(validPayload));
    });
    try {
      await assert.rejects(
        callTranslationServer(
          { input: 'TY - JOUR' },
          {
            config: {
              ...getTranslationServerConfig({}),
              url: `http://127.0.0.1:${port}/parse`,
              connectTimeoutMs: 1000,
              responseTimeoutMs: 150,
              totalTimeoutMs: 5000
            }
          }
        ),
        err => err.code === 'response_timeout',
        'Body slower than the response budget must be cut off'
      );
    } finally {
      await closeServer(server);
    }
  }
}
console.log('✅ Slow-body budget boundaries passed');

// --- 13. Hanging DNS is covered by the total deadline (armed at entry) ---
{
  await assert.rejects(
    callTranslationServer(
      { input: 'TY - JOUR' },
      {
        config: {
          ...getTranslationServerConfig({}),
          url: 'https://translate.example.com/parse',
          allowRemote: true,
          totalTimeoutMs: 100
        },
        lookupFn: () => new Promise(() => {}) // DNS never resolves
      }
    ),
    err => err.code === 'total_timeout',
    'Hanging DNS resolution must be cut off by the total deadline'
  );
}
console.log('✅ Hanging-DNS total deadline passed');

// --- 14. Total deadline takes priority over longer response timeout ---
{
  const { server, port } = await startServer(() => { /* never responds */ });
  try {
    await assert.rejects(
      callTranslationServer(
        { input: 'TY - JOUR' },
        {
          config: {
            ...getTranslationServerConfig({}),
            url: `http://127.0.0.1:${port}/parse`,
            connectTimeoutMs: 5000,
            responseTimeoutMs: 10_000,
            totalTimeoutMs: 150
          }
        }
      ),
      err => err.code === 'total_timeout',
      'The total deadline must fire before a longer response timeout'
    );
  } finally {
    await closeServer(server);
  }
}
console.log('✅ Total-deadline priority passed');

// --- 15. DNS pinning: resolution ALWAYS happens; allowPrivate accepts but pins ---
{
  // 15a: allowPrivate=true still resolves AND pins — no system-DNS fallback.
  const pinned = await resolveTranslationTarget(
    {
      url: 'https://translate.internal.example.com/parse',
      allowRemote: true,
      allowPrivate: true
    },
    { lookupFn: async () => [{ address: '192.168.1.5', family: 4 }] }
  );
  assert.equal(pinned.kind, 'remote');
  assert.ok(pinned.pinnedAddresses.length >= 1,
    'allowPrivate=true must still resolve and pin addresses (never skip DNS)');
  assert.equal(pinned.pinnedAddresses[0].address, '192.168.1.5');

  // 15b: remote resolving to ZERO addresses is rejected; transport never dialed.
  let transportCalled = false;
  await assert.rejects(
    callTranslationServer(
      { input: 'x' },
      {
        config: { ...getTranslationServerConfig({}), url: 'https://translate.example.com/parse', allowRemote: true },
        lookupFn: async () => [],
        transportFn: async () => { transportCalled = true; return okResponse(validPayload); }
      }
    ),
    err => err.code === 'invalid_target' && err.message.includes('no usable addresses')
  );
  assert.equal(transportCalled, false, 'Must never dial after a zero-address resolution');

  // 15c: 'localhost' resolves, is verified all-loopback, and the connection is pinned.
  const localhostResolved = await resolveTranslationTarget(
    { url: 'http://localhost:1969/parse' },
    { lookupFn: async () => [{ address: '127.0.0.2', family: 4 }] }
  );
  assert.equal(localhostResolved.kind, 'loopback');
  assert.equal(localhostResolved.pinnedAddresses[0].address, '127.0.0.2',
    'localhost must dial the RESOLVED loopback address, not re-resolve');

  // 15d: 'localhost' resolving to a non-loopback address is rejected.
  await assert.rejects(
    resolveTranslationTarget(
      { url: 'http://localhost:1969/parse' },
      { lookupFn: async () => [{ address: '10.0.0.1', family: 4 }] }
    ),
    err => err.code === 'invalid_target' && err.message.includes('non-loopback')
  );

  // 15e: IP-literal loopback pins the literal without any DNS lookup.
  let literalLookupCalled = false;
  const literalTarget = await resolveTranslationTarget(
    { url: 'http://127.0.0.1:1969/parse' },
    { lookupFn: async () => { literalLookupCalled = true; return []; } }
  );
  assert.equal(literalTarget.pinnedAddresses[0].address, '127.0.0.1');
  assert.equal(literalLookupCalled, false, 'IP-literal loopback must not trigger DNS');

  // 15f: real round-trip through the RESOLVED-and-pinned 'localhost' name.
  const { server, port } = await startServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(validPayload));
    });
  });
  try {
    const call = await callTranslationServer(
      { input: 'TY - JOUR' },
      {
        config: {
          ...getTranslationServerConfig({}),
          url: `http://localhost:${port}/parse`,
          totalTimeoutMs: 3000
        }
      }
    );
    assert.equal(call.ok, true, 'Pinned localhost dial must complete a real round-trip');
  } finally {
    await closeServer(server);
  }
}
console.log('✅ DNS resolution + pinning (allowPrivate, zero-address, localhost, literal) passed');

// --- 16. Collection caps: creators count and empty-creator rejection ---
{
  // 16a: more than MAX_CREATORS creators rejected
  const manyCreators = Array.from({ length: 101 }, () => ({ name: 'A' }));
  assert.throws(
    () => validateTranslationPayload({ ...validPayload, creators: manyCreators }),
    err => err.code === 'invalid_payload' && err.message.includes('at most 100')
  );
  // Exactly 100 passes
  const hundred = Array.from({ length: 100 }, (_, i) => ({ name: `Author ${i}` }));
  const okHundred = validateTranslationPayload({ ...validPayload, creators: hundred });
  assert.equal(okHundred.creators.length, 100);

  // 16b: creator with no name-ish field rejected
  assert.throws(
    () => validateTranslationPayload({ ...validPayload, creators: [{ creatorType: 'author' }] }),
    err => err.code === 'invalid_payload' && err.message.includes('at least one of firstName, lastName, or name')
  );

  // 16c: serialized request cap applies to the FINAL body, not just the input field
  // (an input of exactly MAX bytes serializes beyond the cap due to JSON overhead).
  await assert.rejects(
    callTranslationServer(
      { input: 'x'.repeat(1024 * 1024) },
      {
        config: { ...getTranslationServerConfig({}), url: 'http://127.0.0.1:1969/parse' },
        transportFn: async () => { throw new Error('transport must not be called'); }
      }
    ),
    err => err.code === 'request_too_large',
    'The serialized {input, format} body must be under the request cap, not just the raw input'
  );
}
console.log('✅ Collection caps and serialized request-size gate passed');

// --- 17. Keep-Alive socket reuse test (P1 fix) ---
// When consecutive requests reuse an already-connected Keep-Alive socket,
// the socket is NOT connecting. It must clear connectTimer immediately,
// switch to the response timer, and succeed when the server delays for 250ms
// (even though connectTimeout=80ms < server delay=250ms < responseTimeout=600ms).
{
  let requestCount = 0;
  let socketCount = 0;
  const { server, port } = await startServer((req, res) => {
    requestCount++;
    const isSecond = requestCount > 1;
    req.resume();
    req.on('end', async () => {
      // Second request on the reused socket: 250ms delayed reply
      if (isSecond) {
        await sleep(250);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(validPayload));
    });
  });
  server.on('connection', () => { socketCount++; });

  try {
    const config = {
      ...getTranslationServerConfig({}),
      url: `http://127.0.0.1:${port}/parse`,
      connectTimeoutMs: 80,
      responseTimeoutMs: 600,
      totalTimeoutMs: 5000
    };

    // Request 1: creates connection
    const call1 = await callTranslationServer({ input: 'TY - JOUR' }, { config });
    assert.equal(call1.ok, true, 'First request must succeed');

    // Request 2: reuses existing Keep-Alive socket
    const start2 = Date.now();
    const call2 = await callTranslationServer({ input: 'TY - JOUR' }, { config });
    const elapsed2 = Date.now() - start2;

    assert.equal(call2.ok, true, 'Second request on reused Keep-Alive socket must succeed');
    assert.equal(call2.item.title, validPayload.title);
    assert.equal(socketCount, 1, 'Both requests must share the single Keep-Alive socket');
    assert.ok(elapsed2 >= 200, `Elapsed time must reflect server delay (~250ms), got ${elapsed2}ms`);
  } finally {
    await closeServer(server);
  }
}
console.log('✅ Keep-Alive socket reuse with connectTimeout < serverDelay < responseTimeout passed');

// --- 18. DNS / target resolution total deadline timer cleanup (P2 fix) ---
// The targetTimer in callTranslationServer must be cleared in finally;
// a quick call with a large totalTimeoutMs must NOT leave a dangling timer
// that prevents the process from exiting immediately.
{
  const childScript = `
    import { callTranslationServer, getTranslationServerConfig } from './server/translation-server.mjs';
    const start = Date.now();
    await callTranslationServer(
      { input: 'TY - JOUR' },
      {
        config: { ...getTranslationServerConfig({}), url: 'http://127.0.0.1:1969/parse', totalTimeoutMs: 4000 },
        transportFn: async () => ({
          status: 200,
          headers: {},
          body: JSON.stringify({ ok: true, sourceType: 'ris', title: 'Quick Exit' })
        })
      }
    );
    // When targetTimer is properly cleared in finally, this process exits immediately
    // rather than waiting 4000ms for totalTimeoutMs to elapse.
  `;
  const t0 = Date.now();
  await execFileAsync(process.execPath, ['--input-type=module', '-e', childScript], {
    timeout: 3000
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, `Child process must exit immediately (<1500ms), took ${elapsed}ms (targetTimer was not cleared)`);
}
console.log('✅ Target resolution timer cleanup on immediate success passed');

// --- 19. 127.0.0.0/8 literal loopback detection (P2 fix) ---
// Any 127.0.0.0/8 IP literal is recognized as loopback without needing ALLOW_REMOTE_TRANSLATION_SERVER
{
  assert.equal(isLoopbackHost('127.0.0.2'), true);
  assert.equal(isLoopbackHost('127.100.200.1'), true);
  assert.equal(isLoopbackHost('127.255.255.254'), true);
  assert.equal(isLoopbackHost('10.0.0.1'), false);
  assert.equal(isLoopbackHost('192.168.1.1'), false);

  const t127_2 = await resolveTranslationTarget({ url: 'http://127.0.0.2:1969/parse', allowRemote: false });
  assert.equal(t127_2.kind, 'loopback');
  assert.equal(t127_2.pinnedAddresses[0].address, '127.0.0.2');

  const t127_custom = await resolveTranslationTarget({ url: 'http://127.250.1.2:1969/parse', allowRemote: false });
  assert.equal(t127_custom.kind, 'loopback');
  assert.equal(t127_custom.pinnedAddresses[0].address, '127.250.1.2');
}
console.log('✅ 127.0.0.0/8 literal loopback recognition passed');

restoreEnv();
console.log('🎉 All M3.1 Translation Server adapter tests passed');
