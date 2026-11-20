import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import {
  ZERO_ADMIN_PRINCIPAL,
  createProjectOwnershipMiddleware,
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

// Exercise the actual Express ownership middleware: the principal comes only
// from the server's authentication layer, never from request headers or body.
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (req.headers.cookie === 'zero_session=valid-test-session') {
    res.locals.zeroPrincipal = ZERO_ADMIN_PRINCIPAL;
  }
  next();
});
const routeProjects = [
  { id: 'owned-http', ownerId: ZERO_ADMIN_PRINCIPAL_ID },
  { id: 'foreign-http', ownerId: 'admin:other' },
];
app.use('/projects/:id', createProjectOwnershipMiddleware(async () => routeProjects));
app.get('/projects/:id', (req, res) => {
  res.json({ projectId: res.locals.zeroProjectId });
});
app.post('/projects/:id', (req, res) => {
  res.json({
    principalId: getZeroPrincipal(res.locals)?.id ?? null,
    ownerId: routeProjects.find((project) => project.id === req.params.id)?.ownerId,
  });
});
const httpServer = app.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const address = httpServer.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = 'http://127.0.0.1:' + address.port;
try {
  const unauthenticated = await fetch(baseUrl + '/projects/owned-http');
  assert.equal(unauthenticated.status, 401);
  const ownedWithSpoofedHeader = await fetch(baseUrl + '/projects/owned-http', {
    headers: { cookie: 'zero_session=valid-test-session', 'x-zero-principal': 'admin:other' },
  });
  assert.equal(ownedWithSpoofedHeader.status, 200, 'client headers cannot replace the authenticated principal');
  const foreignWithSpoofedBody = await fetch(baseUrl + '/projects/foreign-http', {
    headers: { cookie: 'zero_session=valid-test-session', 'content-type': 'application/json' },
    body: JSON.stringify({ principalId: 'admin:other', ownerId: ZERO_ADMIN_PRINCIPAL_ID }),
    method: 'POST',
  });
  assert.equal(foreignWithSpoofedBody.status, 404, 'a forged body identity cannot grant access to a foreign project');
  const spoofedOwnerOnOwnedProject = await fetch(baseUrl + '/projects/owned-http', {
    headers: { cookie: 'zero_session=valid-test-session', 'content-type': 'application/json' },
    body: JSON.stringify({ principalId: 'admin:other', ownerId: 'admin:other' }),
    method: 'POST',
  });
  assert.deepEqual(await spoofedOwnerOnOwnedProject.json(), {
    principalId: ZERO_ADMIN_PRINCIPAL_ID,
    ownerId: ZERO_ADMIN_PRINCIPAL_ID,
  });
} finally {
  await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
}

console.log('ZERO Express ownership middleware spoofing tests passed.');
