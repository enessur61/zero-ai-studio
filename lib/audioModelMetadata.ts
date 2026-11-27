export function resolveAudioModelId(modelUsed: unknown, fallbackModelId: string): string {
  return typeof modelUsed === 'string' && modelUsed.trim()
    ? modelUsed.trim()
    : fallbackModelId;
}
