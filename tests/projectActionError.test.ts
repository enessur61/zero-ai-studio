import assert from 'node:assert/strict';
import { getProjectActionError } from '../lib/projectActionError.ts';

assert.equal(getProjectActionError(new Error('Project write conflict'), 'Projektaktion fehlgeschlagen'), 'Project write conflict');
assert.equal(getProjectActionError(new Error('  '), 'Projekt konnte nicht gespeichert werden.'), 'Projekt konnte nicht gespeichert werden.');
assert.equal(getProjectActionError(undefined, 'Charakter konnte nicht angelegt werden.'), 'Charakter konnte nicht angelegt werden.');

console.log('Project action error tests passed.');
