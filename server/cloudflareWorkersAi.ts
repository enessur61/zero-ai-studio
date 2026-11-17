import { assertCloudflareWorkersAiAllowed, isCloudflareWorkersAiAllowed } from './cloudflareBudgetGate.ts';

const CLOUDFLARE_MODEL_ID = '@cf/zai-org/glm-4.7-flash';
const API_BASE = 'https://api.cloudflare.com/client/v4/accounts';

export class CloudflareWorkersAiError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'CloudflareWorkersAiError';
  }
}

export function isCloudflareWorkersAiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return isCloudflareWorkersAiAllowed(env) && Boolean(env.CLOUDFLARE_ACCOUNT_ID?.trim() && env.CLOUDFLARE_API_TOKEN?.trim());
}

export async function generateCloudflareText(params: {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  enableThinking?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; modelId: string }> {
  assertCloudflareWorkersAiAllowed();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !token) {
    throw new CloudflareWorkersAiError('Cloudflare Workers AI ist nicht konfiguriert (Account-ID oder API-Token fehlt).');
  }
  if (!params.prompt.trim() || params.prompt.length > 24_000) {
    throw new CloudflareWorkersAiError('Cloudflare-Eingabe ist leer oder überschreitet das sichere 24.000-Zeichen-Limit.');
  }

  if (params.systemPrompt && params.systemPrompt.length > 8_000) {
    throw new CloudflareWorkersAiError('Systemanweisung überschreitet das sichere 8.000-Zeichen-Limit.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const fetcher = params.fetchImpl ?? fetch;
    let response: Response | undefined;
    // Never retry provider errors: a 5xx may still have processed or billed the request.
    for (let attempt = 0; attempt < 1; attempt += 1) {
      response = await fetcher(
        `${API_BASE}/${encodeURIComponent(accountId)}/ai/run/${CLOUDFLARE_MODEL_ID}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messages: [
              ...(params.systemPrompt ? [{ role: 'system', content: params.systemPrompt.slice(0, 8_000) }] : []),
              { role: 'user', content: params.prompt },
            ],
            max_completion_tokens: Math.min(Math.max(params.maxTokens ?? 700, 1), 2048),
            temperature: 0.3,
            ...(params.enableThinking === undefined ? {} : { chat_template_kwargs: { enable_thinking: params.enableThinking } }),
          }),
          signal: controller.signal,
        },
      );
    }
    if (!response) throw new CloudflareWorkersAiError('Cloudflare Workers AI hat keine HTTP-Antwort geliefert.');

    const payload = await response.json().catch(() => null) as {
      success?: boolean;
      result?: {
        response?: unknown;
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      errors?: Array<{ message?: string; code?: number }>;
    } | null;

    if (!response.ok || payload?.success === false) {
      const providerMessage = payload?.errors?.[0]?.message;
      if (response.status === 429) {
        throw new CloudflareWorkersAiError('Cloudflare Workers AI meldet HTTP 429 (Rate limit oder kostenloses Tageskontingent ausgeschöpft). ZERO startet keinen kostenpflichtigen Fallback.', 429);
      }
      if (response.status === 403) {
        throw new CloudflareWorkersAiError('Cloudflare meldet HTTP 403 und verweigert den Zugriff auf dieses Modell. Prüfe Workers-AI-Tokenrechte und Free-Plan-Modellzugang. Kein kostenpflichtiger Fallback.', 403);
      }
      throw new CloudflareWorkersAiError(`Cloudflare Workers AI Fehler (${response.status})${providerMessage ? `: ${providerMessage.slice(0, 180)}` : ''}.`, response.status);
    }

    const responseText = payload?.result?.response ?? payload?.result?.choices?.[0]?.message?.content;
    const text = typeof responseText === 'string' ? responseText.trim() : '';
    if (!text) throw new CloudflareWorkersAiError('Cloudflare Workers AI hat keine Textantwort geliefert.');
    return { text: text.slice(0, 20_000), modelId: CLOUDFLARE_MODEL_ID };
  } catch (error) {
    if (error instanceof CloudflareWorkersAiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CloudflareWorkersAiError('Cloudflare-Anfrage nach 45 Sekunden abgebrochen (Timeout).');
    }
    throw new CloudflareWorkersAiError('Cloudflare Workers AI ist momentan nicht erreichbar.');
  } finally {
    clearTimeout(timeout);
  }
}


const CLOUDFLARE_IMAGE_MODEL_ID = '@cf/black-forest-labs/flux-1-schnell';

export async function generateCloudflareImage(params: {
  prompt: string;
  steps?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ imageDataUrl: string; modelId: string }> {
  assertCloudflareWorkersAiAllowed();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !token) {
    throw new CloudflareWorkersAiError('Cloudflare Workers AI ist nicht konfiguriert (Account-ID oder API-Token fehlt).');
  }
  const prompt = params.prompt.trim();
  if (!prompt || prompt.length > 2_048) {
    throw new CloudflareWorkersAiError('Bild-Prompt muss zwischen 1 und 2.048 Zeichen lang sein.');
  }
  const steps = Math.min(Math.max(Math.floor(params.steps ?? 4), 1), 8);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const fetcher = params.fetchImpl ?? fetch;
    let response: Response | undefined;
    for (let attempt = 0; attempt < 1; attempt += 1) {
      response = await fetcher(
        `${API_BASE}/${encodeURIComponent(accountId)}/ai/run/${CLOUDFLARE_IMAGE_MODEL_ID}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt,
            steps,
          }),
          signal: controller.signal,
        },
      );
    }
    if (!response) throw new CloudflareWorkersAiError('Cloudflare FLUX hat keine HTTP-Antwort geliefert.');
    const payload = await response.json().catch(() => null) as {
      success?: boolean;
      result?: { image?: unknown };
      errors?: Array<{ message?: string }>;
    } | null;
    if (!response.ok || payload?.success === false) {
      const providerMessage = payload?.errors?.[0]?.message;
      if (response.status === 429) {
        throw new CloudflareWorkersAiError('Cloudflare Workers AI Free-Kontingent oder Rate-Limit erreicht (HTTP 429). Kein kostenpflichtiger Fallback.', 429);
      }
      if (response.status === 403) {
        throw new CloudflareWorkersAiError('Cloudflare verweigert FLUX den Zugriff (HTTP 403). Prüfe Workers-AI-Tokenrechte und Free-Plan-Modellzugang.', 403);
      }
      throw new CloudflareWorkersAiError(`Cloudflare FLUX Fehler (${response.status})${providerMessage ? `: ${providerMessage.slice(0, 180)}` : ''}.`, response.status);
    }
    const image = payload?.result?.image;
    if (typeof image !== 'string' || image.length < 100) {
      throw new CloudflareWorkersAiError('Cloudflare FLUX hat kein gültiges Base64-Bild zurückgegeben.');
    }
    return { imageDataUrl: `data:image/jpeg;base64,${image}`, modelId: CLOUDFLARE_IMAGE_MODEL_ID };
  } catch (error) {
    if (error instanceof CloudflareWorkersAiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CloudflareWorkersAiError('Cloudflare FLUX Bildgenerierung nach 90 Sekunden abgebrochen (Timeout).');
    }
    throw new CloudflareWorkersAiError('Cloudflare FLUX Bildgenerierung ist momentan nicht erreichbar.');
  } finally {
    clearTimeout(timeout);
  }
}


