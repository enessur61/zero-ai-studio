import { apiRequest } from '../api.ts';
import type { CreateWanJobInput, WanJob, WanJobService, WanJobStatus } from './types.ts';

const TERMINAL_STATUSES = new Set<WanJobStatus>(['cancelled', 'succeeded', 'failed']);

function normalizeJob(value: unknown, fallback?: Partial<WanJob>): WanJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ZERO hat einen ungültigen Wan-Auftrag zurückgegeben.');
  }
  const item = value as Record<string, unknown>;
  const statuses: WanJobStatus[] = ['queued', 'running', 'cancel_requested', 'cancelled', 'succeeded', 'failed'];
  if (typeof item.id !== 'string' || !statuses.includes(item.status as WanJobStatus)) {
    throw new Error('ZERO hat einen ungültigen Wan-Auftragsstatus zurückgegeben.');
  }
  const stringOrNull = (candidate: unknown, fallbackValue: string | null = null) =>
    typeof candidate === 'string' ? candidate : fallbackValue;
  return {
    id: item.id,
    status: item.status as WanJobStatus,
    createdAt: stringOrNull(item.createdAt ?? item.created_at, fallback?.createdAt ?? null),
    startedAt: stringOrNull(item.startedAt ?? item.started_at, fallback?.startedAt ?? null),
    finishedAt: stringOrNull(item.finishedAt ?? item.finished_at, fallback?.finishedAt ?? null),
    durationSec: typeof item.durationSec === 'number' ? item.durationSec
      : typeof item.duration_sec === 'number' ? item.duration_sec : fallback?.durationSec ?? 5,
    engine: stringOrNull(item.engine, fallback?.engine ?? 'Wan 2.1') ?? 'Wan 2.1',
    projectId: stringOrNull(item.projectId ?? item.project_id, fallback?.projectId ?? null),
    sceneId: stringOrNull(item.sceneId ?? item.scene_id, fallback?.sceneId ?? null),
    error: stringOrNull(item.error, fallback?.error ?? null),
    cancelReason: stringOrNull(item.cancelReason ?? item.cancel_reason, fallback?.cancelReason ?? null),
  };
}

export const wanJobService: WanJobService = {
  async create(input: CreateWanJobInput) {
    if (!input.projectId.trim() || !input.sceneId.trim()) {
      throw new Error('Wan-Aufträge benötigen eine gültige Projekt- und Szenenzuordnung.');
    }
    const response = await apiRequest<{ job: unknown }>('/api/video/engine/jobs', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return normalizeJob(response.job, {
      projectId: input.projectId,
      sceneId: input.sceneId,
      durationSec: 5,
      engine: 'Wan 2.1',
    });
  },

  async list(limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Wan-Auftragslimit muss zwischen 1 und 50 liegen.');
    const response = await apiRequest<{ jobs: unknown[] }>(`/api/video/engine/jobs?limit=${limit}`);
    if (!Array.isArray(response.jobs)) throw new Error('ZERO hat keine gültige Wan-Auftragsliste geliefert.');
    return response.jobs.map((item) => normalizeJob(item));
  },

  async get(jobId) {
    if (!jobId.trim()) throw new Error('Wan-Job-ID fehlt.');
    const response = await apiRequest<{ job: unknown }>(`/api/video/engine/jobs/${encodeURIComponent(jobId)}`);
    return normalizeJob(response.job);
  },

  async cancel(jobId) {
    if (!jobId.trim()) throw new Error('Wan-Job-ID fehlt.');
    const response = await apiRequest<{ job: unknown }>(
      `/api/video/engine/jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: 'POST' },
    );
    return normalizeJob(response.job);
  },

  async download(jobId) {
    if (!jobId.trim()) throw new Error('Wan-Job-ID fehlt.');
    const response = await fetch(`/api/video/engine/jobs/${encodeURIComponent(jobId)}/video`, {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Wan-Video konnte nicht geladen werden (HTTP ${response.status}).`);
    const blob = await response.blob();
    if (!blob.type.toLowerCase().includes('video') || blob.size < 1024 || blob.size > 100 * 1024 * 1024) {
      throw new Error('Der Wan-Worker lieferte eine ungültige oder zu große Videodatei.');
    }
    return blob;
  },
};
