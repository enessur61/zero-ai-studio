import assert from 'node:assert/strict';
import { getMemoryActionError } from '../lib/memoryActionError.ts';

assert.equal(
  getMemoryActionError(new Error('Memory service unavailable'), 'Aktion fehlgeschlagen'),
  'Memory service unavailable',
);
assert.equal(
  getMemoryActionError(new Error('   '), 'Suche fehlgeschlagen'),
  'Suche fehlgeschlagen',
);
assert.equal(
  getMemoryActionError({ message: 'untrusted object' }, 'Speichern fehlgeschlagen'),
  'Speichern fehlgeschlagen',
);
assert.equal(
  getMemoryActionError(null, 'Löschen fehlgeschlagen'),
  'Löschen fehlgeschlagen',
);

console.log('Memory action error tests passed.');
