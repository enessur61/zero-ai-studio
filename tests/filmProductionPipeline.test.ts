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
    /hartes 60-Sekunden-Limit/,
  );
}

console.log('Film production pipeline tests passed: autonomous order, partial failures, asset validation and hard 60s cap.');
