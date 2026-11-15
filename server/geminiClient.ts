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
  }
  return sharedClient;
}

function getTodayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
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
  if (quota) {
    if (quota.lastResetDate && quota.lastResetDate !== today) {
      quota.requestsToday = 0;
      quota.exhausted = false;
      quota.lastResetDate = today;
    } else if (!quota.lastResetDate) {
      quota.lastResetDate = today;
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
      throw new Error(
        `Kostenloses Tageskontingent für "${modelId}" ausgeschöpft. Funktion sicher gestoppt (kein kostenpflichtiger Fallback).`
      );
    }
  }

  recordAudit({
    adapterId: 'gemini-free-tier',
    modelId,
    action,
    decision: 'ERLAUBT_0_EUR',
    reason: `Free-Tier Aufruf freigegeben (0,00 €).`,
    costEur: 0,
  });
}

export function isQuotaOrRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('FREE_LIMIT') ||
    lower.includes('free limit reached') ||
    lower.includes('free-limit') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  );
}

export function isTransientServerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    msg.includes('503') ||
    msg.includes('UNAVAILABLE') ||
    lower.includes('high demand') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    lower.includes('aborted')
  );
}

export function formatGermanApiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  // Unwrap structured Google JSON error blobs cleanly if present
  let extracted = raw;
  const jsonStart = raw.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as {
        error?: { code?: number; status?: string; message?: string };
      };
      if (parsed?.error?.message) {
        extracted = `${parsed.error.code ?? ''} ${parsed.error.status ?? ''}: ${parsed.error.message}`.trim();
      }
    } catch {
      // Keep raw string if JSON parsing fails
    }
  }

  const lower = extracted.toLowerCase();
  if (raw.includes('FREE_LIMIT') || raw.includes('402')) {
    return extracted;
  }
  if (
    extracted.includes('429') ||
    extracted.includes('RESOURCE_EXHAUSTED') ||
    lower.includes('quota')
  ) {
    return 'Free-Tier Kontingent (HTTP 429) vorübergehend ausgeschöpft. Funktion sicher gestoppt — kein kostenpflichtiger Fallback.';
  }
  if (
    extracted.includes('503') ||
    extracted.includes('UNAVAILABLE') ||
    lower.includes('high demand')
  ) {
    return 'Free-Tier Server vorübergehend stark ausgelastet (HTTP 503). Bitte in wenigen Sekunden erneut versuchen (kein bezahlter Fallback).';
  }
  if (extracted.includes('404') || lower.includes('not found')) {
    return `Modell-Endpunkt aktuell nicht erreichbar (HTTP 404): ${extracted.slice(0, 140)}`;
  }
  if (lower.includes('api_key') || lower.includes('gemini_api_key')) {
    return 'GEMINI_API_KEY fehlt oder ist ungültig konfiguriert.';
  }
  return extracted.length > 220 ? `${extracted.slice(0, 217)}...` : extracted;
}

export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 1
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
