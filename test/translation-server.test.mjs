import assert from 'assert/strict';
import http from 'node:http';
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

restoreEnv();
console.log('🎉 All M3.1 Translation Server adapter tests passed');
