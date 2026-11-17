import assert from 'node:assert/strict';
import {
  assertZeroBudgetModelAllowed,
  classifyProviderError,
  formatGermanApiError,
  isExhaustedWithinCurrentDay,
  isQuotaExhaustionError,
  isQuotaOrRateLimitError,
  isTransientServerError,
  ZeroQuotaExhaustedError,
} from '../server/geminiClient.ts';
import { recordEmbeddingFailure } from '../server/embeddingGuard.ts';
import type { BudgetAuditEvent, BudgetGuardState } from '../src/types/zero.ts';

const today = new Date().toISOString().slice(0, 10);
const MODEL = 'gemini-3.8-flash';
const EMBEDDING_MODEL = 'gemini-embedding-2';

function baseBudget(): BudgetGuardState {
  return {
    budgetLimitEur: 0,
    totalSpentEur: 0,
    paidProvidersDisabled: true,
    autoFallbackDisabled: true,
    autoUpgradeDisabled: true,
    freeQuotaUsage: {
      [MODEL]: { requestsToday: 0, dailySoftLimit: 10, exhausted: false, lastResetDate: today },
      [EMBEDDING_MODEL]: { requestsToday: 0, dailySoftLimit: 500, exhausted: false, lastResetDate: today },
    },
    auditLog: [],
  };
}

