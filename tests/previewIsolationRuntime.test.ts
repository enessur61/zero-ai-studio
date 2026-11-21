import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PREVIEW_RESOURCE_NAMES } from '../server/security/previewIsolation.ts';
import { assertRuntimePreviewIsolation } from '../server/security/previewIsolationRuntime.ts';

const resources = Object.fromEntries(
  PREVIEW_RESOURCE_NAMES.map((name) => name === 'database' || name === 'auth'
    ? [name, { state: 'isolated', identity: `synthetic-preview-${name}`, previewId: 'preview-pr-118' }]
    : [name, { state: 'disabled' }]),
);
const productionResourceIds = {
  database: 'synthetic-production-database',
  auth: 'synthetic-production-auth',
};
const validPreviewEnv = {
  NODE_ENV: 'production',
  ZERO_DEPLOYMENT_ENV: 'preview',
  ZERO_PREVIEW_ISOLATION_ATTESTED: 'true',
  ZERO_PREVIEW_ID: 'preview-pr-118',
  ZERO_PREVIEW_EXPECTED_ID: 'preview-pr-118',
  ZERO_PREVIEW_RESOURCES_JSON: JSON.stringify(resources),
  ZERO_PRODUCTION_RESOURCE_IDS_JSON: JSON.stringify(productionResourceIds),
};

assert.doesNotThrow(() => assertRuntimePreviewIsolation(validPreviewEnv));
assert.doesNotThrow(() => assertRuntimePreviewIsolation({ NODE_ENV: 'test' }));
assert.doesNotThrow(() => assertRuntimePreviewIsolation({ NODE_ENV: 'development' }));
assert.doesNotThrow(() => assertRuntimePreviewIsolation({ NODE_ENV: 'production', ZERO_DEPLOYMENT_ENV: 'production' }));
assert.throws(() => assertRuntimePreviewIsolation({ NODE_ENV: 'production' }), /DEPLOYMENT_ENVIRONMENT_UNDECLARED/);
assert.throws(
  () => assertRuntimePreviewIsolation({ ...validPreviewEnv, ZERO_PREVIEW_ISOLATION_ATTESTED: 'false' }),
  /PREVIEW_ISOLATION_NOT_ATTESTED/,
);
assert.throws(
  () => assertRuntimePreviewIsolation({ ...validPreviewEnv, ZERO_PREVIEW_ID: 'different-preview' }),
  /PREVIEW_IDENTITY_MISMATCH/,
);
assert.throws(
  () => assertRuntimePreviewIsolation({ ...validPreviewEnv, ZERO_PREVIEW_RESOURCES_JSON: '' }),
  /PREVIEW_RESOURCE_MANIFEST_MISSING_OR_INVALID/,
);
const sharedResources = {
  ...resources,
  database: { state: 'isolated', identity: 'synthetic-production-database', previewId: 'preview-pr-118' },
};
assert.throws(
  () => assertRuntimePreviewIsolation({ ...validPreviewEnv, ZERO_PREVIEW_RESOURCES_JSON: JSON.stringify(sharedResources) }),
  /PRODUCTION_RESOURCE_REUSED:database/,
);
const undeclaredOptionalResource = { ...resources };
delete (undeclaredOptionalResource as Record<string, unknown>).queues;
assert.throws(
  () => assertRuntimePreviewIsolation({ ...validPreviewEnv, ZERO_PREVIEW_RESOURCES_JSON: JSON.stringify(undeclaredOptionalResource) }),
  /RESOURCE_NOT_DECLARED:queues/,
);

const serverSource = await readFile('server.ts', 'utf8');
assert.match(serverSource, /import \{ assertRuntimePreviewIsolation \} from '\.\/server\/security\/previewIsolationRuntime\.ts'/);
assert.match(serverSource, /assertRuntimePreviewIsolation\(process\.env, process\.env\.NODE_ENV\)/);
assert.ok(
  serverSource.indexOf('assertRuntimePreviewIsolation(process.env') < serverSource.indexOf('app.listen('),
  'Runtime isolation must execute before the HTTP listener starts.',
);

console.log('Preview isolation runtime tests passed: explicit deployment classification, attested preview manifest, missing/shared resources rejected before listener startup.');
