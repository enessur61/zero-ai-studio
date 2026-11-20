import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: () => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } }),
});
window.scrollTo = () => {};
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

const playbackKey = 'zero.project-video.playback.v1';
const initialSnapshot = {
  projectId: 'project-1',
  assetId: 'asset-1',
  sceneId: 'scene-1',
  currentTime: 42.75,
  shouldPlay: true,
  savedAt: Date.now(),
};
window.sessionStorage.setItem(playbackKey, JSON.stringify(initialSnapshot));

const project = {
  id: 'project-1',
  title: 'ZERO Integrationstest',
  logline: '',
  genre: 'Mystery',
  targetDurationSec: 60,
  concept: '',
  story: '',
  screenplay: '',
  characterIds: [],
  scenes: [{
    id: 'scene-1',
    index: 0,
    title: 'Szene eins',
    location: 'Innen',
    timeOfDay: 'Nacht',
    durationSec: 5,
    cameraMovement: 'Statisch',
    characterIds: [],
    narrationText: '',
    dialogueText: '',
    subtitleText: '',
    soundCue: '',
    imagePrompt: '',
    videoPrompt: '',
    status: 'Szenenbereit',
  }],
  assets: [],
  snapshots: [],
  status: 'In Produktion',
};
const archivedAsset = {
  id: 'asset-1',
  projectId: 'project-1',
  sceneId: 'scene-1',
  jobId: null,
  contentType: 'video/mp4',
  sizeBytes: 4096,
  createdAt: new Date().toISOString(),
};

const json = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});
let authStatusCalls = 0;
let resolveExpiredProbe;
const fetchMock = async (input, init = {}) => {
  const url = String(input);
  if (url === '/api/auth/status') {
    authStatusCalls += 1;
    if (authStatusCalls === 2) {
      return await new Promise((resolve) => { resolveExpiredProbe = resolve; });
    }
    return json({ required: true, configured: true, authenticated: true });
  }
  if (url === '/api/auth/login' && init.method === 'POST') return json({ ok: true });
  if (url === '/api/models') return json({ models: [], budgetGuard: { totalSpentEur: 0 } });
  if (url === '/api/projects') return json({ projects: [project] });
  if (url === '/api/characters') return json({ characters: [] });
  if (url === '/api/memory') return json({ memories: [] });
  if (url === '/api/brain/history') return json({ messages: [] });
  if (url === '/api/automation') return json({ runs: [] });
  if (url === '/api/system/audit') return json({ budgetGuard: { totalSpentEur: 0 }, backups: [], istZustand: [], roadmap: [] });
  if (url === '/api/system/zip-backups') {
    return json({ currentVersion: '1.1.8', autoZipOnChange: false, lastVerifiedAt: null, zipBackups: [], changelogHistory: [], excludedSecrets: [] });
  }
  if (url === '/api/projects/project-1/videos') return json({ assets: [archivedAsset] });
  if (url === '/api/video/engine/status') return json({ online: false, status: 'OFFLINE', message: 'GPU nicht verbunden' });
  if (url.startsWith('/api/video/engine/jobs?')) return json({ jobs: [] });
  if (url === '/api/projects/project-1/videos/asset-1') {
    return new Response(new Uint8Array([0]), {
      status: 206,
      headers: { 'content-range': 'bytes 0-0/4096', 'content-length': '1', 'accept-ranges': 'bytes' },
    });
  }
  throw new Error(`Unexpected integration-test fetch: ${init.method ?? 'GET'} ${url}`);
};
globalThis.fetch = fetchMock;
window.fetch = fetchMock;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: App } = await import('../App.tsx');

const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(assertion, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = assertion();
      if (value) return value;
    } catch (error) { lastError = error; }
    await act(async () => { await delay(); });
  }
  throw new Error(message, { cause: lastError });
}

