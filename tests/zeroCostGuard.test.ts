import assert from 'node:assert/strict';
import {
  assertZeroCostProviderAllowed,
  getZeroCostGuardStatus,
  isSameOriginRequest,
  reserveZeroCostProviderRequest,
  reserveZeroCostProviderRequestWithPool,
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
  () => assertZeroCostProviderAllowed(request, { ...base, ZERO_COST_GUARD_DAILY_REQUEST_LIMIT: '100001' }),
  (error: unknown) => error instanceof ZeroCostGuardError && error.code === 'INVALID_BUDGET',
);

// The dashboard must apply the exact same 1..100000 configuration bounds.
const fakeStatusPool = {
  connect: async () => ({
    query: async (sql: string) => {
      if (sql.includes("SELECT day_utc::text")) return { rows: [] };
      if (sql.includes('SELECT created_at')) return { rows: [] };
      return { rows: [] };
    },
    release: () => undefined,
  }),
} as never;
const invalidDashboardStatus = await getZeroCostGuardStatus(fakeStatusPool, {
  ...base,
  ZERO_COST_GUARD_DAILY_REQUEST_LIMIT: '100001',
});
assert.equal(invalidDashboardStatus.configured, false);
assert.equal(invalidDashboardStatus.providers.cloudflare, 'GESPERRT');

assert.equal(invalidDashboardStatus.providers.gemini, 'GESPERRT');
const credentialsMissingStatus = await getZeroCostGuardStatus(fakeStatusPool, base);
assert.equal(credentialsMissingStatus.providers.cloudflare, 'GESPERRT');
assert.equal(credentialsMissingStatus.providers.gemini, 'GESPERRT');
const credentialsPresentStatus = await getZeroCostGuardStatus(fakeStatusPool, {
  ...base, CLOUDFLARE_ACCOUNT_ID: 'test-account', CLOUDFLARE_API_TOKEN: 'test-token', GEMINI_API_KEY: 'test-key',
});
assert.equal(credentialsPresentStatus.providers.cloudflare, 'FREIGEGEBEN');
assert.equal(credentialsPresentStatus.providers.gemini, 'FREIGEGEBEN');

await assert.rejects(
  () => reserveZeroCostProviderRequestWithPool({
    connect: async () => { throw new Error('injected connect failure'); },
  } as never, request, base),
  (error: unknown) => error instanceof ZeroCostGuardError && error.code === 'PERSISTENCE_ERROR',
);
let releasedAfterSqlFailure = false;
const sqlFailurePool = {
  connect: async () => ({
    query: async (sql: string) => {
      if (sql === 'ROLLBACK') return { rows: [] };
      throw new Error('injected SQL failure');
    },
    release: () => { releasedAfterSqlFailure = true; },
  }),
} as never;
await assert.rejects(
  () => reserveZeroCostProviderRequestWithPool(sqlFailurePool, request, base),
  (error: unknown) => error instanceof ZeroCostGuardError && error.code === 'PERSISTENCE_ERROR',
);
assert.equal(releasedAfterSqlFailure, true);


// State-changing browser requests require a literal, exact same-origin Origin.
assert.equal(isSameOriginRequest('https://zero.example', 'zero.example', 'https'), true);
assert.equal(isSameOriginRequest(undefined, 'zero.example', 'https'), false);
assert.equal(isSameOriginRequest('https://attacker.example', 'zero.example', 'https'), false);
assert.equal(isSameOriginRequest('null', 'zero.example', 'https'), false);
assert.equal(isSameOriginRequest('https://zero.example/path', 'zero.example', 'https'), false);
assert.equal(isSameOriginRequest('http://zero.example', 'zero.example', 'https'), false);
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
