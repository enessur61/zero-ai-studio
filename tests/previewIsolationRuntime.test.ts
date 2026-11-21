import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PREVIEW_RESOURCE_NAMES } from '../server/security/previewIsolation.ts';
import { assertRuntimePreviewIsolation } from '../server/security/previewIsolationRuntime.ts';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const now = Date.now();
const expected = {
  deploymentId: 'deployment-pr118-synthetic',
  previewId: 'preview-pr118-synthetic',
  pullRequestNumber: 118,
  headSha: '7ced635d287500033788ff20b15831191ea10800',
  issuer: 'zero-test-control-plane',
  publicKeyPem,
};

function makePayload() {
  return {
    schemaVersion: 1,
    issuer: expected.issuer,
    attestationId: 'attestation-synthetic-001',
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
    deploymentId: expected.deploymentId,
    previewId: expected.previewId,
    pullRequestNumber: expected.pullRequestNumber,
    headSha: expected.headSha,
    resources: Object.fromEntries(PREVIEW_RESOURCE_NAMES.map((name) => {
      if (name === 'database' || name === 'auth') {
        return [name, {
          state: 'isolated',
          identity: `synthetic-preview-${name}`,
          previewId: expected.previewId,
          productionIdentity: `synthetic-production-${name}`,
          evidenceRef: `evidence:synthetic:${name}`,
        }];
      }
      return [name, {
        state: 'disabled',
        identity: null,
        previewId: null,
        productionIdentity: null,
        evidenceRef: `evidence:synthetic-disabled:${name}`,
      }];
    })),
  };
}

function envelope(payload: unknown, signingKey = privateKey): string {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return JSON.stringify({
    payload: bytes.toString('base64url'),
    signature: sign(null, bytes, signingKey).toString('base64url'),
  });
}

const validEnvelope = envelope(makePayload());
const validEnv = {
  NODE_ENV: 'production',
  ZERO_DEPLOYMENT_ENV: 'preview',
  ZERO_PREVIEW_DEPLOYMENT_ID: expected.deploymentId,
  ZERO_PREVIEW_ID: expected.previewId,
  ZERO_PREVIEW_PULL_REQUEST_NUMBER: String(expected.pullRequestNumber),
  ZERO_PREVIEW_HEAD_SHA: expected.headSha,
  ZERO_PREVIEW_ATTESTATION_ISSUER: expected.issuer,
  ZERO_PREVIEW_ATTESTATION_PUBLIC_KEY: publicKeyPem,
  ZERO_PREVIEW_ATTESTATION_JSON: validEnvelope,
};

assert.doesNotThrow(() => assertRuntimePreviewIsolation(validEnv));
assert.doesNotThrow(() => assertRuntimePreviewIsolation({ NODE_ENV: 'test' }));
assert.doesNotThrow(() => assertRuntimePreviewIsolation({ NODE_ENV: 'development' }));
assert.doesNotThrow(() => assertRuntimePreviewIsolation({ NODE_ENV: 'production', ZERO_DEPLOYMENT_ENV: 'production' }));
assert.throws(() => assertRuntimePreviewIsolation({ NODE_ENV: 'production' }), /DEPLOYMENT_ENVIRONMENT_UNDECLARED/);

const missingAttestation = { ...validEnv, ZERO_PREVIEW_ATTESTATION_JSON: '' };
assert.throws(() => assertRuntimePreviewIsolation(missingAttestation), /PREVIEW_ATTESTATION_MISSING_OR_OVERSIZED/);
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_ISOLATION_ATTESTED: 'true', ZERO_PREVIEW_ATTESTATION_JSON: '' }), /PREVIEW_ATTESTATION_MISSING_OR_OVERSIZED/);

const tamperedPayload = makePayload();
tamperedPayload.previewId = 'preview-tampered';
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_ATTESTATION_JSON: envelope(tamperedPayload) }), /PREVIEW_ATTESTATION_PREVIEW_MISMATCH/);

const badSignature = JSON.parse(validEnvelope);
badSignature.signature = Buffer.alloc(64, 7).toString('base64url');
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_ATTESTATION_JSON: JSON.stringify(badSignature) }), /PREVIEW_ATTESTATION_SIGNATURE_INVALID/);

