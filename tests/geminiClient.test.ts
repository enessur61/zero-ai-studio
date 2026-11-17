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
assert.throws(
  () => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', {
    ...base(),
    freeQuotaUsage: {},
  }, () => {}),
  /Kontingentdatensatz/,
);

// The production audit callback owns the single request-counter increment.
const reserved = base();
const recordAndCount = (event: { modelId: string; decision: string }) => {
  if (event.decision === 'ERLAUBT_0_EUR') {
    reserved.freeQuotaUsage[event.modelId].requestsToday += 1;
  }
};
assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', reserved, recordAndCount);
assert.equal(reserved.freeQuotaUsage['gemini-3.8-flash'].requestsToday, 1);
for (let i = 1; i < 10; i += 1) {
  assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', reserved, recordAndCount);
}
assert.equal(reserved.freeQuotaUsage['gemini-3.8-flash'].requestsToday, 10);
assert.throws(
  () => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', reserved, recordAndCount),
  /ausgeschöpft/,
  'the audit-owned local request counter must stop further provider calls at its configured limit',
);
assert.equal(reserved.freeQuotaUsage['gemini-3.8-flash'].requestsToday, 10);

const emptyResetDate = base();
emptyResetDate.freeQuotaUsage['gemini-3.8-flash'].lastResetDate = '';
assert.throws(
  () => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', emptyResetDate, () => {}),
  /Reset-Datum/,
);

const malformed = base();
malformed.freeQuotaUsage['gemini-3.8-flash'].lastResetDate = '2026-02-30';
const malformedAudits: Array<{ decision: string; reason: string }> = [];
assert.throws(
  () => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', malformed, (event) => malformedAudits.push(event)),
  /Reset-Datum/,
);
assert.equal(malformedAudits.at(-1)?.decision, 'BLOCKIERT_BUDGET_GUARD');
assert.match(malformedAudits.at(-1)?.reason ?? '', /Reset-Datum.*ungültig/);

const future = base();
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
future.freeQuotaUsage['gemini-3.8-flash'].lastResetDate = tomorrow;
assert.throws(
  () => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', future, () => {}),
  /Reset-Datum/,
);

const missingResetDate = base();
delete missingResetDate.freeQuotaUsage['gemini-3.8-flash'].lastResetDate;
const missingResetAudits: Array<{ decision: string; reason: string }> = [];
assert.throws(
  () => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', missingResetDate, (event) => missingResetAudits.push(event)),
  /Reset-Datum.*fehlt/,
  'missing reset metadata must fail closed instead of being silently initialized',
);
assert.equal(missingResetAudits.at(-1)?.decision, 'BLOCKIERT_BUDGET_GUARD');

const invalidCounters = base();
invalidCounters.freeQuotaUsage['gemini-3.8-flash'].requestsToday = -1;
const invalidCounterAudits: Array<{ decision: string; reason: string }> = [];
assert.throws(
  () => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', invalidCounters, (event) => invalidCounterAudits.push(event)),
  /Kontingentdaten/,
);
assert.equal(invalidCounterAudits.at(-1)?.decision, 'BLOCKIERT_BUDGET_GUARD');
assert.match(invalidCounterAudits.at(-1)?.reason ?? '', /Kontingentdaten.*fehlerhaft/);

const expired = base();
expired.freeQuotaUsage['gemini-3.8-flash'].requestsToday = 10;
expired.freeQuotaUsage['gemini-3.8-flash'].exhausted = true;
expired.freeQuotaUsage['gemini-3.8-flash'].lastResetDate = '2020-01-01';
assert.throws(
  () => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', expired, () => {}),
  /Reset.*nicht verifiziert/,
  'a local calendar rollover is not proof of a provider-side quota reset',
);
assert.equal(expired.freeQuotaUsage['gemini-3.8-flash'].requestsToday, 10);
assert.equal(expired.freeQuotaUsage['gemini-3.8-flash'].exhausted, true);
assert.equal(expired.freeQuotaUsage['gemini-3.8-flash'].lastResetDate, '2020-01-01');

const exhausted = base();
exhausted.freeQuotaUsage['gemini-3.8-flash'].requestsToday = 10;
assert.throws(
  () => assertZeroBudgetModelAllowed('gemini-3.8-flash', 'test', exhausted, () => {}),
  /ausgeschöpft/,
);

console.log('Gemini quota guard tests passed.');
