import assert from 'node:assert/strict';
import { buildSrtFromTimedWords } from '../server/srt.ts';

const basic = buildSrtFromTimedWords([
  { word: 'ZERO', startOffset: '0.100s', endOffset: '0.450s' },
  { word: 'ist', startOffset: '0.500s', endOffset: '0.700s' },
  { word: 'bereit.', startOffset: '0.750s', endOffset: '1.200s' },
]);
assert.equal(basic.subtitleCueCount, 1);
assert.equal(basic.srt, '1\n00:00:00,100 --> 00:00:01,200\nZERO ist bereit.');

const maxWords = buildSrtFromTimedWords(
  Array.from({ length: 8 }, (_, index) => ({
    word: `Wort${index + 1}`,
    startOffset: `${index}s`,
    endOffset: `${index + 0.4}s`,
  })),
);
assert.equal(maxWords.subtitleCueCount, 2);
assert.match(maxWords.srt ?? '', /1\n00:00:00,000 --> 00:00:06,400\nWort1 Wort2 Wort3 Wort4 Wort5 Wort6 Wort7/);
assert.match(maxWords.srt ?? '', /2\n00:00:07,000 --> 00:00:07,400\nWort8/);

const durationSplit = buildSrtFromTimedWords([
  { word: 'Anfang', startOffset: '0s', endOffset: '0.2s' },
  { word: 'Mitte', startOffset: '2s', endOffset: '2.2s' },
  { word: 'Ende', startOffset: '3.6s', endOffset: '3.8s' },
]);
assert.equal(durationSplit.subtitleCueCount, 2);
assert.match(durationSplit.srt ?? '', /00:00:00,000 --> 00:00:02,200\nAnfang Mitte/);
assert.match(durationSplit.srt ?? '', /00:00:03,600 --> 00:00:03,800\nEnde/);

const longTimestamp = buildSrtFromTimedWords([
  { word: 'Später', startOffset: '3661.007s', endOffset: '3661.500s' },
]);
assert.equal(longTimestamp.srt, '1\n01:01:01,007 --> 01:01:01,500\nSpäter');

const invalid = buildSrtFromTimedWords([
  { word: 'ohne', startOffset: '0.1s' },
  { word: 'kaputt', startOffset: '1.2seconds', endOffset: '1.5s' },
  { word: 'rückwärts', startOffset: '2s', endOffset: '1s' },
  { word: '', startOffset: '3s', endOffset: '3.5s' },
]);
assert.deepEqual(invalid, { srt: null, subtitleCueCount: 0 });

console.log('SRT tests passed: provider timestamps, cue boundaries, long times and invalid annotations.');
