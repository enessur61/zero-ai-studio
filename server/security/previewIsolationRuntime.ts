import { PreviewIsolationError } from './previewIsolation.ts';
import { verifyPreviewAttestation, type PreviewAttestationExpectations } from './previewIsolationAttestation.ts';

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function requiredEnv(env: RuntimeEnvironment, key: string): string {
  const value = env[key];
  if (!value || value.trim() !== value) throw new PreviewIsolationError([`PREVIEW_ATTESTATION_INPUT_MISSING:${key}`]);
  return value;
}

/**
 * Verify the signed deployment-control-plane attestation before opening the
 * HTTP listener. The public key and expected deployment coordinates must be
 * provisioned by the trusted control plane; a boolean flag is never accepted.
 *
 * This verifier proves that the trusted issuer signed the stated evidence.
 * The issuer remains responsible for obtaining evidence from provider control
 * planes. Stateless runtime verification cannot provide global one-time nonce
 * or replay prevention; deployments must issue a unique deploymentId and short
 * lived attestation for each preview deployment.
 */
export function assertRuntimePreviewIsolation(
  env: RuntimeEnvironment,
  nodeEnv: string | undefined = env.NODE_ENV,
): void {
  if (nodeEnv !== 'production') return;

  const deploymentEnvironment = env.ZERO_DEPLOYMENT_ENV;
  if (deploymentEnvironment !== 'production' && deploymentEnvironment !== 'preview') {
    throw new PreviewIsolationError(['DEPLOYMENT_ENVIRONMENT_UNDECLARED']);
  }
  if (deploymentEnvironment === 'production') return;

  const expected: PreviewAttestationExpectations = {
    deploymentId: requiredEnv(env, 'ZERO_PREVIEW_DEPLOYMENT_ID'),
    previewId: requiredEnv(env, 'ZERO_PREVIEW_ID'),
    pullRequestNumber: Number(requiredEnv(env, 'ZERO_PREVIEW_PULL_REQUEST_NUMBER')),
    headSha: requiredEnv(env, 'ZERO_PREVIEW_HEAD_SHA'),
    issuer: requiredEnv(env, 'ZERO_PREVIEW_ATTESTATION_ISSUER'),
    publicKeyPem: requiredEnv(env, 'ZERO_PREVIEW_ATTESTATION_PUBLIC_KEY'),
  };
  if (!Number.isSafeInteger(expected.pullRequestNumber) || expected.pullRequestNumber < 1) {
    throw new PreviewIsolationError(['PREVIEW_ATTESTATION_PR_NUMBER_INVALID']);
  }
  if (expected.pullRequestNumber !== 118) {
    throw new PreviewIsolationError(['PREVIEW_ATTESTATION_PR_NOT_AUTHORIZED']);
  }

  verifyPreviewAttestation(env.ZERO_PREVIEW_ATTESTATION_JSON, expected);
}
