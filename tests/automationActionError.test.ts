import assert from 'node:assert/strict';
import { getAutomationActionError } from '../lib/automationActionError.ts';

assert.equal(getAutomationActionError(new Error('Freigabe ist nicht mehr gültig'), 'Freigabe fehlgeschlagen'), 'Freigabe ist nicht mehr gültig');
assert.equal(getAutomationActionError(new Error(' '), 'Freigabe fehlgeschlagen'), 'Freigabe fehlgeschlagen');
assert.equal(getAutomationActionError(null, 'Freigabe fehlgeschlagen'), 'Freigabe fehlgeschlagen');

console.log('Automation action error tests passed.');
