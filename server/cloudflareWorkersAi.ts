const CLOUDFLARE_MODEL_ID = '@cf/zai-org/glm-4.7-flash';
const API_BASE = 'https://api.cloudflare.com/client/v4/accounts';

export class CloudflareWorkersAiError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'CloudflareWorkersAiError';
  }
}

export function isCloudflareWorkersAiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CLOUDFLARE_ACCOUNT_ID?.trim() && env.CLOUDFLARE_API_TOKEN?.trim());
}

export async function generateCloudflareText(params: {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; modelId: string }> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !token) {
    throw new CloudflareWorkersAiError('Cloudflare Workers AI ist nicht konfiguriert (Account-ID oder API-Token fehlt).');
  }
  if (!params.prompt.trim() || params.prompt.length > 24_000) {
    throw new CloudflareWorkersAiError('Cloudflare-Eingabe ist leer oder überschreitet das sichere 24.000-Zeichen-Limit.');
  }

  const prompt = params.systemPrompt
    ? `Systemanweisung:\n${params.systemPrompt.slice(0, 8_000)}\n\nNutzeranfrage:\n${params.prompt}`
    : params.prompt;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const fetcher = params.fetchImpl ?? fetch;
    const response = await fetcher(
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
          max_completion_tokens: Math.min(Math.max(params.maxTokens ?? 700, 1), 1200),
          temperature: 0.3,
        }),
        signal: controller.signal,
      },
    );

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
        throw new CloudflareWorkersAiError('Cloudflare Workers AI meldet ein Rate-Limit oder das kostenlose Tageskontingent ist ausgeschöpft. ZERO startet keinen kostenpflichtigen Fallback.', 429);
      }
      if (response.status === 403) {
        throw new CloudflareWorkersAiError('Cloudflare hat den Zugriff auf dieses Modell verweigert. Prüfe Workers-AI-Tokenrechte und Free-Plan-Modellzugang. Kein kostenpflichtiger Fallback.', 403);
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
