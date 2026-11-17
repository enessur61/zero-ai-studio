import {
  assertZeroBudgetModelAllowed,
  formatGermanApiError,
} from './geminiClient.ts';
import { recordEmbeddingFailure } from './embeddingGuard.ts';
import type { BudgetAuditEvent, BudgetGuardState } from '../src/types/zero.ts';

export const MEMORY_EMBEDDING_MODEL_ID = 'gemini-embedding-2';

export type MemoryEmbeddingAction = 'MEMORY_EMBED' | 'MEMORY_SEARCH';

export interface MemoryEmbeddingResult {
  vector?: number[];
  notice?: string;
}

export async function runMemoryEmbedding(params: {
  budgetGuard: BudgetGuardState;
  action: MemoryEmbeddingAction;
  contents: string[];
  recordAudit: (entry: Omit<BudgetAuditEvent, 'id' | 'timestamp'>) => void;
  embed: (modelId: string, contents: string[]) => Promise<number[] | undefined>;
  persistExhausted?: () => Promise<void> | void;
  reserveQuota?: () => Promise<void>;
}): Promise<MemoryEmbeddingResult> {
  const { budgetGuard, action, contents, recordAudit, embed, persistExhausted, reserveQuota } = params;

  // The guard may already audit a blocked request. Track that so malformed
  // metadata is audited here without duplicating the guard's own audit event.
  let guardAudited = false;
  try {
    if (reserveQuota) {
      await reserveQuota();
    } else {
      assertZeroBudgetModelAllowed(
        MEMORY_EMBEDDING_MODEL_ID,
        action,
        budgetGuard,
        (entry) => {
          guardAudited = true;
          recordAudit(entry);
        },
      );
    }
  } catch (err) {
    if (!guardAudited) {
      recordAudit({
        adapterId: 'gemini-quota-guard',
        modelId: MEMORY_EMBEDDING_MODEL_ID,
        action,
        decision: 'BLOCKIERT_BUDGET_GUARD',
        reason: `Kontingentprüfung fehlgeschlagen; Aufruf sicher blockiert: ${formatGermanApiError(err)}`,
        costEur: 0,
      });
    }
    return { notice: formatGermanApiError(err) };
  }

  try {
    return { vector: await embed(MEMORY_EMBEDDING_MODEL_ID, contents) };
  } catch (err) {
    const outcome = recordEmbeddingFailure({
      modelId: MEMORY_EMBEDDING_MODEL_ID,
      action,
      err,
      budgetGuard,
      recordAudit,
    });
    if (outcome.persistedExhausted && persistExhausted) await persistExhausted();
    return { notice: outcome.message };
  }
}
