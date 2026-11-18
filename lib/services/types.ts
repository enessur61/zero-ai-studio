import type { FilmScene, ProjectAsset, StudioProject } from '../../src/types/zero.ts';

export type WanJobStatus =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'cancelled'
  | 'succeeded'
  | 'failed';

export interface WanJob {
  id: string;
  status: WanJobStatus;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSec: number;
  engine: string;
  projectId: string | null;
  sceneId: string | null;
  error: string | null;
  cancelReason: string | null;
}

export interface CreateProjectInput {
  title: string;
  logline?: string;
  genre?: string;
  targetDurationSec?: number;
  concept?: string;
  story?: string;
  screenplay?: string;
  characterIds?: string[];
  scenes?: FilmScene[];
}

export type UpdateProjectInput = Partial<Pick<
  StudioProject,
  'title' | 'logline' | 'genre' | 'targetDurationSec' | 'concept' |
  'story' | 'screenplay' | 'characterIds' | 'scenes' | 'status'
>>;

export interface ProjectService {
  list(): Promise<StudioProject[]>;
  get(projectId: string): Promise<StudioProject>;
  create(input: CreateProjectInput): Promise<StudioProject>;
  update(projectId: string, input: UpdateProjectInput, expectedVersion?: number): Promise<StudioProject>;
}

export interface SceneService {
  list(projectId: string): Promise<FilmScene[]>;
  get(projectId: string, sceneId: string): Promise<FilmScene>;
  create(projectId: string, scene: FilmScene): Promise<FilmScene>;
  update(projectId: string, sceneId: string, patch: Partial<FilmScene>): Promise<FilmScene>;
  remove(projectId: string, sceneId: string): Promise<void>;
}

export type MediaPersistence = 'server' | 'local_only' | 'pending' | 'failed';

export interface ProjectMediaSaveResult {
  persistence: MediaPersistence;
  localSaved: boolean;
  serverPersisted: boolean;
  persistent: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
}

export interface ProjectMediaService {
  saveSceneVideo(projectId: string, sceneId: string, blob: Blob): Promise<ProjectMediaSaveResult>;
  loadSceneVideo(projectId: string, sceneId: string): Promise<Blob | null>;
}

export interface CreateWanJobInput {
  projectId: string;
  sceneId: string;
  prompt: string;
  aspectRatio: '9:16' | '16:9';
  seed?: number;
}

export interface WanJobService {
  create(input: CreateWanJobInput, signal?: AbortSignal): Promise<WanJob>;
  list(limit?: number, signal?: AbortSignal): Promise<WanJob[]>;
  get(jobId: string, signal?: AbortSignal): Promise<WanJob>;
  cancel(jobId: string, signal?: AbortSignal): Promise<WanJob>;
  download(jobId: string, signal?: AbortSignal): Promise<Blob>;
}

export type { FilmScene, ProjectAsset, StudioProject };
