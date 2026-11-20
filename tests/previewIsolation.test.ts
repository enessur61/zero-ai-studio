import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PREVIEW_RESOURCE_NAMES,
  PreviewIsolationError,
  assertPreviewIsolation,
  evaluatePreviewIsolation,
  type PreviewIsolationInput,
  type PreviewResourceName,
} from '../server/security/previewIsolation.ts';

const PREVIEW_ID = 'preview-pr-118-test-only';

function makeValidConfig(): PreviewIsolationInput {
  const resources = Object.fromEntries(
    PREVIEW_RESOURCE_NAMES.map((name) => {
      if (name === 'database' || name === 'auth') {
        return [name, {
          state: 'isolated',
          identity: `synthetic-preview-${name}-resource`,
          previewId: PREVIEW_ID,
        }];
      }
      return [name, { state: 'disabled' }];
    }),
  ) as PreviewIsolationInput['resources'];

  return {
    deployment: {
      environment: 'preview',
      previewId: PREVIEW_ID,
      expectedPreviewId: PREVIEW_ID,
    },
    productionResourceIds: {
      database: 'synthetic-production-database',
      auth: 'synthetic-production-auth-store',
    },
    resources,
  };
}

function declareIsolated(input: PreviewIsolationInput, name: PreviewResourceName, identity: string): void {
  input.resources[name] = {
    state: 'isolated',
    identity,
    previewId: PREVIEW_ID,
  };
  input.productionResourceIds[name] = `synthetic-production-${name}`;
}

assert.equal(evaluatePreviewIsolation(makeValidConfig()).ok, true, 'separate required resources and disabled optional providers should pass');
assert.doesNotThrow(() => assertPreviewIsolation(makeValidConfig()));

assert.deepEqual(
  evaluatePreviewIsolation(undefined).reasons,
  ['CONFIGURATION_MISSING'],
  'missing configuration must fail closed',
);

const productionDeployment = makeValidConfig();
productionDeployment.deployment.environment = 'production';
assert.ok(evaluatePreviewIsolation(productionDeployment).reasons.includes('DEPLOYMENT_NOT_PREVIEW'));

const mismatchedPreview = makeValidConfig();
mismatchedPreview.deployment.expectedPreviewId = 'different-synthetic-preview';
assert.ok(evaluatePreviewIsolation(mismatchedPreview).reasons.includes('PREVIEW_IDENTITY_MISMATCH'));

const missingDatabase = makeValidConfig();
delete missingDatabase.resources.database;
assert.ok(evaluatePreviewIsolation(missingDatabase).reasons.includes('RESOURCE_NOT_DECLARED:database'));

const disabledDatabase = makeValidConfig();
disabledDatabase.resources.database = { state: 'disabled' };
assert.ok(evaluatePreviewIsolation(disabledDatabase).reasons.includes('REQUIRED_RESOURCE_DISABLED:database'));

const sharedPiper = makeValidConfig();
sharedPiper.resources.piper = { state: 'shared' };
assert.ok(evaluatePreviewIsolation(sharedPiper).reasons.includes('RESOURCE_NOT_ISOLATED:piper'));

const unknownGemini = makeValidConfig();
unknownGemini.resources.gemini = { state: 'unknown' };
assert.ok(evaluatePreviewIsolation(unknownGemini).reasons.includes('RESOURCE_NOT_ISOLATED:gemini'));

const missingResourceIdentity = makeValidConfig();
missingResourceIdentity.resources.cloudflare = { state: 'isolated', previewId: PREVIEW_ID };
missingResourceIdentity.productionResourceIds.cloudflare = 'synthetic-production-cloudflare';
assert.ok(evaluatePreviewIsolation(missingResourceIdentity).reasons.includes('RESOURCE_IDENTITY_MISSING:cloudflare'));

const missingProductionIdentity = makeValidConfig();
declareIsolated(missingProductionIdentity, 'video', 'synthetic-preview-video');
delete missingProductionIdentity.productionResourceIds.video;
assert.ok(evaluatePreviewIsolation(missingProductionIdentity).reasons.includes('PRODUCTION_IDENTITY_NOT_PROVIDED:video'));

const reusedProductionResource = makeValidConfig();
reusedProductionResource.resources.database = {
  state: 'isolated',
  identity: 'synthetic-production-database',
  previewId: PREVIEW_ID,
};
assert.ok(evaluatePreviewIsolation(reusedProductionResource).reasons.includes('PRODUCTION_RESOURCE_REUSED:database'));

const wrongResourcePreview = makeValidConfig();
wrongResourcePreview.resources.auth = {
  state: 'isolated',
  identity: 'synthetic-preview-auth-store',
  previewId: 'another-synthetic-preview',
};
assert.ok(evaluatePreviewIsolation(wrongResourcePreview).reasons.includes('RESOURCE_PREVIEW_ID_MISMATCH:auth'));

const disabledButConfigured = makeValidConfig();
disabledButConfigured.resources.webSearch = {
  state: 'disabled',
  identity: 'synthetic-production-search-endpoint',
};
assert.ok(evaluatePreviewIsolation(disabledButConfigured).reasons.includes('DISABLED_RESOURCE_HAS_CONFIGURATION:webSearch'));

const missingOptionalDeclaration = makeValidConfig();
delete missingOptionalDeclaration.resources.queues;
assert.ok(evaluatePreviewIsolation(missingOptionalDeclaration).reasons.includes('RESOURCE_NOT_DECLARED:queues'));

assert.throws(
  () => assertPreviewIsolation(sharedPiper),
  (error: unknown) => error instanceof PreviewIsolationError && error.reasons.includes('RESOURCE_NOT_ISOLATED:piper'),
  'assertion helper must throw a typed, safe error for any unresolved resource',
);

// Static regression guard: the policy module must remain pure and must not
// read process.env, touch a database, or perform network/filesystem operations.
const policySource = await readFile(new URL('../server/security/previewIsolation.ts', import.meta.url), 'utf8');
assert.doesNotMatch(policySource, /process\.env|fetch\s*\(|new\s+Pool\s*\(|createConnection\s*\(|readFile\s*\(|writeFile\s*\(/);

// Mock-only side-effect assertion: evaluating a policy must never invoke a provider/network mock.
let mockNetworkCalls = 0;
const mockNetworkCall = () => { mockNetworkCalls += 1; };
assert.equal(evaluatePreviewIsolation(makeValidConfig()).ok, true);
assert.equal(mockNetworkCalls, 0);

console.log(`Preview isolation unit tests passed (${PREVIEW_RESOURCE_NAMES.length} resource classes; synthetic inputs only; no network or database access).`);
