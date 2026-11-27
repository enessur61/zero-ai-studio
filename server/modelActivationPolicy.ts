import type { ModelDefinition } from '../src/types/zero.ts';

export interface AutomaticModelActivationPolicy {
  provider: string;
  adapterId: string;
  version: string;
  license: string;
  freeTierType?: 'EINGESCHRÄNKT KOSTENLOS (FREE TIER)';
}

const FREE_CLOUD_AUTO_ACTIVATION_POLICIES: Readonly<Record<string, AutomaticModelActivationPolicy>> = {
  'cloudflare-glm-4.7-flash': {
    provider: 'Cloudflare Workers AI Free allocation',
    adapterId: 'cloudflare-workers-ai',
    version: '@cf/zai-org/glm-4.7-flash',
    license: 'MIT',
    freeTierType: 'EINGESCHRÄNKT KOSTENLOS (FREE TIER)',
  },
  'cloudflare-moondream-3.1-9b-a2b': {
    provider: 'Cloudflare Workers AI Free allocation',
    adapterId: 'cloudflare-workers-ai-moondream-vision',
    version: '@cf/moondream/moondream3.1-9B-A2B',
    license: 'Apache 2.0',
    freeTierType: 'EINGESCHRÄNKT KOSTENLOS (FREE TIER)',
  },
  'flux-1-schnell-free': {
    provider: 'Cloudflare Workers AI Free allocation',
    adapterId: 'cloudflare-workers-ai-image',
    version: '@cf/black-forest-labs/flux-1-schnell',
    license: 'Apache 2.0',
    freeTierType: 'EINGESCHRÄNKT KOSTENLOS (FREE TIER)',
  },
  'cloudflare-whisper-large-v3-turbo': {
    provider: 'Cloudflare Workers AI Free allocation',
    adapterId: 'cloudflare-workers-ai-whisper',
    version: '@cf/openai/whisper-large-v3-turbo',
    license: 'MIT',
    freeTierType: 'EINGESCHRÄNKT KOSTENLOS (FREE TIER)',
  },
  'gemini-3.8-flash': {
    provider: 'Google GenAI Free Tier',
    adapterId: 'gemini-text-adapter',
    version: '3.8-flash',
    license: 'Google Gemini API Free Tier',
  },
  'gemini-3.6-flash': {
    provider: 'Google GenAI Free Tier',
    adapterId: 'gemini-text-adapter',
    version: '3.6-flash',
    license: 'Google Gemini API Free Tier',
  },
  'gemini-3.5-flash-lite': {
    provider: 'Google GenAI Free Tier',
    adapterId: 'gemini-lite-adapter',
    version: '3.5-flash-lite',
    license: 'Google Gemini API Free Tier',
  },
  'gemini-3.1-flash-lite': {
    provider: 'Google GenAI Free Tier',
    adapterId: 'gemini-lite-adapter',
    version: '3.1-lite',
    license: 'Google Gemini API Free Tier',
  },
  'gemini-3.8-flash-lite-tts': {
    provider: 'Google GenAI Free Tier',
    adapterId: 'gemini-tts-adapter',
    version: '3.8-flash-lite-tts',
    license: 'Google Gemini API Free Tier',
  },
  'gemini-3.8-flash-tts': {
    provider: 'Google GenAI Free Tier',
    adapterId: 'gemini-multispeaker-tts',
    version: '3.8-flash-tts',
    license: 'Google Gemini API Free Tier',
  },
  'gemini-3.5-transcribe': {
    provider: 'Google GenAI Free Tier',
    adapterId: 'gemini-transcribe-adapter',
    version: '3.5-transcribe',
    license: 'Google Gemini API Free Tier',
  },
  'gemini-embedding-2': {
    provider: 'Google GenAI Free Tier',
    adapterId: 'gemini-embedding-adapter',
    version: 'embedding-2',
    license: 'Google Gemini API Free Tier',
  },
};

const MAX_TEST_AGE_MS = 24 * 60 * 60 * 1000;
type ActivationEnvironment = Record<string, string | undefined>;

function hasValidSharedCostGates(env: ActivationEnvironment): boolean {
  const dailyLimit = Number(env.ZERO_COST_GUARD_DAILY_REQUEST_LIMIT);
  return env.ZERO_COST_GUARD_ENABLED === 'true' &&
    env.ZERO_COST_GUARD_FREE_ONLY_CONFIRMED === 'true' &&
    Number.isSafeInteger(dailyLimit) && dailyLimit >= 1 && dailyLimit <= 100_000 &&
    env.ZERO_COST_RESOURCE_GUARD_ENABLED === 'true' &&
    env.ZERO_COST_RESOURCE_GUARD_FREE_ONLY_CONFIRMED === 'true' &&
    Boolean(env.DATABASE_URL?.trim());
}

