import type { CharacterProfile, StudioProject } from '../src/types/zero.ts';
import type { ContinuityState, SemanticContinuityConflict } from '../src/types/continuity.ts';
import { detectSemanticContinuityConflicts } from './filmDirection.ts';
import { eventKnowledgeConflicts } from './continuity.ts';

export interface StorySupervisorEpisode {
  projectId: string;
  title: string;
  createdAt: string;
  sceneCount: number;
  characterIds: string[];
}
export interface StorySupervisorCharacterArc {
  characterId: string;
  name: string;
  role: string;
  episodeTitles: string[];
  appearanceCount: number;
  firstAppearanceAt?: string;
  lastAppearanceAt?: string;
  knowledgeMilestones: Array<{ learnedAt: string; fact: string; factType: string }>;
  developmentSummary: string;
}
export interface StorySupervisorDramaturgyInsight {
  id: string;
  category: 'emotion' | 'motivation' | 'contradiction';
  characterName: string;
  episodeTitle: string;
  evidence: string;
  recommendation: string;
  confidence: 'heuristic';
}
export interface StorySupervisorReport {
  generatedAt: string;
  episodeCount: number;
  sceneCount: number;
  episodes: StorySupervisorEpisode[];
  characterArcs: StorySupervisorCharacterArc[];
  revealTimeline: Array<{ eventId: string; title: string; occurredAt: string; kind: string; characterId: string; canonicalValue: string }>;
  conflicts: SemanticContinuityConflict[];
  dataWarnings: string[];
  dramaturgyInsights: StorySupervisorDramaturgyInsight[];
}
const byTime = <T extends { occurredAt: string }>(a: T, b: T) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
const normalizedCanon = (value: string) => value.normalize('NFKC').toLocaleLowerCase('de-DE').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();

/**
 * Builds a read-only, series-wide report from the existing continuity JSON state,
 * linked episode projects and append-only scene snapshots. No schema migration or
 * persistent analysis cache is required.
 */
