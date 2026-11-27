import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://zero.example/',
  pretendToBeVisual: true,
});
const { window } = dom;
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  Node: window.Node,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const bridgeActions = [];
let whisperAvailable = true;
window.webkit = {
  messageHandlers: {
    zeroCoreML: {
      postMessage(payload) {
        bridgeActions.push(payload);
        const response = payload.action === 'diagnostics'
          ? { ok: true, available: whisperAvailable, runtime: whisperAvailable ? 'whisper.cpp test runtime' : 'Whisper runtime not linked', weightsPresent: whisperAvailable, runtimeLinked: whisperAvailable }
          : payload.action === 'pickAudio'
            ? { ok: true, importId: '123e4567-e89b-42d3-a456-426614174000' }
            : payload.action === 'transcribe'
              ? { ok: true, text: 'Lokales Testtranskript', srt: '1\\n00:00:00,000 --> 00:00:01,000\\nLokales Testtranskript' }
              : { ok: false, error: `Unexpected native action: ${payload.action}` };
        queueMicrotask(() => window.__zeroCoreMLReceive?.(payload.requestId, response));
      },
    },
  },
};

const apiCalls = [];
globalThis.fetch = async (input, init = {}) => {
  apiCalls.push({ url: String(input), method: init.method ?? 'GET' });
  throw new Error(`Unexpected API/provider call: ${String(input)}`);
};
window.fetch = globalThis.fetch;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { AudioStudioView } = await import('../components/AudioStudioView.tsx');
const root = createRoot(window.document.getElementById('root'));
try {
  await act(async () => {
    root.render(createElement(AudioStudioView, {
      projects: [],
      onProjectUpdated() {},
    }));
  });

  const importButton = [...window.document.querySelectorAll('button')]
    .find((button) => button.textContent.includes('Native iOS-Dateiimport'));
  assert.ok(importButton, 'Native iOS import action should be visible only when the bridge exists.');

  await act(async () => { importButton.click(); });
  for (let i = 0; i < 10 && !window.document.body.textContent.includes('Lokales Testtranskript'); i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }

  assert.deepEqual(bridgeActions.map((item) => item.action), ['diagnostics', 'pickAudio', 'transcribe']);
  assert.equal(bridgeActions[2].importId, '123e4567-e89b-42d3-a456-426614174000');
  assert.match(window.document.body.textContent, /Lokales Testtranskript/);
  assert.deepEqual(apiCalls, [], 'Native file import and transcription must never call provider/server APIs.');

  // Missing runtime/weights must stop before opening the picker and must not use a cloud fallback.
  whisperAvailable = false;
  await act(async () => { importButton.click(); });
  for (let i = 0; i < 10 && !window.document.body.textContent.includes('Lokale Whisper-Transkription ist nicht verfügbar'); i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  assert.deepEqual(bridgeActions.map((item) => item.action), ['diagnostics', 'pickAudio', 'transcribe', 'diagnostics']);
  assert.match(window.document.body.textContent, /Lokale Whisper-Transkription ist nicht verfügbar/);
  assert.deepEqual(apiCalls, [], 'Unavailable native Whisper must not trigger a provider/server fallback.');
  console.log('AudioStudioView native iOS audio import/transcription end-to-end test passed.');
} finally {
  await act(async () => { root.unmount(); });
  window.close();
}
