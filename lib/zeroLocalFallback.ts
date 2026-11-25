export interface ZeroLocalFallbackEligibility {
  responseStatus: number;
  selectedModelId: string;
  localWebGPUModelLoaded: boolean;
}

/**
 * The browser-local model is a safe fallback only when automatic routing has
 * no verified free cloud route. Never override an explicit model selection.
 */
export function shouldUseZeroLocalFallback({
  responseStatus,
  selectedModelId,
  localWebGPUModelLoaded,
}: ZeroLocalFallbackEligibility): boolean {
  return responseStatus === 503
    && selectedModelId === 'auto'
    && localWebGPUModelLoaded;
}
