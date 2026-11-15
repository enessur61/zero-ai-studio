import type { BudgetGuardState, ModelDefinition } from '../src/types/zero.ts';

const ROUTABLE_GEMINI_TEXT_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
] as const;

const ROUTABLE_MODEL_SET = new Set<string>(ROUTABLE_GEMINI_TEXT_MODELS);

export interface ZeroRouteDecision {
  modelId: string;
  reason: string;
  consideredModelIds: string[];
}

/**
 * Select only a Gemini text model that has passed a real adapter test and is
 * enabled, free-key, zero-cost, and still within its locally tracked quota.
 * Local models are deliberately excluded: this server route cannot execute
 * browser/iOS-local inference.
 */
export function chooseZeroChatModel(
  models: ModelDefinition[],
  budget: BudgetGuardState,
  requestedModelId?: string,
  now = new Date(),
): ZeroRouteDecision | null {
  const today = now.toISOString().slice(0, 10);
  const eligible = models.filter((model) => {
    if (!ROUTABLE_MODEL_SET.has(model.id)) return false;
    if (model.category !== 'Text & Reasoning') return false;
    if (model.executionMode !== 'FREE CLOUD') return false;
    if (!model.enabled || !model.hasRealAdapter || !model.testPassed) return false;
    if (model.requiresPaidKey || model.requiresExternalGpu || model.costEur !== 0) return false;
    if (model.status !== 'FUNKTIONIERT') return false;
    const quota = budget.freeQuotaUsage[model.id];
    if (!quota) return false;
    const quotaIsCurrent = !quota.lastResetDate || quota.lastResetDate === today;
    return !quotaIsCurrent || (!quota.exhausted && quota.requestsToday < quota.dailySoftLimit);
  });

  const consideredModelIds = eligible.map((model) => model.id);
  if (eligible.length === 0) return null;

  const preferred = requestedModelId
    ? eligible.find((model) => model.id === requestedModelId)
    : undefined;
  const selected = preferred ?? eligible[0];
  return {
    modelId: selected.id,
    reason: preferred
      ? 'Angefordertes Modell ist aktiviert, real getestet und innerhalb des Free-Tier-Kontingents.'
      : requestedModelId
        ? 'Angefordertes Modell ist nicht sicher verfügbar; geprüftes kostenloses Ersatzmodell gewählt.'
        : 'Bestes verfügbares, real getestetes kostenloses Textmodell nach ZERO CORE Priorität gewählt.',
    consideredModelIds,
  };
}