// ---------------------------------------------------------------------------
// Fix 3: error classification must never confuse transient faults with quota.
// ---------------------------------------------------------------------------
{
  assert.equal(classifyProviderError(new Error('503 UNAVAILABLE: model is overloaded')), 'transient');
  assert.equal(classifyProviderError(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}')), 'transient');
  assert.equal(isTransientServerError(new Error('fetch failed')), true);
  for (const status of [500, 502, 503, 504]) {
    const cloudflareFailure = new Error(`Cloudflare Workers AI Fehler (${status}): AiError: Internal server error (request-id)`);
    assert.equal(classifyProviderError(cloudflareFailure), 'transient', `HTTP ${status} must be transient`);
    assert.equal(isQuotaExhaustionError(cloudflareFailure), false, `HTTP ${status} must not lock the free quota`);
  }
  assert.match(
    formatGermanApiError(new Error('Cloudflare Workers AI Fehler (500): Internal server error')),
    /HTTP 5xx/,
  );
  assert.equal(
    isQuotaExhaustionError(new Error('503 UNAVAILABLE: high demand, please retry')),
    false,
    'a 503 must never be classified as exhausted quota',
  );

  const realQuota = new Error(
    '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"You exceeded your current quota. FREE_LIMIT reached"}}'
  );
  assert.equal(classifyProviderError(realQuota), 'quota-exhausted');
  assert.equal(isQuotaExhaustionError(realQuota), true);

  const rateLimit = new Error('429 Too Many Requests: rate limit exceeded, retry after 30s');
  assert.equal(classifyProviderError(rateLimit), 'rate-limited');
  const cloudflareRateLimit = new Error('Cloudflare Workers AI Free-Kontingent oder Rate-Limit erreicht (HTTP 429). Kein kostenpflichtiger Fallback.');
  assert.equal(classifyProviderError(cloudflareRateLimit), 'rate-limited');
  assert.equal(isQuotaExhaustionError(cloudflareRateLimit), false, 'Cloudflare 429 must not be assumed to mean permanent daily quota exhaustion');
  assert.equal(isQuotaExhaustionError(rateLimit), false, 'a rate limit is not durable quota exhaustion');
  assert.equal(isQuotaOrRateLimitError(rateLimit), true);

  // Google rate-limit messages also contain the word "quota"; the short window
  // must win so a per-minute limit never creates a durable daily lock.
  const perMinuteQuota = new Error(
    '429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric "generate_content_free_tier_requests", limit: 15, per minute'
  );
  assert.equal(classifyProviderError(perMinuteQuota), 'rate-limited');
  assert.equal(isQuotaExhaustionError(perMinuteQuota), false);

  const billingGateError = new Error('Gemini gesperrt: Setze ZERO_GEMINI_FREE_TIER_ONLY=true erst nachdem im Google-Cloud-Projekt die Abrechnung deaktiviert wurde.');
  assert.equal(classifyProviderError(billingGateError), 'auth');
  assert.match(formatGermanApiError(billingGateError), /ZERO_GEMINI_FREE_TIER_ONLY=true/);
  assert.equal(classifyProviderError(new ZeroQuotaExhaustedError('x')), 'quota-exhausted');

  const quotaMessage = formatGermanApiError(realQuota);
  assert.match(quotaMessage, /ausgeschöpft/);
  assert.match(formatGermanApiError(rateLimit), /Rate-Limit/);
  assert.match(formatGermanApiError(new Error('503 UNAVAILABLE')), /HTTP 5xx/);
  assert.doesNotMatch(
    formatGermanApiError(new Error('503 UNAVAILABLE: high demand')),
    /ausgeschöpft/,
    'a 503 must not produce an exhausted-quota message',
  );
}

// ---------------------------------------------------------------------------
// Fix 1: an exhausted quota must never be cleared by a re-check.
// ---------------------------------------------------------------------------
{
  assert.equal(
    isExhaustedWithinCurrentDay({ requestsToday: 5, dailySoftLimit: 10, exhausted: true, lastResetDate: today }),
    true,
  );
  assert.equal(
    isExhaustedWithinCurrentDay({ requestsToday: 5, dailySoftLimit: 10, exhausted: true, lastResetDate: '2020-01-01' }),
    true,
    'an earlier local date is not proof of a provider-side quota reset',
  );
  assert.equal(
    isExhaustedWithinCurrentDay({ requestsToday: 10, dailySoftLimit: 10, exhausted: false, lastResetDate: today }),
    true,
    'hitting the daily limit locks even without an explicit exhausted flag',
  );

  const budget = baseBudget();
  budget.freeQuotaUsage[MODEL] = {
    requestsToday: 10,
    dailySoftLimit: 10,
    exhausted: true,
    lastResetDate: today,
  };
  assert.throws(
    () => assertZeroBudgetModelAllowed(MODEL, 'MODEL_TEST', budget, () => {}),
    (err: unknown) => err instanceof ZeroQuotaExhaustedError,
    'a re-check of an exhausted model must throw the typed quota error',
  );
  assert.equal(
    budget.freeQuotaUsage[MODEL].exhausted,
    true,
    'the exhausted flag must survive the rejected re-check',
  );

  const rollover = baseBudget();
  rollover.freeQuotaUsage[MODEL] = {
    requestsToday: 10,
    dailySoftLimit: 10,
    exhausted: true,
    lastResetDate: '2020-01-01',
  };
  const rolloverAudits: Array<{ decision: string; reason: string }> = [];
  assert.throws(
    () => assertZeroBudgetModelAllowed(MODEL, 'MODEL_TEST', rollover, (event) => rolloverAudits.push(event)),
    /Reset.*nicht verifiziert/,
    'a local UTC date rollover must never clear a provider quota lock',
  );
  assert.equal(rollover.freeQuotaUsage[MODEL].exhausted, true);
  assert.equal(rollover.freeQuotaUsage[MODEL].requestsToday, 10);
  assert.equal(rollover.freeQuotaUsage[MODEL].lastResetDate, '2020-01-01');
  assert.equal(rolloverAudits.at(-1)?.decision, 'BLOCKIERT_BUDGET_GUARD');

  const staleButNotExhausted = baseBudget();
  staleButNotExhausted.freeQuotaUsage[MODEL] = {
    requestsToday: 2,
    dailySoftLimit: 10,
    exhausted: false,
    lastResetDate: '2020-01-01',
  };
  assert.throws(
    () => assertZeroBudgetModelAllowed(MODEL, 'MODEL_TEST', staleButNotExhausted, () => {}),
    /Reset.*nicht verifiziert/,
    'stale quota metadata must fail closed even when the local counter is below its limit',
  );
  assert.equal(staleButNotExhausted.freeQuotaUsage[MODEL].requestsToday, 2);
  assert.equal(staleButNotExhausted.freeQuotaUsage[MODEL].exhausted, false);
}

// ---------------------------------------------------------------------------
// Fix 2: embedding routes must persist real quota errors, never swallow them.
// ---------------------------------------------------------------------------
{
  const budget = baseBudget();
  const events: Array<Omit<BudgetAuditEvent, 'id' | 'timestamp'>> = [];
  const realQuota = new Error(
    '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for gemini-embedding-2"}}'
  );

  const outcome = recordEmbeddingFailure({
    modelId: EMBEDDING_MODEL,
    action: 'MEMORY_EMBED',
    err: realQuota,
    budgetGuard: budget,
    recordAudit: (e) => events.push(e),
  });
  assert.equal(outcome.persistedExhausted, true);
  assert.equal(budget.freeQuotaUsage[EMBEDDING_MODEL].exhausted, true, 'real quota error must be persisted');
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, 'GESTOPPT_KONTINGENT');
  assert.equal(events[0].action, 'MEMORY_EMBED');

  const budget2 = baseBudget();
  const events2: Array<Omit<BudgetAuditEvent, 'id' | 'timestamp'>> = [];
  const rateLimit = new Error('429 Too Many Requests: rate limit exceeded, retry after 20s');
  const outcome2 = recordEmbeddingFailure({
    modelId: EMBEDDING_MODEL,
    action: 'MEMORY_SEARCH',
    err: rateLimit,
    budgetGuard: budget2,
    recordAudit: (e) => events2.push(e),
  });
  assert.equal(outcome2.persistedExhausted, false, 'a rate limit must not persist an exhausted lock');
  assert.equal(budget2.freeQuotaUsage[EMBEDDING_MODEL].exhausted, false);
  assert.equal(events2.length, 1, 'even a non-quota failure must be audited, never silently dropped');
  assert.equal(events2[0].decision, 'BLOCKIERT_BUDGET_GUARD');

  const budget3 = baseBudget();
  const events3: Array<Omit<BudgetAuditEvent, 'id' | 'timestamp'>> = [];
  const transient = new Error('503 UNAVAILABLE: model is overloaded');
  const outcome3 = recordEmbeddingFailure({
    modelId: EMBEDDING_MODEL,
    action: 'MEMORY_SEARCH',
    err: transient,
    budgetGuard: budget3,
    recordAudit: (e) => events3.push(e),
  });
  assert.equal(outcome3.persistedExhausted, false);
  assert.equal(outcome3.kind, 'transient');
  assert.equal(budget3.freeQuotaUsage[EMBEDDING_MODEL].exhausted, false, 'a 503 must never lock the quota');
}

console.log('Quota guard hardening tests passed.');