const CLOUDFLARE_TRANSCRIPTION_MODEL_ID = '@cf/openai/whisper-large-v3-turbo';

export async function transcribeCloudflareAudio(params: {
  audioBase64: string;
  language?: string;
  task?: 'transcribe' | 'translate';
  fetchImpl?: typeof fetch;
}): Promise<{
  text: string;
  vtt: string | null;
  segments: Array<{ start: number; end: number; text: string }>;
  modelId: string;
}> {
  assertCloudflareWorkersAiAllowed();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !token) {
    throw new CloudflareWorkersAiError('Cloudflare Workers AI ist nicht konfiguriert (Account-ID oder API-Token fehlt).');
  }
  if (!params.audioBase64 || params.audioBase64.length > 24_000_000) {
    throw new CloudflareWorkersAiError('Audiodaten fehlen oder überschreiten das sichere 18-MB-Eingabelimit.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const fetcher = params.fetchImpl ?? fetch;
    let response: Response | undefined;
    for (let attempt = 0; attempt < 1; attempt += 1) {
      response = await fetcher(
        `${API_BASE}/${encodeURIComponent(accountId)}/ai/run/${CLOUDFLARE_TRANSCRIPTION_MODEL_ID}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            audio: params.audioBase64,
            task: params.task ?? 'transcribe',
            ...(params.language ? { language: params.language } : {}),
          }),
          signal: controller.signal,
        },
      );
    }
    if (!response) throw new CloudflareWorkersAiError('Cloudflare Whisper hat keine HTTP-Antwort geliefert.');
    const payload = await response.json().catch(() => null) as {
      success?: boolean;
      result?: {
        text?: unknown;
        vtt?: unknown;
        segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
      };
      errors?: Array<{ message?: string }>;
    } | null;
    if (!response.ok || payload?.success === false) {
      const providerMessage = payload?.errors?.[0]?.message;
      if (response.status === 429) {
        throw new CloudflareWorkersAiError('Cloudflare Workers AI Free-Kontingent oder Rate-Limit erreicht (HTTP 429). Kein kostenpflichtiger Fallback.', 429);
      }
      if (response.status === 403) {
        throw new CloudflareWorkersAiError('Cloudflare verweigert Whisper den Zugriff (HTTP 403). Prüfe Workers-AI-Tokenrechte und Free-Plan-Modellzugang.', 403);
      }
      throw new CloudflareWorkersAiError(`Cloudflare Whisper Fehler (${response.status})${providerMessage ? `: ${providerMessage.slice(0, 180)}` : ''}.`, response.status);
    }
    if (!payload?.result || typeof payload.result !== 'object' || typeof payload.result.text !== 'string') {
      throw new CloudflareWorkersAiError('Cloudflare Whisper hat keine gültige Transkriptionsantwort geliefert.');
    }
    const text = payload.result.text.trim();
    const segments = (payload.result.segments ?? []).flatMap((segment) => {
      const start = Number(segment.start);
      const end = Number(segment.end);
      const segmentText = typeof segment.text === 'string' ? segment.text.trim() : '';
      return Number.isFinite(start) && Number.isFinite(end) && end >= start && segmentText
        ? [{ start, end, text: segmentText }]
        : [];
    });
    return {
      text,
      vtt: typeof payload?.result?.vtt === 'string' ? payload.result.vtt : null,
      segments,
      modelId: CLOUDFLARE_TRANSCRIPTION_MODEL_ID,
    };
  } catch (error) {
    if (error instanceof CloudflareWorkersAiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CloudflareWorkersAiError('Cloudflare Whisper Transkription nach 90 Sekunden abgebrochen (Timeout).');
    }
    throw new CloudflareWorkersAiError('Cloudflare Whisper ist momentan nicht erreichbar.');
  } finally {
    clearTimeout(timeout);
  }
}


const CLOUDFLARE_VISION_MODEL_ID = '@cf/moondream/moondream3.1-9B-A2B';

export async function analyzeCloudflareImage(params: {
  imageDataUrl: string;
  question: string;
  fetchImpl?: typeof fetch;
}): Promise<{ answer: string; modelId: string }> {
  assertCloudflareWorkersAiAllowed();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !token) {
    throw new CloudflareWorkersAiError('Cloudflare Workers AI ist nicht konfiguriert (Account-ID oder API-Token fehlt).');
  }
  if (!/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(params.imageDataUrl) ||
      params.imageDataUrl.length > 16_000_000) {
    throw new CloudflareWorkersAiError('Moondream benötigt ein gültiges Bild als Base64 Data-URL (max. 12 MB Bildgröße).');
  }
  const question = params.question.trim();
  if (!question || question.length > 2_000) {
    throw new CloudflareWorkersAiError('Die Bildanalysefrage muss zwischen 1 und 2.000 Zeichen lang sein.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const fetcher = params.fetchImpl ?? fetch;
    let response: Response | undefined;
    for (let attempt = 0; attempt < 1; attempt += 1) {
      response = await fetcher(
        `${API_BASE}/${encodeURIComponent(accountId)}/ai/run/${CLOUDFLARE_VISION_MODEL_ID}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            task: 'query',
            image: params.imageDataUrl,
            question,
            reasoning: false,
            max_tokens: 512,
            stream: false,
          }),
          signal: controller.signal,
        },
      );
    }
    if (!response) throw new CloudflareWorkersAiError('Cloudflare Moondream hat keine HTTP-Antwort geliefert.');
    const payload = await response.json().catch(() => null) as {
      success?: boolean;
      result?: { answer?: unknown };
      errors?: Array<{ message?: string }>;
    } | null;
    if (!response.ok || payload?.success === false) {
      const providerMessage = payload?.errors?.[0]?.message;
      if (response.status === 429) {
        throw new CloudflareWorkersAiError('Cloudflare Workers AI Free-Kontingent oder Rate-Limit erreicht (HTTP 429). Kein kostenpflichtiger Fallback.', 429);
      }
      if (response.status === 403) {
        throw new CloudflareWorkersAiError('Cloudflare verweigert Moondream den Zugriff (HTTP 403). Prüfe Workers-AI-Tokenrechte und Free-Plan-Modellzugang.', 403);
      }
      throw new CloudflareWorkersAiError(`Cloudflare Moondream Fehler (${response.status})${providerMessage ? `: ${providerMessage.slice(0, 180)}` : ''}.`, response.status);
    }
    const answer = typeof payload?.result?.answer === 'string' ? payload.result.answer.trim() : '';
    if (!answer) throw new CloudflareWorkersAiError('Cloudflare Moondream hat keine Bildanalyse zurückgegeben.');
    return { answer: answer.slice(0, 12_000), modelId: CLOUDFLARE_VISION_MODEL_ID };
  } catch (error) {
    if (error instanceof CloudflareWorkersAiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CloudflareWorkersAiError('Cloudflare Moondream Bildanalyse nach 60 Sekunden abgebrochen (Timeout).');
    }
    throw new CloudflareWorkersAiError('Cloudflare Moondream ist momentan nicht erreichbar.');
  } finally {
    clearTimeout(timeout);
  }
}
