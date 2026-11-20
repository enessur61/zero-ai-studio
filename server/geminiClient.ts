import { isZeroResourceOperationReplay, withZeroCostResourceOperation, ZeroResourceOperationReplayError, type ZeroResourceType } from './zeroCostResourceGuard.ts';
import { createZeroIdempotencyKey, requireZeroPrincipal } from './zeroPrincipalContext.ts';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { BudgetGuardState } from '../src/types/zero.ts';

const ALLOWED_FREE_GEMINI_MODELS = new Set([
  'gemini-3.8-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash-lite-tts',
  'gemini-3.8-flash-tts',
  'gemini-3.5-transcribe',
  'gemini-embedding-2',
  'gemini-web-grounding',
]);

const PAID_GEMINI_MODELS = new Set([
  'gemini-4-argon',
  'gemini-4-argon',
  'gemini-3-pro-image',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite-image',
  'gemini-omni-1.1-flash',
  'lyria-3-clip-preview',
  'lyria-3-pro-preview',
]);

export function classifyGeminiResourceType(modelId: string, payload: string): ZeroResourceType {
  if (/tts|transcrib/i.test(modelId) || payload.includes('audio/')) return 'audio';
  if (payload.includes('video/')) return 'video';
  if (payload.includes('image/')) return 'image';
  return 'text';
}

export function classifyGeminiResourceError(error: unknown): 'REJECTED' | 'UNKNOWN' {
  const kind = classifyProviderError(error);
  if (kind === 'quota-exhausted' || kind === 'rate-limited' || kind === 'auth' || kind === 'not-found') return 'REJECTED';
  const message = error instanceof Error ? error.message : String(error);
  const clientStatus = message.match(/\b(?:HTTP\s*)?(4\d{2})\b/i);
  if (clientStatus) return 'REJECTED';
  return 'UNKNOWN';
}

let sharedClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY ist nicht konfiguriert.');
  }
  if (process.env.ZERO_GEMINI_FREE_TIER_ONLY !== 'true') {
    throw new Error(
      'Gemini gesperrt: Setze ZERO_GEMINI_FREE_TIER_ONLY=true erst nachdem im Google-Cloud-Projekt die Abrechnung deaktiviert wurde. ZERO kann den externen Abrechnungsstatus nicht selbst verifizieren.'
    );
  }
  if (!sharedClient) {
    sharedClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      apiVersion: 'v1beta',
      httpOptions: {
        apiVersion: 'v1beta',
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    const models = sharedClient.models;
    const originalGenerateContent = models.generateContent.bind(models);
    const originalEmbedContent = models.embedContent.bind(models);
    models.generateContent = (async (request: Parameters<typeof models.generateContent>[0]) => {
      const modelId = String(request.model ?? '');
      if (!ALLOWED_FREE_GEMINI_MODELS.has(modelId)) {
        throw new Error('ZERO blockiert ein nicht freigegebenes Gemini-Modell vor dem Provider-Aufruf.');
      }
      const payload = JSON.stringify(request);
      const resourceType = classifyGeminiResourceType(modelId, payload);
      const operationInput = {
        provider: 'google-gemini-free' as const, modelId, resourceType, studio: 'ZERO CORE', action: 'GEMINI_GENERATE',
        payload: { model: modelId, contents: request.contents }, inputBytes: Buffer.byteLength(payload),
        inputChars: resourceType === 'text' ? payload.length : undefined,
      };
      const operationResult = await withZeroCostResourceOperation(
        { ...operationInput, principal: requireZeroPrincipal(),
          idempotencyKey: createZeroIdempotencyKey() },
        () => originalGenerateContent(request), process.env, undefined, undefined, classifyGeminiResourceError,
      );
      if (isZeroResourceOperationReplay(operationResult)) throw new ZeroResourceOperationReplayError(operationResult.operation);
      return operationResult;
    }) as typeof models.generateContent;
    models.embedContent = (async (request: Parameters<typeof models.embedContent>[0]) => {
      const modelId = String(request.model ?? '');
      if (!ALLOWED_FREE_GEMINI_MODELS.has(modelId)) {
        throw new Error('ZERO blockiert ein nicht freigegebenes Gemini-Embedding-Modell vor dem Provider-Aufruf.');
      }
      const payload = JSON.stringify(request);
      const operationInput = {
        provider: 'google-gemini-free' as const, modelId, resourceType: 'text' as const, studio: 'ZERO MEMORY', action: 'GEMINI_EMBED',
        payload: { model: modelId, contents: request.contents }, inputBytes: Buffer.byteLength(payload), inputChars: payload.length,
      };
      const operationResult = await withZeroCostResourceOperation(
        { ...operationInput, principal: requireZeroPrincipal(),
          idempotencyKey: createZeroIdempotencyKey() },
        () => originalEmbedContent(request), process.env, undefined, undefined, classifyGeminiResourceError,
      );
      if (isZeroResourceOperationReplay(operationResult)) throw new ZeroResourceOperationReplayError(operationResult.operation);
      return operationResult;
    }) as typeof models.embedContent;
  }
  return sharedClient;
}

function getTodayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Raised only when the locally tracked free-tier quota is genuinely exhausted.
 * A distinct type lets callers persist a durable lock instead of guessing from
 * a message string, and guarantees a re-test can never clear it (only the
 * proven daily rollover in assertZeroBudgetModelAllowed does).
 */
export class ZeroQuotaExhaustedError extends Error {
  readonly kind = 'quota-exhausted' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ZeroQuotaExhaustedError';
  }
}

/**
 * A local UTC date change is NOT proof that Google's provider-side quota reset.
 * Keep an exhausted flag/limit lock until an independently verified provider
 * reset is recorded. The optional now argument is retained for API compatibility.
 */
export function isExhaustedWithinCurrentDay(
  quota: { requestsToday: number; dailySoftLimit: number; exhausted: boolean; lastResetDate?: string },
  _now = new Date()
): boolean {
  if (quota.exhausted) return true;
  return (
    Number.isSafeInteger(quota.requestsToday) &&
    Number.isSafeInteger(quota.dailySoftLimit) &&
    quota.dailySoftLimit > 0 &&
    quota.requestsToday >= quota.dailySoftLimit
  );
}

export function assertZeroBudgetModelAllowed(
  modelId: string,
  action: string,
  budgetGuard: BudgetGuardState,
  recordAudit: (entry: {
    adapterId: string;
    modelId: string;
    action: string;
    decision: 'ERLAUBT_0_EUR' | 'BLOCKIERT_BUDGET_GUARD' | 'GESTOPPT_KONTINGENT';
    reason: string;
    costEur: number;
  }) => void
): void {
  if (PAID_GEMINI_MODELS.has(modelId) && budgetGuard.paidProvidersDisabled) {
    recordAudit({
      adapterId: 'gemini-budget-guard',
      modelId,
      action,
      decision: 'BLOCKIERT_BUDGET_GUARD',
      reason: `0 € Budget-Schutz: Kostenpflichtiges Modell "${modelId}" wurde strikt blockiert.`,
      costEur: 0,
    });
    throw new Error(
      `0 € Budget-Schutz aktiv: Das Modell "${modelId}" erfordert einen kostenpflichtigen API-Tarif und ist deaktiviert.`
    );
  }

  if (!ALLOWED_FREE_GEMINI_MODELS.has(modelId)) {
    recordAudit({
      adapterId: 'gemini-budget-guard',
      modelId,
      action,
      decision: 'BLOCKIERT_BUDGET_GUARD',
      reason: `Unbekanntes oder nicht freigegebenes Gemini-Modell "${modelId}" blockiert.`,
      costEur: 0,
    });
    throw new Error(`Modell "${modelId}" ist nicht in der kostenlosen 0 € Freigabeliste.`);
  }

  const today = getTodayUtcDate();
  const quota = budgetGuard.freeQuotaUsage[modelId];
  if (!quota) {
    recordAudit({
      adapterId: 'gemini-quota-guard',
      modelId,
      action,
      decision: 'BLOCKIERT_BUDGET_GUARD',
      reason: 'Quota-Metadaten fehlen. Aufruf aus Sicherheitsgründen blockiert.',
      costEur: 0,
    });
    throw new Error(`Kein gültiger Free-Tier-Kontingentdatensatz für "${modelId}". Sicher gestoppt (kein kostenpflichtiger Fallback).`);
  }

  const rejectInvalidQuotaMetadata = (reason: string, message: string): never => {
    recordAudit({
      adapterId: 'gemini-quota-guard',
      modelId,
      action,
      decision: 'BLOCKIERT_BUDGET_GUARD',
      reason,
      costEur: 0,
    });
    throw new Error(message);
  };

  if (!Number.isSafeInteger(quota.requestsToday) || quota.requestsToday < 0 ||
      !Number.isSafeInteger(quota.dailySoftLimit) || quota.dailySoftLimit <= 0 ||
      typeof quota.exhausted !== 'boolean') {
    rejectInvalidQuotaMetadata(
      'Kontingentdaten sind fehlerhaft (ungültige Zähler oder Grenzwerte). Aufruf fail-closed blockiert.',
      `Free-Tier-Kontingentdaten für "${modelId}" sind ungültig. Sicher gestoppt (kein kostenpflichtiger Fallback).`
    );
  }

  if (quota.lastResetDate !== undefined) {
    if (typeof quota.lastResetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(quota.lastResetDate)) {
      rejectInvalidQuotaMetadata(
        'Reset-Datum der Free-Tier-Kontingentdaten ist ungültig. Aufruf fail-closed blockiert.',
        `Reset-Datum des Free-Tier-Kontingents für "${modelId}" ist ungültig. Sicher gestoppt.`
      );
    }
    const resetDate = new Date(`${quota.lastResetDate}T00:00:00.000Z`);
    if (!Number.isFinite(resetDate.getTime()) || resetDate.toISOString().slice(0, 10) !== quota.lastResetDate ||
        quota.lastResetDate > today) {
      rejectInvalidQuotaMetadata(
        'Reset-Datum der Free-Tier-Kontingentdaten ist ungültig. Aufruf fail-closed blockiert.',
        `Reset-Datum des Free-Tier-Kontingents für "${modelId}" ist ungültig. Sicher gestoppt.`
      );
    }
    if (quota.lastResetDate < today) {
      recordAudit({
        adapterId: 'gemini-quota-guard',
        modelId,
        action,
        decision: 'BLOCKIERT_BUDGET_GUARD',
        reason: 'Lokaler UTC-Tageswechsel beweist keinen Reset des Google-Free-Tier-Kontingents. Automatische Freigabe aus Sicherheitsgründen verweigert.',
        costEur: 0,
      });
      throw new Error(
        `Free-Tier-Reset für "${modelId}" ist nicht verifiziert. Das Modell bleibt gesperrt; kein automatischer Reset und kein kostenpflichtiger Fallback.`
      );
    }
  } else {
    recordAudit({
      adapterId: 'gemini-quota-guard',
      modelId,
      action,
      decision: 'BLOCKIERT_BUDGET_GUARD',
      reason: 'Reset-Datum des Free-Tier-Kontingents fehlt. Aufruf aus Sicherheitsgründen blockiert; ein fehlender Zeitstempel ist kein Nachweis für ein frisches Provider-Kontingent.',
      costEur: 0,
    });
    throw new Error(
      `Reset-Datum des Free-Tier-Kontingents für "${modelId}" fehlt. Sicher gestoppt (kein kostenpflichtiger Fallback).`
    );
  }

  if (quota.exhausted || quota.requestsToday >= quota.dailySoftLimit) {
    recordAudit({
      adapterId: 'gemini-quota-guard',
      modelId,
      action,
      decision: 'GESTOPPT_KONTINGENT',
      reason: `Kostenloses Kontingent für "${modelId}" erreicht (${quota.requestsToday}/${quota.dailySoftLimit}). Sicher gestoppt ohne kostenpflichtigen Fallback.`,
      costEur: 0,
    });
    throw new ZeroQuotaExhaustedError(
      `Kostenloses Tageskontingent für "${modelId}" ausgeschöpft. Funktion sicher gestoppt (kein kostenpflichtiger Fallback).`
    );
  }

  // recordBudgetAudit owns the single request-counter increment. Keep the
  // guard itself side-effect-free apart from its audit callback to avoid
  // counting each successful authorization twice in the persisted database.
  recordAudit({
    adapterId: 'gemini-free-tier',
    modelId,
    action,
    decision: 'ERLAUBT_0_EUR',
    reason: `Free-Tier Aufruf freigegeben (0,00 €).`,
    costEur: 0,
  });
}

