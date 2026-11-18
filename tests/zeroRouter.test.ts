import assert from 'node:assert/strict';
import { chooseZeroChatModel, chooseZeroMediaModel } from '../server/zeroRouter.ts';
import type { BudgetGuardState, ModelDefinition } from '../src/types/zero.ts';

const makeModel = (id: string): ModelDefinition => ({
  id,
  name: id,
  family: 'Gemini',
  category: 'Text & Reasoning',
  executionMode: 'FREE CLOUD',
  status: 'FUNKTIONIERT',
  license: 'Provider terms',
  commercialUse: 'Provider terms',
  sizeGB: 0,
  ramRequirementGB: 0,
  iosCompatible: true,
  iosNotes: '',
  provider: 'Google',
  adapterId: 'gemini',
  hasRealAdapter: true,
  requiresPaidKey: false,
  requiresExternalGpu: false,
  costEur: 0,
  enabled: true,
  capabilities: ['Text & Reasoning'],
  lastTestedAt: '2026-11-16T10:00:00.000Z',
  lastTestLatencyMs: 100,
  lastTestMessage: 'Live test passed',
  testPassed: true,
  version: 'test',
  limitations: '',
});

const budget: BudgetGuardState = {
  budgetLimitEur: 0,
  totalSpentEur: 0,
  paidProvidersDisabled: true,
  autoFallbackDisabled: true,
  autoUpgradeDisabled: true,
  freeQuotaUsage: {
    'gemini-3.8-flash': { requestsToday: 0, dailySoftLimit: 10, exhausted: false, lastResetDate: '2026-11-16' },
    'gemini-3.6-flash': { requestsToday: 0, dailySoftLimit: 10, exhausted: false, lastResetDate: '2026-11-16' },
  },
  auditLog: [],
};

const now = new Date('2026-11-16T12:00:00.000Z');
const preferred = chooseZeroChatModel(
  [makeModel('gemini-3.8-flash'), makeModel('gemini-3.6-flash')],
  budget,
  'gemini-3.6-flash',
  now,
);
assert.equal(preferred?.modelId, 'gemini-3.6-flash');

const cloudflareModel = makeModel('cloudflare-glm-4.7-flash');
cloudflareModel.provider = 'Cloudflare Workers AI';
cloudflareModel.adapterId = 'cloudflare-workers-ai';
assert.equal(
  chooseZeroChatModel([cloudflareModel], budget, 'cloudflare-glm-4.7-flash', now)?.modelId,
  'cloudflare-glm-4.7-flash',
  'a successfully tested Cloudflare model uses the provider-side daily Neuron quota and does not require a Gemini quota record',
);

const fallbackBudget: BudgetGuardState = {
  ...budget,
  freeQuotaUsage: {
    ...budget.freeQuotaUsage,
    'gemini-3.8-flash': { requestsToday: 10, dailySoftLimit: 10, exhausted: true, lastResetDate: '2026-11-16' },
  },
};
const fallback = chooseZeroChatModel(
  [makeModel('gemini-3.8-flash'), makeModel('gemini-3.6-flash')],
  fallbackBudget,
  'gemini-3.8-flash',
  now,
);
assert.equal(fallback?.modelId, 'gemini-3.6-flash');

const staleQuotaBudget: BudgetGuardState = {
  ...budget,
  freeQuotaUsage: {
    ...budget.freeQuotaUsage,
    'gemini-3.8-flash': { requestsToday: 10, dailySoftLimit: 10, exhausted: true, lastResetDate: '2026-11-15' },
  },
};
assert.equal(
  chooseZeroChatModel([makeModel('gemini-3.8-flash')], staleQuotaBudget, undefined, now),
  null,
  'the router must not advertise stale quota metadata as available after a local date rollover',
);

const missingQuotaDateBudget: BudgetGuardState = {
  ...budget,
  freeQuotaUsage: {
    ...budget.freeQuotaUsage,
    'gemini-3.8-flash': {
      requestsToday: 0,
      dailySoftLimit: 10,
      exhausted: false,
    },
  },
};
assert.equal(
  chooseZeroChatModel([makeModel('gemini-3.8-flash')], missingQuotaDateBudget, undefined, now),
  null,
);

