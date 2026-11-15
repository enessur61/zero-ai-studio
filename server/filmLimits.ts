export const MAX_VIDEO_DURATION_SEC = 60;
export const MAX_VIDEO_SCENES = 30;

/**
 * Normalize scene durations and guarantee that the exported film timeline
 * never exceeds 60 seconds, even when a project contains too many scenes.
 */
export function clampScenesToMax60Seconds<T extends { durationSec: number }>(scenes: T[]): T[] {
  const normalized = scenes.slice(0, MAX_VIDEO_SCENES).map((scene) => ({
    ...scene,
    durationSec: Math.max(
      2,
      Math.round(Number.isFinite(scene.durationSec) ? scene.durationSec : 1)
    ),
  }));

  if (normalized.length === 0) return [];

  const total = normalized.reduce((sum, scene) => sum + scene.durationSec, 0);
  if (total <= MAX_VIDEO_DURATION_SEC) return normalized;

  const exactDurations = normalized.map(
    (scene) => (scene.durationSec * MAX_VIDEO_DURATION_SEC) / total
  );
  const durations = exactDurations.map((duration) => Math.max(1, Math.floor(duration)));
  let assigned = durations.reduce((sum, duration) => sum + duration, 0);

  // Enforce the hard cap if the 1-second minimum caused rounding overflow.
  while (assigned > MAX_VIDEO_DURATION_SEC) {
    let candidate = -1;
    for (let index = 0; index < durations.length; index += 1) {
      if (durations[index] > 2 && (candidate === -1 || durations[index] > durations[candidate])) {
        candidate = index;
      }
    }
    if (candidate === -1) break;
    durations[candidate] -= 1;
    assigned -= 1;
  }

  // Distribute remaining seconds by largest fractional remainder.
  const order = exactDurations
    .map((duration, index) => ({ index, remainder: duration - Math.floor(duration) }))
    .sort((a, b) => b.remainder - a.remainder);
  let cursor = 0;
  while (assigned < MAX_VIDEO_DURATION_SEC && order.length > 0) {
    durations[order[cursor % order.length].index] += 1;
    assigned += 1;
    cursor += 1;
  }

  return normalized.map((scene, index) => ({
    ...scene,
    durationSec: durations[index],
  }));
}
