import assert from 'node:assert/strict';
import { isValidWanJobId, loadWanJobList, matchWanJobScene, normalizeWanJobList, normalizeWanJobStatus, WAN_JOB_STATUSES } from '../server/wanJobList.ts';

const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
];
const source = WAN_JOB_STATUSES.map((status, index) => ({
  id: ids[index],
  status,
  created_at: '2026-11-18T12:00:00.000Z',
  started_at: null,
  finished_at: null,
  duration_sec: 5,
  engine: 'Wan 2.1',
  project_id: 'project-1',
  scene_id: 'scene-1',
  error: status === 'failed' ? 'x'.repeat(700) : null,
  cancel_reason: status === 'cancelled' ? 'cancelled by operator' : null,
}));
const normalized = normalizeWanJobList(source);
assert.deepEqual(normalized.map((job) => job.status), [...WAN_JOB_STATUSES]);
assert.equal(normalized[0].projectId, 'project-1');
assert.equal(normalized[0].sceneId, 'scene-1');
assert.equal(normalized.find((job) => job.status === 'failed')?.error?.length, 500);
assert.equal(normalized.find((job) => job.status === 'cancelled')?.cancelReason, 'cancelled by operator');

const filtered = normalizeWanJobList([
  null,
  'not-a-job',
  { id: 'not-a-uuid', status: 'running' },
  { id: ids[0], status: 'unknown' },
  source[0],
  source[0],
]);
assert.equal(filtered.length, 1, 'invalid and duplicate worker records must be discarded');

const bounded = normalizeWanJobList([
  { ...source[0], duration_sec: 999 },
  { ...source[1], id: ids[1], duration_sec: -50 },
], 2);
assert.equal(bounded.length, 2);
assert.equal(bounded[0].durationSec, 5);
assert.equal(bounded[1].durationSec, 1);
assert.deepEqual(normalizeWanJobList(source, 0), []);
assert.deepEqual(normalizeWanJobList({ jobs: source }), []);

console.log('Wan job list normalization tests passed: all lifecycle states, validation, deduplication and metadata bounds.');

const targetScene = { id: 'scene-1', title: 'Matching scene' };
assert.equal(matchWanJobScene({ projectId: 'project-1', sceneId: 'scene-1' }, 'project-1', [targetScene]), targetScene);
assert.equal(matchWanJobScene({ projectId: 'another-project', sceneId: 'scene-1' }, 'project-1', [targetScene]), null);
assert.equal(matchWanJobScene({ projectId: 'project-1', sceneId: 'missing-scene' }, 'project-1', [targetScene]), null);
assert.equal(matchWanJobScene({ projectId: null, sceneId: 'scene-1' }, 'project-1', [targetScene]), null);
assert.equal(matchWanJobScene({ projectId: 'project-1', sceneId: 'scene-1' }, undefined, [targetScene]), null);


assert.equal(normalizeWanJobStatus(source[0], ids[0])?.status, 'queued');
assert.equal(normalizeWanJobStatus(source[0], ids[1]), null);
assert.equal(normalizeWanJobStatus({ ...source[0], status: 'invented' }, ids[0]), null);

const okLoad = await loadWanJobList(
  async () => new Response(JSON.stringify({ jobs: [source[0], source[0], { id: 'bad', status: 'running' }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }),
  new URL('https://worker.example/jobs?limit=50'),
  {},
);
assert.equal(okLoad.kind, 'ok');
if (okLoad.kind === 'ok') assert.equal(okLoad.jobs.length, 1);

const malformedLoad = await loadWanJobList(
  async () => new Response(JSON.stringify({ jobs: 'not-an-array' }), { status: 200 }),
  new URL('https://worker.example/jobs'),
  {},
);
assert.equal(malformedLoad.kind, 'invalid');

const failedLoad = await loadWanJobList(
  async () => new Response('{}', { status: 503 }),
  new URL('https://worker.example/jobs'),
  {},
);
assert.equal(failedLoad.kind, 'invalid');

const offlineLoad = await loadWanJobList(
  async () => { throw new TypeError('worker offline'); },
  new URL('https://worker.example/jobs'),
  {},
);
assert.equal(offlineLoad.kind, 'unavailable');


assert.equal(isValidWanJobId(ids[0]), true);
assert.equal(isValidWanJobId(ids[0].toUpperCase()), true);
assert.equal(isValidWanJobId('00000000-0000-0000-0000-000000000000'), false, 'nil UUID is not a generated Wan job ID');
assert.equal(isValidWanJobId('00000000-0000-4000-0000-000000000001'), false, 'invalid UUID variant must be rejected');
assert.equal(isValidWanJobId('00000000-0000-7000-8000-000000000001'), false, 'unsupported UUID version must be rejected');
assert.equal(isValidWanJobId('00000000-0000-4000-8000-000000000001-extra'), false);
assert.equal(isValidWanJobId(null), false);
assert.equal(isValidWanJobId(123), false);
