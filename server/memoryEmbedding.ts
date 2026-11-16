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
}): Promise<MemoryEmbeddingResult> {
  const { budgetGuard, action, contents, recordAudit, embed, persistExhausted } = params;

  // The guard writes its own audit entry. Keep it outside the provider-error
  // handler to avoid double-auditing an already blocked request.
  try {
    assertZeroBudgetModelAllowed(MEMORY_EMBEDDING_MODEL_ID, action, budgetGuard, recordAudit);
  } catch (err) {
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
