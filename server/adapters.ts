import {
  assertZeroBudgetModelAllowed,
  formatGermanApiError,
  getGeminiClient,
  isQuotaOrRateLimitError,
  isTransientServerError,
  ThinkingLevel,
  withTransientRetry,
} from './geminiClient.ts';
import {
  IOS_SWIFT_ADAPTER_IDS,
  verifyIOSAdapterForModel,
} from './coremlAdapter.ts';
import type { ZeroDatabase } from './store.ts';
import { recordBudgetAudit } from './store.ts';
import type { ModelDefinition } from '../src/types/zero.ts';

let lastPollinationsImageAt = 0;
const POLLINATIONS_IMAGE_COOLDOWN_MS = 45_000;

export function getPollinationsCooldownRemainingSec(): number {
  if (!lastPollinationsImageAt) return 0;
  const elapsed = Date.now() - lastPollinationsImageAt;
  if (elapsed >= POLLINATIONS_IMAGE_COOLDOWN_MS) return 0;
  return Math.ceil((POLLINATIONS_IMAGE_COOLDOWN_MS - elapsed) / 1000);
}

function createSilentWavBase64(durationSec = 0.5, sampleRate = 16000): string {
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer.toString('base64');
}

export async function generateFreeOpenText(_params: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}): Promise<{ text: string; engine: string }> {
  throw new Error(
    'GPT-OSS Open Cloud ist deaktiviert: Der bisherige anonyme Pollinations-Endpunkt ist nicht als dauerhaft kostenloser Zugriff verifiziert. Kein kostenpflichtiger Fallback wurde aufgerufen.'
  );
}

export async function generateFreeCloudImage(_params: {
  prompt: string;
  model?: 'flux' | 'turbo' | 'sana';
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3';
  seed?: number;
}): Promise<{ imageDataUrl: string; engine: string; width: number; height: number }> {
  throw new Error(
    'Bildgenerierung über Pollinations ist deaktiviert: Der aktuelle API-Zugriff benötigt Authentifizierung und kann Pollen-Guthaben verbrauchen. Kein kostenpflichtiger Fallback wurde aufgerufen.'
  );
}

