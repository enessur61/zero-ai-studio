import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EPISODE_ONE, EPISODE_ONE_ID } from '../server/episodeOne.ts';

assert.equal(EPISODE_ONE_ID, 'der-fehlende-tag');
assert.equal(EPISODE_ONE.title, 'DER FEHLENDE TAG');
assert.equal(EPISODE_ONE.scenes.length, 8, 'Pilot episode must contain exactly eight planned shots.');
assert.equal(
  EPISODE_ONE.scenes.reduce((sum, scene) => sum + scene.durationSec, 0),
  60,
  'Pilot episode must total exactly 60 seconds.'
);
assert.deepEqual(
  EPISODE_ONE.scenes.map((scene) => scene.title),
  [
    'Nacht',
    'Die Nachricht',
    'Der Schock',
    'Der Anruf',
    'Elias ruft Elias an',
    'Die Videobotschaft',
    'Der Spiegel',
    'PROJECT ZERO',
  ]
);
assert.equal(EPISODE_ONE.scenes[1].subtitleText, 'Du hast mich gestern getötet.');
assert.equal(EPISODE_ONE.scenes[5].subtitleText, 'Du hast es wieder vergessen.');
assert.equal(EPISODE_ONE.scenes[6].subtitleText, 'Dreh dich nicht um.');
assert.equal(EPISODE_ONE.scenes[7].subtitleText, 'PROJECT ZERO · FORTSETZUNG FOLGT');

const server = await readFile('server.ts', 'utf8');
assert.match(server, /req\.body\?\.episodePreset === 'der-fehlende-tag'/);
assert.match(server, /parsed\.scenes\.length !== \(episodeOne \? 8 : 4\)/);
assert.match(server, /episodeOne && parsed\.scenes\.reduce/);
assert.match(server, /if \(!episodeOne\) \{/);
assert.match(server, /if \(episodeOne && mappedScenes\.reduce/);

console.log('Episode 1 production preset tests passed: eight locked shots, exact 60-second cap, established story beats.');
