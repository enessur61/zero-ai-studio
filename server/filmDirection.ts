import { randomUUID } from 'node:crypto';
import type { CharacterKnowledge, ContinuityEvent, ContinuityState, ContinuitySeries, SceneVersion, SemanticContinuityConflict } from '../src/types/continuity.ts';
import type { CharacterProfile, FilmScene, StudioProject } from '../src/types/zero.ts';
import { createSceneVersion, eventKnowledgeConflicts } from './continuity.ts';

const CAMERA_MOVEMENTS: readonly FilmScene['cameraMovement'][] = ['Statisch', 'Langsamer Zoom-In', 'Sanfter Zoom-Out', 'Schwenk Links', 'Schwenk Rechts', 'Vertikaler Tilt'];
export function resolveFilmCameraMovement(value: unknown, sceneIndex: number): FilmScene['cameraMovement'] {
  if (typeof value === 'string' && CAMERA_MOVEMENTS.includes(value as FilmScene['cameraMovement'])) return value as FilmScene['cameraMovement'];
  const safeIndex = Number.isSafeInteger(sceneIndex) ? sceneIndex : 0;
  const fallbackIndex = ((safeIndex % CAMERA_MOVEMENTS.length) + CAMERA_MOVEMENTS.length) % CAMERA_MOVEMENTS.length;
  return CAMERA_MOVEMENTS[fallbackIndex];
}
const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase('de-DE').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
function eventText(event: ContinuityEvent): string { return normalized([event.title, event.description].filter(Boolean).join(' ')); }
function versionProjectId(state: ContinuityState, sceneId: string): string | undefined {
  return state.sceneVersions.filter((v) => v.sceneId === sceneId).sort((a, b) => b.version - a.version)[0]?.projectId;
}
function namesLabel(id: string, characters: CharacterProfile[]): string {
  return characters.find((item) => item.id === id)?.name ?? id;
}
export function detectSemanticContinuityConflicts(state: ContinuityState, seriesId: string, characters: CharacterProfile[] = []): SemanticContinuityConflict[] {
  const events = state.events.filter((event) => event.seriesId === seriesId);
  const knowledge = state.knowledge.filter((fact) => fact.seriesId === seriesId);
  const scenes = events.filter((event) => Boolean(event.sceneId));
  const names = new Map(characters.map((character) => [character.id, character.name]));
  const conflicts: SemanticContinuityConflict[] = [];
  const add = (conflict: SemanticContinuityConflict) => { if (!conflicts.some((item) => item.id === conflict.id)) conflicts.push(conflict); };

  for (const death of events.filter((event) => event.kind === 'death' && event.subjectCharacterId)) {
    const characterId = death.subjectCharacterId!;
    const characterName = names.get(characterId) || 'Die Figur';
    const deathTime = Date.parse(death.occurredAt);
    for (const scene of scenes) {
      const sceneTime = Date.parse(scene.occurredAt);
      if (scene.id === death.id || !scene.characterIds.includes(characterId) || !Number.isFinite(deathTime) || !Number.isFinite(sceneTime) || sceneTime <= deathTime || scene.timeMode === 'flashback' || scene.timeMode === 'dream') continue;
      add({
        id: `dead:${death.id}:${scene.id}`, code: 'DEAD_CHARACTER_ON_SCREEN', severity: 'error',
        message: `${characterName} erscheint in „${scene.title}“, obwohl die Figur laut Zeitachse bereits in „${death.title}“ gestorben ist.`,
        suggestion: `Entferne ${characterName} aus dieser Szene und aus den Figuren- und Bild-/Videoprompts. Falls es bewusst eine Rückblende ist, kennzeichne die Szene ausdrücklich als Rückblende und setze ihre Ereigniszeit vor den Tod.`,
        eventId: scene.id, sourceEventId: death.id, sceneId: scene.sceneId,
        projectId: scene.sceneId ? versionProjectId(state, scene.sceneId) : undefined, characterId,
      });
    }
  }

  for (const reveal of events.filter((event) => (event.kind === 'identity_reveal' || event.kind === 'secret_reveal') && event.subjectCharacterId && event.canonicalValue?.trim())) {
    const isIdentity = reveal.kind === 'identity_reveal';
    const code = isIdentity ? 'IDENTITY_REVEALED_EARLY' : 'SECRET_REVEALED_EARLY';
    const phrase = normalized(reveal.canonicalValue!);
    const revealTime = Date.parse(reveal.occurredAt);
    const subjectId = reveal.subjectCharacterId!;
    const subjectName = names.get(subjectId) || 'Die Figur';
    for (const scene of scenes) {
      const sceneTime = Date.parse(scene.occurredAt);
      if (scene.id === reveal.id || !Number.isFinite(sceneTime) || !Number.isFinite(revealTime) || sceneTime >= revealTime || !eventText(scene).includes(phrase)) continue;
      add({
        id: `early:${reveal.id}:${scene.id}`, code, severity: 'error',
        message: isIdentity
          ? `Die wahre Identität von ${subjectName} wird in „${scene.title}“ vor dem festgelegten Enthüllungsereignis verraten.`
          : `Das Geheimnis „${reveal.canonicalValue}“ wird in „${scene.title}“ vor seiner kanonischen Enthüllung genannt.`,
        suggestion: isIdentity
          ? `Entferne den Namen bzw. die Identitätsenthüllung „${reveal.canonicalValue}“ aus Erzählung, Dialog, Untertiteln und visuellen Prompts. Nutze bis zum Enthüllungszeitpunkt nur die bekannte Tarnidentität.`
          : `Entferne oder verschleiere „${reveal.canonicalValue}“ in Erzählung, Dialog, Untertiteln und visuellen Prompts. Die Information darf erst ab „${reveal.title}“ eindeutig werden.`,
        eventId: scene.id, sourceEventId: reveal.id, sceneId: scene.sceneId,
        projectId: scene.sceneId ? versionProjectId(state, scene.sceneId) : undefined, characterId: subjectId,
      });
    }
    for (const fact of knowledge.filter((item) => item.subjectCharacterId === subjectId && item.factType === (isIdentity ? 'identity' : 'secret'))) {
      const learned = Date.parse(fact.learnedAt);
      if (!Number.isFinite(learned) || !Number.isFinite(revealTime) || learned >= revealTime) continue;
      add({
        id: `knowledge-early:${reveal.id}:${fact.id}`,
        code: isIdentity ? 'IDENTITY_KNOWLEDGE_EARLY' : 'SECRET_KNOWN_EARLY', severity: 'error',
        message: `${names.get(fact.characterId) || 'Eine Figur'} kennt ${isIdentity ? 'die Identität' : 'das Geheimnis'} von ${subjectName} bereits vor dem kanonischen Enthüllungszeitpunkt.`,
        suggestion: `Korrigiere den Zeitpunkt „Erfahren ab“ oder entferne den Wissenseintrag, bis „${reveal.title}“ stattgefunden hat.`,
        eventId: fact.id, sourceEventId: reveal.id, characterId: subjectId,
      });
    }
    if (isIdentity) {
      for (const fact of knowledge.filter((item) => item.subjectCharacterId === subjectId && item.factType === 'identity' && item.canonicalValue?.trim())) {
        const learned = Date.parse(fact.learnedAt);
        if (Number.isFinite(learned) && Number.isFinite(revealTime) && learned >= revealTime && normalized(fact.canonicalValue!) !== phrase) {
          add({
            id: `identity-mismatch:${reveal.id}:${fact.id}`, code: 'IDENTITY_CANON_MISMATCH', severity: 'error',
            message: `Ein Figurenwissenseintrag nennt nach der Enthüllung eine andere Identität („${fact.canonicalValue}“) als der Serienkanon („${reveal.canonicalValue}“).`,
            suggestion: `Aktualisiere den Identitätseintrag auf „${reveal.canonicalValue}“ oder markiere die abweichende Angabe ausdrücklich als falsche Vermutung.`,
            eventId: fact.id, sourceEventId: reveal.id, characterId: subjectId,
          });
        }
      }
    }
  }
  return conflicts;
}
export interface ContinuityDirectorContext {
  series: ContinuitySeries;
  knowledge: CharacterKnowledge[];
  events: ContinuityEvent[];
  conflicts: ReturnType<typeof eventKnowledgeConflicts>;
  semanticConflicts: SemanticContinuityConflict[];
  promptText: string;
}
export function buildContinuityDirectorContext(state: ContinuityState, seriesId: string, characterIds: string[] = [], characters: CharacterProfile[] = []): ContinuityDirectorContext | null {
  const series = state.series.find((item) => item.id === seriesId && !item.archivedAt);
  if (!series) return null;
  const events = state.events.filter((item) => item.seriesId === seriesId);
  const allKnowledge = state.knowledge.filter((item) => item.seriesId === seriesId);
  const knowledge = allKnowledge.filter((item) => characterIds.length === 0 || characterIds.includes(item.characterId));
  const conflicts = eventKnowledgeConflicts(events, allKnowledge);
  const semanticConflicts = detectSemanticContinuityConflicts(state, seriesId, characters);
  const chronologicalEvents = [...events].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const chronologicalKnowledge = [...knowledge].sort((a, b) => Date.parse(a.learnedAt) - Date.parse(b.learnedAt));
  const relationships = state.relationships.filter((item) => item.seriesId === seriesId).slice(0, 40);
  const locations = state.locations.filter((item) => item.seriesId === seriesId).slice(0, 40);
  const promptText = [
    '=== VERBINDLICHER SERIENKANON (CONTINUITY ENGINE) ===',
    'Serie: ' + series.title, 'Genre: ' + series.genre, 'Logline: ' + series.logline,
    'Serienbibel:\n' + (series.bible || 'Noch keine Serienbibel hinterlegt. Keine zusätzlichen Weltregeln erfinden.'),
    'Bisherige Ereigniszeitachse (chronologisch):\n' + chronologicalEvents.slice(-70).map((event) => event.occurredAt + ' | ' + (event.kind || 'fact') + ' | ' + event.title + (event.description ? ' | ' + event.description : '') + (event.subjectCharacterId ? ' | Figur: ' + namesLabel(event.subjectCharacterId, characters) : '') + (event.canonicalValue ? ' | Kanon: ' + event.canonicalValue : '')).join('\n'),
    'Figurenwissen (nur ab dem jeweiligen learnedAt-Zeitpunkt bekannt):\n' + chronologicalKnowledge.slice(-100).map((fact) => 'Figur ' + namesLabel(fact.characterId, characters) + ' ab ' + fact.learnedAt + ': ' + fact.fact + (fact.factType ? ' [' + fact.factType + ']' : '') + (fact.subjectCharacterId ? ' über ' + namesLabel(fact.subjectCharacterId, characters) : '') + (fact.canonicalValue ? ' = ' + fact.canonicalValue : '')).join('\n'),
    'Figurenbeziehungen:\n' + relationships.map((item) => item.fromCharacterId + ' → ' + item.toCharacterId + ': ' + item.type + (item.description ? ' (' + item.description + ')' : '')).join('\n'),
    'Kanonische Orte:\n' + locations.map((item) => item.name + (item.description ? ': ' + item.description : '')).join('\n'),
    'Verbindliche Kontinuitätsregeln: Eine Figur darf nach ihrem Tod nicht in der Gegenwart auftreten; Rückblenden müssen ausdrücklich als solche markiert sein. Wahre Identitäten und Geheimnisse dürfen weder in Szenen noch im Figurenwissen vor dem festgelegten Enthüllungsereignis offengelegt werden. Nach einer Identitätsenthüllung gilt ausschließlich der kanonische Name, abweichende Identitätsangaben müssen als Irrtum gekennzeichnet sein. Neue Szenen müssen an die Zeitachse anschließen.',
  ].join('\n\n').slice(0, 22000);
  return { series, knowledge, events: chronologicalEvents, conflicts, semanticConflicts, promptText };
}
function sceneContinuityDescription(scene: FilmScene): string {
  return [scene.title, scene.narrationText, scene.dialogueText, scene.subtitleText, scene.imagePrompt, scene.videoPrompt, scene.soundCue]
    .filter((value) => typeof value === 'string' && value.trim()).join('\n').slice(0, 7000);
}
function sceneOccurredAt(project: StudioProject, scene: FilmScene): string {
  const base = Date.parse(project.createdAt);
  return new Date((Number.isFinite(base) ? base : Date.now()) + Math.max(0, scene.index - 1) * 1000).toISOString();
}
export function recordFilmProductionContinuity(state: ContinuityState, seriesId: string, project: StudioProject): { seriesId: string; eventsCreated: number; sceneVersionsCreated: number } {
  const series = state.series.find((item) => item.id === seriesId && !item.archivedAt);
  if (!series) throw new Error('Die Continuity-Serie ist nicht verfügbar.');
  if (!series.projectIds.includes(project.id)) series.projectIds = [...series.projectIds, project.id].slice(0, 100);
  const now = new Date().toISOString();
  let eventsCreated = 0;
  let sceneVersionsCreated = 0;
  for (const scene of project.scenes) {
    const existingEvent = state.events.find((item) => item.seriesId === seriesId && item.sceneId === scene.id);
    if (!existingEvent) {
      state.events.unshift({ id: randomUUID(), seriesId, title: project.title + ' — ' + scene.title, description: sceneContinuityDescription(scene), occurredAt: sceneOccurredAt(project, scene), sceneId: scene.id, characterIds: [...scene.characterIds], kind: 'scene', timeMode: 'present', createdAt: now, updatedAt: now });
      eventsCreated++;
    }
    const hasVersion = state.sceneVersions.some((item) => item.seriesId === seriesId && item.projectId === project.id && item.sceneId === scene.id);
    if (!hasVersion) {
      const version: SceneVersion = createSceneVersion({ seriesId, projectId: project.id, sceneId: scene.id, snapshot: JSON.parse(JSON.stringify(scene)) as Record<string, unknown>, note: 'ZERO DIRECTOR: erste Produktionsfassung' }, state.sceneVersions);
      state.sceneVersions.unshift(version);
      sceneVersionsCreated++;
    }
  }
  series.updatedAt = now;
  return { seriesId, eventsCreated, sceneVersionsCreated };
}
export function recordFilmSceneRevision(state: ContinuityState, seriesId: string, project: StudioProject, scene: FilmScene): SceneVersion {
  const now = new Date().toISOString();
  let event = state.events.find((item) => item.seriesId === seriesId && item.sceneId === scene.id);
  if (event) {
    event.title = project.title + ' — ' + scene.title;
    event.description = sceneContinuityDescription(scene);
    event.characterIds = [...scene.characterIds];
    event.updatedAt = now;
  } else {
    event = { id: randomUUID(), seriesId, title: project.title + ' — ' + scene.title, description: sceneContinuityDescription(scene), occurredAt: sceneOccurredAt(project, scene), sceneId: scene.id, characterIds: [...scene.characterIds], kind: 'scene', timeMode: 'present', createdAt: now, updatedAt: now };
    state.events.unshift(event);
  }
  const version = createSceneVersion({ seriesId, projectId: project.id, sceneId: scene.id, snapshot: JSON.parse(JSON.stringify(scene)) as Record<string, unknown>, note: 'ZERO DIRECTOR: Szene neu generiert' }, state.sceneVersions);
  state.sceneVersions.unshift(version);
  const series = state.series.find((item) => item.id === seriesId);
  if (series) series.updatedAt = now;
  return version;
}