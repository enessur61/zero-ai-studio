export interface ZeroLocalFallbackEligibility {
  responseStatus: number;
  selectedModelId: string;
  localWebGPUModelLoaded: boolean;
  requiresServerContext: boolean;
}

/**
 * The browser-local model is a safe fallback only when automatic routing has
 * no verified free cloud route and the request needs no server-only context.
 * Never override an explicit model selection or silently drop web/project data.
 */
export function shouldUseZeroLocalFallback({
  responseStatus,
  selectedModelId,
  localWebGPUModelLoaded,
  requiresServerContext,
}: ZeroLocalFallbackEligibility): boolean {
  return responseStatus === 503
    && selectedModelId === 'auto'
    && localWebGPUModelLoaded
    && !requiresServerContext;
}