export function buildStorySupervisorReport(
  state: ContinuityState,
  seriesId: string,
  projects: StudioProject[],
  characters: CharacterProfile[],
): StorySupervisorReport | null {
  const series = state.series.find((item) => item.id === seriesId && !item.archivedAt);
  if (!series) return null;
  const versions = state.sceneVersions.filter((item) => item.seriesId === seriesId);
  const linkedIds = new Set([...series.projectIds, ...versions.map((item) => item.projectId)]);
  const episodes = projects.filter((project) => linkedIds.has(project.id))
    .sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''))
    .map((project) => {
      const scenes = Array.isArray(project.scenes) ? project.scenes : [];
      return {
        projectId: project.id,
        title: project.title || project.id,
        createdAt: project.createdAt || '',
        sceneCount: scenes.length,
        characterIds: [...new Set(scenes.flatMap((scene) => Array.isArray(scene.characterIds) ? scene.characterIds : []))],
      };
    });
  const episodeById = new Map(episodes.map((episode) => [episode.projectId, episode]));
  const sceneProject = new Map<string, string>();
  for (const project of projects) for (const scene of Array.isArray(project.scenes) ? project.scenes : []) sceneProject.set(scene.id, project.id);
  for (const version of versions) sceneProject.set(version.sceneId, version.projectId);

  const events = state.events.filter((event) => event.seriesId === seriesId).sort(byTime);
  const knowledge = state.knowledge.filter((item) => item.seriesId === seriesId)
    .sort((a, b) => Date.parse(a.learnedAt) - Date.parse(b.learnedAt));
  const characterMap = new Map(characters.map((character) => [character.id, character]));
  const characterIds = new Set<string>();
  for (const event of events) for (const id of event.characterIds) characterIds.add(id);
  for (const fact of knowledge) { characterIds.add(fact.characterId); if (fact.subjectCharacterId) characterIds.add(fact.subjectCharacterId); }
  for (const episode of episodes) for (const id of episode.characterIds) characterIds.add(id);

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const emotionLexicon = [
    { label: 'Angst / Anspannung', words: ['angst', 'fürcht', 'zitter', 'panik', 'bedroh', 'nervös'] },
    { label: 'Wut / Aggression', words: ['wut', 'zorn', 'hass', 'schreit', 'rasend', 'aggress'] },
    { label: 'Trauer / Verlust', words: ['trau', 'weint', 'träne', 'verlust', 'vermisst', 'verzweif'] },
    { label: 'Vertrauen / Nähe', words: ['vertraut', 'liebt', 'liebe', 'umarm', 'geborgen', 'offenbart'] },
    { label: 'Misstrauen / Distanz', words: ['misstrau', 'lügt', 'verrat', 'geheim', 'verdächtig', 'meidet'] },
    { label: 'Hoffnung / Entschlossenheit', words: ['hoff', 'kämpft', 'entschlossen', 'rett', 'schützt'] },
  ];
  const dramaturgyInsights: StorySupervisorDramaturgyInsight[] = [];
  const characterArcs = [...characterIds].map((characterId) => {
    const profile = characterMap.get(characterId);
    const appearances = events.filter((event) => Boolean(event.sceneId) && Array.isArray(event.characterIds) && event.characterIds.includes(characterId));
    const episodeTitles = [...new Set(appearances.map((event) => {
      const projectId = event.sceneId ? sceneProject.get(event.sceneId) : undefined;
      return projectId ? episodeById.get(projectId)?.title : undefined;
    }).filter((title): title is string => Boolean(title)))];
    const milestones = knowledge.filter((item) => item.characterId === characterId)
      .map((item) => ({ learnedAt: item.learnedAt, fact: item.fact, factType: item.factType || 'fact' }));
    const first = appearances[0], last = appearances[appearances.length - 1];
    for (const event of appearances) {
      const projectId = event.sceneId ? sceneProject.get(event.sceneId) : undefined;
      const episode = projectId ? episodeById.get(projectId) : undefined;
      const project = projectId ? projectById.get(projectId) : undefined;
      const scene = project?.scenes?.find((item) => item.id === event.sceneId);
      const evidenceText = normalizedCanon([event.title, event.description, scene?.narrationText, scene?.dialogueText, scene?.subtitleText].filter(Boolean).join(' '));
      if (!evidenceText) continue;
      for (const signal of emotionLexicon) {
        const hits = signal.words.filter((word) => evidenceText.includes(word));
        if (hits.length) dramaturgyInsights.push({
          id: `emotion:${event.id}:${signal.label}`, category: 'emotion',
          characterName: profile?.name || characterId, episodeTitle: episode?.title || 'Unzugeordnete Szene',
          evidence: `Emotionsmarker ${signal.label.toLowerCase()} in „${event.title}“ (${hits.slice(0, 3).join(', ')}).`,
          recommendation: `Prüfe, ob ${profile?.name || 'die Figur'} diese Emotion vor und nach der Szene durch Handlung, Dialog oder Körpersprache entwickelt.`,
          confidence: 'heuristic',
        });
      }
      const motivationMatches = evidenceText.match(/\b(?:will|wollen|möchte|muss|müssen|sucht|versucht|braucht)\b[^.!?]{0,100}/giu) || [];
      for (const phrase of motivationMatches.slice(0, 2)) dramaturgyInsights.push({
        id: `motivation:${event.id}:${phrase}`, category: 'motivation',
        characterName: profile?.name || characterId, episodeTitle: episode?.title || 'Unzugeordnete Szene',
        evidence: `Mögliches Ziel / Bedürfnis: „${phrase.trim()}“.`,
        recommendation: 'Mache Ziel, Hindernis und Preis der Entscheidung konkret und verknüpfe das Ergebnis mit dem nächsten Figurenauftritt.',
        confidence: 'heuristic',
      });
      for (const [positive, negative] of [['vertraut', 'misstrau'], ['liebt', 'hasst'], ['lebt', 'tot'], ['verbündet', 'feind']]) {
        if (evidenceText.includes(positive) && evidenceText.includes(negative)) dramaturgyInsights.push({
          id: `contradiction:${event.id}:${positive}:${negative}`, category: 'contradiction',
          characterName: profile?.name || characterId, episodeTitle: episode?.title || 'Unzugeordnete Szene',
          evidence: `Gegensätzliche Marker „${positive}“ und „${negative}“ treten im selben Szenenkontext auf.`,
          recommendation: 'Prüfe, ob der Gegensatz beabsichtigt ist (Lüge, Perspektivwechsel oder Wendung); andernfalls Figurenstatus und Formulierung präzisieren.',
          confidence: 'heuristic',
        });
      }
    }
    const developmentSummary = appearances.length
      ? `Auftritt in ${episodeTitles.length || 1} Episode(n) und ${appearances.length} erfassten Szenen; ${milestones.length} Wissensmeilenstein(e).`
      : `Noch keine Szenenauftritte in der Serienzeitachse erfasst; ${milestones.length} Wissensmeilenstein(e).`;
    return {
      characterId, name: profile?.name || String(characterId), role: profile?.role || '',
      episodeTitles, appearanceCount: appearances.length,
      ...(first ? { firstAppearanceAt: first.occurredAt } : {}),
      ...(last ? { lastAppearanceAt: last.occurredAt } : {}),
      knowledgeMilestones: milestones, developmentSummary,
    };
  }).sort((a, b) => b.appearanceCount - a.appearanceCount || a.name.localeCompare(b.name, 'de'));

  const revealEvents = events.filter((event) =>
    (event.kind === 'identity_reveal' || event.kind === 'secret_reveal') &&
    event.subjectCharacterId && event.canonicalValue?.trim());
  const revealTimeline = revealEvents.map((event) => ({
    eventId: event.id, title: event.title, occurredAt: event.occurredAt,
    kind: event.kind || 'fact', characterId: event.subjectCharacterId!,
    canonicalValue: event.canonicalValue!,
  }));

  const conflicts = detectSemanticContinuityConflicts(state, seriesId, characters);
  const addConflict = (conflict: SemanticContinuityConflict) => {
    if (!conflicts.some((item) => item.id === conflict.id)) conflicts.push(conflict);
  };
  for (const kind of ['identity_reveal', 'secret_reveal'] as const) {
    const bySubject = new Map<string, typeof revealEvents>();
    for (const event of revealEvents.filter((item) => item.kind === kind)) {
      const key = event.subjectCharacterId!;
      bySubject.set(key, [...(bySubject.get(key) || []), event]);
    }
    for (const [characterId, subjectEvents] of bySubject) {
      const distinct = new Map<string, typeof subjectEvents>();
      for (const event of subjectEvents) {
        const canon = normalizedCanon(event.canonicalValue || '');
        if (!distinct.has(canon)) distinct.set(canon, []);
        distinct.get(canon)!.push(event);
      }
      if (distinct.size < 2) continue;
      const entries = [...distinct.values()];
      const first = entries[0][0], divergent = entries[1][0];
      addConflict({
        id: `story-canon-divergence:${kind}:${characterId}`,
        code: 'STORY_CANON_DIVERGENCE', severity: 'error',
        message: `${characterMap.get(characterId)?.name || 'Eine Figur'} hat widersprüchliche kanonische ${kind === 'identity_reveal' ? 'Identitätsenthüllungen' : 'Geheimnisenthüllungen'}: „${first.canonicalValue}“ und „${divergent.canonicalValue}“.`,
        suggestion: `Lege einen einzigen kanonischen Wert fest und korrigiere oder kennzeichne die abweichende Enthüllung ausdrücklich als Täuschung bzw. falsche Fährte. Prüfe alle betroffenen Episoden und Szenenversionen.`,
        eventId: divergent.id, sourceEventId: first.id, characterId,
        ...(divergent.sceneId ? { sceneId: divergent.sceneId } : {}),
        ...(divergent.sceneId && sceneProject.get(divergent.sceneId) ? { projectId: sceneProject.get(divergent.sceneId) } : {}),
      });
    }
  }
  const dataWarnings = eventKnowledgeConflicts(events, knowledge).map((item) => item.message);
  const sceneCount = episodes.reduce((total, episode) => total + episode.sceneCount, 0);
  return {
    generatedAt: new Date().toISOString(), episodeCount: episodes.length, sceneCount,
    episodes, characterArcs, revealTimeline, conflicts, dataWarnings,
    dramaturgyInsights: dramaturgyInsights.slice(0, 120),
  };
}
