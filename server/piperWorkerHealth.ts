export const PIPER_WORKER_HEALTH_EXPECTED = Object.freeze({
  engine: 'Piper ONNX CPU',
  modelId: 'de_DE-thorsten-medium',
  engineVersion: '1.8.0',
  modelRevision: 'cf910fb59f1d79ab3b625a63993a108751c6c25d',
  engineLicense: 'GPL-3.0-or-later',
  voiceDatasetLicense: 'CC0',
  voiceTrainingBase: 'rdh (nl_BE, one Flemish speaker, CC0)',
  modelSha256: 'fd270eb3d1ebf91d763f8a0f949b1b1bebdfefaea18c3aaf8577dd34536e064f',
});

export function isPiperWorkerHealthPayload(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const health = value as Record<string, unknown>;
  return health.ok === true &&
    health.auth_configured === true &&
    health.engine === PIPER_WORKER_HEALTH_EXPECTED.engine &&
    health.model_id === PIPER_WORKER_HEALTH_EXPECTED.modelId &&
    health.voice === PIPER_WORKER_HEALTH_EXPECTED.modelId &&
    health.engine_version === PIPER_WORKER_HEALTH_EXPECTED.engineVersion &&
    health.model_revision === PIPER_WORKER_HEALTH_EXPECTED.modelRevision &&
    health.engine_license === PIPER_WORKER_HEALTH_EXPECTED.engineLicense &&
    health.voice_dataset_license === PIPER_WORKER_HEALTH_EXPECTED.voiceDatasetLicense &&
    health.voice_training_base === PIPER_WORKER_HEALTH_EXPECTED.voiceTrainingBase &&
    health.model_sha256 === PIPER_WORKER_HEALTH_EXPECTED.modelSha256 &&
    health.cost_eur === 0 &&
    health.paid_fallback === false &&
    health.commercial_use_confirmed === false;
}
