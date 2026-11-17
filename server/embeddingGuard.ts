import {
  classifyProviderError,
  formatGermanApiError,
  type ProviderErrorKind,
} from './geminiClient.ts';
import type { BudgetAuditEvent, BudgetGuardState } from '../src/types/zero.ts';

export type EmbeddingQuotaDecision = 'BLOCKIERT_BUDGET_GUARD' | 'GESTOPPT_KONTINGENT';

export interface EmbeddingFailureOutcome {
  kind: ProviderErrorKind;
  /** True only when a durable exhausted lock was written into the budget guard. */
  persistedExhausted: boolean;
  decision: EmbeddingQuotaDecision;
  message: string;
}

/**
 * Classify and record the outcome of a failed embedding call.
 *
 * A provider-confirmed quota exhaustion sets a durable `exhausted` lock that the
 * caller persists via saveDb; a temporary rate limit or transient fault is
 * recorded in the audit log but never marked as exhausted. Every failure is
 * surfaced through the audit log so nothing silently bypasses the quota guard.
 */
export function recordEmbeddingFailure(params: {
  modelId: string;
  action: string;
  err: unknown;
  budgetGuard: BudgetGuardState;
  recordAudit: (entry: Omit<BudgetAuditEvent, 'id' | 'timestamp'>) => void;
}): EmbeddingFailureOutcome {
  const { modelId, action, err, budgetGuard, recordAudit } = params;
  const kind = classifyProviderError(err);
  const message = formatGermanApiError(err);
  const quota = budgetGuard.freeQuotaUsage[modelId];

  if (kind === 'quota-exhausted') {
    if (quota) quota.exhausted = true;
    recordAudit({
      adapterId: 'gemini-quota-guard',
      modelId,
      action,
      decision: 'GESTOPPT_KONTINGENT',
      reason: `Embedding-Kontingent für "${modelId}" ausgeschöpft und dauerhaft gesperrt: ${message}`,
      costEur: 0,
    });
    return { kind, persistedExhausted: Boolean(quota), decision: 'GESTOPPT_KONTINGENT', message };
  }

  recordAudit({
    adapterId: 'gemini-embedding-guard',
    modelId,
    action,
    decision: 'BLOCKIERT_BUDGET_GUARD',
    reason: `Embedding-Aufruf fehlgeschlagen (${kind}); kein Kontingent verbraucht, kein stiller Fehler: ${message}`,
    costEur: 0,
  });
  return { kind, persistedExhausted: false, decision: 'BLOCKIERT_BUDGET_GUARD', message };
}
