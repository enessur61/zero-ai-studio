import assert from 'node:assert/strict';
import { clampScenesToMax60Seconds } from '../server/filmLimits.ts';

function totalDuration(scenes: Array<{ durationSec: number }>): number {
  return scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
}

const ordinary = clampScenesToMax60Seconds([
  { id: 'a', durationSec: 8 },
  { id: 'b', durationSec: 12 },
  { id: 'c', durationSec: 10 },
]);
assert.deepEqual(ordinary.map((scene) => scene.durationSec), [8, 12, 10]);
assert.equal(totalDuration(ordinary), 30);

const oneLongScene = clampScenesToMax60Seconds([{ id: 'long', durationSec: 95 }]);
assert.equal(totalDuration(oneLongScene), 60);

const sixteenScenes = clampScenesToMax60Seconds(
  Array.from({ length: 16 }, (_, index) => ({ id: String(index), durationSec: 4 }))
);
assert.equal(sixteenScenes.length, 16);
assert.equal(totalDuration(sixteenScenes), 60);
assert.ok(sixteenScenes.every((scene) => scene.durationSec >= 2));

const tooManyScenes = clampScenesToMax60Seconds(
  Array.from({ length: 100 }, (_, index) => ({ id: String(index), durationSec: 2 }))
);
assert.equal(tooManyScenes.length, 30);
assert.ok(totalDuration(tooManyScenes) <= 60);

const invalidDurations = clampScenesToMax60Seconds([
  { id: 'nan', durationSec: Number.NaN },
  { id: 'negative', durationSec: -10 },
]);
assert.deepEqual(invalidDurations.map((scene) => scene.durationSec), [2, 2]);
assert.ok(totalDuration(invalidDurations) <= 60);

console.log('Film timeline tests passed: all generated timelines are <= 60 seconds.');
