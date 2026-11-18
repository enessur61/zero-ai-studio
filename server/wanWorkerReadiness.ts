export interface WanWorkerHealthPayload {
  ok?: unknown;
  engine?: unknown;
  model?: unknown;
  cuda_available?: unknown;
  persistent_storage_configured?: unknown;
  cost_gate_open?: unknown;
  daily_job_limit?: unknown;
  daily_jobs_remaining?: unknown;
  max_concurrent_jobs?: unknown;
}

export interface WanReadinessCriterion {
  id: string;
  label: string;
  ready: boolean;
  detail: string;
}

export interface WanWorkerReadiness {
  online: boolean;
  status: string;
  message: string;
  gpuAvailable: boolean;
  persistentStorageConfigured: boolean;
  costGateOpen: boolean;
  dailyJobLimit: number | null;
  dailyJobsRemaining: number | null;
  maxConcurrentJobs: number | null;
  readiness: WanReadinessCriterion[];
}

export function evaluateWanWorkerReadiness(input: {
  workerUrlConfigured: boolean;
  workerTokenConfigured: boolean;
  workerReachable: boolean;
  payload?: WanWorkerHealthPayload | null;
}): WanWorkerReadiness {
  const payload = input.payload ?? {};
  const engine = [payload.engine, payload.model].some(
    (value) => typeof value === 'string' && /wan/i.test(value),
  );
  const dailyJobLimit = Number.isInteger(payload.daily_job_limit)
    ? Number(payload.daily_job_limit)
    : null;
  const dailyJobsRemaining = Number.isInteger(payload.daily_jobs_remaining)
    ? Number(payload.daily_jobs_remaining)
    : null;
  const maxConcurrentJobs = Number.isInteger(payload.max_concurrent_jobs)
    ? Number(payload.max_concurrent_jobs)
    : null;
  const dailyLimitReady = dailyJobLimit !== null
    && dailyJobLimit >= 1
    && dailyJobLimit <= 3
    && dailyJobsRemaining !== null
    && dailyJobsRemaining >= 1
    && dailyJobsRemaining <= dailyJobLimit;

  const readiness: WanReadinessCriterion[] = [
    {
      id: 'worker_url',
      label: 'Worker-Adresse',
      ready: input.workerUrlConfigured,
      detail: input.workerUrlConfigured ? 'Worker-Adresse ist konfiguriert.' : 'ZERO_VIDEO_ENGINE_URL fehlt.',
    },
    {
      id: 'worker_token',
      label: 'Worker-Authentifizierung',
      ready: input.workerTokenConfigured,
      detail: input.workerTokenConfigured ? 'Serverseitiges Worker-Token ist vorhanden.' : 'ZERO_VIDEO_ENGINE_TOKEN fehlt.',
    },
    {
      id: 'worker_reachable',
      label: 'Worker-Verbindung',
      ready: input.workerReachable && payload.ok === true,
      detail: input.workerReachable && payload.ok === true ? 'Authentifizierter Health-Check erfolgreich.' : 'Worker-Health-Check nicht erfolgreich.',
    },
    {
      id: 'engine',
      label: 'Wan-Engine',
      ready: engine,
      detail: engine ? 'Wan-Engine erkannt.' : 'Health-Antwort nennt keine Wan-Engine.',
    },
    {
      id: 'cuda',
      label: 'NVIDIA CUDA-GPU',
      ready: payload.cuda_available === true,
      detail: payload.cuda_available === true ? 'CUDA-GPU verfügbar.' : 'Keine verfügbare CUDA-GPU bestätigt.',
    },
    {
      id: 'persistent_storage',
      label: 'Persistenter Speicher',
      ready: payload.persistent_storage_configured === true,
      detail: payload.persistent_storage_configured === true ? 'Persistentes Worker-Volume bestätigt.' : 'Persistentes Worker-Volume fehlt oder ist nicht bestätigt.',
    },
    {
      id: 'cost_gate',
      label: 'Worker-Kostensperren',
      ready: payload.cost_gate_open === true,
      detail: payload.cost_gate_open === true ? 'Beide Worker-Freigaben sind aktiv.' : 'Mindestens eine Worker-Kostensperre ist geschlossen.',
    },
    {
      id: 'daily_limit',
      label: 'Tageskontingent',
      ready: dailyLimitReady,
      detail: dailyLimitReady
        ? `${dailyJobsRemaining} von maximal ${dailyJobLimit} GPU-Aufträgen heute verfügbar.`
        : dailyJobLimit === null || dailyJobLimit < 1 || dailyJobLimit > 3
          ? 'Tageslimit fehlt, ist ungültig oder überschreitet drei Aufträge.'
          : 'Das Tageslimit ist ausgeschöpft oder die Restmenge fehlt.',
    },
  ];

  const failed = readiness.find((criterion) => !criterion.ready);
  let status = 'WORKER_ONLINE';
  if (!input.workerUrlConfigured) status = 'GPU_WORKER_NOT_CONFIGURED';
  else if (!input.workerTokenConfigured) status = 'WORKER_TOKEN_MISSING';
  else if (!input.workerReachable || payload.ok !== true) status = 'WORKER_OFFLINE';
  else if (!engine) status = 'WORKER_PROTOCOL_MISMATCH';
  else if (payload.cuda_available !== true) status = 'WORKER_GPU_UNAVAILABLE';
  else if (payload.persistent_storage_configured !== true) status = 'WORKER_STORAGE_NOT_PERSISTENT';
  else if (payload.cost_gate_open !== true) status = 'WORKER_COST_GATE_CLOSED';
  else if (!dailyLimitReady) status = 'WORKER_DAILY_LIMIT_REACHED';

  return {
    online: readiness.every((criterion) => criterion.ready),
    status,
    message: failed
      ? `Nicht startbereit: ${failed.label} – ${failed.detail}`
      : 'Wan-Worker vollständig bereit: Verbindung, CUDA, persistenter Speicher, Kostensperren und Tageskontingent sind bestätigt.',
    gpuAvailable: payload.cuda_available === true,
    persistentStorageConfigured: payload.persistent_storage_configured === true,
    costGateOpen: payload.cost_gate_open === true,
    dailyJobLimit,
    dailyJobsRemaining,
    maxConcurrentJobs,
    readiness,
  };
}
