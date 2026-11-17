import { randomUUID } from 'node:crypto';
import type { CharacterKnowledge, ContinuityEvent, ContinuityState, ContinuitySeries, SceneVersion } from '../src/types/continuity.ts';
import type { FilmScene, StudioProject } from '../src/types/zero.ts';
import { createSceneVersion, eventKnowledgeConflicts } from './continuity.ts';

const CAMERA_MOVEMENTS: readonly FilmScene['cameraMovement'][] = ['Statisch', 'Langsamer Zoom-In', 'Sanfter Zoom-Out', 'Schwenk Links', 'Schwenk Rechts', 'Vertikaler Tilt'];
export function resolveFilmCameraMovement(value: unknown, sceneIndex: number): FilmScene['cameraMovement'] {
  if (typeof value === 'string' && CAMERA_MOVEMENTS.includes(value as FilmScene['cameraMovement'])) return value as FilmScene['cameraMovement'];
  const safeIndex = Number.isSafeInteger(sceneIndex) ? sceneIndex : 0;
  const fallbackIndex = ((safeIndex % CAMERA_MOVEMENTS.length) + CAMERA_MOVEMENTS.length) % CAMERA_MOVEMENTS.length;
  return CAMERA_MOVEMENTS[fallbackIndex];
}
export interface ContinuityDirectorContext { series: ContinuitySeries; knowledge: CharacterKnowledge[]; events: ContinuityEvent[]; conflicts: ReturnType<typeof eventKnowledgeConflicts>; promptText: string; }
export function buildContinuityDirectorContext(state: ContinuityState, seriesId: string, characterIds: string[] = []): ContinuityDirectorContext | null {
  const series = state.series.find((item) => item.id === seriesId && !item.archivedAt);
  if (!series) return null;
  const events = state.events.filter((item) => item.seriesId === seriesId);
  const allKnowledge = state.knowledge.filter((item) => item.seriesId === seriesId);
  const knowledge = allKnowledge.filter((item) => characterIds.length === 0 || characterIds.includes(item.characterId));
  const conflicts = eventKnowledgeConflicts(events, allKnowledge);
  const chronologicalEvents = [...events].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const chronologicalKnowledge = [...knowledge].sort((a, b) => Date.parse(a.learnedAt) - Date.parse(b.learnedAt));
  const relationships = state.relationships.filter((item) => item.seriesId === seriesId).slice(0, 40);
  const locations = state.locations.filter((item) => item.seriesId === seriesId).slice(0, 40);
  const promptText = [
    '=== VERBINDLICHER SERIENKANON (CONTINUITY ENGINE) ===',
    'Serie: ' + series.title, 'Genre: ' + series.genre, 'Logline: ' + series.logline,
    'Serienbibel:\n' + (series.bible || 'Noch keine Serienbibel hinterlegt. Keine zusätzlichen Weltregeln erfinden.'),
    'Bisherige Ereigniszeitachse (chronologisch):\n' + chronologicalEvents.slice(-50).map((event) => event.occurredAt + ' | ' + event.title + (event.description ? ' | ' + event.description : '')).join('\n'),
    'Figurenwissen (nur ab dem jeweiligen learnedAt-Zeitpunkt bekannt):\n' + chronologicalKnowledge.slice(-80).map((fact) => 'Figur ' + fact.characterId + ' ab ' + fact.learnedAt + ': ' + fact.fact).join('\n'),
    'Figurenbeziehungen:\n' + relationships.map((item) => item.fromCharacterId + ' → ' + item.toCharacterId + ': ' + item.type + (item.description ? ' (' + item.description + ')' : '')).join('\n'),
    'Kanonische Orte:\n' + locations.map((item) => item.name + (item.description ? ': ' + item.description : '')).join('\n'),
    'Regeln: Widersprich niemals der Serienbibel oder bestehenden Ereignissen. Eine Figur darf nur Wissen verwenden, das ihr zu diesem Zeitpunkt bereits bekannt ist. Geheimnisse dürfen nicht vor ihrem kanonischen Enthüllungszeitpunkt ausgesprochen, gezeigt oder als selbstverständlich behandelt werden. Erfinde keine rückwirkenden Erinnerungen. Neue Szenen müssen an die bestehende Zeitachse anschließen.',
  ].join('\n\n').slice(0, 18000);
  return { series, knowledge, events: chronologicalEvents, conflicts, promptText };
}
function sceneContinuityDescription(scene: FilmScene): string { return [scene.narrationText, scene.dialogueText, scene.subtitleText, scene.soundCue].filter((value) => typeof value === 'string' && value.trim()).join('\n').slice(0, 4000); }
function sceneOccurredAt(project: StudioProject, scene: FilmScene): string { const base = Date.parse(project.createdAt); return new Date((Number.isFinite(base) ? base : Date.now()) + Math.max(0, scene.index - 1) * 1000).toISOString(); }
export function recordFilmProductionContinuity(state: ContinuityState, seriesId: string, project: StudioProject): { seriesId: string; eventsCreated: number; sceneVersionsCreated: number } {
  const series = state.series.find((item) => item.id === seriesId && !item.archivedAt);
  if (!series) throw new Error('Die Continuity-Serie ist nicht verfügbar.');
  if (!series.projectIds.includes(project.id)) series.projectIds = [...series.projectIds, project.id].slice(0, 100);
  const now = new Date().toISOString(); let eventsCreated = 0; let sceneVersionsCreated = 0;
  for (const scene of project.scenes) {
    const existingEvent = state.events.find((item) => item.seriesId === seriesId && item.sceneId === scene.id);
    if (!existingEvent) { state.events.unshift({ id: randomUUID(), seriesId, title: project.title + ' — ' + scene.title, description: sceneContinuityDescription(scene), occurredAt: sceneOccurredAt(project, scene), sceneId: scene.id, characterIds: [...scene.characterIds], createdAt: now, updatedAt: now }); eventsCreated += 1; }
    const hasVersion = state.sceneVersions.some((item) => item.seriesId === seriesId && item.projectId === project.id && item.sceneId === scene.id);
    if (!hasVersion) { const version: SceneVersion = createSceneVersion({ seriesId, projectId: project.id, sceneId: scene.id, snapshot: JSON.parse(JSON.stringify(scene)) as Record<string, unknown>, note: 'ZERO DIRECTOR: erste Produktionsfassung' }, state.sceneVersions); state.sceneVersions.unshift(version); sceneVersionsCreated += 1; }
  }
  series.updatedAt = now; return { seriesId, eventsCreated, sceneVersionsCreated };
}
export function recordFilmSceneRevision(state: ContinuityState, seriesId: string, project: StudioProject, scene: FilmScene): SceneVersion {
  const now = new Date().toISOString();
  let event = state.events.find((item) => item.seriesId === seriesId && item.sceneId === scene.id);
  if (event) { event.title = project.title + ' — ' + scene.title; event.description = sceneContinuityDescription(scene); event.characterIds = [...scene.characterIds]; event.updatedAt = now; }
  else { event = { id: randomUUID(), seriesId, title: project.title + ' — ' + scene.title, description: sceneContinuityDescription(scene), occurredAt: sceneOccurredAt(project, scene), sceneId: scene.id, characterIds: [...scene.characterIds], createdAt: now, updatedAt: now }; state.events.unshift(event); }
  const version = createSceneVersion({ seriesId, projectId: project.id, sceneId: scene.id, snapshot: JSON.parse(JSON.stringify(scene)) as Record<string, unknown>, note: 'ZERO DIRECTOR: Szene neu generiert' }, state.sceneVersions);
  state.sceneVersions.unshift(version); const series = state.series.find((item) => item.id === seriesId); if (series) series.updatedAt = now; return version;
}