export interface AutomaticModelActivationDecision {
  managed: boolean;
  eligible: boolean;
  reason: string;
}

/**
 * Fail-closed automatic activation for a deliberately small, audited free-cloud
 * allowlist. This function is pure: it never contacts a provider or allocates
 * compute. A fresh, successful live test and the current cost gates are required.
 */
export function getAutomaticModelActivationDecision(
  model: ModelDefinition,
  now = new Date(),
  env: ActivationEnvironment = process.env,
): AutomaticModelActivationDecision {
  const policy = FREE_CLOUD_AUTO_ACTIVATION_POLICIES[model.id];
  if (!policy) {
    return { managed: false, eligible: false, reason: 'Modell ist nicht für automatische Free-Cloud-Aktivierung freigegeben.' };
  }
  if (
    model.executionMode !== 'FREE CLOUD' ||
    model.provider !== policy.provider ||
    model.adapterId !== policy.adapterId ||
    model.version !== policy.version ||
    model.license !== policy.license ||
    (policy.freeTierType !== undefined && model.freeTierType !== policy.freeTierType)
  ) {
    return { managed: true, eligible: false, reason: 'Modell-ID, Provider, Adapter, Version, Lizenz oder Free-Tier-Klassifizierung weicht von der geprüften Freigabeliste ab.' };
  }
  if (
    model.requiresPaidKey ||
    model.requiresExternalGpu ||
    model.costEur !== 0
  ) {
    return { managed: true, eligible: false, reason: 'Kostenpflichtiger Schlüssel, externe GPU oder nicht-null Kosten verhindern die Aktivierung.' };
  }
  if (!model.hasRealAdapter || !model.testPassed || model.status !== 'FUNKTIONIERT') {
    return { managed: true, eligible: false, reason: 'Ein echter Adapter und ein erfolgreiches Live-Testergebnis sind erforderlich.' };
  }
  const testedAt = model.lastTestedAt ? Date.parse(model.lastTestedAt) : Number.NaN;
  const age = now.getTime() - testedAt;
  if (!Number.isFinite(testedAt) || age < 0 || age > MAX_TEST_AGE_MS) {
    return { managed: true, eligible: false, reason: 'Der erfolgreiche Live-Test fehlt, liegt in der Zukunft oder ist älter als 24 Stunden.' };
  }
  if (!hasValidSharedCostGates(env)) {
    return { managed: true, eligible: false, reason: 'PostgreSQL sowie beide zentralen ZERO-Kosten- und Ressourcenfreigaben sind nicht vollständig aktiv.' };
  }
  if (model.id.startsWith('cloudflare-') || model.id === 'flux-1-schnell-free') {
    if (
      env.ZERO_CLOUDFLARE_AI_ENABLED !== 'true' ||
      env.ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED !== 'true' ||
      !env.CLOUDFLARE_ACCOUNT_ID?.trim() ||
      !env.CLOUDFLARE_API_TOKEN?.trim()
    ) {
      return { managed: true, eligible: false, reason: 'Cloudflare-Free-Plan, Zugangsdaten und explizite ZERO-Freigaben müssen aktuell bestätigt sein.' };
    }
  } else if (
    env.ZERO_GEMINI_FREE_TIER_ONLY !== 'true' ||
    !env.GEMINI_API_KEY?.trim()
  ) {
    return { managed: true, eligible: false, reason: 'Gemini-Free-Tier-only und ein konfigurierter API-Schlüssel müssen aktuell bestätigt sein.' };
  }
  return { managed: true, eligible: true, reason: 'Frischer Live-Test erfolgreich; Adapter, Modell-ID, Lizenz, Free-Tier und sämtliche Kosten-Gates stimmen.' };
}

/** Reconcile only models owned by this automatic cloud policy; local user toggles remain untouched. */
export function reconcileAutomaticModelActivation(
  model: ModelDefinition,
  now = new Date(),
  env: ActivationEnvironment = process.env,
): AutomaticModelActivationDecision {
  const decision = getAutomaticModelActivationDecision(model, now, env);
  if (decision.managed) model.enabled = decision.eligible;
  return decision;
}

export function getAutomaticFreeCloudModelIds(): string[] {
  return Object.keys(FREE_CLOUD_AUTO_ACTIVATION_POLICIES);
}
