import assert from 'node:assert/strict';
import { enrichModelMetadata } from '../server/store.ts';
import { INITIAL_MODEL_CATALOG } from '../server/modelCatalog.ts';
import { runAllModelTests } from '../server/adapters.ts';
import type { ZeroDatabase } from '../server/store.ts';
import type { ModelDefinition } from '../src/types/zero.ts';

const privacyNotice = /Google kann Inhalte aus dem kostenlosen Gemini-API-Tarif zur Verbesserung seiner Produkte verwenden/;
const sensitiveDataWarning = /keine sensiblen personenbezogenen oder vertraulichen Daten/i;
const billingGateWarning = /ZERO_GEMINI_FREE_TIER_ONLY=true/;

const googleModels = INITIAL_MODEL_CATALOG.filter((model) => model.provider === 'Google GenAI Free Tier');
assert.ok(googleModels.length > 0, 'Google Gemini free-tier models must be present in the catalog');

for (const definition of googleModels) {
  const model = enrichModelMetadata(definition);
  assert.equal(model.freeTierType, 'EINGESCHRÄNKT KOSTENLOS (FREE TIER)');
  assert.match(model.prerequisites ?? '', privacyNotice, model.id);
  assert.match(model.prerequisites ?? '', sensitiveDataWarning, model.id);
  assert.match(model.prerequisites ?? '', billingGateWarning, model.id);
}

const groundingDefinition = INITIAL_MODEL_CATALOG.find((model) => model.id === 'gemini-web-grounding');
assert.ok(groundingDefinition, 'Legacy Gemini web grounding model must exist');
const grounding = enrichModelMetadata(groundingDefinition);
assert.match(grounding.prerequisites ?? '', privacyNotice);
assert.match(grounding.prerequisites ?? '', sensitiveDataWarning);
assert.match(grounding.prerequisites ?? '', billingGateWarning);

const cloudflareDefinition = INITIAL_MODEL_CATALOG.find((model) => model.id === 'cloudflare-glm-4.7-flash');
assert.ok(cloudflareDefinition, 'Cloudflare GLM model must exist');
const cloudflare = enrichModelMetadata(cloudflareDefinition);
assert.doesNotMatch(cloudflare.prerequisites ?? '', privacyNotice);

const unavailableCloudModels = ['sd-turbo-free', 'sana-free'].map((id) => ({
  id,
  enabled: false,
  status: 'ADAPTER FEHLT',
  testPassed: false,
  hasRealAdapter: false,
  requiresPaidKey: false,
  requiresExternalGpu: false,
  lastTestedAt: null,
  lastTestLatencyMs: null,
  lastTestMessage: '',
}) as ModelDefinition);
const unavailableCloudResult = await runAllModelTests({
  models: unavailableCloudModels,
} as unknown as ZeroDatabase);
for (const model of unavailableCloudResult.models) {
  assert.equal(model.enabled, false, model.id);
  assert.equal(model.testPassed, false, model.id);
  assert.equal(model.status, 'ADAPTER FEHLT', model.id);
  assert.equal(
    model.lastTestMessage,
    'Sicher deaktiviert: kein verifizierter, dauerhaft kostenloser Provider verfügbar.',
    model.id,
  );
  assert.doesNotMatch(model.lastTestMessage, /Pollinations|bereits verifiziert|Abkühlzeit/, model.id);
}

console.log('Gemini free-tier privacy and billing disclosures passed.');
