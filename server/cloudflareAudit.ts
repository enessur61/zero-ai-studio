import type { BudgetAuditEvent } from '../src/types/zero.ts';
import type { CloudflareAuditEvent } from './cloudflareWorkersAi.ts';
import { recordBudgetAudit, type ZeroDatabase } from './store.ts';

export function createCloudflareBudgetAuditRecorder(
  db: ZeroDatabase,
  save: (database: ZeroDatabase) => Promise<void>,
): (event: CloudflareAuditEvent) => Promise<void> {
  return async (event) => {
    const entry: Omit<BudgetAuditEvent, 'id' | 'timestamp'> = {
      adapterId: event.adapterId,
      modelId: event.modelId,
      action: event.action,
      decision: event.decision,
      reason: event.reason,
      costEur: event.costEur,
      provider: event.provider,
      outcome: event.outcome,
      httpStatus: event.httpStatus,
      providerRequestId: event.providerRequestId,
      errorCategory: event.errorCategory,
      durationMs: event.durationMs,
    };
    recordBudgetAudit(db, entry);
    await save(db);
  };
}