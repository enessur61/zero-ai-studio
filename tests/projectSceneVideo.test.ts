import assert from 'node:assert/strict';
import { lookupProjectSceneVideo } from '../server/projectSceneVideo.ts';
import type { StudioProject } from '../src/types/zero.ts';

function project(overrides: Partial<StudioProject> = {}): StudioProject {
  return {
    id: 'project-a', title: 'Test', logline: '', genre: 'Thriller', targetDurationSec: 5,
    concept: '', story: '', screenplay: '', characterIds: [],
    scenes: [{
      id: 'scene-a', index: 0, title: 'Szene A', location: '', timeOfDay: '', durationSec: 5,
      cameraMovement: 'Statisch', characterIds: [], narrationText: '', dialogueText: '',
      subtitleText: '', soundCue: '', imagePrompt: '', videoPrompt: '', status: 'Entwurf',
    }],
    assets: [{
      id: 'asset-a', type: 'video', title: 'Clip A', url: 'data:video/mp4;base64,AAAA',
      modelId: 'zero-scene-video:scene-a', durationSec: 5, createdAt: '2026-11-18T00:00:00.000Z',
    }],
    snapshots: [], status: 'Konzept', version: 1,
    createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  };
}

const valid = project();
assert.deepEqual(lookupProjectSceneVideo([valid], 'project-a', 'scene-a'), {
  kind: 'found', dataUrl: 'data:video/mp4;base64,AAAA',
});
assert.deepEqual(lookupProjectSceneVideo([], 'project-a', 'scene-a'), { kind: 'project_not_found' });
assert.deepEqual(lookupProjectSceneVideo([valid], 'project-a', 'deleted-scene'), { kind: 'scene_not_found' });
assert.deepEqual(lookupProjectSceneVideo([project({ assets: [] })], 'project-a', 'scene-a'), { kind: 'media_not_found' });
assert.deepEqual(lookupProjectSceneVideo([
  project({ assets: [{ ...valid.assets[0], url: 'javascript:alert(1)' }] }),
], 'project-a', 'scene-a'), { kind: 'invalid_media' });
assert.deepEqual(lookupProjectSceneVideo([
  project({ id: 'project-b', assets: [{ ...valid.assets[0], modelId: 'zero-scene-video:scene-a' }] }),
], 'project-a', 'scene-a'), { kind: 'project_not_found' });
assert.deepEqual(lookupProjectSceneVideo([
  project({ scenes: [], assets: valid.assets }),
], 'project-a', 'scene-a'), { kind: 'scene_not_found' });

console.log('Project scene video lookup tests passed: project, scene, asset ownership and safe media validation.');
