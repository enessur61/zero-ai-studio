import assert from 'node:assert/strict';
import { classifyGeminiResourceError, classifyGeminiResourceType } from '../server/geminiClient.ts';
import {
  getZeroResourceLimits,
  validateZeroResourceOperation,
  withZeroCostResourceOperation,
  ZeroResourceGuardError,
  type ZeroResourceOperationInput,
} from '../server/zeroCostResourceGuard.ts';

const env = {
  ZERO_COST_GUARD_ENABLED: 'true', ZERO_COST_GUARD_FREE_ONLY_CONFIRMED: 'true',
  ZERO_CLOUDFLARE_AI_ENABLED: 'true', ZERO_COST_RESOURCE_GUARD_ENABLED: 'true',
  ZERO_COST_RESOURCE_GUARD_FREE_ONLY_CONFIRMED: 'true',
  ZERO_COST_GUARD_DAILY_REQUEST_LIMIT: '100',
  ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'true',
  ZERO_GEMINI_FREE_TIER_ONLY: 'true',
  NODE_ENV: 'test',
};
const base: ZeroResourceOperationInput = {
  provider: 'cloudflare-workers-ai', modelId: '@cf/zai-org/glm-4.7-flash',
  resourceType: 'text', studio: 'UNIT', action: 'TEST', payload: { prompt: 'hello' }, inputChars: 5,
};
const rejectsCode = (code: string) => (error: unknown) => error instanceof ZeroResourceGuardError && error.code === code;

