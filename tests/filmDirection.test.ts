import assert from 'node:assert/strict';
import { buildContinuityDirectorContext, detectSemanticContinuityConflicts, recordFilmProductionContinuity, recordFilmSceneRevision, resolveFilmCameraMovement } from '../server/filmDirection.ts';
import { emptyContinuityState } from '../src/types/continuity.ts';
import type { FilmScene, StudioProject } from '../src/types/zero.ts';

assert.equal(resolveFilmCameraMovement('Schwenk Rechts', 0), 'Schwenk Rechts');
assert.equal(resolveFilmCameraMovement('Vertikaler Tilt', 2), 'Vertikaler Tilt');
assert.equal(resolveFilmCameraMovement('Statisch', 5), 'Statisch');

assert.equal(resolveFilmCameraMovement(undefined, 0), 'Statisch');
assert.equal(resolveFilmCameraMovement(null, 1), 'Langsamer Zoom-In');
assert.equal(resolveFilmCameraMovement('nicht erlaubt', 2), 'Sanfter Zoom-Out');
assert.equal(resolveFilmCameraMovement('nicht erlaubt', -1), 'Vertikaler Tilt');
assert.equal(resolveFilmCameraMovement('nicht erlaubt', Number.NaN), 'Statisch');

console.log('Film direction tests passed: valid AI camera movements are preserved and invalid values safely fall back.');
{
  const state = emptyContinuityState();
  const series = { id: 'series-a', title: 'ZERO Test', logline: 'Mystery', genre: 'Thriller', bible: 'Niemand kennt die Wahrheit vor Folge 4.', projectIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  state.series.push(series);
  state.events.push({ id: 'event-a', seriesId: series.id, title: 'Die Nachricht', description: 'Elias findet das Telefon.', occurredAt: '2026-01-01T10:00:00.000Z', characterIds: ['character-a'], createdAt: '', updatedAt: '' });
  state.knowledge.push({ id: 'knowledge-a', seriesId: series.id, characterId: 'character-a', fact: 'Elias kennt die Nachricht.', sourceEventId: 'event-a', learnedAt: '2026-01-01T10:01:00.000Z', createdAt: '', updatedAt: '' });
  const context = buildContinuityDirectorContext(state, series.id, ['character-a']);
  assert.ok(context?.promptText.includes('Niemand kennt die Wahrheit vor Folge 4.')); assert.ok(context?.promptText.includes('Elias kennt die Nachricht.')); assert.equal(context?.conflicts.length, 0);
  assert.equal(buildContinuityDirectorContext(state, 'archived-or-missing'), null);
  const scene = { id: 'scene-a', index: 1, title: 'Fund', location: 'Berlin', timeOfDay: 'Nacht', durationSec: 15, cameraMovement: 'Statisch', characterIds: ['character-a'], narrationText: 'Ein Telefon klingelt.', dialogueText: '', subtitleText: 'Wer ist da?', soundCue: 'Pulsierender Bass', imagePrompt: 'night', videoPrompt: 'slow', status: 'Entwurf' } as FilmScene;
  const project = { id: 'project-a', title: 'Episode 1', logline: 'Start', genre: 'Thriller', targetDurationSec: 15, concept: '', story: '', screenplay: '', characterIds: ['character-a'], scenes: [scene], assets: [], snapshots: [], status: 'Konzept', version: 1, createdAt: '2026-01-01T10:02:00.000Z', updatedAt: '2026-01-01T10:02:00.000Z' } as StudioProject;
  const recorded = recordFilmProductionContinuity(state, series.id, project);
  assert.equal(recorded.eventsCreated, 1); assert.equal(recorded.sceneVersionsCreated, 1); assert.ok(series.projectIds.includes(project.id));
  const revision = recordFilmSceneRevision(state, series.id, project, { ...scene, title: 'Fund — neue Fassung' });
  assert.equal(revision.version, 2); assert.equal(state.sceneVersions.length, 2);
  assert.equal(state.events.find((item) => item.sceneId === scene.id)?.title, 'Episode 1 — Fund — neue Fassung');
  const broken = emptyContinuityState(); broken.series.push({ ...series, id: 'series-b', projectIds: [] });
  broken.events.push({ id: 'future-event', seriesId: 'series-b', title: 'Später', description: '', occurredAt: '2026-01-03T00:00:00.000Z', characterIds: [], createdAt: '', updatedAt: '' });
  broken.knowledge.push({ id: 'future-knowledge', seriesId: 'series-b', characterId: 'character-a', fact: 'Kennt das Geheimnis', sourceEventId: 'future-event', learnedAt: '2026-01-02T00:00:00.000Z', createdAt: '', updatedAt: '' });
  assert.equal(buildContinuityDirectorContext(broken, 'series-b')?.conflicts.length, 1);
}
console.log('Continuity-aware film direction tests passed: canon context, event/knowledge conflicts, production timeline and append-only scene versions.');
{
  const state = emptyContinuityState();
  state.series.push({ id: 'semantic', title: 'Semantic', logline: '', genre: '', bible: '', projectIds: ['project-a'], createdAt: '', updatedAt: '' });
  state.events.push({ id: 'death', seriesId: 'semantic', title: 'Elias stirbt', description: '', occurredAt: '2026-02-02T00:00:00.000Z', characterIds: [], kind: 'death', subjectCharacterId: 'character-a', createdAt: '', updatedAt: '' });
  state.events.push({ id: 'scene-after-death', seriesId: 'semantic', title: 'Elias steht auf', description: 'Elias betritt den Raum.', occurredAt: '2026-02-03T00:00:00.000Z', sceneId: 'scene-after-death', characterIds: ['character-a'], kind: 'scene', createdAt: '', updatedAt: '' });
  state.sceneVersions.push({ id: 'version-a', seriesId: 'semantic', projectId: 'project-a', sceneId: 'scene-after-death', version: 1, snapshot: {}, note: '', createdAt: '' });
  state.events.push({ id: 'identity', seriesId: 'semantic', title: 'Wahre Identität', description: '', occurredAt: '2026-02-05T00:00:00.000Z', characterIds: [], kind: 'identity_reveal', subjectCharacterId: 'character-b', canonicalValue: 'Mara Winter', createdAt: '', updatedAt: '' });
  state.events.push({ id: 'early-identity-scene', seriesId: 'semantic', title: 'Hinweis', description: 'Mara Winter wird im Bericht genannt.', occurredAt: '2026-02-04T00:00:00.000Z', sceneId: 'early-identity-scene', characterIds: ['character-b'], kind: 'scene', createdAt: '', updatedAt: '' });
  state.events.push({ id: 'secret', seriesId: 'semantic', title: 'Geheimnis enthüllt', description: '', occurredAt: '2026-02-07T00:00:00.000Z', characterIds: [], kind: 'secret_reveal', subjectCharacterId: 'character-a', canonicalValue: 'Der Schlüssel liegt im Keller', createdAt: '', updatedAt: '' });
  state.knowledge.push({ id: 'early-secret-knowledge', seriesId: 'semantic', characterId: 'character-b', subjectCharacterId: 'character-a', factType: 'secret', canonicalValue: 'Der Schlüssel liegt im Keller', fact: 'Kennt das Geheimnis', learnedAt: '2026-02-06T00:00:00.000Z', createdAt: '', updatedAt: '' });
  state.knowledge.push({ id: 'identity-known-too-early', seriesId: 'semantic', characterId: 'character-a', subjectCharacterId: 'character-b', factType: 'identity', canonicalValue: 'Mara Winter', fact: 'Kennt die Identität zu früh', learnedAt: '2026-02-04T00:00:00.000Z', createdAt: '', updatedAt: '' });
  state.knowledge.push({ id: 'identity-wrong-after-reveal', seriesId: 'semantic', characterId: 'character-a', subjectCharacterId: 'character-b', factType: 'identity', canonicalValue: 'Alias X', fact: 'Falsche Identität bleibt bestehen', learnedAt: '2026-02-06T00:00:00.000Z', createdAt: '', updatedAt: '' });
  const semanticConflicts = detectSemanticContinuityConflicts(state, 'semantic');
  assert.ok(semanticConflicts.some((item) => item.code === 'DEAD_CHARACTER_ON_SCREEN' && item.sceneId === 'scene-after-death'));
  assert.ok(semanticConflicts.some((item) => item.code === 'IDENTITY_REVEALED_EARLY' && item.sceneId === 'early-identity-scene'));
  assert.ok(semanticConflicts.some((item) => item.code === 'SECRET_KNOWN_EARLY'));
  assert.ok(semanticConflicts.some((item) => item.code === 'IDENTITY_KNOWLEDGE_EARLY'));
  assert.ok(semanticConflicts.some((item) => item.code === 'IDENTITY_CANON_MISMATCH'));
  state.events.find((item) => item.id === 'scene-after-death')!.timeMode = 'flashback';
  assert.ok(!detectSemanticContinuityConflicts(state, 'semantic').some((item) => item.code === 'DEAD_CHARACTER_ON_SCREEN'));
}
console.log('Semantic continuity tests passed: death chronology, premature identity/secret reveals, early knowledge and flashback exemption.');
