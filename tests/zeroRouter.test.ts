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
assert.equal(chooseZeroChatModel([makeModel('gemini-3.8-flash')], staleQuotaBudget, undefined, now)?.modelId, 'gemini-3.8-flash');

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

const localVideo = makeMediaModel('zero-timeline-video-60s', 'Videogenerierung');
localVideo.executionMode = 'LOCAL ON-DEVICE';
assert.equal(chooseZeroMediaModel([localVideo], budget, 'video', [], now), null);
assert.equal(
  chooseZeroMediaModel([localVideo], budget, 'video', ['zero-timeline-video-60s'], now)?.modelId,
  'zero-timeline-video-60s',
);

const unverifiedImage = makeMediaModel('flux-1-schnell-free', 'Bildgenerierung');
assert.equal(chooseZeroMediaModel([unverifiedImage], budget, 'image', [], now), null);
