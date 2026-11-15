import type { BudgetGuardState, ModelCategory, ModelDefinition } from '../src/types/zero.ts';

const ROUTABLE_GEMINI_TEXT_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
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

export type ZeroMediaTask = 'image' | 'video' | 'text-to-speech' | 'transcription';

const MEDIA_TASKS: Record<ZeroMediaTask, {
  category: ModelCategory;
  cloudModelIds: readonly string[];
  localModelIds: readonly string[];
}> = {
  image: {
    category: 'Bildgenerierung',
    // No image cloud endpoint is currently verified as safely free and executable.
    cloudModelIds: [],
    localModelIds: ['zero-canvas-img2img'],
  },
  video: {
    category: 'Videogenerierung',
    cloudModelIds: [],
    localModelIds: ['zero-timeline-video-60s'],
  },
  'text-to-speech': {
    category: 'Sprache & Audio',
    cloudModelIds: ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'],
    localModelIds: ['apple-avspeech-webspeech', 'piper-tts-de', 'kokoro-82m'],
  },
  transcription: {
    category: 'Sprache & Audio',
    cloudModelIds: ['gemini-3.5-transcribe'],
    localModelIds: ['whisper-cpp-small'],
  },
};

function hasAvailableQuota(budget: BudgetGuardState, modelId: string, today: string): boolean {
  const quota = budget.freeQuotaUsage[modelId];
  if (!quota) return false;
  const quotaIsCurrent = !quota.lastResetDate || quota.lastResetDate === today;
  return !quotaIsCurrent || (!quota.exhausted && quota.requestsToday < quota.dailySoftLimit);
}

/**
 * Select a media model only after a real model test. Local models additionally
 * require an explicit device-side runtime probe supplied by the client.
 * Cloud image/video providers are intentionally absent until a genuinely
 * free, working endpoint has been verified.
 */
export function chooseZeroMediaModel(
  models: ModelDefinition[],
  budget: BudgetGuardState,
  task: ZeroMediaTask,
  availableLocalRuntimeModelIds: string[] = [],
  now = new Date(),
): ZeroRouteDecision | null {
  const spec = MEDIA_TASKS[task];
  const today = now.toISOString().slice(0, 10);
  const eligible = models.filter((model) => {
    if (model.category !== spec.category) return false;
    if (!model.enabled || !model.hasRealAdapter || !model.testPassed) return false;
    if (model.requiresPaidKey || model.requiresExternalGpu || model.costEur !== 0) return false;
    if (model.status !== 'FUNKTIONIERT' && model.status !== 'LOKAL INSTALLIERT') return false;

    if (spec.cloudModelIds.includes(model.id)) {
      return model.executionMode === 'FREE CLOUD' && hasAvailableQuota(budget, model.id, today);
    }
    if (spec.localModelIds.includes(model.id)) {
      return model.executionMode === 'LOCAL ON-DEVICE' && availableLocalRuntimeModelIds.includes(model.id);
    }
    return false;
  });

  if (eligible.length === 0) return null;
  const selected = eligible[0];
  return {
    modelId: selected.id,
    consideredModelIds: eligible.map((model) => model.id),
    reason: selected.executionMode === 'LOCAL ON-DEVICE'
      ? 'Lokales Modell hat einen echten Gerätetest bestanden und wurde vom Client als verfügbar gemeldet.'
      : 'Cloud-Modell hat einen echten Adaptertest bestanden und verfügt über ein verfügbares Free-Tier-Kontingent.',
  };
}
