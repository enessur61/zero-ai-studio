import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = new URL(process.env.ZERO_E2E_BASE_URL || 'http://127.0.0.1:4179');
const password = process.env.ZERO_E2E_PASSWORD;
assert.ok(password, 'ZERO_E2E_PASSWORD is required');

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const pageErrors = [];
const providerRequests = [];
let createdMemoryId = null;
let createdProjectId = null;

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // The browser test is deliberately offline except for the local ZERO server.
  // This prevents fonts, remote models, cloud inference, and accidental fallbacks.
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== baseUrl.origin) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === baseUrl.origin &&
        request.method() !== 'GET' &&
        /^\/api\/(image\/generate|audio\/tts|audio\/transcribe|music\/compose|film\/direct|brain\/chat|automation\/run|video\/engine\/jobs)$/.test(url.pathname)) {
      providerRequests.push({ method: request.method(), path: url.pathname });
    }
  });

  await page.goto(baseUrl.href, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Admin-Passwort').fill(password);
  await page.getByRole('button', { name: 'Sicher anmelden' }).click();
  await page.locator('main h1').filter({ hasText: 'BEYOND LIMITS' }).waitFor();
  const main = page.locator('main');
  const sidebar = page.locator('aside');

  async function openStudio(label, heading) {
    await sidebar.getByRole('button', { name: label, exact: true }).click();
    await main.getByRole('heading', { name: heading, exact: true }).waitFor();
  }

  // Model Hub: real browser navigation and client-side catalogue filtering.
  await openStudio('MODEL HUB', 'ZERO MODEL HUB');
  const modelSearch = main.getByPlaceholder('Modelle durchsuchen (GPT-OSS, Qwen, FLUX, Sana, Whisper...)');
  await modelSearch.fill('gpt-oss');
  await modelSearch.clear();

  // Image Studio: process the bundled same-origin sample with the local canvas path.
  await openStudio('IMAGE STUDIO', 'ZERO IMAGE STUDIO');
  await main.getByRole('button', { name: 'Noir Kontrast', exact: true }).click();
  await main.getByText(/ZERO Local Canvas \(/).waitFor();

  // Video Studio: mount the project timeline and archived-clip UI without starting a GPU job.
  await openStudio('VIDEO STUDIO', 'ZERO VIDEO STUDIO');
  await main.getByRole('heading', { name: 'Video-Export & Qualitätsprüfung' }).waitFor();

  // Audio Studio: exercise editable voiceover controls without submitting provider requests.
  await openStudio('AUDIO STUDIO', 'ZERO AUDIO STUDIO');
  const voiceover = main.getByPlaceholder('Deutschen oder mehrsprachigen Sprechertext eingeben...');
  await voiceover.fill('ZERO Browser-Test: lokale UI-Eingabe.');
  await main.locator('select').first().selectOption('Charon');

  // Music Studio: render a local on-device SFX through WebAudio, not AI composition.
  await openStudio('MUSIC STUDIO', 'ZERO MUSIC STUDIO');
  await main.getByRole('button', { name: 'Sub-Bass Impact', exact: true }).click();
  await main.getByText('Aktiver SFX: Sub-Bass Impact').waitFor();
  await main.locator('audio[src^="blob:"]').waitFor();

  // Film Director: exercise the editor surface but never submit a generation request.
  await openStudio('FILM DIRECTOR', 'ZERO FILM DIRECTOR');
  await main.getByPlaceholder('Neue Serie anlegen').fill('ZERO browser smoke only');

  // Projects: create a real project through the visible UI and verify it appears.
  await openStudio('PROJECTS', 'Projekte');
  const projectTitle = `ZERO Browser E2E ${Date.now()}`;
  await main.getByPlaceholder('Projekttitel').fill(projectTitle);
  await main.getByPlaceholder('Kurze Logline / Beschreibung').fill('Temporary browser E2E fixture; no provider calls.');
  await main.getByRole('button', { name: 'Projekt speichern', exact: true }).click();
  await main.getByRole('heading', { name: projectTitle, exact: true }).waitFor();
  const projectPayload = await page.evaluate(async (title) => {
    const response = await fetch('/api/projects');
    if (!response.ok) throw new Error('Project list API failed during browser E2E cleanup');
    const data = await response.json();
    return data.projects.find((project) => project.title === title) ?? null;
  }, projectTitle);
  assert.ok(projectPayload?.id, 'The project created from the UI must be persisted by the API');
  createdProjectId = projectPayload.id;

  // Memory: create, search, and delete a real record through the visible UI.
  await openStudio('MEMORY', 'ZERO MEMORY');
  const memoryTitle = `ZERO Browser Memory ${Date.now()}`;
  await main.getByPlaceholder('Titel (z.B. Kamera-Preset Berlin)').fill(memoryTitle);
  await main.getByPlaceholder('Inhalt dauerhaft ablegen...').fill('zero-browser-e2e-local-search-fixture');
  await main.getByPlaceholder('Schlagwörter (kommagetrennt)').fill('browser, ci');
  await main.getByRole('button', { name: 'Im Gedächtnis sichern', exact: true }).click();
  await main.getByRole('heading', { name: memoryTitle, exact: true }).waitFor();
  const memoryPayload = await page.evaluate(async (title) => {
    const response = await fetch('/api/memory');
    if (!response.ok) throw new Error('Memory list API failed during browser E2E cleanup');
    const data = await response.json();
    return data.memories.find((memory) => memory.title === title) ?? null;
  }, memoryTitle);
  assert.ok(memoryPayload?.id, 'The memory created from the UI must be persisted by the API');
  createdMemoryId = memoryPayload.id;
  await main.getByPlaceholder('Semantische Suche in allen Erinnerungen...').fill('zero-browser-e2e-local-search-fixture');
  await main.getByRole('button', { name: 'Suchen', exact: true }).click();
  await main.getByRole('heading', { name: memoryTitle, exact: true }).waitFor();
  await main.getByRole('heading', { name: memoryTitle, exact: true }).locator('xpath=../..').getByRole('button', { name: 'Eintrag löschen' }).click();
  await main.getByRole('heading', { name: memoryTitle, exact: true }).waitFor({ state: 'detached' });
  createdMemoryId = null;

  // Automation: verify the real editor and run history load; do not start a workflow.
  await openStudio('AUTOMATION', 'ZERO BRAIN & Intelligence');
  await main.getByRole('heading', { name: 'ZERO AUTOMATION ENGINE', exact: true }).waitFor();
  await main.getByRole('button', { name: 'Workflow ausführen', exact: true }).waitFor();

  assert.deepEqual(providerRequests, [], 'Browser E2E must not invoke AI providers, cloud inference, or GPU jobs');
  assert.deepEqual(pageErrors, [], 'No uncaught browser runtime errors are allowed during studio navigation');

  console.log('ZERO browser E2E passed: Model Hub, local Image Canvas, Video Studio, Audio UI, local Music SFX, Film Director, Projects CRUD, Memory CRUD/search, and Automation UI. External origins were blocked; no AI/provider/GPU generation requests were made.');

  // Remove the temporary project through the authenticated same-origin API.
  if (createdProjectId) {
    const cleanup = await page.evaluate(async (id) => {
      const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return { ok: response.ok, status: response.status };
    }, createdProjectId);
    if (!cleanup.ok) throw new Error('Temporary browser E2E project cleanup failed: HTTP ' + cleanup.status);
    createdProjectId = null;
  }
  await context.close();
} finally {
  // Best-effort cleanup keeps CI fixtures isolated even if an assertion fails.
  try {
    if (createdMemoryId) {
      await pageCleanup(baseUrl, password, '/api/memory/' + encodeURIComponent(createdMemoryId));
    }
  } catch {}
  try {
    if (createdProjectId) {
      await pageCleanup(baseUrl, password, '/api/projects/' + encodeURIComponent(createdProjectId));
    }
  } catch {}
  await browser.close();
}

async function pageCleanup(base, adminPassword, path) {
  const response = await fetch(new URL('/api/auth/login', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: adminPassword }),
  });
  if (!response.ok) throw new Error('Cleanup login failed');
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  const deletion = await fetch(new URL(path, base), { method: 'DELETE', headers: { cookie } });
  if (!deletion.ok && deletion.status !== 404) throw new Error('Cleanup failed: HTTP ' + deletion.status);
}
