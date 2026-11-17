import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { PersistentStateConflictError } from '../server/persistence.ts';
import { createApiAuthMiddleware } from '../server/apiAuth.ts';
import { createContinuityRouter } from '../src/routes/continuity.ts';
import { emptyContinuityState } from '../src/types/continuity.ts';
import type { ZeroDatabase } from '../server/store.ts';

let db = {
  characters: [{ id: 'character-a' }, { id: 'character-b' }],
  projects: [{ id: 'project-a', title: 'Testprojekt', scenes: [{ id: 'scene-a', index: 0, title: 'Original scene', durationSec: 12, narrationText: 'Alter Erzähltext', dialogueText: 'Alter Dialog', subtitleText: 'Alter Untertitel' }] }],
  continuity: emptyContinuityState(),
} as unknown as ZeroDatabase;

let forceConflict = false;
const store = {
  async loadDb() { return structuredClone(db); },
  async saveDb(next: ZeroDatabase) {
    if (forceConflict) {
      forceConflict = false;
      throw new PersistentStateConflictError(4, 5);
    }
    db = next;
  },
};

const app = express();
app.use(express.json());
app.use('/api', createApiAuthMiddleware({
  isProduction: true,
  adminPassword: 'test-admin-password-long',
  sessionSecret: 'test-session-secret-long-enough-for-production-check',
  hasValidSession: async (request) => request.headers.cookie === 'zero_session=valid-test-session',
}));
app.use('/api/continuity', createContinuityRouter(store));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof PersistentStateConflictError) {
    response.status(409).json({
      error: 'Der Datenstand wurde parallel geändert. Bitte neu laden und erneut versuchen.',
      code: 'PERSISTENCE_REVISION_CONFLICT',
      expectedRevision: error.expectedRevision,
      actualRevision: error.actualRevision,
    });
    return;
  }
  response.status(500).json({ error: 'Interner Serverfehler.' });
});

