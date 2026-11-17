import type { BudgetGuardState } from '../src/types/zero.ts';

const RESETTABLE_FREE_GEMINI_MODELS = new Set([
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

/**
 * Applies a reset only after an authenticated operator explicitly attests
 * that the provider-side free-tier quota has actually reset. Local time alone
 * is never used as evidence. This function does not contact Google.
 */
export function applyManualFreeQuotaReset(params: {
  modelId: string;
  confirmedProviderReset: boolean;
  budgetGuard: BudgetGuardState;
  now?: Date;
}): { requestsToday: number; dailySoftLimit: number; exhausted: boolean; lastResetDate: string } {
  const { modelId, confirmedProviderReset, budgetGuard } = params;
  if (confirmedProviderReset !== true) {
    throw new Error('Provider-Reset muss ausdrücklich bestätigt werden.');
  }
  if (!RESETTABLE_FREE_GEMINI_MODELS.has(modelId)) {
    throw new Error('Dieses Modell ist nicht für einen manuellen Free-Tier-Reset freigegeben.');
  }
  const quota = budgetGuard.freeQuotaUsage[modelId];
  if (!quota) {
    throw new Error('Kontingentdatensatz fehlt; ein manueller Reset kann ihn nicht sicher rekonstruieren.');
  }
  if (
    !Number.isSafeInteger(quota.requestsToday) || quota.requestsToday < 0 ||
    !Number.isSafeInteger(quota.dailySoftLimit) || quota.dailySoftLimit <= 0 ||
    typeof quota.exhausted !== 'boolean'
  ) {
    throw new Error('Kontingentdaten sind beschädigt. Manueller Reset wurde verweigert.');
  }

  const lastResetDate = (params.now ?? new Date()).toISOString().slice(0, 10);
  quota.requestsToday = 0;
  quota.exhausted = false;
  quota.lastResetDate = lastResetDate;
  return {
    requestsToday: quota.requestsToday,
    dailySoftLimit: quota.dailySoftLimit,
    exhausted: quota.exhausted,
    lastResetDate,
  };
}
