export function isWanGpuAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.ZERO_WAN_GPU_ENABLED === 'true' && env.ZERO_WAN_GPU_COSTS_CONFIRMED === 'true';
}

export interface WanWorkerHealthPayload {
  ok?: unknown;
  engine?: unknown;
  model?: unknown;
  cuda_available?: unknown;
  gpu_name?: unknown;
  gpu_vram_total_mb?: unknown;
  gpu_vram_free_mb?: unknown;
  model_cache_persistent?: unknown;
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
  gpuName: string | null;
  gpuVramTotalMb: number | null;
  gpuVramFreeMb: number | null;
  modelCachePersistent: boolean;
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
  zeroCostGateOpen: boolean;
  payload?: WanWorkerHealthPayload | null;
}): WanWorkerReadiness {
  const payload = input.payload ?? {};
  const engine = [payload.engine, payload.model].some(
    (value) => typeof value === 'string' && /wan/i.test(value),
  );
  const dailyJobLimit = typeof payload.daily_job_limit === 'number' && Number.isInteger(payload.daily_job_limit)
    ? Number(payload.daily_job_limit)
    : null;
  const dailyJobsRemaining = typeof payload.daily_jobs_remaining === 'number' && Number.isInteger(payload.daily_jobs_remaining)
    ? Number(payload.daily_jobs_remaining)
    : null;
  const maxConcurrentJobs = typeof payload.max_concurrent_jobs === 'number' && Number.isInteger(payload.max_concurrent_jobs)
    ? Number(payload.max_concurrent_jobs)
    : null;
  const gpuVramTotalMb = typeof payload.gpu_vram_total_mb === 'number' && Number.isFinite(payload.gpu_vram_total_mb) ? payload.gpu_vram_total_mb : null;
  const gpuVramFreeMb = typeof payload.gpu_vram_free_mb === 'number' && Number.isFinite(payload.gpu_vram_free_mb) ? payload.gpu_vram_free_mb : null;
  const gpuVramReady = gpuVramTotalMb !== null && gpuVramTotalMb >= 12 * 1024;
  const modelCachePersistent = payload.model_cache_persistent === true;
  const dailyLimitReady = dailyJobLimit !== null
    && dailyJobLimit >= 1
    && dailyJobLimit <= 15
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
      id: 'gpu_vram',
      label: 'GPU-VRAM',
      ready: gpuVramReady,
      detail: gpuVramReady ? `${Math.round((gpuVramTotalMb ?? 0) / 1024)} GB GPU-VRAM erkannt.` : 'Mindestens 12 GB GPU-VRAM müssen bestätigt sein; 24 GB werden empfohlen.',
    },
    {
      id: 'persistent_storage',
      label: 'Persistenter Speicher',
      ready: payload.persistent_storage_configured === true,
      detail: payload.persistent_storage_configured === true ? 'Persistentes Worker-Volume bestätigt.' : 'Persistentes Worker-Volume fehlt oder ist nicht bestätigt.',
    },
    {
      id: 'model_cache',
      label: 'Persistenter Modell-Cache',
      ready: modelCachePersistent,
      detail: modelCachePersistent ? 'Hugging-Face-Modell-Cache liegt auf persistentem Speicher.' : 'Persistenter Hugging-Face-Modell-Cache fehlt.',
    },
    {
      id: 'cost_gate',
      label: 'Worker-Kostensperren',
      ready: payload.cost_gate_open === true,
      detail: payload.cost_gate_open === true ? 'Beide Worker-Freigaben sind aktiv.' : 'Mindestens eine Worker-Kostensperre ist geschlossen.',
    },
    {
      id: 'zero_cost_gate',
      label: 'ZERO-Kostensperren',
      ready: input.zeroCostGateOpen,
      detail: input.zeroCostGateOpen ? 'ZERO-Wan-Freigaben sind beide ausdrücklich aktiviert.' : 'ZERO_WAN_GPU_ENABLED und ZERO_WAN_GPU_COSTS_CONFIRMED sind nicht beide true.',
    },
    {
      id: 'daily_limit',
      label: 'Tageskontingent',
      ready: dailyLimitReady,
      detail: dailyLimitReady
        ? `${dailyJobsRemaining} von maximal ${dailyJobLimit} GPU-Aufträgen heute verfügbar.`
        : dailyJobLimit === null || dailyJobLimit < 1 || dailyJobLimit > 3
          ? 'Tageslimit fehlt, ist ungültig oder überschreitet 15 Aufträge.'
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
  else if (!gpuVramReady) status = 'WORKER_GPU_VRAM_INSUFFICIENT';
  else if (payload.persistent_storage_configured !== true) status = 'WORKER_STORAGE_NOT_PERSISTENT';
  else if (!modelCachePersistent) status = 'WORKER_MODEL_CACHE_NOT_PERSISTENT';
  else if (payload.cost_gate_open !== true) status = 'WORKER_COST_GATE_CLOSED';
  else if (!input.zeroCostGateOpen) status = 'ZERO_COST_GATE_CLOSED';
  else if (!dailyLimitReady) status = 'WORKER_DAILY_LIMIT_REACHED';

  return {
    online: readiness.every((criterion) => criterion.ready),
    status,
    message: failed
      ? `Nicht startbereit: ${failed.label} – ${failed.detail}`
      : 'Wan-Worker vollständig bereit: Verbindung, CUDA, ausreichender VRAM, persistenter Job- und Modell-Cache, Kostensperren und Tageskontingent sind bestätigt.',
    gpuAvailable: payload.cuda_available === true,
    gpuName: typeof payload.gpu_name === 'string' ? payload.gpu_name : null,
    gpuVramTotalMb,
    gpuVramFreeMb,
    modelCachePersistent,
    persistentStorageConfigured: payload.persistent_storage_configured === true,
    costGateOpen: payload.cost_gate_open === true,
    dailyJobLimit,
    dailyJobsRemaining,
    maxConcurrentJobs,
    readiness,
  };
}
