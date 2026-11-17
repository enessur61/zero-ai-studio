export type ExecutionMode = 'LOCAL ON-DEVICE' | 'FREE CLOUD' | 'SELF-HOSTED';

export type ModelStatus =
  | 'FUNKTIONIERT'
  | 'LOKAL INSTALLIERT'
  | 'Ready for Deployment'
  | 'INSTALLATION ERFORDERLICH'
  | 'BROWSER TEST ERFORDERLICH'
  | 'ADAPTER FEHLT'
  | 'NICHT KOMPATIBEL'
  | 'FREE-TIER AUSGESCHÖPFT'
  | 'RATE LIMIT'
  | 'VORÜBERGEHEND AUSGELASTET'
  | 'GESPERRT';

export type ModelCategory =
  | 'Text & Reasoning'
  | 'Bildgenerierung'
  | 'Videogenerierung'
  | 'Sprache & Audio'
  | 'Musik & SFX'
  | 'Multimodal & Vision'
  | 'Embeddings & Suche'
  | 'Code & Automatisierung';

export type FreeTierClassification =
  | 'DAUERHAFT KOSTENLOS (LOKAL)'
  | 'DAUERHAFT KOSTENLOS (OPEN CLOUD)'
  | 'EINGESCHRÄNKT KOSTENLOS (FREE TIER)'
  | 'HARDWARE / SERVER ERFORDERLICH'
  | 'GESPERRT (KOSTENPFLICHTIG)'
  | 'DERZEIT NICHT VERFÜGBAR';

export interface ModelDefinition {
  id: string;
  name: string;
  family: string;
  category: ModelCategory;
  executionMode: ExecutionMode;
  status: ModelStatus;
  license: string;
  commercialUse: string;
  sizeGB: number;
  ramRequirementGB: number;
  iosCompatible: boolean;
  iosNotes: string;
  provider: string;
  adapterId: string;
  hasRealAdapter: boolean;
  requiresPaidKey: boolean;
  requiresExternalGpu: boolean;
  costEur: number;
  enabled: boolean;
  capabilities: string[];
  lastTestedAt: string | null;
  lastTestLatencyMs: number | null;
  lastTestMessage: string;
  testPassed: boolean;
  version: string;
  limitations: string;
  freeTierType?: FreeTierClassification;
  prerequisites?: string;
}

export interface BudgetAuditEvent {
  id: string;
  timestamp: string;
  adapterId: string;
  modelId: string;
  action: string;
  decision: 'ERLAUBT_0_EUR' | 'BLOCKIERT_BUDGET_GUARD' | 'GESTOPPT_KONTINGENT' | 'RESET_BESTAETIGT_MANUELL';
  reason: string;
  costEur: number;
}

export interface BudgetGuardState {
  budgetLimitEur: number;
  totalSpentEur: number;
  paidProvidersDisabled: boolean;
  autoFallbackDisabled: boolean;
  autoUpgradeDisabled: boolean;
  freeQuotaUsage: Record<
    string,
    { requestsToday: number; dailySoftLimit: number; exhausted: boolean; lastResetDate?: string }
  >;
  auditLog: BudgetAuditEvent[];
}

export type MemoryType =
  | 'conversation'
  | 'project'
  | 'preference'
  | 'character'
  | 'knowledge'
  | 'production';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  projectId?: string;
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

export interface CharacterProfile {
  id: string;
  name: string;
  role: string;
  age: string;
  appearance: string;
  faceFeatures: string;
  clothing: string;
  voiceStyle: string;
  voiceName: 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr';
  referenceImageUrl: string;
  consistencyPrompt: string;
  notes: string;
  createdAt: string;
}

