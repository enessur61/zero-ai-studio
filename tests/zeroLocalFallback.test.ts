import assert from 'node:assert/strict';
import { shouldUseZeroLocalFallback } from '../lib/zeroLocalFallback.ts';

assert.equal(shouldUseZeroLocalFallback({
  responseStatus: 503,
  selectedModelId: 'auto',
  localWebGPUModelLoaded: true,
  requiresServerContext: false,
}), true, 'automatic routing uses an already-loaded local model when no free cloud route exists');

assert.equal(shouldUseZeroLocalFallback({
  responseStatus: 503,
  selectedModelId: 'gemini-3.8-flash',
  localWebGPUModelLoaded: true,
  requiresServerContext: false,
}), false, 'an explicit cloud model selection is never silently replaced');

assert.equal(shouldUseZeroLocalFallback({
  responseStatus: 503,
  selectedModelId: 'auto',
  localWebGPUModelLoaded: false,
  requiresServerContext: false,
}), false, 'the fallback never triggers a surprise model download');

assert.equal(shouldUseZeroLocalFallback({
  responseStatus: 429,
  selectedModelId: 'auto',
  localWebGPUModelLoaded: true,
  requiresServerContext: false,
}), false, 'provider quota errors do not silently bypass provider-side quota policy');

assert.equal(shouldUseZeroLocalFallback({
  responseStatus: 200,
  selectedModelId: 'auto',
  localWebGPUModelLoaded: true,
  requiresServerContext: false,
}), false, 'successful cloud routing remains unchanged');

console.log('ZERO local fallback regression tests passed.');

assert.equal(shouldUseZeroLocalFallback({
  responseStatus: 503,
  selectedModelId: 'auto',
  localWebGPUModelLoaded: true,
  requiresServerContext: true,
}), false, 'web search or project context must never be silently dropped by a local fallback');
