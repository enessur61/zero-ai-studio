import assert from 'node:assert/strict';
import { isPiperWorkerHealthPayload, PIPER_WORKER_HEALTH_EXPECTED } from '../server/piperWorkerHealth.ts';

const valid = {
  ok: true,
  auth_configured: true,
  engine: PIPER_WORKER_HEALTH_EXPECTED.engine,
  model_id: PIPER_WORKER_HEALTH_EXPECTED.modelId,
  voice: PIPER_WORKER_HEALTH_EXPECTED.modelId,
  engine_version: PIPER_WORKER_HEALTH_EXPECTED.engineVersion,
  model_revision: PIPER_WORKER_HEALTH_EXPECTED.modelRevision,
  engine_license: PIPER_WORKER_HEALTH_EXPECTED.engineLicense,
  voice_dataset_license: PIPER_WORKER_HEALTH_EXPECTED.voiceDatasetLicense,
  voice_training_base: PIPER_WORKER_HEALTH_EXPECTED.voiceTrainingBase,
  model_sha256: PIPER_WORKER_HEALTH_EXPECTED.modelSha256,
  cost_eur: 0,
  paid_fallback: false,
  commercial_use_confirmed: false,
  voice_loaded: false,
};

assert.equal(isPiperWorkerHealthPayload(valid), true);
assert.equal(isPiperWorkerHealthPayload(null), false);
assert.equal(isPiperWorkerHealthPayload([]), false);
assert.equal(isPiperWorkerHealthPayload({ ...valid, model_sha256: 'wrong' }), false);
assert.equal(isPiperWorkerHealthPayload({ ...valid, engine_version: '1.3.0' }), false);
assert.equal(isPiperWorkerHealthPayload({ ...valid, engine_license: 'MIT' }), false);
assert.equal(isPiperWorkerHealthPayload({ ...valid, voice_dataset_license: 'unknown' }), false);
assert.equal(isPiperWorkerHealthPayload({ ...valid, cost_eur: 0.01 }), false);
assert.equal(isPiperWorkerHealthPayload({ ...valid, paid_fallback: true }), false);
assert.equal(isPiperWorkerHealthPayload({ ...valid, commercial_use_confirmed: true }), false);

console.log('Piper worker health metadata gate tests passed.');