export interface FilmScene {
  id: string;
  index: number;
  title: string;
  location: string;
  timeOfDay: string;
  durationSec: number;
  cameraMovement: 'Statisch' | 'Langsamer Zoom-In' | 'Sanfter Zoom-Out' | 'Schwenk Links' | 'Schwenk Rechts' | 'Vertikaler Tilt';
  characterIds: string[];
  narrationText: string;
  dialogueText: string;
  subtitleText: string;
  soundCue: string;
  imagePrompt: string;
  videoPrompt: string;
  imageUrl?: string;
  /** Temporary browser object URL for a generated scene clip; the clip itself is stored separately. */
  videoUrl?: string;
  audioDataUrl?: string;
  status: 'Entwurf' | 'Bild bereit' | 'Audio bereit' | 'Szenenbereit' | 'Bildgenerierung nicht verfügbar';
}

export interface ProjectAsset {
  id: string;
  type: 'image' | 'audio' | 'music' | 'video' | 'script';
  title: string;
  url: string;
  modelId: string;
  durationSec?: number;
  createdAt: string;
}

export interface ProjectSnapshotState {
  title: string;
  logline: string;
  genre: string;
  targetDurationSec: number;
  concept: string;
  story: string;
  screenplay: string;
  characterIds: string[];
  scenes: FilmScene[];
  assets: ProjectAsset[];
  status: StudioProject['status'];
}

export interface ProjectSnapshot {
  id: string;
  version: number;
  note: string;
  createdAt: string;
  sceneCount: number;
  totalDurationSec: number;
  state?: ProjectSnapshotState;
}

export interface StudioProject {
  id: string;
  title: string;
  logline: string;
  genre: string;
  targetDurationSec: number;
  concept: string;
  story: string;
  screenplay: string;
  characterIds: string[];
  scenes: FilmScene[];
  assets: ProjectAsset[];
  snapshots: ProjectSnapshot[];
  status: 'Konzept' | 'In Produktion' | 'Schnittbereit' | 'Exportiert';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  modelUsed?: string;
  routingSteps?: string[];
  sources?: Array<{ title: string; uri: string }>;
  timestamp: string;
}

export interface AutomationStep {
  id: string;
  title: string;
  module: string;
  modelId: string;
  status: 'wartend' | 'läuft' | 'erfolgreich' | 'bestätigung_erforderlich' | 'freigegeben' | 'fehler';
  requiresConfirmation: boolean;
  outputSummary?: string;
  durationMs?: number;
}

export interface AutomationRun {
  id: string;
  goal: string;
  status: 'geplant' | 'läuft' | 'pausiert_bestätigung' | 'abgeschlossen' | 'fehler';
  steps: AutomationStep[];
  createdAt: string;
  finishedAt?: string;
}

export interface SystemBackupMeta {
  id: string;
  filename: string;
  createdAt: string;
  note: string;
  sizeBytes: number;
}

export interface ZipBackupVersion {
  id: string;
  version: string;
  filename: string;
  createdAt: string;
  changelog: string;
  trigger: 'manual' | 'auto' | 'pre_restore';
  fileCount: number;
  sizeBytes: number;
  verified: boolean;
  protected: boolean;
  excludedSecrets: string[];
}

export interface BackupConfigState {
  currentVersion: string;
  autoZipOnChange: boolean;
  lastVerifiedAt: string | null;
  zipBackups: ZipBackupVersion[];
  changelogHistory: Array<{
    version: string;
    date: string;
    summary: string;
  }>;
}

export interface IstZustandItem {
  area: string;
  status: 'vorhanden' | 'neu_implementiert' | 'hardware_abhängig' | 'gesperrt_0eur';
  summary: string;
  details: string;
}

export interface DevelopmentPhase {
  phase: number;
  title: string;
  status: 'abgeschlossen' | 'aktiv' | 'nativ_ios_roadmap';
  deliverables: string[];
}

export type NavigationTab =
  | 'home'
  | 'brain'
  | 'models'
  | 'image'
  | 'video'
  | 'audio'
  | 'music'
  | 'director'
  | 'projects'
  | 'memory'
  | 'automation'
  | 'settings';