let playCalls = 0;
function installMediaMocks(video) {
  Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 });
  Object.defineProperty(video, 'duration', { configurable: true, value: 60 });
  Object.defineProperty(video, 'ended', { configurable: true, value: false });
  video.load = () => {};
  video.play = () => { playCalls += 1; return Promise.resolve(); };
  return video;
}

const root = createRoot(window.document.getElementById('root'));
try {
  await act(async () => { root.render(React.createElement(App)); });
  const firstVideo = await waitFor(
    () => window.document.querySelector('video'),
    'The real App did not mount VideoStudioView from the persisted playback marker.',
  );
  installMediaMocks(firstVideo);
  await waitFor(() => typeof resolveExpiredProbe === 'function', 'VideoStudioView did not start its authenticated playback probe.');

  await act(async () => {
    firstVideo.dispatchEvent(new window.Event('loadedmetadata', { bubbles: true }));
    firstVideo.dispatchEvent(new window.Event('play', { bubbles: true }));
    firstVideo.currentTime = 42.75;
    firstVideo.dispatchEvent(new window.Event('timeupdate', { bubbles: true }));
  });
  await waitFor(() => playCalls >= 1, 'The initially active archived clip did not attempt playback.');

  // Safari can reset the media element before the auth gate tears down the view.
  firstVideo.currentTime = 0;
  await act(async () => {
    resolveExpiredProbe(json({ authenticated: false }, 401));
  });

  await waitFor(
    () => window.document.querySelector('#zero-admin-password'),
    'The actual App auth gate did not replace VideoStudioView after session expiry.',
  );
  assert.equal(window.document.querySelector('video'), null, 'The auth gate must actually unmount the video element.');
  const persistedAtGate = JSON.parse(window.sessionStorage.getItem(playbackKey));
  assert.equal(persistedAtGate.currentTime, 42.75, 'Unmount cleanup must retain the last known position, not Safari currentTime=0.');
  assert.equal(persistedAtGate.shouldPlay, true, 'Unmount cleanup must retain the prior playback intent.');
  assert.equal(persistedAtGate.projectId, 'project-1');
  assert.equal(persistedAtGate.assetId, 'asset-1');
  assert.equal(persistedAtGate.sceneId, 'scene-1');

  const password = window.document.querySelector('#zero-admin-password');
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    valueSetter.call(password, 'integration-test-password');
    password.dispatchEvent(new window.Event('input', { bubbles: true }));
    password.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });

  const restoredVideo = await waitFor(
    () => {
      const video = window.document.querySelector('video');
      return video && video !== firstVideo ? video : null;
    },
    'Successful login did not remount VideoStudioView with the archived clip.',
  );
  installMediaMocks(restoredVideo);
  assert.equal(restoredVideo.getAttribute('src'), '/api/projects/project-1/videos/asset-1',
    'Login restoration must select the exact archived clip from the original project.');
  assert.match(window.document.body.textContent, /Fertiger KI-Clip: Szene eins/,
    'Login restoration must recover the original scene label.');
  const restoredSnapshot = JSON.parse(window.sessionStorage.getItem(playbackKey));
  assert.equal(restoredSnapshot.projectId, 'project-1');
  assert.equal(restoredSnapshot.assetId, 'asset-1');
  assert.equal(restoredSnapshot.sceneId, 'scene-1');
  assert.equal(restoredSnapshot.currentTime, 42.75);
  assert.equal(restoredSnapshot.shouldPlay, true);

  await act(async () => {
    restoredVideo.dispatchEvent(new window.Event('loadedmetadata', { bubbles: true }));
  });
  assert.equal(restoredVideo.currentTime, 42.75, 'The authenticated remount must seek to the saved playback position.');
  assert.ok(playCalls >= 2, 'The authenticated remount must honor the saved shouldPlay intent.');
  console.log('VideoStudioView React-DOM auth-gate unmount/login restoration integration test passed.');
} finally {
  await act(async () => { root.unmount(); });
  dom.window.close();
}
