/**
 * Pure, fail-closed policy for validating a ZERO preview's resource isolation.
 *
 * This module deliberately performs no environment reads, secret reads,
 * filesystem access, database access, or network requests. Callers must pass
 * normalized, non-secret resource identities obtained from a trusted
 * deployment-control plane. Never pass raw URLs, connection strings, or tokens.
 */

export const PREVIEW_RESOURCE_NAMES = [
  'database',
  'auth',
  'piper',
  'video',
  'gemini',
  'cloudflare',
  'webSearch',
  'storage',
  'queues',
] as const;

export type PreviewResourceName = (typeof PREVIEW_RESOURCE_NAMES)[number];
export type PreviewResourceState = 'isolated' | 'disabled' | 'shared' | 'unknown';

export interface PreviewResourceDeclaration {
  /** Whether this resource is isolated, disabled, shared, or not verified. */
  state: PreviewResourceState;
  /** Opaque, non-secret identity (or one-way fingerprint) for this resource. */
  identity?: string;
  /** Preview ID to which this resource is explicitly assigned. */
  previewId?: string;
}

export interface PreviewIsolationInput {
  deployment: {
    environment: string;
    /** Identity assigned to this preview by the deployment control plane. */
    previewId: string;
    /** Expected preview identity supplied by a trusted deployment control plane. */
    expectedPreviewId: string;
  };
  /**
   * Trusted production resource identities/fingerprints used only for comparison.
   * A value is mandatory whenever the corresponding resource is enabled.
   */
  productionResourceIds: Partial<Record<PreviewResourceName, string>>;
  /** Every resource must be explicitly declared; absence is not isolation. */
  resources: Partial<Record<PreviewResourceName, PreviewResourceDeclaration>>;
}

export interface PreviewIsolationResult {
  ok: boolean;
  /** Safe reason codes only; never includes supplied identities or secrets. */
  reasons: readonly string[];
}

const REQUIRED_RESOURCES: ReadonlySet<PreviewResourceName> = new Set([
  'database',
  'auth',
]);

function isNonEmptyOpaqueIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && value.length <= 256;
}

/** Evaluate the preview isolation policy without performing any I/O. */
export function evaluatePreviewIsolation(
  input: PreviewIsolationInput | null | undefined,
): PreviewIsolationResult {
  const reasons: string[] = [];

  if (!input || typeof input !== 'object') {
    return { ok: false, reasons: ['CONFIGURATION_MISSING'] };
  }

  const deployment = input.deployment;
  if (!deployment || deployment.environment !== 'preview') {
    reasons.push('DEPLOYMENT_NOT_PREVIEW');
  }

  const previewId = deployment?.previewId;
  const expectedPreviewId = deployment?.expectedPreviewId;
  if (!isNonEmptyOpaqueIdentity(previewId) || !isNonEmptyOpaqueIdentity(expectedPreviewId)) {
    reasons.push('PREVIEW_IDENTITY_MISSING');
  } else if (previewId !== expectedPreviewId) {
    reasons.push('PREVIEW_IDENTITY_MISMATCH');
  }

  for (const resourceName of PREVIEW_RESOURCE_NAMES) {
    const declaration = input.resources?.[resourceName];
    if (!declaration || typeof declaration !== 'object') {
      reasons.push(`RESOURCE_NOT_DECLARED:${resourceName}`);
      continue;
    }

    if (declaration.state === 'disabled') {
      if (REQUIRED_RESOURCES.has(resourceName)) {
        reasons.push(`REQUIRED_RESOURCE_DISABLED:${resourceName}`);
      }
      if (declaration.identity !== undefined || declaration.previewId !== undefined) {
        reasons.push(`DISABLED_RESOURCE_HAS_CONFIGURATION:${resourceName}`);
      }
      continue;
    }

    if (declaration.state !== 'isolated') {
      reasons.push(`RESOURCE_NOT_ISOLATED:${resourceName}`);
      continue;
    }

    if (!isNonEmptyOpaqueIdentity(declaration.identity)) {
      reasons.push(`RESOURCE_IDENTITY_MISSING:${resourceName}`);
    }

    if (!isNonEmptyOpaqueIdentity(previewId) || declaration.previewId !== previewId) {
      reasons.push(`RESOURCE_PREVIEW_ID_MISMATCH:${resourceName}`);
    }

    const productionIdentity = input.productionResourceIds?.[resourceName];
    if (!isNonEmptyOpaqueIdentity(productionIdentity)) {
      reasons.push(`PRODUCTION_IDENTITY_NOT_PROVIDED:${resourceName}`);
    } else if (isNonEmptyOpaqueIdentity(declaration.identity) && declaration.identity === productionIdentity) {
      reasons.push(`PRODUCTION_RESOURCE_REUSED:${resourceName}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

export class PreviewIsolationError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`Preview isolation rejected: ${reasons.join(', ')}`);
    this.name = 'PreviewIsolationError';
    this.reasons = [...reasons];
  }
}

/** Throw unless every required and optional resource is proven isolated or disabled. */
export function assertPreviewIsolation(input: PreviewIsolationInput | null | undefined): void {
  const result = evaluatePreviewIsolation(input);
  if (!result.ok) throw new PreviewIsolationError(result.reasons);
}