const malformedQuotaDateBudget: BudgetGuardState = {
  ...budget,
  freeQuotaUsage: {
    ...budget.freeQuotaUsage,
    'gemini-3.8-flash': {
      requestsToday: 0,
      dailySoftLimit: 10,
      exhausted: false,
      lastResetDate: 'yesterday',
    },
  },
};
assert.equal(
  chooseZeroChatModel([makeModel('gemini-3.8-flash')], malformedQuotaDateBudget, undefined, now),
  null,
);

const impossibleQuotaDateBudget: BudgetGuardState = {
  ...budget,
  freeQuotaUsage: {
    ...budget.freeQuotaUsage,
    'gemini-3.8-flash': {
      requestsToday: 0,
      dailySoftLimit: 10,
      exhausted: false,
      lastResetDate: '2026-02-30',
    },
  },
};
assert.equal(chooseZeroChatModel([makeModel('gemini-3.8-flash')], impossibleQuotaDateBudget, undefined, now), null);

const futureQuotaDateBudget: BudgetGuardState = {
  ...budget,
  freeQuotaUsage: {
    ...budget.freeQuotaUsage,
    'gemini-3.8-flash': {
      requestsToday: 0,
      dailySoftLimit: 10,
      exhausted: false,
      lastResetDate: '2026-11-17',
    },
  },
};
assert.equal(chooseZeroChatModel([makeModel('gemini-3.8-flash')], futureQuotaDateBudget, undefined, now), null);

const invalidQuotaCountersBudget: BudgetGuardState = {
  ...budget,
  freeQuotaUsage: {
    ...budget.freeQuotaUsage,
    'gemini-3.8-flash': {
      requestsToday: -1,
      dailySoftLimit: 10,
      exhausted: false,
      lastResetDate: '2026-11-16',
    },
  },
};
assert.equal(chooseZeroChatModel([makeModel('gemini-3.8-flash')], invalidQuotaCountersBudget, undefined, now), null);

const malformedExhaustedFlagBudget: BudgetGuardState = {
  ...budget,
  freeQuotaUsage: {
    ...budget.freeQuotaUsage,
    'gemini-3.8-flash': {
      requestsToday: 0,
      dailySoftLimit: 10,
      exhausted: 'false' as unknown as boolean,
      lastResetDate: '2026-11-16',
    },
  },
};
assert.equal(
  chooseZeroChatModel([makeModel('gemini-3.8-flash')], malformedExhaustedFlagBudget, undefined, now),
  null,
  'a non-boolean exhausted flag must fail closed instead of being treated as available quota',
);

const nonIntegerQuotaBudget: BudgetGuardState = {
  ...budget,
  freeQuotaUsage: {
    ...budget.freeQuotaUsage,
    'gemini-3.8-flash': {
      requestsToday: 0.5,
      dailySoftLimit: 10,
      exhausted: false,
      lastResetDate: '2026-11-16',
    },
  },
};
assert.equal(
  chooseZeroChatModel([makeModel('gemini-3.8-flash')], nonIntegerQuotaBudget, undefined, now),
  null,
  'fractional request counters must fail closed',
);

const untested = makeModel('gemini-3.8-flash');
untested.testPassed = false;
assert.equal(chooseZeroChatModel([untested], budget, undefined, now), null);

const noPaid = makeModel('gemini-3.8-flash');
noPaid.requiresPaidKey = true;
assert.equal(chooseZeroChatModel([noPaid], budget, undefined, now), null);

console.log('ZERO CORE router tests passed.');

const makeMediaModel = (id: string, category: ModelDefinition['category']): ModelDefinition => ({
  ...makeModel(id),
  category,
});

