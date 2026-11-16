import assert from 'node:assert/strict';
import { assertZeroBudgetModelAllowed } from '../server/geminiClient.ts';
import type { BudgetGuardState } from '../src/types/zero.ts';

const today = new Date().toISOString().slice(0, 10);
const base = (): BudgetGuardState => ({
  budgetLimitEur: 0,
  totalSpentEur: 0,
  paidProvidersDisabled: true,
  autoFallbackDisabled: true,
  autoUpgradeDisabled: true,
  freeQuotaUsage: {
    'gemini-3.8-flash': {
      requestsToday: 0,
      dailySoftLimit: 10,
      exhausted: false,
      lastResetDate: today,
    },
  },
  auditLog: [],
});
const audit = () => [];

assert.throws(
  () => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', {
    ...base(),
    freeQuotaUsage: {},
  }, () => {}),
  /Kontingentdatensatz/,
);

const malformed = base();
malformed.freeQuotaUsage['gemini-3.8-flash'].lastResetDate = '2026-02-30';
assert.throws(
  () => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', malformed, () => {}),
  /Reset-Datum/,
);

const future = base();
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
future.freeQuotaUsage['gemini-3.8-flash'].lastResetDate = tomorrow;
assert.throws(
  () => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', future, () => {}),
  /Reset-Datum/,
);

const invalidCounters = base();
invalidCounters.freeQuotaUsage['gemini-3.8-flash'].requestsToday = -1;
assert.throws(
  () => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', invalidCounters, () => {}),
  /Kontingentdaten/,
);

const expired = base();
expired.freeQuotaUsage['gemini-3.8-flash'].requestsToday = 10;
expired.freeQuotaUsage['gemini-3.8-flash'].exhausted = true;
expired.freeQuotaUsage['gemini-3.8-flash'].lastResetDate = '2020-01-01';
assert.doesNotThrow(() => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', expired, () => {}));
assert.equal(expired.freeQuotaUsage['gemini-3.8-flash'].requestsToday, 0);
assert.equal(expired.freeQuotaUsage['gemini-3.8-flash'].exhausted, false);
assert.equal(expired.freeQuotaUsage['gemini-3.8-flash'].lastResetDate, today);

const exhausted = base();
exhausted.freeQuotaUsage['gemini-3.8-flash'].requestsToday = 10;
assert.throws(
  () => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', exhausted, () => {}),
  /ausgeschöpft/,
);

console.log('Gemini quota guard tests passed.');
