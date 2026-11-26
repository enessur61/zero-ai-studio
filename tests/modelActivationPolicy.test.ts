import assert from 'node:assert/strict';
import { INITIAL_MODEL_CATALOG } from '../server/modelCatalog.ts';
import {
  getAutomaticFreeCloudModelIds,
  getAutomaticModelActivationDecision,
  reconcileAutomaticModelActivation,
} from '../server/modelActivationPolicy.ts';
import { WEBGPU_LOCAL_MODELS } from '../lib/webgpuLocalModel.ts';

const now = new Date('2026-11-26T12:00:00.000Z');
const env = {
  DATABASE_URL: 'postgres://zero:test@127.0.0.1:5432/zero',
  ZERO_COST_GUARD_ENABLED: 'true',
  ZERO_COST_GUARD_FREE_ONLY_CONFIRMED: 'true',
  ZERO_COST_GUARD_DAILY_REQUEST_LIMIT: '100',
  ZERO_COST_RESOURCE_GUARD_ENABLED: 'true',
  ZERO_COST_RESOURCE_GUARD_FREE_ONLY_CONFIRMED: 'true',
  ZERO_CLOUDFLARE_AI_ENABLED: 'true',
  ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'true',
  CLOUDFLARE_ACCOUNT_ID: 'test-account',
  CLOUDFLARE_API_TOKEN: 'test-token',
  ZERO_GEMINI_FREE_TIER_ONLY: 'true',
  GEMINI_API_KEY: 'test-gemini-key',
};

assert.equal(INITIAL_MODEL_CATALOG.length, 49, 'catalog audit must cover all 49 definitions after Piper worker separation');
assert.equal(new Set(INITIAL_MODEL_CATALOG.map((model) => model.id)).size, 49, 'catalog IDs must be unique');
assert.equal(getAutomaticFreeCloudModelIds().length, 12, 'only the explicit 12-model free-cloud allowlist is auto-managed');

const byId = (id: string) => {
  const model = INITIAL_MODEL_CATALOG.find((entry) => entry.id === id);
  assert.ok(model, `missing catalog model: ${id}`);
  return model;
};

for (const id of getAutomaticFreeCloudModelIds()) {
  const model = {
    ...byId(id),
    enabled: false,
    hasRealAdapter: true,
    testPassed: true,
    status: 'FUNKTIONIERT' as const,
    lastTestedAt: now.toISOString(),
  };
  const decision = getAutomaticModelActivationDecision(model, now, env);
  assert.equal(decision.managed, true, id);
  assert.equal(decision.eligible, true, `${id}: ${decision.reason}`);
  reconcileAutomaticModelActivation(model, now, env);
  assert.equal(model.enabled, true, `${id} should auto-activate after a fresh verified test`);
}

const first = {
  ...byId('cloudflare-glm-4.7-flash'),
  enabled: true,
  hasRealAdapter: true,
  testPassed: true,
  status: 'FUNKTIONIERT' as const,
  lastTestedAt: now.toISOString(),
};
for (const [name, changedEnv] of [
  ['missing shared cost guard', { ...env, ZERO_COST_GUARD_ENABLED: 'false' }],
  ['missing resource guard', { ...env, ZERO_COST_RESOURCE_GUARD_ENABLED: 'false' }],
  ['missing PostgreSQL', { ...env, DATABASE_URL: '' }],
  ['missing Cloudflare free-plan confirmation', { ...env, ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'false' }],
  ['missing Cloudflare credentials', { ...env, CLOUDFLARE_API_TOKEN: '' }],
] as const) {
  const model = { ...first };
  const decision = reconcileAutomaticModelActivation(model, now, changedEnv);
  assert.equal(decision.eligible, false, name);
  assert.equal(model.enabled, false, name);
}

const gemini = {
  ...byId('gemini-3.8-flash'),
  enabled: true,
  hasRealAdapter: true,
  testPassed: true,
  status: 'FUNKTIONIERT' as const,
  lastTestedAt: now.toISOString(),
};
for (const [name, changedEnv] of [
  ['Gemini free-only flag', { ...env, ZERO_GEMINI_FREE_TIER_ONLY: 'false' }],
  ['Gemini API key', { ...env, GEMINI_API_KEY: '' }],
] as const) {
  const model = { ...gemini };
  assert.equal(reconcileAutomaticModelActivation(model, now, changedEnv).eligible, false, name);
  assert.equal(model.enabled, false, name);
}

for (const [name, lastTestedAt] of [
  ['missing test timestamp', null],
  ['stale test', new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString()],
  ['future test', new Date(now.getTime() + 60_000).toISOString()],
] as const) {
  const model = { ...gemini, lastTestedAt };
  assert.equal(reconcileAutomaticModelActivation(model, now, env).eligible, false, name);
  assert.equal(model.enabled, false, name);
}

