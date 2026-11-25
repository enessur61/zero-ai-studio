import assert from 'node:assert/strict';
import { createWanWorkerStatusPayload, evaluateWanWorkerReadiness, isWanGpuAllowed } from '../server/wanWorkerReadiness.ts';

const healthy = {
  ok: true,
  engine: 'Wan 2.1',
  cuda_available: true,
  gpu_name: 'NVIDIA RTX 4090',
  gpu_vram_total_mb: 24576,
  gpu_vram_free_mb: 22000,
  model_cache_persistent: true,
  persistent_storage_configured: true,
  cost_gate_open: true,
  daily_job_limit: 3,
  daily_jobs_remaining: 2,
  max_concurrent_jobs: 1,
};
const base = {
  workerUrlConfigured: true,
  workerTokenConfigured: true,
  workerReachable: true,
  zeroCostGateOpen: true,
  payload: healthy,
};

const ready = evaluateWanWorkerReadiness(base);
assert.equal(ready.online, true);
assert.equal(ready.status, 'WORKER_ONLINE');
assert.equal(ready.readiness.length, 11);
assert.ok(ready.readiness.every((criterion) => criterion.ready));

const missingUrl = evaluateWanWorkerReadiness({ ...base, workerUrlConfigured: false });
assert.equal(missingUrl.online, false);
assert.equal(missingUrl.status, 'GPU_WORKER_NOT_CONFIGURED');
assert.equal(missingUrl.readiness.find((item) => item.id === 'worker_url')?.ready, false);

const missingToken = evaluateWanWorkerReadiness({ ...base, workerTokenConfigured: false });
assert.equal(missingToken.online, false);
assert.equal(missingToken.status, 'WORKER_TOKEN_MISSING');

const noGpu = evaluateWanWorkerReadiness({ ...base, payload: { ...healthy, cuda_available: false } });
assert.equal(noGpu.online, false);
assert.equal(noGpu.status, 'WORKER_GPU_UNAVAILABLE');

const insufficientVram = evaluateWanWorkerReadiness({ ...base, payload: { ...healthy, gpu_vram_total_mb: 8192 } });
assert.equal(insufficientVram.online, false);
assert.equal(insufficientVram.status, 'WORKER_GPU_VRAM_INSUFFICIENT');

const noModelCache = evaluateWanWorkerReadiness({ ...base, payload: { ...healthy, model_cache_persistent: false } });
assert.equal(noModelCache.online, false);
assert.equal(noModelCache.status, 'WORKER_MODEL_CACHE_NOT_PERSISTENT');

const noPersistentStorage = evaluateWanWorkerReadiness({
  ...base,
  payload: { ...healthy, persistent_storage_configured: false },
});
assert.equal(noPersistentStorage.online, false);
assert.equal(noPersistentStorage.status, 'WORKER_STORAGE_NOT_PERSISTENT');

const closedCostGate = evaluateWanWorkerReadiness({
  ...base,
  payload: { ...healthy, cost_gate_open: false },
});
assert.equal(closedCostGate.online, false);
assert.equal(closedCostGate.status, 'WORKER_COST_GATE_CLOSED');

const zeroCostGateClosed = evaluateWanWorkerReadiness({
  ...base,
  zeroCostGateOpen: false,
});
assert.equal(zeroCostGateClosed.online, false);
assert.equal(zeroCostGateClosed.status, 'ZERO_COST_GATE_CLOSED');

const exhaustedDailyLimit = evaluateWanWorkerReadiness({
  ...base,
  payload: { ...healthy, daily_jobs_remaining: 0 },
});
assert.equal(exhaustedDailyLimit.online, false);
assert.equal(exhaustedDailyLimit.status, 'WORKER_DAILY_LIMIT_REACHED');

const expandedDailyLimit = evaluateWanWorkerReadiness({
  ...base,
  payload: { ...healthy, daily_job_limit: 15, daily_jobs_remaining: 15 },
});
assert.equal(expandedDailyLimit.online, true);
assert.equal(expandedDailyLimit.dailyJobLimit, 15);

assert.equal(expandedDailyLimit.dailyJobsRemaining, 15);

// Regression: the actual Video Studio status payload must use all readiness gates,
// not merely a reachable HTTP endpoint and a CUDA device.
const healthyStatus = createWanWorkerStatusPayload(base);
assert.equal(healthyStatus.online, true);
assert.equal(healthyStatus.maxDurationSec, 60);
assert.equal(healthyStatus.costFallback, false);

for (const [name, payload, expectedStatus] of [
  ['worker cost gate', { ...healthy, cost_gate_open: false }, 'WORKER_COST_GATE_CLOSED'],
  ['daily quota', { ...healthy, daily_jobs_remaining: 0 }, 'WORKER_DAILY_LIMIT_REACHED'],
  ['persistent output storage', { ...healthy, persistent_storage_configured: false }, 'WORKER_STORAGE_NOT_PERSISTENT'],
  ['persistent model cache', { ...healthy, model_cache_persistent: false }, 'WORKER_MODEL_CACHE_NOT_PERSISTENT'],
  ['GPU VRAM', { ...healthy, gpu_vram_total_mb: 8192 }, 'WORKER_GPU_VRAM_INSUFFICIENT'],
]) {
  const status = createWanWorkerStatusPayload({ ...base, payload });
  assert.equal(status.online, false, `Video Studio must not enable Wan when ${name} is unavailable`);
  assert.equal(status.status, expectedStatus);
}
const offlineStatus = createWanWorkerStatusPayload({ ...base, workerReachable: false });
assert.equal(offlineStatus.online, false);
assert.equal(offlineStatus.status, 'WORKER_OFFLINE');

const invalidDailyLimit = evaluateWanWorkerReadiness({
  ...base,
  payload: { ...healthy, daily_job_limit: 16 },
});
assert.equal(invalidDailyLimit.online, false);
assert.equal(invalidDailyLimit.status, 'WORKER_DAILY_LIMIT_REACHED');

const unreachable = evaluateWanWorkerReadiness({ ...base, workerReachable: false });
assert.equal(unreachable.online, false);
assert.equal(unreachable.status, 'WORKER_OFFLINE');

console.log('Wan worker readiness regression tests passed.');

assert.equal(isWanGpuAllowed({}), false);
assert.equal(isWanGpuAllowed({ ZERO_WAN_GPU_ENABLED: 'true' }), false);
assert.equal(isWanGpuAllowed({ ZERO_WAN_GPU_COSTS_CONFIRMED: 'true' }), false);
assert.equal(isWanGpuAllowed({ ZERO_WAN_GPU_ENABLED: 'true', ZERO_WAN_GPU_COSTS_CONFIRMED: 'true' }), true);
