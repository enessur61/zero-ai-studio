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
  async create(input: CreateWanJobInput, signal?: AbortSignal) {
    if (!input.projectId.trim() || !input.sceneId.trim()) {
      throw new Error('Wan-Aufträge benötigen eine gültige Projekt- und Szenenzuordnung.');
    }
    const response = await apiRequest<{ job: unknown; costFallback?: unknown; maxFinalDurationSec?: unknown }>('/api/video/engine/jobs', {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    });
    if (response.costFallback !== false) throw new Error('Wan-Auftrag wurde nicht ausdrücklich kostenfallbackfrei bestätigt.');
    if (response.maxFinalDurationSec !== 60) throw new Error('Wan hat das harte 60-Sekunden-Exportlimit nicht bestätigt.');
    if (!response.job || typeof response.job !== 'object' || Array.isArray(response.job)) {
      throw new Error('Wan hat keine gültigen Auftragsdaten zurückgegeben.');
    }
    const rawJob = response.job as Record<string, unknown>;
    const rawDuration = rawJob.durationSec ?? rawJob.duration_sec;
    if (rawDuration !== 5) throw new Error('Wan hat keine exakt fünf Sekunden lange Szene bestätigt.');
    const job = normalizeJob(response.job, {
      projectId: input.projectId,
      sceneId: input.sceneId,
      durationSec: 5,
      engine: 'Wan 2.1',
    });
    if (job.status !== 'queued') throw new Error('Wan hat keinen gültigen 5-Sekunden-Auftrag bestätigt.');
    return job;
  },

  async list(limit = 50, signal?: AbortSignal) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Wan-Auftragslimit muss zwischen 1 und 50 liegen.');
    const response = await apiRequest<{ jobs: unknown[] }>(`/api/video/engine/jobs?limit=${limit}`, { signal });
    if (!Array.isArray(response.jobs)) throw new Error('ZERO hat keine gültige Wan-Auftragsliste geliefert.');
    return response.jobs.map((item) => normalizeJob(item));
  },

  async get(jobId, signal?: AbortSignal) {
    if (!jobId.trim()) throw new Error('Wan-Job-ID fehlt.');
    const response = await apiRequest<{ job: unknown; costFallback?: unknown }>(
      `/api/video/engine/jobs/${encodeURIComponent(jobId)}`, { signal },
    );
    if (response.costFallback !== false) throw new Error('Wan-Status wurde nicht ausdrücklich kostenfallbackfrei bestätigt.');
    return normalizeJob(response.job);
  },

  async cancel(jobId, signal?: AbortSignal) {
    if (!jobId.trim()) throw new Error('Wan-Job-ID fehlt.');
    const response = await apiRequest<{ job: unknown }>(
      `/api/video/engine/jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: 'POST', signal },
    );
    return normalizeJob(response.job);
  },

  async download(jobId, signal?: AbortSignal) {
    if (!jobId.trim()) throw new Error('Wan-Job-ID fehlt.');
    const response = await fetch(`/api/video/engine/jobs/${encodeURIComponent(jobId)}/video`, {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw new Error(`Wan-Video konnte nicht geladen werden (HTTP ${response.status}).`);
    const blob = await response.blob();
    if (!blob.type.toLowerCase().includes('video') || blob.size < 1024 || blob.size > 100 * 1024 * 1024) {
      throw new Error('Der Wan-Worker lieferte eine ungültige oder zu große Videodatei.');
    }
    return blob;
  },
};
