export interface ContinuitySeries {
  id: string; title: string; logline: string; genre: string; bible: string;
  projectIds: string[]; createdAt: string; updatedAt: string; archivedAt?: string;
}
export interface CharacterKnowledge {
  id: string; seriesId: string; characterId: string; fact: string;
  sourceEventId?: string; learnedAt: string; createdAt: string; updatedAt: string;
  factType?: 'fact' | 'identity' | 'secret'; subjectCharacterId?: string; canonicalValue?: string;
}
export interface CharacterRelationship {
  id: string; seriesId: string; fromCharacterId: string; toCharacterId: string;
  type: string; description: string; createdAt: string; updatedAt: string;
}
export interface ContinuityLocation {
  id: string; seriesId: string; name: string; description: string;
  attributes: Record<string, string>; createdAt: string; updatedAt: string;
}
export interface ContinuityEvent {
  id: string; seriesId: string; title: string; description: string;
  occurredAt: string; sceneId?: string; characterIds: string[];
  createdAt: string; updatedAt: string;
  kind?: 'scene' | 'fact' | 'death' | 'identity_reveal' | 'secret_reveal';
  subjectCharacterId?: string; canonicalValue?: string; timeMode?: 'present' | 'flashback' | 'dream';
}
export interface SceneVersion {
  id: string; seriesId: string; projectId: string; sceneId: string;
  version: number; snapshot: Record<string, unknown>; note: string;
  createdAt: string;
}
export interface SemanticContinuityConflict {
  id: string;
  code: 'DEAD_CHARACTER_ON_SCREEN' | 'IDENTITY_REVEALED_EARLY' | 'IDENTITY_KNOWLEDGE_EARLY' | 'IDENTITY_CANON_MISMATCH' | 'SECRET_REVEALED_EARLY' | 'SECRET_KNOWN_EARLY' | 'STORY_CANON_DIVERGENCE';
  severity: 'error' | 'warning';
  message: string;
  suggestion: string;
  eventId: string;
  sourceEventId: string;
  sceneId?: string;
  projectId?: string;
  characterId?: string;
}

export interface DramaturgyAnalysisVersion {
  id: string; seriesId: string; version: number; createdAt: string;
  modelId: string; costMode: 'confirmed-free-cloud' | 'local';
  sourceFingerprint: string;
  analysis: {
    overallAssessment: string;
    characterAnalyses: Array<{ characterId: string; psychologicalProfile: string; coreMotivation: string; emotionalArc: string; relationshipDynamics: string[]; contradictions: string[] }>;
    findings: Array<{ id: string; category: string; severity: string; characterIds: string[]; episodeTitle: string; sceneTitle: string; evidence: string; interpretation: string; recommendation: string; confidence: string }>;
    storyRecommendations: string[];
  };
  comparison?: { previousVersion: number; changedCharacters: Array<{ characterId: string; changedFields: string[] }>; newContradictions: string[]; resolvedContradictions: string[]; summary: string };
}
export interface DramaturgyDecision {
  id: string; seriesId: string; analysisVersionId: string; findingId: string;
  decision: 'approved' | 'rejected'; note: string; createdAt: string;
}

export interface DramaturgyApplication {
  id: string; seriesId: string; analysisVersionId: string; findingId: string; decisionId: string;
  projectId: string; sceneId: string; field: 'narrationText' | 'dialogueText' | 'subtitleText';
  previousText: string; replacementText: string; createdAt: string;
}

export interface ContinuityState {
  series: ContinuitySeries[];
  knowledge: CharacterKnowledge[];
  relationships: CharacterRelationship[];
  locations: ContinuityLocation[];
  events: ContinuityEvent[];
  sceneVersions: SceneVersion[];
  dramaturgyAnalyses: DramaturgyAnalysisVersion[];
  dramaturgyDecisions: DramaturgyDecision[];
  dramaturgyApplications: DramaturgyApplication[];
}
export function emptyContinuityState(): ContinuityState {
  return { series: [], knowledge: [], relationships: [], locations: [], events: [], sceneVersions: [], dramaturgyAnalyses: [], dramaturgyDecisions: [], dramaturgyApplications: [] };
}
