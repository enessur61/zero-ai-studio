import assert from 'node:assert/strict';
import { resolveFilmCameraMovement } from '../server/filmDirection.ts';

assert.equal(resolveFilmCameraMovement('Schwenk Rechts', 0), 'Schwenk Rechts');
assert.equal(resolveFilmCameraMovement('Vertikaler Tilt', 2), 'Vertikaler Tilt');
assert.equal(resolveFilmCameraMovement('Statisch', 5), 'Statisch');

assert.equal(resolveFilmCameraMovement(undefined, 0), 'Statisch');
assert.equal(resolveFilmCameraMovement(null, 1), 'Langsamer Zoom-In');
assert.equal(resolveFilmCameraMovement('nicht erlaubt', 2), 'Sanfter Zoom-Out');
assert.equal(resolveFilmCameraMovement('Schwenk Links', -1), 'Vertikaler Tilt');
assert.equal(resolveFilmCameraMovement('Schwenk Links', Number.NaN), 'Statisch');

console.log('Film direction tests passed: valid AI camera movements are preserved and invalid values safely fall back.');
