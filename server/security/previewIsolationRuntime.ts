import {
  assertPreviewIsolation,
  PreviewIsolationError,
  type PreviewIsolationInput,
  type PreviewResourceName,
} from './previewIsolation.ts';

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function parseManifestObject(raw: string | undefined, reason: string): Record<string, unknown> {
  if (!raw) throw new PreviewIsolationError([reason]);
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
    return value as Record<string, unknown>;
  } catch {
    throw new PreviewIsolationError([reason]);
  }
}

/**
 * Enforce deployment classification and preview isolation before the HTTP
 * listener starts. Production and preview labels must be injected by the
 * deployment control plane. Preview manifests contain opaque resource
 * identities/fingerprints only, never URLs, connection strings, or credentials.
 *
 * The attestation flag is the deployment control plane's assertion that the
 * manifest was assembled from actual bound resources. This process validates
 * that manifest but cannot independently inspect provider dashboards.
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

  if (env.ZERO_PREVIEW_ISOLATION_ATTESTED !== 'true') {
    throw new PreviewIsolationError(['PREVIEW_ISOLATION_NOT_ATTESTED']);
  }

  const resources = parseManifestObject(
    env.ZERO_PREVIEW_RESOURCES_JSON,
    'PREVIEW_RESOURCE_MANIFEST_MISSING_OR_INVALID',
  );
  const productionResourceIds = parseManifestObject(
    env.ZERO_PRODUCTION_RESOURCE_IDS_JSON,
    'PRODUCTION_RESOURCE_FINGERPRINTS_MISSING_OR_INVALID',
  );

  const input: PreviewIsolationInput = {
    deployment: {
      environment: deploymentEnvironment,
      previewId: env.ZERO_PREVIEW_ID ?? '',
      expectedPreviewId: env.ZERO_PREVIEW_EXPECTED_ID ?? '',
    },
    resources: resources as PreviewIsolationInput['resources'],
    productionResourceIds: productionResourceIds as Partial<Record<PreviewResourceName, string>>,
  };

  assertPreviewIsolation(input);
}