const server = createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${address.port}/api/continuity`;
const headers = { 'content-type': 'application/json', cookie: 'zero_session=valid-test-session' };
async function request(path: string, method = 'GET', body?: unknown, authenticated = true) {
  return fetch(baseUrl + path, {
    method,
    headers: authenticated ? headers : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(response: Response) { return response.json() as Promise<Record<string, any>>; }

try {
  const unauthorized = await request('/series', 'GET', undefined, false);
  assert.equal(unauthorized.status, 401, 'the shared production API auth gate must reject unauthenticated requests');

  const created = await request('/series', 'POST', {
    title: 'Testserie', logline: 'Mystery', genre: 'Thriller', bible: 'Serienbibel',
    projectIds: ['project-a'],
  });
  assert.equal(created.status, 201);
  const series = (await json(created)).series;
  assert.equal(series.title, 'Testserie');
  const seriesId = series.id as string;

  const updated = await request(`/series/${seriesId}`, 'PUT', { title: 'Testserie 2', projectIds: ['project-a'] });
  assert.equal(updated.status, 200);
  assert.equal((await json(updated)).series.title, 'Testserie 2');

  const analysis = {
    id: 'analysis-test-1', seriesId, version: 1, createdAt: new Date().toISOString(), modelId: 'local-test-model',
    costMode: 'local' as const, sourceFingerprint: 'test-fingerprint',
    analysis: { overallAssessment: 'Testanalyse', characterAnalyses: [], storyRecommendations: [], findings: [
      { id: 'finding-test-1', category: 'motivation', severity: 'warning', characterIds: ['character-a'], episodeTitle: 'Episode 1', sceneTitle: 'Original scene', evidence: 'Alter Erzähltext', interpretation: 'Motivation unklar', recommendation: 'Dialog präzisieren', confidence: 'high' },
    ] },
  };
  db.continuity!.series.push({ id: seriesId, title: 'Testserie', logline: '', genre: '', bible: '', projectIds: ['project-a'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  db.continuity!.dramaturgyAnalyses.push(analysis);

  const applyPath = `/series/${seriesId}/dramaturgy-analyses/1/apply`;
  const applyBody = (decisionId: string) => ({ decisionId, findingId: 'finding-test-1', projectId: 'project-a', sceneId: 'scene-a', field: 'dialogueText', expectedPreviousText: 'Alter Dialog', replacementText: 'Neuer, manuell geprüfter Dialog' });
  const noApproval = await request(applyPath, 'POST', applyBody('missing-approval'));
  assert.equal(noApproval.status, 403, 'application without manual approval must be blocked');

  const rejectedResponse = await request(`/series/${seriesId}/dramaturgy-analyses/1/decisions`, 'POST', { findingId: 'finding-test-1', approved: false, note: 'Abgelehnt' });
  assert.equal(rejectedResponse.status, 201);
  const rejectedDecision = (await json(rejectedResponse)).decision;
  const rejectedApply = await request(applyPath, 'POST', applyBody(rejectedDecision.id));
  assert.equal(rejectedApply.status, 403, 'a rejected correction must never be applied');

  const firstApprovalResponse = await request(`/series/${seriesId}/dramaturgy-analyses/1/decisions`, 'POST', { findingId: 'finding-test-1', approved: true, note: 'Freigegeben' });
  const firstApproval = (await json(firstApprovalResponse)).decision;
  const laterRejectionResponse = await request(`/series/${seriesId}/dramaturgy-analyses/1/decisions`, 'POST', { findingId: 'finding-test-1', approved: false, note: 'Freigabe widerrufen' });
  assert.equal(laterRejectionResponse.status, 201);
  const staleApply = await request(applyPath, 'POST', applyBody(firstApproval.id));
  assert.equal(staleApply.status, 403, 'a superseded approval must not authorize application');

  const finalApprovalResponse = await request(`/series/${seriesId}/dramaturgy-analyses/1/decisions`, 'POST', { findingId: 'finding-test-1', approved: true, note: 'Erneut ausdrücklich freigegeben' });
  const finalApproval = (await json(finalApprovalResponse)).decision;
  const successfulApply = await request(applyPath, 'POST', applyBody(finalApproval.id));
  assert.equal(successfulApply.status, 200);
  const applied = await json(successfulApply);
  assert.equal(applied.applied, true);
  assert.equal(applied.sceneVersion.snapshot.dialogueText, 'Alter Dialog', 'snapshot must preserve the pre-change scene');
  assert.equal(db.projects[0].scenes[0].dialogueText, 'Neuer, manuell geprüfter Dialog');
  assert.equal(db.continuity!.sceneVersions[0]?.snapshot && (db.continuity!.sceneVersions[0]!.snapshot as any).dialogueText, 'Alter Dialog');
  assert.equal(db.continuity!.dramaturgyApplications.length, 1, 'successful application must append an audit record');
  const replay = await request(applyPath, 'POST', applyBody(finalApproval.id));
  assert.equal(replay.status, 409, 'a decision may only be applied once');

  const eventResponse = await request(`/series/${seriesId}/events`, 'POST', {
    title: 'Die Nachricht', occurredAt: '2026-11-17T10:00:00.000Z', characterIds: ['character-a'],
  });
  assert.equal(eventResponse.status, 201);
  const event = (await json(eventResponse)).event;

  const knowledgeResponse = await request(`/series/${seriesId}/knowledge`, 'POST', {
    characterId: 'character-a', fact: 'Die Nachricht wurde empfangen.',
    sourceEventId: event.id, learnedAt: '2026-11-17T10:01:00.000Z',
  });
  assert.equal(knowledgeResponse.status, 201);
  const knowledge = (await json(knowledgeResponse)).knowledge;
  assert.equal(knowledge.sourceEventId, event.id);

  const knowledgeUpdate = await request(`/knowledge/${knowledge.id}`, 'PUT', { fact: 'Die Nachricht wurde verstanden.' });
  assert.equal(knowledgeUpdate.status, 200);

  const relationshipResponse = await request(`/series/${seriesId}/relationships`, 'POST', {
    fromCharacterId: 'character-a', toCharacterId: 'character-b', type: 'Misstrauen',
  });
  assert.equal(relationshipResponse.status, 201);
  const relationship = (await json(relationshipResponse)).relationship;
  assert.equal((await request(`/relationships/${relationship.id}`, 'PUT', { description: 'Wächst' })).status, 200);

  const locationResponse = await request(`/series/${seriesId}/locations`, 'POST', {
    name: 'Fremdes Zimmer', description: 'Fensterlos', attributes: { lighting: 'cold' },
  });
  assert.equal(locationResponse.status, 201);
  const location = (await json(locationResponse)).location;
  assert.equal((await request(`/locations/${location.id}`, 'PUT', { name: 'Hotelzimmer' })).status, 200);

  const eventUpdate = await request(`/events/${event.id}`, 'PUT', { title: 'Die unbekannte Nachricht' });
  assert.equal(eventUpdate.status, 200);

  const sceneVersionResponse = await request(`/series/${seriesId}/scene-versions`, 'POST', {
    projectId: 'project-a', sceneId: 'scene-a', note: 'Erste Fassung',
  });
  assert.equal(sceneVersionResponse.status, 201);
  const firstVersion = (await json(sceneVersionResponse)).sceneVersion;
  assert.equal(firstVersion.version, 1);
  const secondVersionResponse = await request(`/series/${seriesId}/scene-versions`, 'POST', {
    projectId: 'project-a', sceneId: 'scene-a', note: 'Zweite Fassung',
  });
  assert.equal((await json(secondVersionResponse)).sceneVersion.version, 2);

  const typedEvent = await request(`/series/${seriesId}/events`, 'POST', { title: 'Wahre Identität', occurredAt: '2026-11-17T12:00:00.000Z', kind: 'identity_reveal', subjectCharacterId: 'character-a', canonicalValue: 'Mara Winter' });
  assert.equal(typedEvent.status, 201);
  const invalidReveal = await request(`/series/${seriesId}/events`, 'POST', { title: 'Ungültige Enthüllung', occurredAt: '2026-11-17T12:00:00.000Z', kind: 'secret_reveal', subjectCharacterId: 'character-a' });
  assert.equal(invalidReveal.status, 400, 'reveal events must include a canonical value');
  const typedKnowledge = await request(`/series/${seriesId}/knowledge`, 'POST', { characterId: 'character-b', fact: 'Kennt die Tarnidentität', factType: 'identity', subjectCharacterId: 'character-a', canonicalValue: 'Mara Winter', learnedAt: '2026-11-17T12:01:00.000Z' });
  assert.equal(typedKnowledge.status, 201);

  const seriesDetail = await json(await request(`/series/${seriesId}`));
  assert.equal(seriesDetail.knowledge.length, 2);
  assert.equal(seriesDetail.relationships.length, 1);
  assert.equal(seriesDetail.locations.length, 1);
  assert.equal(seriesDetail.events.length, 2);
  assert.ok(Array.isArray(seriesDetail.semanticConflicts));
  assert.equal(seriesDetail.sceneVersions.length, 3, 'the manual correction must append a third scene snapshot');

  forceConflict = true;
  const conflict = await request(`/series/${seriesId}/locations`, 'POST', { name: 'Must not save' });
  assert.equal(conflict.status, 409, 'revision conflicts must surface as HTTP 409');
  const conflictBody = await json(conflict);
  assert.equal(conflictBody.code, 'PERSISTENCE_REVISION_CONFLICT');
  assert.equal(conflictBody.expectedRevision, 4);
  assert.equal(conflictBody.actualRevision, 5);

  const archived = await request(`/series/${seriesId}`, 'DELETE');
  assert.equal(archived.status, 200);
  assert.equal((await json(archived)).archived, true);
  assert.equal(db.continuity?.series.length, 1, 'series record must be retained');
  assert.equal(db.continuity?.knowledge.length, 2, 'knowledge must not be cascade-deleted');
  assert.equal(db.continuity?.locations.length, 1, 'failed revision writes must not leak into persisted state');
  assert.equal(db.continuity?.sceneVersions.length, 3, 'all original and correction snapshots must be retained');

  console.log('Continuity HTTP route, shared auth gate, revision-conflict and non-destructive archive tests passed.');
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
