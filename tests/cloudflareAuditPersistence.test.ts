import assert from 'node:assert/strict';
import { createCloudflareBudgetAuditRecorder } from '../server/cloudflareAudit.ts';
import type { CloudflareAuditEvent } from '../server/cloudflareWorkersAi.ts';
import type { ZeroDatabase } from '../server/store.ts';

function createDatabase(): ZeroDatabase {
  return {
    models: [],
    budgetGuard: {
      budgetLimitEur: 0,
      totalSpentEur: 0,
      paidProvidersDisabled: true,
      autoFallbackDisabled: true,
      autoUpgradeDisabled: true,
      freeQuotaUsage: {},
      auditLog: [],
    },
    memories: [],
    characters: [],
    projects: [],
    chatHistory: [],
    automationRuns: [],
    backups: [],
    backupConfig: { currentVersion: '1.1.0', autoZipOnChange: false, lastVerifiedAt: new Date(0).toISOString(), zipBackups: [], changelogHistory: [] },
    settings: { targetDevice: 'iPhone 16 Pro Max', maxVideoDurationSec: 60, preferredVideoDurationSec: 58, language: 'de-DE', offlineFirstPreferLocal: true },
  };
}

function event(overrides: Partial<CloudflareAuditEvent> = {}): CloudflareAuditEvent {
  return {
    provider: 'cloudflare-workers-ai',
    adapterId: 'cloudflare-workers-ai',
    modelId: 'cloudflare-glm-4.7-flash',
    action: 'CLOUDFLARE_TEXT',
    decision: 'ERLAUBT_0_EUR',
    outcome: 'success',
    reason: 'Antwort erfolgreich.',
    httpStatus: 200,
    providerRequestId: 'cf-ray:ray-test-123',
    errorCategory: null,
    durationMs: 42,
    costEur: 0,
    timestamp: '2026-11-18T12:00:00.000Z',
    ...overrides,
  };
}

{
  const db = createDatabase();
  let saves = 0;
  const record = createCloudflareBudgetAuditRecorder(db, async (database) => {
    assert.equal(database, db, 'the request state object is saved in-place to preserve its revision');
    saves += 1;
  });
  await Promise.all([
    record(event()),
    record(event({ outcome: 'gate_blocked', decision: 'BLOCKIERT_BUDGET_GUARD', action: 'CLOUDFLARE_IMAGE', httpStatus: 403, providerRequestId: null, errorCategory: 'billing_gate', reason: 'Flag fehlt.' })),
    record(event({ outcome: 'http_error', decision: 'PROVIDER_FEHLER', httpStatus: 429, errorCategory: 'http', reason: 'HTTP 429.' })),
    record(event({ outcome: 'network_error', decision: 'PROVIDER_FEHLER', httpStatus: null, providerRequestId: null, errorCategory: 'network', reason: 'fetch failed.' })),
  ]);
  assert.equal(saves, 4);
  assert.equal(db.budgetGuard.auditLog.length, 4);
  assert.deepEqual(
    db.budgetGuard.auditLog.map((item) => item.outcome),
    ['network_error', 'http_error', 'gate_blocked', 'success'],
  );
  const success = db.budgetGuard.auditLog.find((item) => item.outcome === 'success');
  assert.equal(success?.provider, 'cloudflare-workers-ai');
  assert.equal(success?.providerRequestId, 'cf-ray:ray-test-123');
  assert.equal(success?.httpStatus, 200);
  assert.equal(success?.durationMs, 42);
  assert.equal(db.budgetGuard.freeQuotaUsage['cloudflare-glm-4.7-flash'], undefined);
}

{
  const db = createDatabase();
  for (let index = 0; index < 510; index += 1) {
    const record = createCloudflareBudgetAuditRecorder(db, async () => undefined);
    await record(event({ reason: 'retention-' + index }));
  }
  assert.equal(db.budgetGuard.auditLog.length, 500, 'the existing durable audit history retains the newest 500 events');
  assert.match(db.budgetGuard.auditLog[0].reason, /retention-509/);
}

console.log('Cloudflare durable audit persistence tests passed.');