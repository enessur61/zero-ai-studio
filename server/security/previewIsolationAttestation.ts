import { createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  PREVIEW_RESOURCE_NAMES,
  assertPreviewIsolation,
  PreviewIsolationError,
  type PreviewIsolationInput,
  type PreviewResourceName,
} from './previewIsolation.ts';

const HEX_SHA = /^[a-f0-9]{40}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const MAX_ATTESTATION_BYTES = 64 * 1024;
const MAX_VALIDITY_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

export interface PreviewAttestationExpectations {
  deploymentId: string;
  previewId: string;
  pullRequestNumber: number;
  headSha: string;
  issuer: string;
  publicKeyPem: string;
}

interface SignedResource {
  state: 'isolated' | 'disabled';
  identity: string | null;
  previewId: string | null;
  productionIdentity: string | null;
  evidenceRef: string;
}

export interface PreviewAttestationPayload {
  schemaVersion: 1;
  issuer: string;
  attestationId: string;
  issuedAt: string;
  expiresAt: string;
  deploymentId: string;
  previewId: string;
  pullRequestNumber: number;
  headSha: string;
  resources: Record<PreviewResourceName, SignedResource>;
}

interface SignedEnvelope {
  payload: string;
  signature: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isEvidenceRef(value: unknown): value is string {
  return typeof value === 'string' && EVIDENCE_REF.test(value);
}

function decodeBase64Url(value: unknown, maxBytes: number): Buffer | null {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.length % 4 === 1) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length === 0 || decoded.length > maxBytes || decoded.toString('base64url') !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function validatePayloadShape(value: unknown): value is PreviewAttestationPayload {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'issuer', 'attestationId', 'issuedAt', 'expiresAt',
    'deploymentId', 'previewId', 'pullRequestNumber', 'headSha', 'resources',
  ])) return false;

  if (value.schemaVersion !== 1 ||
      !isOpaqueId(value.issuer) ||
      !isOpaqueId(value.attestationId) ||
      !isCanonicalIsoDate(value.issuedAt) ||
      !isCanonicalIsoDate(value.expiresAt) ||
      !isOpaqueId(value.deploymentId) ||
      !isOpaqueId(value.previewId) ||
      !Number.isSafeInteger(value.pullRequestNumber) ||
      !HEX_SHA.test(String(value.headSha)) ||
      !isRecord(value.resources) ||
      !exactKeys(value.resources, PREVIEW_RESOURCE_NAMES)) return false;

  for (const name of PREVIEW_RESOURCE_NAMES) {
    const resource = value.resources[name];
    if (!isRecord(resource) || !exactKeys(resource, [
      'state', 'identity', 'previewId', 'productionIdentity', 'evidenceRef',
    ])) return false;
    if (resource.state !== 'isolated' && resource.state !== 'disabled') return false;
    if (!isEvidenceRef(resource.evidenceRef)) return false;
    if (resource.state === 'disabled') {
      if (resource.identity !== null || resource.previewId !== null || resource.productionIdentity !== null) return false;
    } else if (
      !isOpaqueId(resource.identity) ||
      !isOpaqueId(resource.previewId) ||
      !isOpaqueId(resource.productionIdentity)
    ) return false;
  }

  return true;
}

function safeReject(reason: string): never {
  throw new PreviewIsolationError([reason]);
}

/**
 * Verify a compact envelope whose payload is the exact UTF-8 JSON byte sequence
 * signed by the trusted Ed25519 deployment-control-plane key. No canonical JSON
 * re-serialization is performed: the verifier checks precisely the signed bytes.
 */
