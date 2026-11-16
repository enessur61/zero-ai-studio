import assert from 'node:assert/strict';
import { MEMORY_EMBEDDING_MODEL_ID, runMemoryEmbedding } from '../server/memoryEmbedding.ts';
import type { BudgetAuditEvent, BudgetGuardState } from '../src/types/zero.ts';

const today = new Date().toISOString().slice(0, 10);
function budget(): BudgetGuardState {
  return {
    budgetLimitEur: 0,
    totalSpentEur: 0,
    paidProvidersDisabled: true,
    autoFallbackDisabled: true,
    autoUpgradeDisabled: true,
    freeQuotaUsage: {
      [MEMORY_EMBEDDING_MODEL_ID]: {
        requestsToday: 0,
        dailySoftLimit: 500,
        exhausted: false,
        lastResetDate: today,
      },
      'gemini-3.8-flash': {
        requestsToday: 0,
        dailySoftLimit: 10,
        exhausted: false,
        lastResetDate: today,
      },
    },
    auditLog: [],
  };
}

const events: Array<Omit<BudgetAuditEvent, 'id' | 'timestamp'>> = [];
const state = budget();
let persisted = 0;
let calledModel = '';
const success = await runMemoryEmbedding({
  budgetGuard: state,
  action: 'MEMORY_EMBED',
  contents: ['title\ncontent'],
  recordAudit: (entry) => events.push(entry),
  embed: async (modelId, contents) => {
    calledModel = modelId;
    assert.deepEqual(contents, ['title\ncontent']);
    return [0.1, 0.2, 0.3];
  },
  persistExhausted: () => { persisted += 1; },
});
assert.equal(calledModel, 'gemini-embedding-2');
assert.equal(MEMORY_EMBEDDING_MODEL_ID, 'gemini-embedding-2');
assert.deepEqual(success.vector, [0.1, 0.2, 0.3]);
assert.equal(success.notice, undefined);

const quotaState = budget();
const quotaEvents: Array<Omit<BudgetAuditEvent, 'id' | 'timestamp'>> = [];
const quotaResult = await runMemoryEmbedding({
  budgetGuard: quotaState,
  action: 'MEMORY_EMBED',
  contents: ['x'],
  recordAudit: (entry) => quotaEvents.push(entry),
  embed: async () => { throw new Error('429 RESOURCE_EXHAUSTED: Quota exceeded for gemini-embedding-2'); },
  persistExhausted: () => { persisted += 1; },
});
assert.match(quotaResult.notice ?? '', /ausgeschöpft/i);
assert.equal(quotaState.freeQuotaUsage[MEMORY_EMBEDDING_MODEL_ID].exhausted, true);
assert.equal(quotaEvents.at(-1)?.modelId, MEMORY_EMBEDDING_MODEL_ID);
assert.equal(quotaEvents.at(-1)?.action, 'MEMORY_EMBED');
assert.equal(quotaEvents.at(-1)?.decision, 'GESTOPPT_KONTINGENT');
assert.equal(persisted, 1);

for (const [action, failure] of [
  ['MEMORY_SEARCH', new Error('429 Too Many Requests: rate limit exceeded, retry after 20s')],
  ['MEMORY_SEARCH', new Error('503 UNAVAILABLE: temporarily unavailable')],
] as const) {
  const stateForTransient = budget();
  const failureEvents: Array<Omit<BudgetAuditEvent, 'id' | 'timestamp'>> = [];
  const result = await runMemoryEmbedding({
    budgetGuard: stateForTransient,
    action,
    contents: ['query'],
    recordAudit: (entry) => failureEvents.push(entry),
    embed: async () => { throw failure; },
    persistExhausted: () => { persisted += 1; },
  });
  assert.ok(result.notice);
  assert.equal(stateForTransient.freeQuotaUsage[MEMORY_EMBEDDING_MODEL_ID].exhausted, false);
  assert.equal(failureEvents.at(-1)?.modelId, MEMORY_EMBEDDING_MODEL_ID);
  assert.equal(failureEvents.at(-1)?.action, action);
  assert.notEqual(failureEvents.at(-1)?.decision, 'GESTOPPT_KONTINGENT');
}

const blocked = budget();
blocked.freeQuotaUsage[MEMORY_EMBEDDING_MODEL_ID].exhausted = true;
let providerCalled = false;
const blockedEvents: Array<Omit<BudgetAuditEvent, 'id' | 'timestamp'>> = [];
const blockedResult = await runMemoryEmbedding({
  budgetGuard: blocked,
  action: 'MEMORY_SEARCH',
  contents: ['query'],
  recordAudit: (entry) => blockedEvents.push(entry),
  embed: async () => { providerCalled = true; return [1]; },
});
assert.ok(blockedResult.notice);
assert.equal(providerCalled, false);
assert.equal(blockedEvents.at(-1)?.decision, 'GESTOPPT_KONTINGENT');

console.log('Memory embedding integration tests passed.');
