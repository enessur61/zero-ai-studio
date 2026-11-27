import assert from 'node:assert/strict';
import { runAutonomousFilmProduction } from '../lib/filmProductionPipeline.ts';
import type { FilmScene, StudioProject } from '../src/types/zero.ts';

function makeScene(index: number, durationSec: number): FilmScene {
  return {
    id: `scene-${index}`,
    index,
    title: `Szene ${index}`,
    location: 'Berlin',
    timeOfDay: 'Nacht',
    durationSec,
    cameraMovement: 'Statisch',
    characterIds: [],
    narrationText: `Erzähltext ${index}`,
    dialogueText: '',
    subtitleText: `Untertitel ${index}`,
    soundCue: 'Tiefe Atmosphäre',
    imagePrompt: 'Cinematic Berlin night',
    videoPrompt: 'Slow cinematic movement',
    status: 'Entwurf',
    ...(index === 1 ? { imageUrl: 'data:image/jpeg;base64,AAAA' } : {}),
  };
}

function makeProject(scenes: FilmScene[]): StudioProject {
  return {
    id: 'project-test',
    title: 'ZERO Testepisode',
    logline: 'Eine Nachricht verändert alles.',
    genre: 'Thriller',
    targetDurationSec: scenes.reduce((sum, scene) => sum + scene.durationSec, 0),
    concept: 'Noir',
    story: 'Testgeschichte',
    screenplay: 'Testdrehbuch',
    characterIds: [],
    scenes,
    assets: [],
    snapshots: [],
    status: 'Konzept',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeVideo(durationSec: number) {
  return {
    videoUrl: 'blob:zero-test-video',
    mimeType: 'video/mp4',
    durationSec,
    sizeBytes: 1024,
    hasAudioTrack: true,
  };
}

{
  const events: string[] = [];
  const progress: Array<{ percent: number; stage: string }> = [];
  const original = makeProject([makeScene(1, 29), makeScene(2, 29)]);
  const result = await runAutonomousFilmProduction({
    createDraft: async () => {
      events.push('draft');
      return { project: original, imageGenerationWarnings: ['FLUX für eine Szene nicht verfügbar.'] };
    },
    generateVoiceover: async (scene) => {
      events.push(`voice-${scene.index}`);
      if (scene.index === 2) throw new Error('Free-Tier-Kontingent ausgeschöpft');
      return { audioDataUrl: 'data:audio/wav;base64,AAAA', modelUsed: 'free-tts' };
    },
    saveProject: async (projectId, scenes) => {
      events.push('save');
      assert.equal(projectId, original.id);
      assert.ok(scenes[0].audioDataUrl);
      assert.equal(scenes[1].audioDataUrl, undefined);
      return { ...original, scenes };
    },
    renderVideo: async (project, onProgress) => {
      events.push('render');
      assert.equal(project.scenes.length, 2);
      onProgress(50, 'Halbzeit');
      return makeVideo(58);
    },
  }, (item) => progress.push({ percent: item.percent, stage: item.stage }));

  assert.deepEqual(events, ['draft', 'voice-1', 'voice-2', 'save', 'render']);
  assert.equal(result.imagesReady, 1);
  assert.equal(result.voiceoversReady, 1);
  assert.equal(result.video.durationSec, 58);
  assert.ok(result.warnings.some((warning) => warning.includes('FLUX')));
  assert.ok(result.warnings.some((warning) => warning.includes('Kontingent ausgeschöpft')));
  assert.equal(progress.at(-1)?.stage, 'complete');
  assert.equal(progress.at(-1)?.percent, 100);
}

{
  const project = makeProject([makeScene(1, 15), makeScene(2, 15), makeScene(3, 15), makeScene(4, 15)]);
  const persisted: FilmScene[] = [];
  let generated = 0;
  let renderedClips = 0;
  const result = await runAutonomousFilmProduction({
    createDraft: async () => ({ project }),
    generateVoiceover: async () => ({ audioDataUrl: 'data:audio/wav;base64,AAAA' }),
    generateVideoClip: async (scene, projectId) => {
      generated += 1;
      assert.ok(scene.videoPrompt.length > 0);
      assert.equal(projectId, project.id);
      return URL.createObjectURL(new Blob(['clip']));
    },
    saveVideoClip: async (projectId, sceneId) => {
      assert.equal(projectId, project.id);
      assert.ok(project.scenes.some((scene) => scene.id === sceneId));
      return { serverPersisted: true };
    },
    saveProject: async (_id, scenes) => {
      persisted.push(...scenes);
      assert.ok(scenes.every((scene) => !scene.videoUrl), 'temporary blob URLs must never be persisted');
      return { ...project, scenes };
    },
    renderVideo: async (renderProject) => {
      renderedClips = renderProject.scenes.filter((scene) => Boolean(scene.videoUrl)).length;
      assert.equal(renderedClips, 3, 'at most three Wan clips are attached to one episode');
      return makeVideo(60);
    },
  });
  assert.equal(generated, 3);
  assert.equal(renderedClips, 3);
  assert.ok(result.warnings.some((warning) => warning.includes('maximal 3 KI-Clips')));
  assert.ok(persisted.every((scene) => !scene.videoUrl));
}

{
  const project = makeProject([makeScene(1, 20), makeScene(2, 20)]);
  let rendered = false;
  const result = await runAutonomousFilmProduction({
    createDraft: async () => ({ project }),
    generateVoiceover: async () => ({ audioDataUrl: 'data:audio/wav;base64,AAAA' }),
    generateVideoClip: async () => { throw new Error('Wan-GPU ist gesperrt'); },
    saveProject: async (_id, scenes) => ({ ...project, scenes }),
    renderVideo: async (renderProject) => {
      rendered = true;
      assert.ok(renderProject.scenes.every((scene) => !scene.videoUrl));
      return makeVideo(40);
    },
  });
  assert.equal(rendered, true, 'Wan failures must fall back to local storyboard rendering');
  assert.ok(result.warnings.some((warning) => warning.includes('Wan-GPU ist gesperrt')));
  assert.ok(result.warnings.some((warning) => warning.includes('Storyboard-Schnitt')));
}

{
  const project = makeProject([makeScene(1, 20), makeScene(2, 20)]);
  let renderAttempts = 0;
  const result = await runAutonomousFilmProduction({
    createDraft: async () => ({ project }),
    generateVoiceover: async () => ({ audioDataUrl: 'data:audio/wav;base64,AAAA' }),
    generateVideoClip: async (_scene, projectId) => {
      assert.equal(projectId, project.id);
      return URL.createObjectURL(new Blob(['valid temporary clip']));
    },
    saveVideoClip: async () => ({ serverPersisted: true }),
    saveProject: async (_id, scenes) => ({ ...project, scenes }),
    renderVideo: async (renderProject) => {
      renderAttempts += 1;
      if (renderAttempts === 1) {
        assert.ok(renderProject.scenes.some((scene) => scene.videoUrl));
        throw new Error('Browser kann MP4-Codec nicht dekodieren');
      }
      assert.ok(renderProject.scenes.every((scene) => !scene.videoUrl), 'retry must use local storyboard frames only');
      return makeVideo(40);
    },
  });
  assert.equal(renderAttempts, 2);
  assert.equal(result.video.durationSec, 40);
  assert.ok(result.warnings.some((warning) => warning.includes('lokalem Storyboard-Schnitt')));
}

{
  const overLimit = makeProject([makeScene(1, 31), makeScene(2, 30)]);
  let providerCalls = 0;
  await assert.rejects(
    () => runAutonomousFilmProduction({
      createDraft: async () => ({ project: overLimit }),
      generateVoiceover: async () => {
        providerCalls += 1;
        return { audioDataUrl: 'data:audio/wav;base64,AAAA' };
      },
      saveProject: async (_id, scenes) => ({ ...overLimit, scenes }),
      renderVideo: async () => makeVideo(61),
    }),
    /60-Sekunden-Limit/,
  );
  assert.equal(providerCalls, 0, 'over-limit productions must stop before provider calls');
}

{
  const project = makeProject([makeScene(1, 20)]);
  let rendered = false;
  const result = await runAutonomousFilmProduction({
    createDraft: async () => ({ project }),
    generateVoiceover: async () => ({ audioDataUrl: 'https://not-audio.example/file.wav' }),
    saveProject: async (_id, scenes) => ({ ...project, scenes }),
    renderVideo: async () => {
      rendered = true;
      return makeVideo(20);
    },
  });
  assert.equal(result.voiceoversReady, 0);
  assert.ok(result.warnings.some((warning) => warning.includes('gültige Audio-Data-URL')));
  assert.equal(rendered, true, 'a bad optional voiceover must not prevent the episode export');
}

{
  const project = makeProject([]);
  await assert.rejects(
    () => runAutonomousFilmProduction({
      createDraft: async () => ({ project }),
      generateVoiceover: async () => ({ audioDataUrl: 'data:audio/wav;base64,AAAA' }),
      saveProject: async (_id, scenes) => ({ ...project, scenes }),
      renderVideo: async () => makeVideo(0),
    }),
    /keinen gültigen Szenenplan/,
  );
}

{
  const project = makeProject([makeScene(1, 60)]);
  await assert.rejects(
    () => runAutonomousFilmProduction({
      createDraft: async () => ({ project }),
      generateVoiceover: async () => ({ audioDataUrl: 'data:audio/wav;base64,AAAA' }),
      saveProject: async (_id, scenes) => ({ ...project, scenes }),
      renderVideo: async () => makeVideo(61),
    }),
    /60-Sekunden-Limit/,
  );
}


{
  const project = makeProject([makeScene(1, 20), makeScene(2, 20)]);
  let generated = 0;
  let saved = 0;
  let renderCount = 0;
  const revoked: string[] = [];
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = ((url: string) => { revoked.push(url); }) as typeof URL.revokeObjectURL;
  const clipUrl = URL.createObjectURL(new Blob(['one generated Wan clip']));
  try {
    const result = await runAutonomousFilmProduction({
      createDraft: async () => ({ project }),
      generateVoiceover: async () => ({ audioDataUrl: 'data:audio/wav;base64,AAAA' }),
      generateVideoClip: async (_scene, projectId) => {
        generated += 1;
        assert.equal(projectId, project.id);
        return clipUrl;
      },
      saveVideoClip: async (projectId, sceneId, blob) => {
        saved += 1;
        assert.equal(projectId, project.id);
        assert.equal(sceneId, 'scene-1');
        assert.ok(blob.size > 0);
        return { serverPersisted: false };
      },
      saveProject: async (_id, scenes) => ({ ...project, scenes }),
      renderVideo: async (renderProject) => {
        renderCount += 1;
        assert.ok(renderProject.scenes.every((scene) => !scene.videoUrl),
          'a clip without confirmed server persistence must never enter the render');
        return makeVideo(40);
      },
    });
    assert.equal(generated, 1, 'a media upload failure must not trigger another Wan generation');
    assert.equal(saved, 1, 'the generated clip is saved once without retrying GPU inference');
    assert.equal(renderCount, 1, 'storyboard fallback still completes the episode');
    assert.ok(result.warnings.some((warning) => warning.includes('Dauerhafte Serverspeicherung')));
    assert.deepEqual(revoked, [clipUrl], 'temporary object URL is revoked after fallback rendering');
  } finally {
    URL.revokeObjectURL = originalRevoke;
  }
}

console.log('Film production pipeline tests passed: autonomous order, durable clip storage, upload-failure fallback, cleanup and hard 60s cap.');
