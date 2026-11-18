import assert from 'node:assert/strict';
import { projectService } from '../lib/services/projectService.ts';
import { sceneService } from '../lib/services/sceneService.ts';
import { wanJobService } from '../lib/services/wanJobService.ts';

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
const scene = {
  id: 'scene-1', index: 0, title: 'Scene', location: '', timeOfDay: '', durationSec: 5,
  cameraMovement: 'Statisch' as const, characterIds: [], narrationText: '', dialogueText: '',
  subtitleText: '', soundCue: '', imagePrompt: '', videoPrompt: '', status: 'Entwurf' as const,
};
const project = {
  id: 'project-1', title: 'Project', logline: '', genre: 'Thriller', targetDurationSec: 5,
  concept: '', story: '', screenplay: '', characterIds: [], scenes: [scene], assets: [], snapshots: [],
  status: 'Konzept' as const, version: 1, createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  requests.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
  if (url === '/api/projects') return new Response(JSON.stringify({ projects: [project] }), { status: 200 });
  if (url === '/api/projects/project-1') return new Response(JSON.stringify({ project }), { status: 200 });
  if (url === '/api/video/engine/jobs') return new Response(JSON.stringify({ costFallback: false, job: {
    id: '00000000-0000-4000-8000-000000000001', status: 'queued', duration_sec: 5, engine: 'Wan 2.1',
  } }), { status: 201 });
  return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
}) as typeof fetch;

try {
  assert.equal((await projectService.get('project-1')).id, 'project-1');
  assert.equal((await sceneService.get('project-1', 'scene-1')).id, 'scene-1');
  await assert.rejects(() => sceneService.get('project-1', 'scene-missing'), /gehört nicht/);
  const job = await wanJobService.create({
    projectId: 'project-1', sceneId: 'scene-1', prompt: 'Cinematic scene', aspectRatio: '9:16',
  });
  assert.equal(job.projectId, 'project-1');
  assert.equal(job.sceneId, 'scene-1');
  assert.equal(job.status, 'queued');
  await assert.rejects(() => wanJobService.create({
    projectId: '', sceneId: 'scene-1', prompt: 'Cinematic scene', aspectRatio: '9:16',
  }), /Projekt- und Szenenzuordnung/);
  assert.ok(requests.some((request) => request.url === '/api/projects' && request.method === 'GET'));
  assert.ok(requests.some((request) => request.url === '/api/video/engine/jobs' &&
    request.body?.projectId === 'project-1' && request.body?.sceneId === 'scene-1'));
} finally {
  globalThis.fetch = originalFetch;
}

console.log('ZERO service adapter tests passed: existing API compatibility and mandatory Wan project/scene context.');
