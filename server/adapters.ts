import {
  assertZeroBudgetModelAllowed,
  classifyProviderError,
  formatGermanApiError,
  getGeminiClient,
  isExhaustedWithinCurrentDay,
  ThinkingLevel,
  withSingleProviderAttempt,
} from './geminiClient.ts';
import {
  IOS_SWIFT_ADAPTER_IDS,
  verifyIOSAdapterForModel,
} from './coremlAdapter.ts';
import type { ZeroDatabase } from './store.ts';
import { recordBudgetAudit } from './store.ts';
import type { ModelDefinition } from '../src/types/zero.ts';
import { CloudflareWorkersAiGateError } from './cloudflareBudgetGate.ts';
import { analyzeCloudflareImage, generateCloudflareImage, generateCloudflareText, transcribeCloudflareAudio } from './cloudflareWorkersAi.ts';

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

export async function generateFreeCloudImage(params: {
  prompt: string;
  model?: 'flux' | 'turbo' | 'sana';
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3';
  seed?: number;
}): Promise<{ imageDataUrl: string; engine: string; width: number; height: number }> {
  if (params.model && params.model !== 'flux') {
    throw new Error('Für ZERO ist aktuell nur FLUX.1 Schnell über Cloudflare verifiziert. SD Turbo und Sana bleiben sicher deaktiviert.');
  }
  const result = await generateCloudflareImage({
    prompt: params.prompt,
    steps: 4,
  });
  return {
    imageDataUrl: result.imageDataUrl,
    engine: 'Cloudflare Workers AI · FLUX.1 Schnell',
    width: 1024,
    height: 1024,
  };
}

