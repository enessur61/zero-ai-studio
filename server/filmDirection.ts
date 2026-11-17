import type { FilmScene } from '../src/types/zero.ts';

const CAMERA_MOVEMENTS: readonly FilmScene['cameraMovement'][] = [
  'Statisch',
  'Langsamer Zoom-In',
  'Sanfter Zoom-Out',
  'Schwenk Links',
  'Schwenk Rechts',
  'Vertikaler Tilt',
];

/**
 * Preserve the director model's camera choice when it is valid.
 * Invalid or missing values fall back to a stable scene-index rotation.
 */
export function resolveFilmCameraMovement(
  value: unknown,
  sceneIndex: number,
): FilmScene['cameraMovement'] {
  if (typeof value === 'string' && CAMERA_MOVEMENTS.includes(value as FilmScene['cameraMovement'])) {
    return value as FilmScene['cameraMovement'];
  }
  const safeIndex = Number.isSafeInteger(sceneIndex) ? sceneIndex : 0;
  const fallbackIndex = ((safeIndex % CAMERA_MOVEMENTS.length) + CAMERA_MOVEMENTS.length) % CAMERA_MOVEMENTS.length;
  return CAMERA_MOVEMENTS[fallbackIndex];
}
