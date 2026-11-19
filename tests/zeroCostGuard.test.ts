import assert from 'node:assert/strict';
import {
  assertZeroCostProviderAllowed,
  reserveZeroCostProviderRequest,
  ZeroCostGuardError,
} from '../server/zeroCostGuard.ts';

const base = {
  ZERO_COST_GUARD_ENABLED: 'true',
  ZERO_COST_GUARD_FREE_ONLY_CONFIRMED: 'true',
  ZERO_COST_GUARD_DAILY_REQUEST_LIMIT: '250',
  ZERO_CLOUDFLARE_AI_ENABLED: 'true',
  ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'true',
  ZERO_GEMINI_FREE_TIER_ONLY: 'true',
  DATABASE_URL: 'postgresql://test-only.invalid/never-used',
  NODE_ENV: 'test',
};

const request = {
  provider: 'cloudflare-workers-ai' as const,
  modelId: '@cf/zai-org/glm-4.7-flash',
  studio: 'ZERO CORE',
  action: 'UNIT_TEST',
};

assert.equal(assertZeroCostProviderAllowed(request, base), 250);
assert.throws(
  () => assertZeroCostProviderAllowed(request, { ...base, ZERO_COST_GUARD_ENABLED: 'false' }),
  (error: unknown) => error instanceof ZeroCostGuardError && error.code === 'GUARD_DISABLED',
);
assert.throws(
  () => assertZeroCostProviderAllowed(request, { ...base, ZERO_COST_GUARD_DAILY_REQUEST_LIMIT: '0' }),
  (error: unknown) => error instanceof ZeroCostGuardError && error.code === 'INVALID_BUDGET',
);
assert.throws(
  () => assertZeroCostProviderAllowed({ ...request, modelId: '@cf/vendor/paid-model' }, base),
  (error: unknown) => error instanceof ZeroCostGuardError && error.code === 'MODEL_NOT_ALLOWLISTED',
);
assert.throws(
  () => assertZeroCostProviderAllowed(request, { ...base, ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'false' }),
  (error: unknown) => error instanceof ZeroCostGuardError && error.code === 'PROVIDER_DISABLED',
);
assert.throws(
  () => assertZeroCostProviderAllowed({ ...request, provider: 'paid-provider' as never }, base),
  (error: unknown) => error instanceof ZeroCostGuardError && error.code === 'PROVIDER_NOT_ALLOWLISTED',
);
await assert.rejects(
  () => reserveZeroCostProviderRequest(request, { ...base, DATABASE_URL: '' }),
  (error: unknown) => error instanceof ZeroCostGuardError && error.code === 'PERSISTENCE_UNAVAILABLE',
);

console.log('ZERO COST GUARD policy tests passed (no provider/network calls).');
