export function isPiperWorkerAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.ZERO_PIPER_WORKER_ENABLED === 'true' &&
    env.ZERO_PIPER_WORKER_COSTS_CONFIRMED === 'true';
}
