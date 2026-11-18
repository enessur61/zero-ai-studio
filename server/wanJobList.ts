export const WAN_JOB_STATUSES = [
  'queued',
  'running',
  'cancel_requested',
  'cancelled',
  'succeeded',
  'failed',
] as const;

export type WanJobStatus = (typeof WAN_JOB_STATUSES)[number];

export interface WanJobListItem {
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS_SET = new Set<string>(WAN_JOB_STATUSES);

function optionalString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maxLength) : null;
}

/** Validate untrusted worker data before exposing persisted jobs to the iPhone UI. */
export function normalizeWanJobList(value: unknown, limit = 50): WanJobListItem[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Array.isArray(value)) return [];
  const jobs: WanJobListItem[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const job = item as Record<string, unknown>;
    if (typeof job.id !== 'string' || !UUID_PATTERN.test(job.id) || !STATUS_SET.has(String(job.status))) continue;
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    const duration = typeof job.duration_sec === 'number' && Number.isFinite(job.duration_sec)
      ? Math.min(5, Math.max(1, Math.round(job.duration_sec)))
      : 5;
    jobs.push({
      id: job.id,
      status: job.status as WanJobStatus,
      createdAt: optionalString(job.created_at, 64),
      startedAt: optionalString(job.started_at, 64),
      finishedAt: optionalString(job.finished_at, 64),
      durationSec: duration,
      engine: optionalString(job.engine, 80) ?? 'Wan 2.1',
      projectId: optionalString(job.project_id, 128),
      sceneId: optionalString(job.scene_id, 128),
      error: optionalString(job.error, 500),
      cancelReason: optionalString(job.cancel_reason, 300),
    });
    if (jobs.length >= limit) break;
  }
  return jobs;
}


/** Attach a recovered clip only to the exact project and scene that created it. */
export function matchWanJobScene<T extends { id: string }>(
  job: Pick<WanJobListItem, 'projectId' | 'sceneId'>,
  currentProjectId: string | null | undefined,
  scenes: readonly T[],
): T | null {
  if (!currentProjectId || job.projectId !== currentProjectId || !job.sceneId) return null;
  return scenes.find((scene) => scene.id === job.sceneId) ?? null;
}


export function normalizeWanJobStatus(value: unknown, expectedId: string): WanJobListItem | null {
  const job = normalizeWanJobList([value], 1)[0];
  return job?.id === expectedId ? job : null;
}

export type WanJobListLoadResult =
  | { kind: 'ok'; jobs: WanJobListItem[] }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

/** Production-used transport boundary; distinguish an offline worker from malformed data. */
export async function loadWanJobList(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
  limit = 50,
): Promise<WanJobListLoadResult> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch {
    return { kind: 'unavailable' };
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== 'object' ||
      !Array.isArray((payload as Record<string, unknown>).jobs)) {
    return { kind: 'invalid' };
  }
  return { kind: 'ok', jobs: normalizeWanJobList((payload as { jobs: unknown[] }).jobs, limit) };
}
