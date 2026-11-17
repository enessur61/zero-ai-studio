import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCloudflareWorkersAiAllowed,
  isCloudflareWorkersAiAllowed,
} from '../server/cloudflareBudgetGate.ts';

test('Cloudflare is fail-closed when no explicit opt-in exists', () => {
  assert.equal(isCloudflareWorkersAiAllowed({}), false);
  assert.throws(() => assertCloudflareWorkersAiAllowed({}), /gesperrt/i);
});

test('Cloudflare stays blocked when only one operator attestation is set', () => {
  assert.equal(isCloudflareWorkersAiAllowed({ ZERO_CLOUDFLARE_AI_ENABLED: 'true' }), false);
  assert.equal(isCloudflareWorkersAiAllowed({ ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'true' }), false);
});

test('Cloudflare requires exact true values for both opt-in flags', () => {
  assert.equal(isCloudflareWorkersAiAllowed({
    ZERO_CLOUDFLARE_AI_ENABLED: 'TRUE',
    ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'true',
  }), false);
  assert.equal(isCloudflareWorkersAiAllowed({
    ZERO_CLOUDFLARE_AI_ENABLED: 'true',
    ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'true',
  }), true);
  assert.doesNotThrow(() => assertCloudflareWorkersAiAllowed({
    ZERO_CLOUDFLARE_AI_ENABLED: 'true',
    ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'true',
  }));
});
