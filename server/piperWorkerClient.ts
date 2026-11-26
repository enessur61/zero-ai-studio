export type PiperReservationState = 'reserved' | 'completed' | 'released';

export type PiperReplayDecision =
  | { kind: 'replay'; payload: unknown }
  | { kind: 'processing' }
  | { kind: 'completed_without_result' }
  | { kind: 'released' };

/** Deterministic replay policy shared by the API route and no-provider tests. */
export function resolvePiperReplay(
  status: PiperReservationState,
  cachedPayload: unknown | null,
): PiperReplayDecision {
  if (cachedPayload !== null) return { kind: 'replay', payload: cachedPayload };
  if (status === 'reserved') return { kind: 'processing' };
  if (status === 'completed') return { kind: 'completed_without_result' };
  return { kind: 'released' };
}

/** Sends one authenticated request to the configured self-hosted worker only. */
export async function postPiperWorkerTts(input: {
  baseUrl: string;
  headers: Record<string, string>;
  text: string;
  speed: number;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  const endpoint = new URL('/tts', input.baseUrl);
  const fetcher = input.fetchImpl ?? fetch;
  return fetcher(endpoint, {
    method: 'POST',
    headers: {
      ...input.headers,
      'Content-Type': 'application/json',
      Accept: 'audio/wav',
    },
    body: JSON.stringify({ text: input.text, speed: input.speed }),
    signal: input.signal,
    redirect: 'error',
  });
}
