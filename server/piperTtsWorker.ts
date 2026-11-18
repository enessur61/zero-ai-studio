import { Buffer } from "node:buffer";

export const PIPER_WORKER_MODEL_ID = "de_DE-thorsten-medium";
const MAX_WAV_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 150_000;

export class PiperWorkerGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiperWorkerGateError";
  }
}

export interface PiperWorkerResult {
  audioDataUrl: string;
  modelUsed: string;
  voice: string;
  costEur: 0;
  paidFallback: false;
}

interface PiperWorkerHealth {
  ok: boolean;
  engine: string;
  model_id: string;
  voice: string;
  engine_license: string;
  voice_dataset_license: string;
  cost_eur: number;
  paid_fallback: boolean;
}

interface PiperWorkerOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function workerBaseUrl(): URL {
  if (process.env.ZERO_PIPER_WORKER_ENABLED !== "true") {
    throw new PiperWorkerGateError("Piper gesperrt: ZERO_PIPER_WORKER_ENABLED=true wurde nicht ausdrücklich bestätigt.");
  }
  if (process.env.ZERO_PIPER_WORKER_COSTS_CONFIRMED !== "true") {
    throw new PiperWorkerGateError("Piper gesperrt: ZERO_PIPER_WORKER_COSTS_CONFIRMED=true muss nach Prüfung der Hosting-Abrechnung ausdrücklich bestätigt werden.");
  }
  const configuredUrl = process.env.ZERO_TTS_WORKER_URL?.trim();
  const token = process.env.ZERO_TTS_WORKER_TOKEN?.trim();
  if (!configuredUrl || !token) {
    throw new PiperWorkerGateError("Piper-Worker nicht konfiguriert: ZERO_TTS_WORKER_URL und ZERO_TTS_WORKER_TOKEN fehlen.");
  }
  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new PiperWorkerGateError("Piper-Worker-URL ist ungültig.");
  }
  const allowHttpLocal = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  if (url.protocol !== "https:" && !(allowHttpLocal && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new PiperWorkerGateError("Piper-Worker benötigt HTTPS; HTTP ist nur für localhost in Development/Test erlaubt.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function workerHeaders(accept: string): HeadersInit {
  return {
    Authorization: "Bearer " + (process.env.ZERO_TTS_WORKER_TOKEN?.trim() ?? ""),
    Accept: accept,
  };
}

async function fetchWorker(
  path: "/health" | "/tts",
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const baseUrl = workerBaseUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(new URL(path, baseUrl), {
      ...init,
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Piper-Worker hat das Zeitlimit überschritten; kein kostenpflichtiger Fallback wurde gestartet.");
    }
    throw new Error("Piper-Worker ist nicht erreichbar; kein kostenpflichtiger Fallback wurde gestartet.");
  } finally {
    clearTimeout(timeout);
  }
}

async function readHealth(fetchImpl: typeof fetch, timeoutMs: number): Promise<PiperWorkerHealth> {
  const response = await fetchWorker("/health", {
    method: "GET",
    headers: workerHeaders("application/json"),
  }, fetchImpl, timeoutMs);
  if (!response.ok) throw new Error("Piper-Worker Health-Check fehlgeschlagen (HTTP " + response.status + ").");
  const payload = await response.json() as Partial<PiperWorkerHealth>;
  if (
    payload.ok !== true ||
    payload.engine !== "Piper ONNX" ||
    payload.model_id !== PIPER_WORKER_MODEL_ID ||
    payload.voice !== PIPER_WORKER_MODEL_ID ||
    payload.engine_license !== "GPL-3.0-or-later" ||
    payload.voice_dataset_license !== "CC0" ||
    payload.paid_fallback !== false ||
    payload.cost_eur !== 0
  ) {
    throw new Error("Piper-Worker meldet eine unbekannte Engine, Voice-Version oder Lizenz-/Kostenkonfiguration.");
  }
  return payload as PiperWorkerHealth;
}

export async function synthesizePiperWorker(
  params: { text: string; speed?: number } & PiperWorkerOptions,
): Promise<PiperWorkerResult> {
  const text = params.text.trim();
  if (!text) throw new Error("Text für Piper fehlt.");
  if (text.length > 5000) throw new Error("Piper unterstützt maximal 5.000 Zeichen pro WAV-Datei.");
  const speed = Number.isFinite(params.speed) ? Math.min(1.25, Math.max(0.75, params.speed ?? 1)) : 1;
  const fetchImpl = params.fetchImpl ?? fetch;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const response = await fetchWorker("/tts", {
    method: "POST",
    headers: { ...workerHeaders("audio/wav"), "Content-Type": "application/json" },
    body: JSON.stringify({ text, speed }),
  }, fetchImpl, timeoutMs);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { detail?: unknown };
    const detail = typeof payload.detail === "string" ? payload.detail.slice(0, 400) : "Der Piper-Worker konnte keine Sprache erzeugen.";
    throw new Error("Piper-Worker-Fehler (HTTP " + response.status + "): " + detail + ". Kein kostenpflichtiger Fallback.");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WAV_BYTES) {
    throw new Error("Piper-WAV überschreitet das 20-MB-Limit.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length < 44 ||
    bytes.length > MAX_WAV_BYTES ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Piper lieferte keine gültige WAV-Datei.");
  }
  return {
    audioDataUrl: "data:audio/wav;base64," + bytes.toString("base64"),
    modelUsed: "Piper ONNX · de_DE-thorsten-medium (eigener ZERO-Worker)",
    voice: "Thorsten · Deutsch",
    costEur: 0,
    paidFallback: false,
  };
}

export async function probePiperWorker(options: PiperWorkerOptions = {}): Promise<PiperWorkerResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await readHealth(fetchImpl, timeoutMs);
  return synthesizePiperWorker({
    text: "ZERO Piper Verbindungstest.",
    speed: 1,
    fetchImpl,
    timeoutMs,
  });
}