const expiredPayload = makePayload();
expiredPayload.issuedAt = new Date(now - 20 * 60 * 1000).toISOString();
expiredPayload.expiresAt = new Date(now - 10 * 60 * 1000).toISOString();
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_ATTESTATION_JSON: envelope(expiredPayload) }), /PREVIEW_ATTESTATION_EXPIRED_OR_INVALID_TIME/);

const wrongIssuerEnv = { ...validEnv, ZERO_PREVIEW_ATTESTATION_ISSUER: 'another-issuer' };
assert.throws(() => assertRuntimePreviewIsolation(wrongIssuerEnv), /PREVIEW_ATTESTATION_ISSUER_MISMATCH/);
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_DEPLOYMENT_ID: 'different-deployment' }), /PREVIEW_ATTESTATION_DEPLOYMENT_MISMATCH/);
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_PULL_REQUEST_NUMBER: '116' }), /PREVIEW_ATTESTATION_PR_NOT_AUTHORIZED/);
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_HEAD_SHA: '0'.repeat(40) }), /PREVIEW_ATTESTATION_HEAD_SHA_MISMATCH/);

const incomplete = makePayload();
delete (incomplete.resources as Record<string, unknown>).queues;
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_ATTESTATION_JSON: envelope(incomplete) }), /PREVIEW_ATTESTATION_SCHEMA_INVALID/);

const extraResource = makePayload();
(extraResource.resources as Record<string, unknown>).unexpected = { state: 'disabled', identity: null, previewId: null, productionIdentity: null, evidenceRef: 'evidence:synthetic:extra' };
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_ATTESTATION_JSON: envelope(extraResource) }), /PREVIEW_ATTESTATION_SCHEMA_INVALID/);

const unknownResourceState = makePayload();
(unknownResourceState.resources.piper as { state: string }).state = 'shared';
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_ATTESTATION_JSON: envelope(unknownResourceState) }), /PREVIEW_ATTESTATION_SCHEMA_INVALID/);

const disabledRequiredResource = makePayload();
disabledRequiredResource.resources.database = {
  state: 'disabled', identity: null, previewId: null, productionIdentity: null, evidenceRef: 'evidence:synthetic:database',
};
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_ATTESTATION_JSON: envelope(disabledRequiredResource) }), /REQUIRED_RESOURCE_DISABLED:database/);

const productionReuse = makePayload();
productionReuse.resources.auth.identity = productionReuse.resources.auth.productionIdentity;
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_ATTESTATION_JSON: envelope(productionReuse) }), /PRODUCTION_RESOURCE_REUSED:auth/);

const missingEvidence = makePayload();
missingEvidence.resources.storage.evidenceRef = '';
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_ATTESTATION_JSON: envelope(missingEvidence) }), /PREVIEW_ATTESTATION_SCHEMA_INVALID/);

const disabledWithBinding = makePayload();
disabledWithBinding.resources.video.identity = 'synthetic-identity';
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_ATTESTATION_JSON: envelope(disabledWithBinding) }), /PREVIEW_ATTESTATION_SCHEMA_INVALID/);

const wrongKeyPair = generateKeyPairSync('ed25519');
assert.throws(() => assertRuntimePreviewIsolation({
  ...validEnv,
  ZERO_PREVIEW_ATTESTATION_PUBLIC_KEY: wrongKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}), /PREVIEW_ATTESTATION_SIGNATURE_INVALID/);

assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_ATTESTATION_PUBLIC_KEY: '' }), /PREVIEW_ATTESTATION_INPUT_MISSING/);
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_ATTESTATION_ISSUER: '' }), /PREVIEW_ATTESTATION_INPUT_MISSING/);
assert.throws(() => assertRuntimePreviewIsolation({ ...validEnv, ZERO_PREVIEW_HEAD_SHA: 'stale-sha' }), /PREVIEW_ATTESTATION_HEAD_SHA_MISMATCH/);

const serverSource = await readFile('server.ts', 'utf8');
assert.match(serverSource, /import \{ assertRuntimePreviewIsolation \} from '\.\/server\/security\/previewIsolationRuntime\.ts'/);
assert.match(serverSource, /assertRuntimePreviewIsolation\(process\.env, process\.env\.NODE_ENV\)/);
assert.ok(serverSource.indexOf('assertRuntimePreviewIsolation(process.env') < serverSource.indexOf('app.listen('));

console.log('Signed preview attestation tests passed: Ed25519, exact PR/SHA/deployment binding, strict nine-resource schema, expiry and fail-closed cases; synthetic keys only.');