for (const patch of [
  { testPassed: false },
  { hasRealAdapter: false },
  { status: 'INSTALLATION ERFORDERLICH' as const },
  { requiresPaidKey: true },
  { requiresExternalGpu: true },
  { costEur: 0.01 },
  { version: 'unverified-version' },
  { adapterId: 'disabled-unverified-cloud-adapter' },
] as const) {
  const model = { ...gemini, ...patch };
  assert.equal(reconcileAutomaticModelActivation(model, now, env).eligible, false, JSON.stringify(patch));
  assert.equal(model.enabled, false, JSON.stringify(patch));
}

const legacyGrounding = { ...byId('gemini-web-grounding'), enabled: true };
const unmanaged = reconcileAutomaticModelActivation(legacyGrounding, now, env);
assert.equal(unmanaged.managed, false);
assert.equal(legacyGrounding.enabled, true, 'manual/unmanaged availability flags are not rewritten by the cloud auto-policy');

const localCreative = { ...byId('zero-canvas-img2img'), enabled: true };
assert.equal(reconcileAutomaticModelActivation(localCreative, now, env).managed, false);
assert.equal(localCreative.enabled, true, 'local browser availability remains separately user/runtime controlled');

const llamaPreset = WEBGPU_LOCAL_MODELS.find((entry) => entry.id === 'webgpu-llama-3.2-1b');
const smollmPreset = WEBGPU_LOCAL_MODELS.find((entry) => entry.id === 'smollm2-360m-webgpu');
assert.ok(llamaPreset, 'Llama 3.2 1B must have an explicit runtime preset');
assert.equal(llamaPreset.modelId, 'Llama-3.2-1B-Instruct-q4f16_1-MLC');
assert.equal(llamaPreset.downloadMB, 705);
assert.equal(llamaPreset.vramMB, 879);
assert.ok(smollmPreset, 'SmolLM2 360M must have an explicit runtime preset');
assert.equal(smollmPreset.modelId, 'SmolLM2-360M-Instruct-q4f32_1-MLC');
assert.equal(smollmPreset.vramMB, 580);
for (const id of ['webgpu-llama-3.2-1b', 'smollm2-360m-webgpu']) {
  const catalogModel = byId(id);
  assert.equal(catalogModel.adapterId, 'webllm');
  assert.equal(catalogModel.hasRealAdapter, true);
  assert.equal(catalogModel.status, 'BROWSER TEST ERFORDERLICH');
  assert.equal(catalogModel.testPassed, false, 'runtime presence is not a successful device inference test');
}
const iosPiper = byId('piper-tts-de');
const workerPiper = byId('piper-tts-de-worker');
assert.equal(iosPiper.adapterId, 'ios-piper-onnx');
assert.equal(iosPiper.executionMode, 'LOCAL ON-DEVICE');
assert.equal(iosPiper.hasRealAdapter, false, 'iOS model weights and runtime remain unverified');
assert.match(iosPiper.license, /GPL-3\.0-or-later/);
assert.match(iosPiper.license, /NOT VERIFIED/);
assert.equal(workerPiper.adapterId, 'piper-cpu-worker');
assert.equal(workerPiper.executionMode, 'SELF-HOSTED');
assert.equal(workerPiper.hasRealAdapter, true);
assert.equal(workerPiper.enabled, false);
assert.equal(workerPiper.testPassed, false, 'CI worker test is not production worker activation');
assert.match(workerPiper.license, /GPL-3\.0-or-later/);
assert.match(workerPiper.license, /CC0/);
assert.match(workerPiper.commercialUse, /commercial_use_confirmed=false/);
const implementedWebGpuIds = new Set(WEBGPU_LOCAL_MODELS.map((entry) => entry.id));
assert.deepEqual([...implementedWebGpuIds].sort(), ['smollm2-360m-webgpu', 'webgpu-llama-3.2-1b'].sort());
const webGpuCatalog = INITIAL_MODEL_CATALOG.filter((model) => model.adapterId === 'webllm');
assert.equal(webGpuCatalog.length, 11);
for (const model of webGpuCatalog) {
  if (!implementedWebGpuIds.has(model.id)) {
    assert.equal(model.hasRealAdapter, false, `${model.id} must not claim a runtime adapter absent from the runtime allowlist`);
    assert.equal(model.status, 'ADAPTER FEHLT', model.id);
  }
}

console.log('Model activation policy tests passed: 48 unique catalog entries, 12 gated free-cloud models, 24h freshness, provider/cost gates, no unverified activation, and WebLLM runtime/catalog parity.');
