import assert from 'node:assert/strict';
import { VideoObjectUrlRegistry } from '../lib/videoObjectUrlRegistry.ts';

function makeRegistry() {
  let nextId = 0;
  const revoked: string[] = [];
  const registry = new VideoObjectUrlRegistry({
    createObjectURL: () => `blob:zero-test-${++nextId}`,
    revokeObjectURL: (url) => { revoked.push(url); },
  });
  const create = (projectId: string, sceneId: string | undefined, kind: 'restored' | 'generated' | 'export') =>
    registry.create(new Blob(['video clip']), { projectId, sceneId, kind });
  return { registry, create, revoked };
}

// Project switch releases only restored URLs associated with the outgoing project.
{
  const { registry, create, revoked } = makeRegistry();
  const restoredOutgoing = create('project-a', 'scene-a', 'restored');
  registry.retainPreview(restoredOutgoing, 'wan-clip-preview', 'project-a', 'restored');
  const generatedOutgoing = create('project-a', 'scene-b', 'generated');
  const restoredIncoming = create('project-b', 'scene-c', 'restored');
  assert.deepEqual(registry.releaseProjectRestored('project-a'), [restoredOutgoing]);
  assert.deepEqual(revoked, [restoredOutgoing]);
  assert.equal(registry.has(generatedOutgoing), true);
  assert.equal(registry.has(restoredIncoming), true);
}

// Multiple scene clips are independent; shared URLs survive until their final scene reference is removed.
{
  const { registry, create, revoked } = makeRegistry();
  const first = create('project-a', 'scene-1', 'restored');
  const second = create('project-a', 'scene-2', 'restored');
  const shared = create('project-a', 'scene-3', 'restored');
  registry.register(shared, { projectId: 'project-a', sceneId: 'scene-4', kind: 'restored' });
  assert.equal(registry.releaseSceneReference(first, 'project-a', 'scene-1'), true);
  assert.deepEqual(revoked, [first]);
  assert.equal(registry.has(second), true);
  assert.equal(registry.releaseSceneReference(shared, 'project-a', 'scene-3'), false);
  assert.equal(registry.has(shared), true);
  registry.releaseSceneReference(shared, 'project-a', 'scene-4');
  registry.releaseSceneReference(second, 'project-a', 'scene-2');
  assert.deepEqual(new Set(revoked), new Set([first, shared, second]));
}

// Replacing the preview removes only its preview reference; the scene keeps the old URL alive.
{
  const { registry, create, revoked } = makeRegistry();
  const previous = create('project-a', 'scene-1', 'generated');
  registry.retainPreview(previous, 'wan-clip-preview', 'project-a', 'generated');
  const replacement = create('project-a', 'scene-1', 'generated');
  registry.retainPreview(replacement, 'wan-clip-preview', 'project-a', 'generated');
  assert.equal(registry.releasePreview(previous, 'wan-clip-preview'), true);
  assert.equal(registry.has(previous), true);
  registry.releaseSceneReference(previous, 'project-a', 'scene-1');
  assert.deepEqual(revoked, [previous]);
  assert.equal(registry.has(replacement), true);
  assert.equal(registry.releasePreview(replacement, 'wan-clip-preview'), false);
  assert.equal(registry.has(replacement), true);
}

// Unmount releases every URL owned by this Video Studio instance.
{
  const { registry, create, revoked } = makeRegistry();
  const restored = create('project-a', 'scene-1', 'restored');
  const generated = create('project-b', 'scene-2', 'generated');
  const exportUrl = create('project-b', undefined, 'export');
  registry.retainPreview(exportUrl, 'export-preview', 'project-b', 'export');
  const released = registry.releaseAll();
  assert.deepEqual(new Set(released), new Set([restored, generated, exportUrl]));
  assert.deepEqual(new Set(revoked), new Set([restored, generated, exportUrl]));
  assert.equal(registry.has(restored), false);
  assert.equal(registry.has(generated), false);
  assert.equal(registry.has(exportUrl), false);
}
console.log('Video object URL registry tests passed: project switch, multiple clips, preview replacement and unmount.');
