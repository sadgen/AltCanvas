import dns from 'dns/promises';
import { isPrivateNetworkHost } from './security.mjs';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

function configuredValues(override = null) {
  const baseUrl = String(override?.baseUrl ?? process.env.AI_BASE_URL ?? '').trim();
  const model = String(override?.model ?? process.env.AI_MODEL ?? '').trim();
  return {
    baseUrl,
    model,
    apiKey: String(override?.apiKey ?? process.env.AI_API_KEY ?? ''),
    allowPrivate: process.env.ALLOW_PRIVATE_AI_HOSTS === 'true',
    allowInsecure: process.env.ALLOW_INSECURE_AI === 'true',
  };
}

export async function validateAiEndpoint(raw, { allowPrivate = false, allowInsecure = false } = {}) {
  if (!raw) throw new TypeError('服务器尚未配置 AI_BASE_URL');
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new TypeError('AI_BASE_URL 不是有效的网址');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new TypeError('AI_BASE_URL 必须是无账号密码的 HTTP(S) 地址');
  }
  if (endpoint.protocol !== 'https:' && !allowInsecure) {
    throw new TypeError('AI_BASE_URL 必须使用 HTTPS；本机模型需显式启用 ALLOW_INSECURE_AI');
  }
  endpoint.search = '';
  endpoint.hash = '';

  if (!allowPrivate) {
    if (isPrivateNetworkHost(endpoint.hostname)) throw new TypeError('AI 端点不能指向本机或私有网络');
    if (!endpoint.hostname.includes(':') && !/^\d+(?:\.\d+){3}$/.test(endpoint.hostname)) {
      let addresses;
      try {
        addresses = await dns.lookup(endpoint.hostname, { all: true, verbatim: true });
      } catch {
        throw new TypeError('AI 端点域名无法解析');
      }
      if (!addresses.length || addresses.some(({ address }) => isPrivateNetworkHost(address))) {
        throw new TypeError('AI 端点解析到了不允许的网络地址');
      }
    }
  }

  const normalized = endpoint.toString().replace(/\/+$/, '');
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

export function getAiPublicConfig(override = null) {
  const { baseUrl, model } = configuredValues(override);
  let provider = '';
  try { provider = baseUrl ? new URL(baseUrl).host : ''; } catch { /* reported on use */ }
  return { configured: Boolean(baseUrl && model), provider, model };
}

async function readLimitedText(response) {
  const maxBytes = Number(process.env.AI_MAX_RESPONSE_BYTES || DEFAULT_MAX_RESPONSE_BYTES);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('AI 模型响应超过大小限制');
  const chunks = [];
  let total = 0;
  if (!response.body) return '';
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error('AI 模型响应超过大小限制');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function requestAiCompletion({ messages, temperature = 0.4, maxTokens }, override = null) {
  const config = configuredValues(override);
  if (!config.model) throw new Error('服务器尚未配置 AI_MODEL');
  const targetUrl = await validateAiEndpoint(config.baseUrl, config);
  const controller = new AbortController();
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      redirect: 'manual',
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      }),
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('AI 模型端点不允许重定向');
    }
    const text = await readLimitedText(response);
    if (!response.ok) {
      let upstreamCode = '';
      try {
        const upstreamError = JSON.parse(text)?.error;
        const candidate = String(upstreamError?.code || upstreamError?.type || '');
        if (/^[A-Za-z0-9_.-]{1,64}$/.test(candidate)) upstreamCode = candidate;
      } catch { /* non-JSON response */ }
      throw new Error(`AI 模型端点返回 HTTP ${response.status}${upstreamCode ? ` (${upstreamCode})` : ''}`);
    }
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error('AI 模型返回了无效 JSON'); }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('AI 模型未返回有效内容');
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}
