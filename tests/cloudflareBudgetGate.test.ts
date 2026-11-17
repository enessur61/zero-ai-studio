import assert from 'node:assert/strict';
import {
  assertCloudflareWorkersAiAllowed,
  isCloudflareWorkersAiAllowed,
} from '../server/cloudflareBudgetGate.ts';

assert.equal(isCloudflareWorkersAiAllowed({}), false);
assert.throws(() => assertCloudflareWorkersAiAllowed({}), /gesperrt/i);

assert.equal(isCloudflareWorkersAiAllowed({ ZERO_CLOUDFLARE_AI_ENABLED: 'true' }), false);
assert.equal(isCloudflareWorkersAiAllowed({ ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'true' }), false);

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

console.log('Cloudflare budget gate tests passed.');
