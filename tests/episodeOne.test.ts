import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EPISODE_ONE, EPISODE_ONE_ID } from '../server/episodeOne.ts';

assert.equal(EPISODE_ONE_ID, 'die-nachricht');
assert.equal(EPISODE_ONE.title, 'DIE NACHRICHT');
assert.equal(EPISODE_ONE.scenes.length, 8, 'Pilot episode must contain exactly eight planned shots.');
assert.equal(
  EPISODE_ONE.scenes.reduce((sum, scene) => sum + scene.durationSec, 0),
  60,
  'Pilot episode must never exceed the 60-second production limit.'
);
assert.deepEqual(
  EPISODE_ONE.scenes.map((scene) => scene.durationSec),
  [5, 8, 7, 7, 8, 8, 12, 5]
);
assert.deepEqual(
  EPISODE_ONE.scenes.map((scene) => scene.title),
  [
    'Elias wacht auf',
    '02:13 – Die Nachricht',
    'Der Schock',
    'Der eigene Anruf',
    'Die eigene Stimme',
    '02:14 – Die zweite Nachricht',
    'Der Spiegel',
    'PROJECT ZERO',
  ]
);
assert.equal(EPISODE_ONE.scenes[1].timeOfDay, '02:13 Uhr');
assert.equal(EPISODE_ONE.scenes[1].subtitleText, '02:13 · EIGENE NUMMER · Du hast mich gestern getötet.');
assert.equal(EPISODE_ONE.scenes[3].soundCue.includes('eigene Nummer'), true);
assert.equal(EPISODE_ONE.scenes[4].subtitleText, 'Ich weiß, dass du mich hören kannst.');
assert.equal(EPISODE_ONE.scenes[5].timeOfDay, '02:14 Uhr');
assert.equal(EPISODE_ONE.scenes[5].subtitleText, '02:14 · Dreh dich nicht um.');
assert.equal(EPISODE_ONE.scenes[6].subtitleText, '');
assert.equal(EPISODE_ONE.scenes[7].subtitleText, 'PROJECT ZERO · NICHTS IST ZUFÄLLIG.');
assert.match(EPISODE_ONE.scenes[0].imagePrompt, /black hoodie/i);
assert.match(EPISODE_ONE.scenes[6].imagePrompt, /black hoodie/i);
assert.ok(!JSON.stringify(EPISODE_ONE).includes('DER FEHLENDE TAG'));
assert.ok(!JSON.stringify(EPISODE_ONE).includes('Du hast es wieder vergessen.'));
assert.ok(!JSON.stringify(EPISODE_ONE).includes('Videobotschaft'));

const server = await readFile('server.ts', 'utf8');
assert.match(server, /req\.body\?\.episodePreset === 'die-nachricht'/);
assert.match(server, /const generateImages = episodeOne \? false : Boolean\(req\.body\?\.generateImages\)/);
assert.match(server, /parsed\.scenes\.length !== \(episodeOne \? 8 : 4\)/);
assert.match(server, /episodeOne && parsed\.scenes\.reduce/);
assert.match(server, /if \(!episodeOne\) \{/);
assert.match(server, /if \(episodeOne && mappedScenes\.reduce/);

const director = await readFile('components/FilmDirectorView.tsx', 'utf8');
assert.match(director, /episodePreset: 'die-nachricht'/);
assert.match(director, /DIE NACHRICHT/);
assert.match(director, /Episode 1 – Szenenplan anlegen \(0 € Anbietergebühr\)/);
assert.match(director, /Cloudflare-Free-Gate erforderlich/);
assert.match(director, /Voiceover erzeugen \(ohne externe TTS-Gebühr\)/);
assert.doesNotMatch(director, /Kurzfilm automatisch produzieren \(0 €\)/);
assert.match(server, /if \(!episodeOne && !idea\)/);
assert.match(director, /if \(\(!episodeOnePreset && !idea\.trim\(\)\) \|\| directing\) return;/);
assert.match(director, /disabled=\{directing \|\| \(!episodeOnePreset && !idea\.trim\(\)\)\}/);
assert.equal((director.match(/disabled=\{episodeOnePreset\}/g) ?? []).length, 5);
assert.match(director, /Das feste Preset verwendet ausschließlich das freigegebene Drehbuch/);
assert.match(director, /sc\.timeOfDay/);

console.log('Episode 1 tests passed: original DIE NACHRICHT beats, 02:13/02:14 overlays, Elias black hoodie, eight shots and hard 60-second cap.');
