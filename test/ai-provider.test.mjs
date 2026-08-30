import assert from 'assert/strict';
import { getAiPublicConfig, validateAiEndpoint } from '../server/ai-provider.mjs';

console.log('🧪 Running server-side AI provider security tests...');

await assert.rejects(
  () => validateAiEndpoint('http://127.0.0.1:11434/v1'),
  /HTTPS/,
  'plain HTTP must require an explicit opt-in'
);
await assert.rejects(
  () => validateAiEndpoint('https://127.0.0.1/v1'),
  /本机或私有网络/,
  'loopback endpoints must be blocked by default'
);
await assert.rejects(
  () => validateAiEndpoint('https://user:password@example.com/v1'),
  /无账号密码/,
  'credentials must not be embedded in the endpoint URL'
);

assert.equal(
  await validateAiEndpoint('http://127.0.0.1:11434/v1/', { allowPrivate: true, allowInsecure: true }),
  'http://127.0.0.1:11434/v1/chat/completions'
);
assert.equal(
  await validateAiEndpoint('https://8.8.8.8/v1?api_key=must-be-removed'),
  'https://8.8.8.8/v1/chat/completions',
  'query strings must never be forwarded to the model endpoint'
);

const previous = {
  baseUrl: process.env.AI_BASE_URL,
  model: process.env.AI_MODEL,
  apiKey: process.env.AI_API_KEY,
};
try {
  process.env.AI_BASE_URL = 'https://ai.example.test/v1';
  process.env.AI_MODEL = 'safe-model';
  process.env.AI_API_KEY = 'never-expose-this-key';
  const publicConfig = getAiPublicConfig();
  assert.deepEqual(publicConfig, {
    configured: true,
    provider: 'ai.example.test',
    model: 'safe-model',
  });
  assert.doesNotMatch(JSON.stringify(publicConfig), /never-expose-this-key/);
} finally {
  for (const [name, value] of [
    ['AI_BASE_URL', previous.baseUrl],
    ['AI_MODEL', previous.model],
    ['AI_API_KEY', previous.apiKey],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log('✅ Server-only credentials and AI endpoint SSRF boundaries passed');
