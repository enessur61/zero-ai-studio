import assert from 'node:assert/strict';
import { isPiperWorkerAllowed } from '../server/piperWorkerReadiness.ts';

assert.equal(isPiperWorkerAllowed({}), false);
assert.equal(isPiperWorkerAllowed({ ZERO_PIPER_WORKER_ENABLED: 'true' }), false);
assert.equal(isPiperWorkerAllowed({ ZERO_PIPER_WORKER_COSTS_CONFIRMED: 'true' }), false);
assert.equal(isPiperWorkerAllowed({
  ZERO_PIPER_WORKER_ENABLED: 'true',
  ZERO_PIPER_WORKER_COSTS_CONFIRMED: 'true',
}), true);

console.log('Piper worker default-deny readiness tests passed.');