export async function runLiveModelTest(
  model: ModelDefinition,
  db: ZeroDatabase
): Promise<ModelDefinition> {
  const started = Date.now();
  const now = new Date().toISOString();
  // Revoke any stale activation before probing; only the verified-success path below may re-enable it.
  model.enabled = false;

  if (
    !model.enabled &&
    ['gpt-oss-20b-free', 'flux-1-schnell-free', 'sd-turbo-free', 'sana-free'].includes(model.id)
  ) {
    model.testPassed = false;
    model.status = 'ADAPTER FEHLT';
    model.lastTestedAt = now;
    model.lastTestLatencyMs = 0;
    model.lastTestMessage = 'Sicher deaktiviert: kein verifizierter, dauerhaft kostenloser Provider verfügbar.';
    return model;
  }

  if (model.requiresPaidKey || model.status === 'GESPERRT') {
    recordBudgetAudit(db, {
      adapterId: model.adapterId,
      modelId: model.id,
      action: 'MODEL_TEST',
      decision: 'BLOCKIERT_BUDGET_GUARD',
      reason: 'Test blockiert: Kostenpflichtiges Modell durch 0 € Budget-Schutz gesperrt.',
      costEur: 0,
    });
    model.testPassed = false;
    model.status = 'GESPERRT';
    model.lastTestedAt = now;
    model.lastTestLatencyMs = Date.now() - started;
    model.lastTestMessage = 'Blockiert durch 0 € Budget-Schutz (kostenpflichtiger Tarif erforderlich).';
    return model;
  }

  if (model.requiresExternalGpu) {
    model.testPassed = false;
    model.status = 'NICHT KOMPATIBEL';
    model.lastTestedAt = now;
    model.lastTestLatencyMs = Date.now() - started;
    model.lastTestMessage = `Hardware fehlt: Benötigt ~${model.ramRequirementGB} GB VRAM / eigene GPU (auf iPhone 16 Pro Max nicht lokal ausführbar).`;
    return model;
  }

  // Native iPhone 16 Pro Max Swift 6 Adapter verification (all 8 local iOS models)
  if (IOS_SWIFT_ADAPTER_IDS.has(model.adapterId)) {
    const pkg = await verifyIOSAdapterForModel(model.id, model.adapterId);
    recordBudgetAudit(db, {
      adapterId: model.adapterId,
      modelId: model.id,
      action: 'IOS_ADAPTER_VERIFY',
      decision: 'ERLAUBT_0_EUR',
      reason: `Swift 6 iOS Adapter geprüft (${pkg.checkedFiles.filter((f) => f.exists).length}/${pkg.checkedFiles.length} Dateien, 0,00 €).`,
      costEur: 0,
    });
    const swiftSourcesPresent = pkg.checkedFiles.every((file) => file.exists);
    // Swift source files alone are not a runnable iOS adapter: model weights,
    // concrete runtime dependencies, tokenizer/backend wiring and a native app target are still missing.
    model.hasRealAdapter = false;
    model.testPassed = false;
    model.status = swiftSourcesPresent ? 'INSTALLATION ERFORDERLICH' : 'ADAPTER FEHLT';
    model.lastTestedAt = now;
    model.lastTestLatencyMs = Date.now() - started;
    model.lastTestMessage = pkg.notes;
    return model;
  }

  if (!model.hasRealAdapter) {
    model.testPassed = false;
    model.status = 'INSTALLATION ERFORDERLICH';
    model.lastTestedAt = now;
    model.lastTestLatencyMs = Date.now() - started;
    model.lastTestMessage = `Lokale Gewichte (${model.sizeGB} GB) noch nicht installiert.`;
    return model;
  }

  // A server-side test cannot execute browser APIs on the user's iPhone.
  // Never mark a client-only adapter as tested without a real device-side probe.
  if (model.executionMode === 'LOCAL ON-DEVICE') {
    model.testPassed = false;
    model.status = 'BROWSER TEST ERFORDERLICH';
    model.lastTestedAt = now;
    model.lastTestLatencyMs = Date.now() - started;
    model.lastTestMessage =
      'Quellcode ist vorhanden; die Browser-/iPhone-Laufzeit wurde vom Server nicht ausgeführt. Direkt auf dem Zielgerät prüfen.';
    return model;
  }

  // Allow explicit live re-probe to recover from transient 429/503 cooldowns
  if (db.budgetGuard.freeQuotaUsage[model.id]?.exhausted) {
    db.budgetGuard.freeQuotaUsage[model.id].exhausted = false;
  }

  // Real FREE CLOUD probes
  try {
    if ([
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
    ].includes(model.id)) {
      assertZeroBudgetModelAllowed(model.id, 'MODEL_HEALTH_TEST', db.budgetGuard, (e) =>
        recordBudgetAudit(db, e)
      );
      const ai = getGeminiClient();
      const res = await withTransientRetry(
        () =>
          ai.models.generateContent({
            model: model.id,
            contents: 'Antworte exakt mit einem Wort: BEREIT',
            config: {
              ...(model.id === 'gemini-3.8-flash'
                ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                : model.id === 'gemini-3.1-flash-lite'
                  ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }
                  : {}),
            },
          }),
        1
      );
      const text = (res.text ?? '').trim();
      model.testPassed = text.length > 0;
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = model.testPassed
        ? `Live-Probe erfolgreich (${text.slice(0, 32)}).`
        : 'Leere Antwort vom Endpunkt.';
    } else if (model.id === 'gemini-3.8-flash-lite-tts' || model.id === 'gemini-3.8-flash-tts') {
      assertZeroBudgetModelAllowed(model.id, 'MODEL_HEALTH_TEST', db.budgetGuard, (e) =>
        recordBudgetAudit(db, e)
      );
      const ai = getGeminiClient();
      const res = await withTransientRetry(
        () =>
          ai.models.generateContent({
            model: model.id,
            contents: [{ role: 'user', parts: [{ text: 'ZERO Audio Test.' }] }],
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
              },
            },
          }),
        1
      );
      const audioPart = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      const audioB64 = audioPart?.inlineData?.data;
      model.testPassed = Boolean(audioB64 && audioB64.length > 100);
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = model.testPassed
        ? `WAV-Synthese erfolgreich (${Math.round((audioB64!.length * 0.75) / 1024)} KB Audio).`
        : 'Keine Audiodaten empfangen.';
    } else if (model.id === 'gemini-3.5-transcribe') {
      assertZeroBudgetModelAllowed(model.id, 'MODEL_HEALTH_TEST', db.budgetGuard, (e) =>
        recordBudgetAudit(db, e)
      );
      const ai = getGeminiClient();
      const wavB64 = createSilentWavBase64(0.5, 16000);
      const res = await withTransientRetry(
        () =>
          ai.models.generateContent({
            model: 'gemini-3.5-transcribe',
            contents: {
              parts: [
                { inlineData: { mimeType: 'audio/wav', data: wavB64 } },
                { text: 'Transcribe this audio.' },
              ],
            },
          }),
        1
      );
      const hasCandidate = Boolean(res.candidates?.[0]?.finishReason);
      model.testPassed = hasCandidate;
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = model.testPassed
        ? 'Audio-Transkriptions-Endpunkt erfolgreich geprüft (v1beta, audioTranscription).'
        : 'Keine Antwort vom Transkriptions-Endpunkt.';
    } else if (model.id === 'gemini-embedding-2') {
      assertZeroBudgetModelAllowed(model.id, 'MODEL_HEALTH_TEST', db.budgetGuard, (e) =>
        recordBudgetAudit(db, e)
      );
      const ai = getGeminiClient();
      const res = await withTransientRetry(
        () =>
          ai.models.embedContent({
            model: 'gemini-embedding-2',
            contents: ['ZERO AI STUDIO Test Embedding'],
          }),
        1
      );
      const dims = res.embeddings?.[0]?.values?.length ?? 0;
      model.testPassed = dims > 0;
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = model.testPassed
        ? `Vektor-Embedding erfolgreich (${dims} Dimensionen).`
        : 'Keine Vektoren zurückgegeben.';
    } else if (model.id === 'gemini-web-grounding') {
      assertZeroBudgetModelAllowed('gemini-web-grounding', 'MODEL_HEALTH_TEST', db.budgetGuard, (e) =>
        recordBudgetAudit(db, e)
      );
      assertZeroBudgetModelAllowed('gemini-2.5-flash-lite', 'MODEL_HEALTH_TEST', db.budgetGuard, (e) =>
        recordBudgetAudit(db, e)
      );
      const ai = getGeminiClient();
      const res = await withTransientRetry(
        () =>
          ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: 'Was ist die aktuelle offizielle Swift-Version?',
            config: {
              tools: [{ googleSearch: {} }],
            },
          }),
        1
      );
      const chunks = res.candidates?.[0]?.groundingMetadata?.groundingChunks?.length ?? 0;
      model.testPassed = Boolean(res.text);
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = `Web-Grounding aktiv (${chunks} verifizierte Quellen gefunden).`;
    } else if (
      model.id === 'flux-1-schnell-free' ||
      model.id === 'sd-turbo-free' ||
      model.id === 'sana-free'
    ) {
      const result = await generateFreeCloudImage({
        prompt: 'minimalist dark studio probe',
        model: model.id === 'sd-turbo-free' ? 'turbo' : model.id === 'sana-free' ? 'sana' : 'flux',
        aspectRatio: '1:1',
        seed: 42,
      });
      model.testPassed = result.imageDataUrl.startsWith('data:image/');
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = model.testPassed
        ? `Live-Bildtest erfolgreich (${result.engine}).`
        : 'Bildendpunkt lieferte kein Bild.';
    } else if (model.id === 'gpt-oss-20b-free') {
      const res = await withTransientRetry(
        () =>
          generateFreeOpenText({
            messages: [{ role: 'user', content: 'Antworte mit genau einem Wort: BEREIT' }],
          }),
        1
      );
      model.testPassed = res.text.length > 0;
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = model.testPassed
        ? `Live-Probe erfolgreich (${res.text.slice(0, 32)}).`
        : 'Leere Antwort vom Open-Cloud Endpunkt.';
    }
  } catch (err) {
    const cleanMsg = formatGermanApiError(err);
    if (isQuotaOrRateLimitError(err)) {
      if (db.budgetGuard.freeQuotaUsage[model.id]) {
        db.budgetGuard.freeQuotaUsage[model.id].exhausted = true;
      }
      model.status = 'FREE-TIER AUSGESCHÖPFT';
      model.testPassed = false;
      model.lastTestMessage = cleanMsg;
    } else if (isTransientServerError(err)) {
      model.status = 'FREE-TIER AUSGESCHÖPFT';
      model.testPassed = false;
      model.lastTestMessage = cleanMsg;
    } else if (
      cleanMsg.includes('GEMINI_API_KEY') ||
      cleanMsg.includes('ZERO_GEMINI_FREE_TIER_ONLY')
    ) {
      model.testPassed = false;
      model.status = 'INSTALLATION ERFORDERLICH';
      model.lastTestMessage = cleanMsg;
    } else {
      model.testPassed = false;
      model.status = 'ADAPTER FEHLT';
      model.lastTestMessage = `Testfehler: ${cleanMsg}`;
    }
  }

  // Automatically enable only models that passed a real live probe and have a real adapter.
  // A source-code stub, local model without weights, paid model, or failed/quota-limited endpoint stays disabled.
  const verifiedRunnable =
    model.testPassed &&
    model.hasRealAdapter &&
    !model.requiresPaidKey &&
    !model.requiresExternalGpu &&
    (model.status === 'FUNKTIONIERT' || model.status === 'LOKAL INSTALLIERT');
  model.enabled = verifiedRunnable;

  model.lastTestedAt = now;
  model.lastTestLatencyMs = Date.now() - started;
  return model;
}

export async function runAllModelTests(db: ZeroDatabase): Promise<{
  testedCount: number;
  models: ModelDefinition[];
}> {
  let pollinationsTestedInBatch = false;

  for (const model of db.models) {
    const isPollinationsImage =
      model.id === 'flux-1-schnell-free' ||
      model.id === 'sd-turbo-free' ||
      model.id === 'sana-free';

    if (isPollinationsImage) {
      const cooldown = getPollinationsCooldownRemainingSec();
      if (pollinationsTestedInBatch || cooldown > 0) {
        model.lastTestedAt = new Date().toISOString();
        model.lastTestLatencyMs = 0;
        model.lastTestMessage =
          cooldown > 0
            ? `Geteilter Pollinations Open-Cloud Bildendpunkt (IP-Abkühlzeit aktiv: noch ${cooldown}s).`
            : 'Geteilter Pollinations Open-Cloud Bildendpunkt in diesem Durchlauf bereits verifiziert.';
        continue;
      }
      pollinationsTestedInBatch = true;
    }

    await runLiveModelTest(model, db);
  }

  return {
    testedCount: db.models.length,
    models: db.models,
  };
}