export type ProviderErrorKind =
  | 'quota-exhausted'
  | 'rate-limited'
  | 'transient'
  | 'auth'
  | 'not-found'
  | 'unknown';

/** Flatten a structured Google/HTTP error blob into a readable one-line string. */
function extractProviderErrorText(raw: string): string {
  const jsonStart = raw.indexOf('{');
  if (jsonStart === -1) return raw;
  try {
    const parsed = JSON.parse(raw.slice(jsonStart)) as {
      error?: { code?: number; status?: string; message?: string };
    };
    if (parsed?.error?.message) {
      return `${parsed.error.code ?? ''} ${parsed.error.status ?? ''}: ${parsed.error.message}`.trim();
    }
  } catch {
    // Not JSON — keep the raw string.
  }
  return raw;
}

/**
 * Classify a provider failure into exactly one kind. Order matters:
 *   1. transient 503/network faults are checked first, so a temporary outage is
 *      never mistaken for exhausted quota;
 *   2. explicit short-window rate limiting (per minute/second, retry-after,
 *      too-many-requests) is checked before any "quota" wording, because Google
 *      rate-limit messages also contain the word "quota" but must NOT create a
 *      durable daily lock;
 *   3. only then is durable quota exhaustion recognised — from explicit daily /
 *      free-limit signals, or from a bare 429/RESOURCE_EXHAUSTED that carries no
 *      short-window hint (the free-tier daily case in practice).
 */
