import assert from 'node:assert/strict';
import { enrichModelMetadata } from '../server/store.ts';
import { INITIAL_MODEL_CATALOG } from '../server/modelCatalog.ts';

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

console.log('Gemini free-tier privacy and billing disclosures passed.');
