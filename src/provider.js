import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createHash } from 'node:crypto';

export function createConfiguredModel(config, { fetch: fetchImplementation = globalThis.fetch } = {}) {
  validateConfig(config);
  const requests = [];
  const retainedRequests = [];
  let preflightResult;
  const preflight = () => {
    if (!preflightResult) {
      preflightResult = assertToolCapability(config, { fetch: fetchImplementation }).catch(error => {
        preflightResult = undefined;
        throw error;
      });
    }
    return preflightResult;
  };
  const recordedFetch = async (url, init = {}) => {
    const request = recordRequest(url, init);
    requests.push(request);
    retainedRequests.push(retainedRequest(request));
    return fetchImplementation(url, init);
  };

  if (config.provider === 'openrouter') {
    const apiKey = readKey(config.apiKeyEnv ?? 'OPENROUTER_API_KEY', false);
    const provider = createOpenRouter({
      apiKey,
      baseURL: config.baseURL,
      compatibility: 'strict',
      appName: config.appName ?? 'Music',
      appUrl: config.appUrl,
      fetch: recordedFetch,
    });
    return {
      model: provider.chat(config.model, config.modelSettings),
      identity: { provider: 'openrouter', model: config.model },
      inference: inferenceSettings(config),
      requests: () => structuredClone(requests),
      retainedRequests: () => structuredClone(retainedRequests),
      preflight,
    };
  }

  const apiKey = readKey(config.apiKeyEnv, config.baseURL.includes('localhost') || config.baseURL.includes('127.0.0.1'));
  const provider = createOpenAICompatible({
    name: config.name ?? 'openai-compatible',
    baseURL: config.baseURL,
    apiKey: apiKey || 'no-key-required',
    headers: config.headers,
    fetch: recordedFetch,
  });
  return {
    model: provider.chatModel(config.model),
    identity: { provider: config.name ?? 'openai-compatible', model: config.model },
    inference: inferenceSettings(config),
    requests: () => structuredClone(requests),
    retainedRequests: () => structuredClone(retainedRequests),
    preflight,
  };
}

export async function assertToolCapability(config, { fetch: fetchImplementation = globalThis.fetch } = {}) {
  validateConfig(config);
  if (config.provider === 'openai-compatible') {
    if (config.capabilities?.tools !== true) {
      throw new Error('generic OpenAI-compatible models need an explicit capabilities.tools=true claim');
    }
    return { tools: true, source: 'config' };
  }

  const apiKey = readKey(config.apiKeyEnv ?? 'OPENROUTER_API_KEY', false);
  const modelPath = config.model.split('/').map(encodeURIComponent).join('/');
  const response = await fetchImplementation(`https://openrouter.ai/api/v1/model/${modelPath}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`OpenRouter model lookup returned ${response.status} for ${config.model}`);
  const payload = await response.json();
  const model = payload?.data;
  if (!model || typeof model !== 'object') throw new Error('OpenRouter model lookup returned no model data');
  if (!Array.isArray(model.supported_parameters) || !model.supported_parameters.includes('tools')) {
    throw new Error(`OpenRouter model ${config.model} does not declare tool support`);
  }
  return { tools: true, source: 'openrouter', model: model.id ?? config.model };
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('model config must be an object');
  if (!['openrouter', 'openai-compatible'].includes(config.provider)) throw new Error('provider must be openrouter or openai-compatible');
  if (typeof config.model !== 'string' || !config.model.trim()) throw new Error('model config needs a model id');
  if (config.provider === 'openai-compatible' && (typeof config.baseURL !== 'string' || !config.baseURL.trim())) {
    throw new Error('openai-compatible config needs a baseURL');
  }
  validatePositiveInteger(config.maxSteps, 'maxSteps');
  validatePositiveInteger(config.maxOutputTokens, 'maxOutputTokens');
  if (config.maxRetries !== undefined && (!Number.isInteger(config.maxRetries) || config.maxRetries < 0)) {
    throw new Error('maxRetries must be a non-negative integer');
  }
}

function validatePositiveInteger(value, name) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function inferenceSettings(config) {
  return {
    ...(config.maxSteps === undefined ? {} : { maxSteps: config.maxSteps }),
    ...(config.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.maxOutputTokens }),
    ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }),
  };
}

function readKey(environmentName, optional) {
  if (!environmentName) {
    if (optional) return undefined;
    throw new Error('model config needs an API key environment variable');
  }
  const value = process.env[environmentName]?.trim();
  if (!value && !optional) throw new Error(`${environmentName} is not set`);
  return value;
}

function recordRequest(url, init) {
  const encodedBody = typeof init.body === 'string'
    ? init.body
    : init.body === undefined ? '' : Object.prototype.toString.call(init.body);
  let body = init.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = { unparsed: body.slice(0, 16_384) }; }
  } else if (body !== undefined) {
    body = { kind: Object.prototype.toString.call(body) };
  }
  return {
    url: String(url),
    method: init.method ?? 'GET',
    headerNames: [...new Headers(init.headers).keys()].filter(name => name.toLowerCase() !== 'authorization').sort(),
    body: body ?? null,
    bodyBytes: Buffer.byteLength(encodedBody),
    bodySha256: createHash('sha256').update(encodedBody).digest('hex'),
  };
}

function retainedRequest(request) {
  const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {};
  return {
    format: 'music-provider-request-1',
    url: request.url,
    method: request.method,
    headerNames: request.headerNames,
    bodyBytes: request.bodyBytes,
    bodySha256: request.bodySha256,
    model: typeof body.model === 'string' ? body.model : null,
    messageCount: Array.isArray(body.messages) ? body.messages.length : null,
    toolNames: Array.isArray(body.tools)
      ? body.tools.map(candidate => candidate?.function?.name).filter(name => typeof name === 'string')
      : [],
  };
}