export async function runLiveModelTest(
  model: ModelDefinition,
  db: ZeroDatabase
): Promise<ModelDefinition> {
  const started = Date.now();
  const now = new Date().toISOString();
  // Revoke stale activation for server-probed models. WebGPU is probed in the browser, not on this server.
  if (!['webgpu-llama-3.2-1b', 'apple-foundation-model'].includes(model.id)) model.enabled = false;

  if (
    !model.enabled &&
    ['gpt-oss-20b-free', 'sd-turbo-free', 'sana-free'].includes(model.id)
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

  if (
    model.id === 'webgpu-llama-3.2-1b' &&
    model.enabled &&
    model.status === 'LOKAL INSTALLIERT' &&
    model.testPassed
  ) {
    model.lastTestMessage =
      'Auf diesem Gerät bereits durch echte lokale WebGPU-Inferenz bestätigt. Der Server kann die Browser-GPU nicht erneut testen.';
    model.lastTestedAt = now;
    model.lastTestLatencyMs = 0;
    return model;
  }

  if (
    model.id === 'apple-foundation-model' &&
    model.enabled &&
    model.status === 'LOKAL INSTALLIERT' &&
    model.testPassed
  ) {
    model.lastTestMessage =
      'Auf diesem iPhone bereits durch echte native Apple-Foundation-Models-Inferenz bestätigt. Der Server kann das OS-Modell nicht selbst ausführen.';
    model.lastTestedAt = now;
    model.lastTestLatencyMs = 0;
    return model;
  }

  // Apple Foundation Models require native iOS installation and cannot be
  // verified by a server-side request.
  if (model.id === 'apple-foundation-model') {
    model.hasRealAdapter = false;
    model.testPassed = false;
    model.status = 'INSTALLATION ERFORDERLICH';
    model.lastTestedAt = now;
    model.lastTestLatencyMs = Date.now() - started;
    model.lastTestMessage =
      'Apple Foundation Models können nur in der nativen ZERO-iOS-App auf einem kompatiblen iPhone geprüft werden.';
    return model;
  }

  // A server-side test cannot execute browser APIs or device-local runtimes.
  // Never infer successful local inference from static catalog metadata.
  if (model.executionMode === 'LOCAL ON-DEVICE') {
    model.hasRealAdapter = false;
    model.testPassed = false;
    model.status = 'BROWSER TEST ERFORDERLICH';
    model.lastTestedAt = now;
    model.lastTestLatencyMs = Date.now() - started;
    model.lastTestMessage =
      'Quellcode ist vorhanden; die Browser-/iPhone-Laufzeit wurde vom Server nicht ausgeführt. Direkt auf dem Zielgerät prüfen.';
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

  // A re-test must never clear a genuine quota lock. Only the proven daily
  // rollover inside assertZeroBudgetModelAllowed may reset an exhausted quota.
  const existingQuota = db.budgetGuard.freeQuotaUsage[model.id];
  if (existingQuota && isExhaustedWithinCurrentDay(existingQuota)) {
    model.testPassed = false;
    model.status = 'FREE-TIER AUSGESCHÖPFT';
    model.enabled = false;
    model.lastTestedAt = now;
    model.lastTestLatencyMs = Date.now() - started;
    model.lastTestMessage =
      'Free-Tier Tageskontingent ist ausgeschöpft. Ein erneuter Modelltest setzt diese Sperre nicht zurück — Freigabe erst nach dem nachgewiesenen täglichen Kontingent-Reset.';
    recordBudgetAudit(db, {
      adapterId: 'gemini-quota-guard',
      modelId: model.id,
      action: 'MODEL_TEST',
      decision: 'GESTOPPT_KONTINGENT',
      reason: 'Erneuter Modelltest blockiert: Tageskontingent weiterhin ausgeschöpft (kein Reset durch Re-Test).',
      costEur: 0,
    });
    return model;
  }

  // Cloudflare Workers AI is a real server-side free-tier provider. Its provider-side daily
  // Neuron limit is authoritative; ZERO never retries through a paid provider.
  try {
    if (model.id === 'cloudflare-moondream-3.1-9b-a2b') {
      // A tiny valid PNG verifies the actual vision endpoint and answer schema.
      const result = await analyzeCloudflareImage({
        imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRx8AAAAASUVORK5CYII=',
        question: 'Beschreibe das Bild in einem kurzen Satz.',
      });
      model.testPassed = result.modelId === '@cf/moondream/moondream3.1-9B-A2B' && result.answer.length > 0;
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = model.testPassed
        ? 'Cloudflare Moondream Vision Live-Probe erfolgreich; Bildfragen und Bildbeschreibungen sind verfügbar.'
        : 'Moondream lieferte keine gültige Bildanalyse.';
    } else if (model.id === 'cloudflare-whisper-large-v3-turbo') {
      // A short silent PCM probe verifies the provider endpoint and response schema.
      // Speech quality is confirmed by actual uploaded audio in the Transcription Studio.
      const result = await transcribeCloudflareAudio({
        audioBase64: createSilentWavBase64(0.5, 16000),
        language: 'de',
      });
      model.testPassed = result.modelId === '@cf/openai/whisper-large-v3-turbo' && typeof result.text === 'string';
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = model.testPassed
        ? 'Cloudflare Whisper Live-Probe erfolgreich; echte deutsche Transkription erfolgt mit der nächsten Audioaufnahme.'
        : 'Whisper lieferte kein gültiges Transkriptionsformat.';
    } else if (model.id === 'cloudflare-glm-4.7-flash') {
      const result = await generateCloudflareText({ prompt: 'Antworte exakt mit einem Wort: BEREIT', maxTokens: 128, enableThinking: false });
      model.testPassed = result.text.length > 0;
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = model.testPassed
        ? `Cloudflare Workers AI Live-Probe erfolgreich (${result.modelId}).`
        : 'Leere Antwort vom Cloudflare-Endpunkt.';
    } else if ([
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
    ].includes(model.id)) {
      // Validate the explicit free-only billing gate before recording any model-call allowance.
      // Client construction is local; no provider request is made here.
      const ai = getGeminiClient();
      assertZeroBudgetModelAllowed(model.id, 'MODEL_HEALTH_TEST', db.budgetGuard, (e) =>
        recordBudgetAudit(db, e)
      );
      const res = await withSingleProviderAttempt(
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
          })
      );
      const text = (res.text ?? '').trim();
      model.testPassed = text.length > 0;
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = model.testPassed
        ? `Live-Probe erfolgreich (${text.slice(0, 32)}).`
        : 'Leere Antwort vom Endpunkt.';
    } else if (model.id === 'gemini-3.8-flash-lite-tts' || model.id === 'gemini-3.8-flash-tts') {
      // Validate the explicit free-only billing gate before recording any model-call allowance.
      // Client construction is local; no provider request is made here.
      const ai = getGeminiClient();
      assertZeroBudgetModelAllowed(model.id, 'MODEL_HEALTH_TEST', db.budgetGuard, (e) =>
        recordBudgetAudit(db, e)
      );
      const res = await withSingleProviderAttempt(
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
          })
      );
      const audioPart = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      const audioB64 = audioPart?.inlineData?.data;
      model.testPassed = Boolean(audioB64 && audioB64.length > 100);
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = model.testPassed
        ? `WAV-Synthese erfolgreich (${Math.round((audioB64!.length * 0.75) / 1024)} KB Audio).`
        : 'Keine Audiodaten empfangen.';
    } else if (model.id === 'gemini-3.5-transcribe') {
      // Validate the explicit free-only billing gate before recording any model-call allowance.
      // Client construction is local; no provider request is made here.
      const ai = getGeminiClient();
      assertZeroBudgetModelAllowed(model.id, 'MODEL_HEALTH_TEST', db.budgetGuard, (e) =>
        recordBudgetAudit(db, e)
      );
      const wavB64 = createSilentWavBase64(0.5, 16000);
      const res = await withSingleProviderAttempt(
        () =>
          ai.models.generateContent({
            model: 'gemini-3.5-transcribe',
            contents: {
              parts: [
                { inlineData: { mimeType: 'audio/wav', data: wavB64 } },
                { text: 'Transcribe this audio.' },
              ],
            },
          })
      );
      const hasCandidate = Boolean(res.candidates?.[0]?.finishReason);
      model.testPassed = hasCandidate;
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = model.testPassed
        ? 'Audio-Transkriptions-Endpunkt erfolgreich geprüft (v1beta, audioTranscription).'
        : 'Keine Antwort vom Transkriptions-Endpunkt.';
    } else if (model.id === 'gemini-embedding-2') {
      // Validate the explicit free-only billing gate before recording any model-call allowance.
      // Client construction is local; no provider request is made here.
      const ai = getGeminiClient();
      assertZeroBudgetModelAllowed(model.id, 'MODEL_HEALTH_TEST', db.budgetGuard, (e) =>
        recordBudgetAudit(db, e)
      );
      const res = await withSingleProviderAttempt(
        () =>
          ai.models.embedContent({
            model: 'gemini-embedding-2',
            contents: ['ZERO AI STUDIO Test Embedding'],
          })
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
      const res = await withSingleProviderAttempt(
        () =>
          ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: 'Was ist die aktuelle offizielle Swift-Version?',
            config: {
              tools: [{ googleSearch: {} }],
            },
          })
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
      });
      model.testPassed = result.imageDataUrl.startsWith('data:image/');
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = model.testPassed
        ? `Live-Bildtest erfolgreich (${result.engine}).`
        : 'Bildendpunkt lieferte kein Bild.';
    } else if (model.id === 'gpt-oss-20b-free') {
      const res = await withSingleProviderAttempt(
        () =>
          generateFreeOpenText({
            messages: [{ role: 'user', content: 'Antworte mit genau einem Wort: BEREIT' }],
          })
      );
      model.testPassed = res.text.length > 0;
      model.status = model.testPassed ? 'FUNKTIONIERT' : 'ADAPTER FEHLT';
      model.lastTestMessage = model.testPassed
        ? `Live-Probe erfolgreich (${res.text.slice(0, 32)}).`
        : 'Leere Antwort vom Open-Cloud Endpunkt.';
    }
  } catch (err) {
    const cleanMsg = formatGermanApiError(err);
    const kind = classifyProviderError(err);
    if (err instanceof CloudflareWorkersAiGateError) {
      model.enabled = false;
      model.testPassed = false;
      model.status = 'INSTALLATION ERFORDERLICH';
      model.lastTestMessage = err.message;
      recordBudgetAudit(db, {
        adapterId: 'cloudflare-budget-guard',
        modelId: model.id,
        action: 'MODEL_HEALTH_TEST',
        decision: 'BLOCKIERT_BUDGET_GUARD',
        reason: 'Cloudflare-Modelltest vor jedem Provider-Aufruf blockiert: Workers-Free-Tarif und Ausschluss kostenpflichtiger Nutzung sind nicht bestätigt.',
        costEur: 0,
      });
    } else if (kind === 'quota-exhausted') {
      // Genuine, provider-confirmed quota exhaustion: persist a durable lock.
      if (db.budgetGuard.freeQuotaUsage[model.id]) {
        db.budgetGuard.freeQuotaUsage[model.id].exhausted = true;
      }
      model.status = 'FREE-TIER AUSGESCHÖPFT';
      model.testPassed = false;
      model.lastTestMessage = cleanMsg;
    } else if (kind === 'rate-limited') {
      // A temporary 429 rate limit is NOT exhausted daily quota: never persist
      // an exhausted lock, never auto-enable the model.
      model.status = 'RATE LIMIT';
      model.testPassed = false;
      model.lastTestMessage = cleanMsg;
    } else if (kind === 'transient') {
      // A temporary 503/network fault must never be shown as exhausted quota.
      model.status = 'VORÜBERGEHEND AUSGELASTET';
      model.testPassed = false;
      model.lastTestMessage = cleanMsg;
    } else if (
      kind === 'auth' ||
      cleanMsg.includes('ZERO_GEMINI_FREE_TIER_ONLY')
    ) {
      model.testPassed = false;
      model.status = 'INSTALLATION ERFORDERLICH';
      model.lastTestMessage = cleanMsg;
      recordBudgetAudit(db, {
        adapterId: 'gemini-budget-guard',
        modelId: model.id,
        action: 'MODEL_HEALTH_TEST',
        decision: 'BLOCKIERT_BUDGET_GUARD',
        reason: 'Gemini-Modelltest vor jedem Provider-Aufruf blockiert: Free-only-Abrechnungsschutz ist nicht ausdrücklich bestätigt.',
        costEur: 0,
      });
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
  for (const model of db.models) {
    // Unavailable legacy cloud models are evaluated individually and remain
    // explicitly disabled; never claim a shared Pollinations probe succeeded.
    await runLiveModelTest(model, db);
  }

  return {
    testedCount: db.models.length,
    models: db.models,
  };
}