assert.equal(getZeroResourceLimits(env).text.dailyUnits, 20);
assert.equal(getZeroResourceLimits(env).image.dailyUnits, 5);
assert.equal(getZeroResourceLimits(env).audio.dailyUnits, 10);
assert.equal(getZeroResourceLimits(env).video.dailyUnits, 12);
assert.equal(getZeroResourceLimits(env).text.concurrency, 3);
assert.equal(getZeroResourceLimits(env).image.concurrency, 1);
assert.equal(getZeroResourceLimits(env).audio.concurrency, 1);
assert.equal(getZeroResourceLimits(env).video.concurrency, 1);
assert.equal(classifyGeminiResourceType('gemini-3.8-flash', '{"mimeType":"video/mp4"}'), 'video');
assert.equal(classifyGeminiResourceType('gemini-3.8-flash', '{"mimeType":"image/png"}'), 'image');
assert.equal(classifyGeminiResourceType('gemini-3.8-flash', '{"mimeType":"audio/wav"}'), 'audio');
assert.equal(classifyGeminiResourceType('gemini-3.8-flash-tts', '{"text":"hello"}'), 'audio');
assert.equal(classifyGeminiResourceType('gemini-3.8-flash', '{"text":"hello"}'), 'text');
assert.equal(classifyGeminiResourceError(new Error('429 RESOURCE_EXHAUSTED')), 'FAILED');
assert.equal(classifyGeminiResourceError(new Error('HTTP 403 PERMISSION_DENIED')), 'FAILED');
assert.equal(classifyGeminiResourceError(new Error('503 UNAVAILABLE')), 'UNKNOWN');
assert.equal(classifyGeminiResourceError(new Error('socket hang up')), 'UNKNOWN');
assert.throws(() => validateZeroResourceOperation(base, { ...env, ZERO_COST_RESOURCE_GUARD_ENABLED: 'false' }), rejectsCode('GUARD_DISABLED'));
assert.throws(() => validateZeroResourceOperation(base, { ...env, ZERO_COST_RESOURCE_GUARD_FREE_ONLY_CONFIRMED: 'false' }), rejectsCode('GUARD_DISABLED'));
assert.throws(() => validateZeroResourceOperation(base, { ...env, ZERO_COST_GUARD_DAILY_REQUEST_LIMIT: '0' }), rejectsCode('INVALID_BUDGET'));
assert.throws(() => validateZeroResourceOperation(base, { ...env, ZERO_COST_GUARD_DAILY_REQUEST_LIMIT: '100001' }), rejectsCode('INVALID_BUDGET'));
assert.throws(() => validateZeroResourceOperation(base, { ...env, ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'false' }), rejectsCode('PROVIDER_DISABLED'));
assert.throws(() => validateZeroResourceOperation({ ...base, provider: 'google-gemini-free', modelId: 'gemini-3.8-flash' }, { ...env, ZERO_GEMINI_FREE_TIER_ONLY: 'false' }), rejectsCode('PROVIDER_DISABLED'));
assert.throws(() => validateZeroResourceOperation({ ...base, provider: 'google-gemini-free', modelId: 'gemini-paid-pro' }, env), rejectsCode('MODEL_NOT_ALLOWLISTED'));
assert.throws(() => validateZeroResourceOperation({ ...base, modelId: '' }, env), rejectsCode('INVALID_METADATA'));
assert.throws(() => validateZeroResourceOperation({ ...base, modelId: '@cf/vendor/paid-model' }, env), rejectsCode('MODEL_NOT_ALLOWLISTED'));
assert.throws(() => validateZeroResourceOperation(base, { ...env, ZERO_CLOUDFLARE_AI_ENABLED: 'false' }), rejectsCode('PROVIDER_DISABLED'));
assert.throws(() => validateZeroResourceOperation(base, { ...env, ZERO_COST_GUARD_ENABLED: 'false' }), rejectsCode('GUARD_DISABLED'));
assert.throws(() => validateZeroResourceOperation({ ...base, studio: '' }, env), rejectsCode('INVALID_METADATA'));
assert.throws(() => validateZeroResourceOperation({ ...base, action: '' }, env), rejectsCode('INVALID_METADATA'));
assert.throws(() => validateZeroResourceOperation({ ...base, units: 0 }, env), rejectsCode('INVALID_UNITS'));
assert.throws(() => validateZeroResourceOperation({ ...base, units: 21 }, env), rejectsCode('INVALID_UNITS'));
assert.throws(() => validateZeroResourceOperation({ ...base, inputBytes: 128_001 }, env), rejectsCode('INPUT_TOO_LARGE'));
assert.throws(() => validateZeroResourceOperation({ ...base, inputChars: 32_769 }, env), rejectsCode('INPUT_TOO_LARGE'));
assert.throws(() => validateZeroResourceOperation({ ...base, resourceType: 'audio', durationSeconds: 301 }, env), rejectsCode('DURATION_TOO_LONG'));
assert.throws(() => validateZeroResourceOperation({ ...base, idempotencyKey: 'tiny' }, env), rejectsCode('INVALID_IDEMPOTENCY_KEY'));
assert.throws(() => getZeroResourceLimits({ ...env, ZERO_RESOURCE_TEXT_DAILY_LIMIT: '0' }), rejectsCode('INVALID_LIMIT'));
assert.throws(() => getZeroResourceLimits({ ...env, ZERO_RESOURCE_IMAGE_CONCURRENCY: '21' }), rejectsCode('INVALID_LIMIT'));
assert.equal(validateZeroResourceOperation({ ...base, idempotencyKey: 'request-0001' }, env).text.dailyUnits, 20);
let providerExecutedWithoutDatabase = false;
await assert.rejects(
  () => withZeroCostResourceOperation({ ...base, env: { ...env, DATABASE_URL: undefined } }, async () => { providerExecutedWithoutDatabase = true; return 'must-not-run'; }, { ...env, DATABASE_URL: undefined }),
  (error: unknown) => error instanceof ZeroResourceGuardError && error.code === 'PERSISTENCE_UNAVAILABLE',
);
assert.equal(providerExecutedWithoutDatabase, false, 'missing PostgreSQL must block before provider execution');
console.log('ZERO resource guard policy tests passed (32 policy checks; no provider/network calls).');
