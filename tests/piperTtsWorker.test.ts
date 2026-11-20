import assert from "node:assert/strict";
import {
  PiperWorkerGateError,
  probePiperWorker,
  synthesizePiperWorker,
} from "../server/piperTtsWorker.ts";

const envKeys = [
  "ZERO_PIPER_WORKER_ENABLED",
  "ZERO_PIPER_WORKER_COSTS_CONFIRMED",
  "ZERO_TTS_WORKER_URL",
  "ZERO_TTS_WORKER_TOKEN",
  "NODE_ENV",
] as const;
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function wavFixture(): Buffer {
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(38, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(22050, 24);
  bytes.writeUInt32LE(44100, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(2, 40);
  return bytes;
}

try {
  for (const key of envKeys) delete process.env[key];
  let fetchCalls = 0;
  const blockedFetch: typeof fetch = async () => {
    fetchCalls += 1;
    return new Response("{}");
  };

  await assert.rejects(
    () => synthesizePiperWorker({ text: "Guten Tag", fetchImpl: blockedFetch }),
    PiperWorkerGateError,
  );
  process.env.ZERO_PIPER_WORKER_ENABLED = "true";
  await assert.rejects(
    () => synthesizePiperWorker({ text: "Guten Tag", fetchImpl: blockedFetch }),
    /ZERO_PIPER_WORKER_COSTS_CONFIRMED=true/,
  );
  process.env.ZERO_PIPER_WORKER_COSTS_CONFIRMED = "true";
  await assert.rejects(
    () => synthesizePiperWorker({ text: "Guten Tag", fetchImpl: blockedFetch }),
    /ZERO_TTS_WORKER_URL und ZERO_TTS_WORKER_TOKEN/,
  );
  assert.equal(fetchCalls, 0, "default-deny gates must block before network access");

  process.env.ZERO_TTS_WORKER_URL = "https://piper.example.test";
  process.env.ZERO_TTS_WORKER_TOKEN = "test-token";
  const wav = wavFixture();
  const calls: Array<{ url: string; method: string; headers: Headers; body?: string; redirect?: RequestRedirect }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
      redirect: init?.redirect,
    });
    if (String(input).endsWith("/health")) {
      return new Response(JSON.stringify({
        ok: true,
        engine: "Piper ONNX",
        model_id: "de_DE-thorsten-medium",
        voice: "de_DE-thorsten-medium",
        voice_loaded: false,
        model_files_present: false,
        model_revision: "cf910fb59f1d79ab3b625a63993a108751c6c25d",
        engine_version: "1.8.0",
        engine_license: "GPL-3.0-or-later",
        voice_dataset_license: "CC0",
        voice_training_base: "rdh (nl_BE, one Flemish speaker, CC0)",
        commercial_use_confirmed: false,
        cost_eur: 0,
        paid_fallback: false,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(wav, { status: 200, headers: { "Content-Type": "audio/wav", "Content-Length": String(wav.length) } });
  };

  const result = await probePiperWorker({ fetchImpl: fetchMock, timeoutMs: 1000 });
  assert.equal(calls.length, 2, "probe performs one health request and one real synthesis request");
  assert.ok(calls[0].url.endsWith("/health"));
  assert.ok(calls[1].url.endsWith("/tts"));
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[0].headers.get("authorization"), "Bearer test-token");
  assert.equal(calls[1].headers.get("authorization"), "Bearer test-token");
  assert.equal(calls[0].redirect, "error");
  assert.deepEqual(JSON.parse(calls[1].body ?? "{}"), { text: "ZERO Piper Verbindungstest.", speed: 1 });
  assert.equal(result.costEur, 0);
  assert.equal(result.paidFallback, false);
  assert.equal(result.voice, "Thorsten · Deutsch");
  assert.ok(result.audioDataUrl.startsWith("data:audio/wav;base64,"));

  await assert.rejects(
    () => synthesizePiperWorker({
      text: "Fehlerprobe",
      fetchImpl: async () => new Response(JSON.stringify({ detail: "worker unavailable" }), { status: 503 }),
      timeoutMs: 1000,
    }),
    /HTTP 503.*Kein kostenpflichtiger Fallback/,
  );
  await assert.rejects(
    () => synthesizePiperWorker({
      text: "Fehlerhafte WAV",
      fetchImpl: async () => new Response("not-a-wave", { status: 200 }),
      timeoutMs: 1000,
    }),
    /keine gültige WAV-Datei/,
  );
  await assert.rejects(
    () => synthesizePiperWorker({ text: "x".repeat(5001), fetchImpl: blockedFetch }),
    /maximal 5.000 Zeichen/,
  );
  console.log("Piper worker adapter tests passed: default-deny, auth, health, WAV validation and no paid fallback.");
} finally {
  for (const key of envKeys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