export function verifyPreviewAttestation(
  rawEnvelope: string | undefined,
  expected: PreviewAttestationExpectations,
  nowMs = Date.now(),
): PreviewAttestationPayload {
  if (!rawEnvelope || Buffer.byteLength(rawEnvelope, 'utf8') > MAX_ATTESTATION_BYTES) {
    return safeReject('PREVIEW_ATTESTATION_MISSING_OR_OVERSIZED');
  }

  let envelopeValue: unknown;
  try {
    envelopeValue = JSON.parse(rawEnvelope);
  } catch {
    return safeReject('PREVIEW_ATTESTATION_ENVELOPE_INVALID');
  }
  if (!isRecord(envelopeValue) || !exactKeys(envelopeValue, ['payload', 'signature'])) {
    return safeReject('PREVIEW_ATTESTATION_ENVELOPE_INVALID');
  }

  const payloadBytes = decodeBase64Url(envelopeValue.payload, MAX_ATTESTATION_BYTES);
  const signature = decodeBase64Url(envelopeValue.signature, 128);
  if (!payloadBytes || !signature || signature.length !== 64) {
    return safeReject('PREVIEW_ATTESTATION_ENCODING_INVALID');
  }

  let payloadValue: unknown;
  try {
    payloadValue = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return safeReject('PREVIEW_ATTESTATION_PAYLOAD_INVALID');
  }
  if (!validatePayloadShape(payloadValue)) {
    return safeReject('PREVIEW_ATTESTATION_SCHEMA_INVALID');
  }

  let publicKey;
  try {
    if (!expected.publicKeyPem.trim()) throw new Error('missing key');
    publicKey = createPublicKey(expected.publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
  } catch {
    return safeReject('PREVIEW_ATTESTATION_TRUSTED_KEY_INVALID');
  }

  let signatureValid = false;
  try {
    signatureValid = verifySignature(null, payloadBytes, publicKey, signature);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return safeReject('PREVIEW_ATTESTATION_SIGNATURE_INVALID');

  const payload = payloadValue;
  if (payload.issuer !== expected.issuer) return safeReject('PREVIEW_ATTESTATION_ISSUER_MISMATCH');
  if (payload.deploymentId !== expected.deploymentId) return safeReject('PREVIEW_ATTESTATION_DEPLOYMENT_MISMATCH');
  if (payload.previewId !== expected.previewId) return safeReject('PREVIEW_ATTESTATION_PREVIEW_MISMATCH');
  if (payload.pullRequestNumber !== expected.pullRequestNumber) return safeReject('PREVIEW_ATTESTATION_PR_MISMATCH');
  if (!HEX_SHA.test(expected.headSha) || payload.headSha !== expected.headSha) {
    return safeReject('PREVIEW_ATTESTATION_HEAD_SHA_MISMATCH');
  }

  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (issuedAt > nowMs + CLOCK_SKEW_MS || expiresAt <= nowMs ||
      expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) {
    return safeReject('PREVIEW_ATTESTATION_EXPIRED_OR_INVALID_TIME');
  }

  const resources = {} as PreviewAttestationPayload['resources'];
  for (const name of PREVIEW_RESOURCE_NAMES) {
    const signed = payload.resources[name];
    resources[name] = { ...signed };
  }

  const input: PreviewIsolationInput = {
    deployment: {
      environment: 'preview',
      previewId: payload.previewId,
      expectedPreviewId: expected.previewId,
    },
    resources: Object.fromEntries(PREVIEW_RESOURCE_NAMES.map((name) => {
      const resource = resources[name];
      return [name, resource.state === 'disabled'
        ? { state: 'disabled' }
        : { state: 'isolated', identity: resource.identity!, previewId: resource.previewId! }];
    })) as PreviewIsolationInput['resources'],
    productionResourceIds: Object.fromEntries(PREVIEW_RESOURCE_NAMES.flatMap((name) => {
      const resource = resources[name];
      return resource.state === 'isolated' ? [[name, resource.productionIdentity!]] : [];
    })) as Partial<Record<PreviewResourceName, string>>,
  };

  try {
    assertPreviewIsolation(input);
  } catch (error) {
    if (error instanceof PreviewIsolationError) throw error;
    return safeReject('PREVIEW_ATTESTATION_POLICY_REJECTED');
  }

  return payload;
}
