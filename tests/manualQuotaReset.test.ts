import assert from 'node:assert/strict';
import { applyManualFreeQuotaReset } from '../server/manualQuotaReset.ts';
import type { BudgetGuardState } from '../src/types/zero.ts';

const budget = (): BudgetGuardState => ({
  budgetLimitEur: 0,
  totalSpentEur: 0,
  paidProvidersDisabled: true,
  autoFallbackDisabled: true,
  autoUpgradeDisabled: true,
  freeQuotaUsage: {
    'gemini-3.8-flash': {
      requestsToday: 250,
      dailySoftLimit: 250,
      exhausted: true,
      lastResetDate: '2026-11-15',
    },
  },
  auditLog: [],
});

const state = budget();
const reset = applyManualFreeQuotaReset({
  modelId: 'gemini-3.8-flash',
  confirmedProviderReset: true,
  budgetGuard: state,
  now: new Date('2026-11-16T04:00:00.000Z'),
});
assert.deepEqual(reset, {
  requestsToday: 0,
  dailySoftLimit: 250,
  exhausted: false,
  lastResetDate: '2026-11-16',
});
assert.equal(state.freeQuotaUsage['gemini-3.8-flash'].requestsToday, 0);

const unconfirmed = budget();
assert.throws(
  () => applyManualFreeQuotaReset({
    modelId: 'gemini-3.8-flash',
    confirmedProviderReset: false,
    budgetGuard: unconfirmed,
  }),
  /ausdrücklich bestätigt/,
);
assert.equal(unconfirmed.freeQuotaUsage['gemini-3.8-flash'].requestsToday, 250);

assert.throws(
  () => applyManualFreeQuotaReset({
    modelId: 'not-a-free-model',
    confirmedProviderReset: true,
    budgetGuard: budget(),
  }),
  /nicht für einen manuellen/,
);

const corrupt = budget();
corrupt.freeQuotaUsage['gemini-3.8-flash'].requestsToday = 1.5;
assert.throws(
  () => applyManualFreeQuotaReset({
    modelId: 'gemini-3.8-flash',
    confirmedProviderReset: true,
    budgetGuard: corrupt,
  }),
  /beschädigt/,
);
assert.equal(corrupt.freeQuotaUsage['gemini-3.8-flash'].requestsToday, 1.5);

console.log('Manual provider quota reset tests passed.');