const ttsModel = makeMediaModel('gemini-3.8-flash-lite-tts', 'Sprache & Audio');
const ttsBudget: BudgetGuardState = {
  ...budget,
  freeQuotaUsage: {
    ...budget.freeQuotaUsage,
    'gemini-3.8-flash-lite-tts': { requestsToday: 0, dailySoftLimit: 10, exhausted: false, lastResetDate: '2026-11-16' },
  },
};
assert.equal(
  chooseZeroMediaModel([ttsModel], ttsBudget, 'text-to-speech', [], now, 'gemini-3.8-flash-lite-tts')?.modelId,
  'gemini-3.8-flash-lite-tts',
);
const piperWorker = makeMediaModel('piper-tts-de-worker', 'Sprache & Audio');
piperWorker.adapterId = 'piper-worker';
piperWorker.provider = 'ZERO self-hosted Piper Worker';
piperWorker.executionMode = 'FREE CLOUD';
piperWorker.status = 'FUNKTIONIERT';
assert.equal(
  chooseZeroMediaModel([piperWorker], budget, 'text-to-speech', [], now, 'piper-tts-de-worker')?.modelId,
  'piper-tts-de-worker',
  'a verified Piper worker must route without a Gemini quota record',
);
const disabledPiperWorker = { ...piperWorker, enabled: false };
assert.equal(chooseZeroMediaModel([disabledPiperWorker], budget, 'text-to-speech', [], now), null, 'disabled Piper worker must remain unroutable');

const localVideo = makeMediaModel('zero-timeline-video-60s', 'Videogenerierung');
localVideo.executionMode = 'LOCAL ON-DEVICE';
localVideo.status = 'BROWSER TEST ERFORDERLICH';
localVideo.enabled = true;
localVideo.hasRealAdapter = false;
localVideo.testPassed = false;
assert.equal(chooseZeroMediaModel([localVideo], budget, 'video', [], now), null);
assert.equal(
  chooseZeroMediaModel([localVideo], budget, 'video', ['zero-timeline-video-60s'], now)?.modelId,
  'zero-timeline-video-60s',
);
const disabledLocalVideo = { ...localVideo, enabled: false };
assert.equal(
  chooseZeroMediaModel([disabledLocalVideo], budget, 'video', ['zero-timeline-video-60s'], now),
  null,
);
const paidLocalVideo = { ...localVideo, requiresPaidKey: true };
assert.equal(
  chooseZeroMediaModel([paidLocalVideo], budget, 'video', ['zero-timeline-video-60s'], now),
  null,
);

const unverifiedImage: ModelDefinition = {
  ...makeMediaModel('flux-1-schnell-free', 'Bildgenerierung'),
  adapterId: 'cloudflare-workers-ai-image',
  hasRealAdapter: true,
  enabled: false,
  testPassed: false,
  status: 'INSTALLATION ERFORDERLICH',
};
assert.equal(
  chooseZeroMediaModel([unverifiedImage], budget, 'image', [], now),
  null,
  'Cloudflare FLUX must remain unavailable until its live test has passed and the model is enabled',
);

const verifiedFluxImage = {
  ...unverifiedImage,
  executionMode: 'FREE CLOUD' as const,
  status: 'FUNKTIONIERT' as const,
  adapterId: 'cloudflare-workers-ai-image',
  hasRealAdapter: true,
  enabled: true,
  testPassed: true,
};
assert.equal(
  chooseZeroMediaModel([verifiedFluxImage], budget, 'image', [], now, 'flux-1-schnell-free')?.modelId,
  'flux-1-schnell-free',
  'a live-tested Cloudflare FLUX image model uses its provider-side shared Neuron allocation',
);

const verifiedCloudflareWhisper = {
  ...makeMediaModel('cloudflare-whisper-large-v3-turbo', 'Sprache & Audio'),
  executionMode: 'FREE CLOUD' as const,
  status: 'FUNKTIONIERT' as const,
  adapterId: 'cloudflare-workers-ai-whisper',
  hasRealAdapter: true,
  enabled: true,
  testPassed: true,
};
assert.equal(
  chooseZeroMediaModel(
    [verifiedCloudflareWhisper],
    budget,
    'transcription',
    [],
    now,
    'cloudflare-whisper-large-v3-turbo',
  )?.modelId,
  'cloudflare-whisper-large-v3-turbo',
  'a live-tested Cloudflare Whisper model uses the provider-side shared Neuron allocation',
);
