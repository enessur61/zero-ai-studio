import assert from 'node:assert/strict';
import {
  ZERO_ADMIN_PRINCIPAL,
  ZERO_ADMIN_PRINCIPAL_ID,
  getZeroPrincipal,
  migrateProjectOwnership,
  resolveOwnedProject,
} from '../server/projectIdentity.ts';

const legacyProjects: Array<{ id: string; ownerId?: unknown; title: string }> = [
  { id: 'project-legacy', title: 'Legacy project' },
  { id: 'project-owned', ownerId: ZERO_ADMIN_PRINCIPAL_ID, title: 'Owned project' },
];
assert.equal(migrateProjectOwnership(legacyProjects), true);
assert.equal(legacyProjects[0].ownerId, ZERO_ADMIN_PRINCIPAL_ID);
assert.equal(migrateProjectOwnership(legacyProjects), false, 'ownership migration must be idempotent');
assert.equal(legacyProjects[1].title, 'Owned project', 'migration must preserve project data');

assert.equal(resolveOwnedProject(legacyProjects, ZERO_ADMIN_PRINCIPAL, 'project-legacy'), legacyProjects[0]);
assert.equal(resolveOwnedProject(legacyProjects, ZERO_ADMIN_PRINCIPAL, 'missing'), null);
assert.equal(resolveOwnedProject([{ id: 'foreign', ownerId: 'admin:other' }], ZERO_ADMIN_PRINCIPAL, 'foreign'), null,
  'a project with another owner must not resolve');
assert.equal(resolveOwnedProject(legacyProjects, ZERO_ADMIN_PRINCIPAL, ''), null);
assert.equal(resolveOwnedProject(legacyProjects, ZERO_ADMIN_PRINCIPAL, ['project-legacy']), null);

assert.throws(
  () => migrateProjectOwnership([{ id: 'foreign', ownerId: 'admin:other' }]),
  /Ungültige Projekt-Eigentümerschaft/,
  'an explicit foreign owner must fail closed instead of being reassigned',
);
assert.throws(() => migrateProjectOwnership([{ id: 'empty-owner', ownerId: '' }]), /Ungültige Projekt-Eigentümerschaft/);
assert.equal(getZeroPrincipal({ zeroPrincipal: ZERO_ADMIN_PRINCIPAL }), ZERO_ADMIN_PRINCIPAL);
assert.equal(getZeroPrincipal({ zeroPrincipal: { id: 'admin:other', role: 'admin' } }), null);
assert.equal(getZeroPrincipal({ body: { principalId: ZERO_ADMIN_PRINCIPAL_ID, ownerId: ZERO_ADMIN_PRINCIPAL_ID } }), null,
  'client-controlled body identity must never establish a principal');
assert.equal(getZeroPrincipal({ headers: { 'x-zero-principal': ZERO_ADMIN_PRINCIPAL_ID } }), null,
  'client-controlled headers must never establish a principal');
assert.equal(getZeroPrincipal(undefined), null);

console.log('ZERO server-side principal, project ownership, spoofing and migration tests passed.');