export function classifyProviderError(err: unknown): ProviderErrorKind {
  if (err instanceof ZeroQuotaExhaustedError) return 'quota-exhausted';
  const raw = err instanceof Error ? err.message : String(err);
  const text = extractProviderErrorText(raw);
  const lower = text.toLowerCase();

  if (
    /\b(?:500|502|503|504)\b/.test(raw) ||
    lower.includes('internal server error') ||
    text.includes('UNAVAILABLE') ||
    lower.includes('high demand') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('overloaded') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    lower.includes('socket hang up') ||
    lower.includes('aborted')
  ) {
    return 'transient';
  }

  if (
    lower.includes('per minute') ||
    lower.includes('per second') ||
    lower.includes('rate limit') ||
    lower.includes('rate-limit') ||
    lower.includes('rate_limit') ||
    lower.includes('ratelimit') ||
    lower.includes('too many requests') ||
    lower.includes('retry after') ||
    lower.includes('throughput')
  ) {
    return 'rate-limited';
  }

  const durableQuotaSignals =
    raw.includes('FREE_LIMIT') ||
    lower.includes('free limit reached') ||
    lower.includes('free-limit') ||
    lower.includes('free tier limit') ||
    lower.includes('per day') ||
    lower.includes('daily limit') ||
    lower.includes('dailylimitexceeded') ||
    lower.includes('quota exceeded') ||
    lower.includes('quotaexceeded') ||
    lower.includes('exceeded your current quota');
  if (durableQuotaSignals) return 'quota-exhausted';

  if (text.includes('429') || text.includes('RESOURCE_EXHAUSTED') || lower.includes('quota')) {
    return 'quota-exhausted';
  }

  if (
    lower.includes('api_key') ||
    lower.includes('api key') ||
    lower.includes('zero_gemini_free_tier_only')
  ) return 'auth';
  if (text.includes('404') || lower.includes('not found')) return 'not-found';
  return 'unknown';
}

/** True only for genuine free-tier quota exhaustion (never for 503 / rate limits). */
export function isQuotaExhaustionError(err: unknown): boolean {
  return classifyProviderError(err) === 'quota-exhausted';
}

/** Back-compat helper: genuine quota exhaustion OR a temporary rate limit. */
export function isQuotaOrRateLimitError(err: unknown): boolean {
  const kind = classifyProviderError(err);
  return kind === 'quota-exhausted' || kind === 'rate-limited';
}

export function isTransientServerError(err: unknown): boolean {
  return classifyProviderError(err) === 'transient';
}

export function formatGermanApiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const extracted = extractProviderErrorText(raw);
  switch (classifyProviderError(err)) {
    case 'quota-exhausted':
      return 'Free-Tier Tageskontingent ausgeschöpft (HTTP 429). Funktion sicher gestoppt — kein kostenpflichtiger Fallback. Freigabe erst nach dem täglichen Kontingent-Reset.';
    case 'rate-limited':
      return 'Free-Tier Anfrage-Limit vorübergehend erreicht (HTTP 429, Rate-Limit). Bitte kurz warten und erneut versuchen — kein dauerhaft ausgeschöpftes Kontingent, kein kostenpflichtiger Fallback.';
    case 'transient':
      return 'KI-Provider vorübergehend mit einem Serverfehler (HTTP 5xx) nicht erreichbar. ZERO hat begrenzt erneut versucht; bitte später erneut versuchen. Kein kostenpflichtiger Fallback.';
    case 'auth':
      if (raw.toLowerCase().includes('zero_gemini_free_tier_only')) {
        return 'Gemini gesperrt: ZERO_GEMINI_FREE_TIER_ONLY=true muss erst bestätigt werden, nachdem die Abrechnung im Google-Cloud-Projekt deaktiviert wurde. ZERO kann den externen Abrechnungsstatus nicht selbst verifizieren.';
      }
      return 'GEMINI_API_KEY fehlt oder ist ungültig konfiguriert.';
    case 'not-found':
      return `Modell-Endpunkt aktuell nicht erreichbar (HTTP 404): ${extracted.slice(0, 140)}`;
    default:
      return extracted.length > 220 ? `${extracted.slice(0, 217)}...` : extracted;
  }
}

export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  // Retries are disabled by default: provider requests must each reserve budget first.
  // Callers may opt in only when they supply per-attempt budget reservations.
  maxRetries = 0
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err) {
      if (isQuotaOrRateLimitError(err)) {
        throw err;
      }
      if (!isTransientServerError(err) || attempt >= maxRetries) {
        throw err;
      }
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, 1400 * attempt));
    }
  }
}

export { ThinkingLevel, Type };
