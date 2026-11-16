import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRestoreHandlers } from '../server/restoreHandlers.ts';
import { asyncRoute } from '../server/asyncRoute.ts';
import { createPostgresConcurrencyGate } from '../server/concurrencyGate.ts';
import { createVerifiedZipRestoreService } from '../server/verifiedZipRestore.ts';
import { assertRestorableDatabase, type ZeroDatabase, type SaveDbOptions } from '../server/store.ts';
import { BackupCleanupError, createVersionedZipBackupService } from '../server/versionedZipBackup.ts';
import {
  buildFullProjectZip,
  EXCLUDED_SECRETS_DOC,
  MAX_ZIP_ARCHIVE_BYTES,
  MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
  verifyZipBuffer,
} from '../server/zipExporter.ts';
import type { ZipBackupVersion } from '../src/types/zero.ts';
import { Pool } from 'pg';
import { createPostgresAuthStore } from '../server/postgresAuthStore.ts';
import {
  createPostgresStateStore,
  PersistentStateConflictError,
  withPersistentAutoBackupLease,
  readBackupFile,
} from '../server/persistence.ts';

const connectionString = process.env.DATABASE_URL;
if (process.env.ZERO_POSTGRES_TESTS !== 'true' || !connectionString) {
  throw new Error('PostgreSQL integration tests require ZERO_POSTGRES_TESTS=true and DATABASE_URL.');
}
const databaseUrl = new URL(connectionString);
if (!['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname)) {
  throw new Error('Refusing to run PostgreSQL integration tests against a non-local database.');
}

const schema = `zero_revision_test_${randomUUID().replaceAll('-', '')}`;
const adminPool = new Pool({ connectionString, max: 1 });
const poolA = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1 });
const poolB = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1 });

try {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const storeA = createPostgresStateStore(poolA);
  const storeB = createPostgresStateStore(poolB);

  // Run DDL sequentially: concurrent CREATE TABLE IF NOT EXISTS may race in pg_type.
  await storeA.ensureSchema();
  await storeB.ensureSchema();

  // Production auth state must be shared across independent Node-process pools.
  const authA = createPostgresAuthStore(poolA);
  const authB = createPostgresAuthStore(poolB);
  await authA.ensureSchema();
  await authB.ensureSchema();
  const sessionHash = 'a'.repeat(64);
  await authA.createSession(sessionHash, new Date(Date.now() + 60_000));
  assert.equal(await authB.hasSession(sessionHash), true, 'a session created on pool A must validate on pool B');
  await authB.deleteSession(sessionHash);
  assert.equal(await authA.hasSession(sessionHash), false, 'logout on pool B must revoke the session on pool A');
  await authA.createSession('b'.repeat(64), new Date(Date.now() - 1));
  assert.equal(await authB.hasSession('b'.repeat(64)), false, 'expired sessions must fail closed across pools');

  // Eight failed logins are shared; the ninth attempt is rejected across pools.
  const loginKeyHash = 'c'.repeat(64);
  const loginNow = new Date();
  const loginAttempts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? authA : authB).consumeLoginAttempt(loginKeyHash, loginNow, 15 * 60 * 1000, 8)
  ));
  assert.equal(loginAttempts.filter((entry) => entry.allowed).length, 8);
  const blockedLogin = await authB.consumeLoginAttempt(loginKeyHash, loginNow, 15 * 60 * 1000, 8);
  assert.equal(blockedLogin.allowed, false, 'the ninth attempt must be blocked even when it reaches another pool');
  assert.equal(blockedLogin.attempts, 9);
  await authA.clearLoginAttempts(loginKeyHash);
  assert.equal((await authB.consumeLoginAttempt(loginKeyHash, loginNow, 15 * 60 * 1000, 8)).allowed, true);

  // A shared atomic quota reservation must admit only the configured number
  // of provider calls, even when requests are distributed across two pools.
  const quotaParams = {
    modelId: 'gemini-3.8-flash-cross-pool-test',
    resetDate: new Date().toISOString().slice(0, 10),
    currentRequests: 0,
    dailyLimit: 8,
  };
  const quotaReservations = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? authA : authB).reserveGeminiQuota(quotaParams)
  ));
  assert.equal(quotaReservations.filter((entry) => entry.allowed).length, 8);
  const exhaustedQuota = await authB.reserveGeminiQuota(quotaParams);
  assert.equal(exhaustedQuota.allowed, false, 'ninth Gemini reservation must fail across independent pools');
  assert.equal(exhaustedQuota.requestsToday, 8);

  // Production ZIP middleware must enforce one shared limit across two pools.
  const gateA = createPostgresConcurrencyGate(poolA, 2, 5);
  const gateB = createPostgresConcurrencyGate(poolB, 2, 5);
  const gateAppA = express();
  const gateAppB = express();
  let heldRequests = 0;
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let releaseOccupied!: () => void;
  const occupiedWork = new Promise<void>((resolve) => { releaseOccupied = resolve; });
  let releaseDisconnected!: () => void;
  const disconnectedWork = new Promise<void>((resolve) => { releaseDisconnected = resolve; });
  let disconnectedEntered = false;
  const route = (gate: ReturnType<typeof createPostgresConcurrencyGate>) => {
    const app = express();
    app.get('/held/:id', gate.middleware, asyncRoute(async (req, res) => {
      heldRequests++;
      if (heldRequests <= 2) await held;
      if (req.params.id === 'occupied') await occupiedWork;
      res.json({ id: req.params.id });
    }));
    app.get('/disconnect', gate.middleware, asyncRoute(async (_req, res) => {
      disconnectedEntered = true;
      await disconnectedWork;
      res.json({ ok: true });
    }));
    return app;
  };
  const serverA = route(gateA).listen(0, '127.0.0.1');
  const serverB = route(gateB).listen(0, '127.0.0.1');
  await Promise.all([once(serverA, 'listening'), once(serverB, 'listening')]);
  const addressA = serverA.address();
  const addressB = serverB.address();
  assert.ok(addressA && typeof addressA !== 'string');
  assert.ok(addressB && typeof addressB !== 'string');
  const baseA = `http://127.0.0.1:${addressA.port}`;
  const baseB = `http://127.0.0.1:${addressB.port}`;
  try {
    const first = fetch(baseA + '/held/one');
    while (heldRequests < 1) await new Promise((resolve) => setImmediate(resolve));
    const second = fetch(baseB + '/held/two');
    while (heldRequests < 2) await new Promise((resolve) => setImmediate(resolve));
    const third = await fetch(baseA + '/held/three');
    assert.equal(third.status, 429, 'third ZIP request must be rejected across independent pools');
    assert.equal(third.headers.get('retry-after'), '5');

    releaseHeld();
    assert.equal((await (await first).json()).id, 'one');
    assert.equal((await (await second).json()).id, 'two');
    const afterRelease = await fetch(baseB + '/held/after-release');
    assert.equal(afterRelease.status, 200, 'a completed ZIP handler must release a global slot');

    const abort = new AbortController();
    const disconnectedRequest = fetch(baseA + '/disconnect', { signal: abort.signal }).catch(() => undefined);
    while (!disconnectedEntered) await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await disconnectedRequest;
    const occupy = fetch(baseB + '/held/occupied');
    while (heldRequests < 3) await new Promise((resolve) => setImmediate(resolve));
    const stillHeld = await fetch(baseA + '/held/blocked-after-disconnect');
    assert.equal(stillHeld.status, 429, 'client disconnect must not release a slot while async work is still running');
    releaseDisconnected();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterDisconnectWork = await fetch(baseA + '/held/after-disconnect-work');
    assert.equal(afterDisconnectWork.status, 200, 'slot must release once disconnected handler work settles');
    releaseOccupied();
    await (await occupy).json();
  } finally {
    releaseHeld();
    releaseOccupied();
    releaseDisconnected();
    serverA.close();
    serverB.close();
    await Promise.all([once(serverA, 'close'), once(serverB, 'close')]);
  }

  // PostgreSQL must reject oversized BYTEA reads using octet_length in SQL,
  // before transferring the blob into the Node.js process.
  const oversizedBlobId = 'zip-read-limit-fixture';
  const oversizedBlob = Buffer.alloc(256, 0x5a);
  await poolA.query(
    `INSERT INTO zero_backup_files (id, filename, content_type, payload)
     VALUES ($1, 'oversized-fixture.zip', 'application/zip', $2)`,
    [oversizedBlobId, oversizedBlob]
  );
  await assert.rejects(
    () => readBackupFile(oversizedBlobId, 128, poolB),
    /überschreitet das Größenlimit/,
    'PostgreSQL must not return a BYTEA blob larger than the configured ZIP read cap'
  );
  assert.deepEqual(
    await readBackupFile(oversizedBlobId, MAX_ZIP_ARCHIVE_BYTES, poolB),
    oversizedBlob,
    'a blob within the configured archive cap must remain readable'
  );
  await poolA.query('DELETE FROM zero_backup_files WHERE id = $1', [oversizedBlobId]);

  // Reconciliation must use one checked-out connection and one stable snapshot.
  const reconciliationSql: string[] = [];
  let reconciliationClientReleased = false;
  const reconciliationClient = {
    query: async (sql: string) => {
      reconciliationSql.push(sql);
      if (sql.includes('FROM zero_app_state')) {
        return { rows: [{ backups: [], zip_backups: [] }] };
      }
      if (sql.includes('FROM zero_backup_files')) return { rows: [] };
      return { rows: [] };
    },
    release: () => { reconciliationClientReleased = true; },
  };
  const reconciliationPool = {
    query: async () => ({ rows: [] }),
    connect: async () => reconciliationClient,
  } as unknown as Pool;
  const reconciliationStore = createPostgresStateStore(reconciliationPool);
  assert.deepEqual(await reconciliationStore.inspectBackupConsistency(), {
    orphanedBlobIds: [],
    missingBlobIds: [],
  });
  assert.equal(
    reconciliationSql[0],
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'reconciliation must start a stable read-only transaction'
  );
  assert.ok(reconciliationSql.includes('COMMIT'));
  assert.equal(reconciliationClientReleased, true, 'reconciliation must always release its checked-out client');

  const initialRevision = await storeA.write({ value: 0 }, 0);
  assert.equal(initialRevision, 1, 'initial insert must create revision 1');

  const [snapshotA, snapshotB] = await Promise.all([storeA.read(), storeB.read()]);
  assert.ok(snapshotA);
  assert.ok(snapshotB);
  assert.equal(snapshotA.revision, 1);
  assert.equal(snapshotB.revision, 1);

  // Two independent pools deliberately race with the same expected revision.
  const concurrent = await Promise.allSettled([
    storeA.write({ writer: 'connection-A' }, snapshotA.revision),
    storeB.write({ writer: 'connection-B' }, snapshotB.revision),
  ]);
  const successes = concurrent.filter((entry) => entry.status === 'fulfilled');
  const failures = concurrent.filter((entry) => entry.status === 'rejected');
  assert.equal(successes.length, 1, 'exactly one concurrent writer may win');
  assert.equal(failures.length, 1, 'the stale concurrent writer must be rejected');
  assert.ok(
    failures[0].status === 'rejected' && failures[0].reason instanceof PersistentStateConflictError,
    'the losing writer must receive an explicit revision conflict'
  );

  const afterRace = await storeA.read();
  assert.ok(afterRace);
  assert.equal(afterRace.revision, 2, 'one successful race must advance revision exactly once');
  assert.ok(
    ['connection-A', 'connection-B'].includes((afterRace.payload as { writer: string }).writer),
    'the committed payload must belong to the winning writer'
  );

  await assert.rejects(
    () => storeB.write({ writer: 'stale-overwrite' }, snapshotB.revision),
    (error: unknown) => error instanceof PersistentStateConflictError,
    'a later stale write must not overwrite the winning payload'
  );

  const nextRevision = await storeB.write({ value: 'after-conflict' }, afterRace.revision);
  assert.equal(nextRevision, 3, 'a caller using the latest revision may write successfully');
  const finalState = await storeA.read();
  assert.deepEqual(finalState, { payload: { value: 'after-conflict' }, revision: 3 });

  // State metadata and the backup bytes must commit in the same PostgreSQL transaction.
  const backupBytes = Buffer.from('ZERO-BACKUP-CONSISTENCY-TEST');
  const backupRevision = await storeA.writeWithBackup(
    {
      value: 'backup-published',
      backups: [{ id: 'backup-atomic-success' }],
      backupConfig: { zipBackups: [{ id: 'backup-atomic-success' }] },
    },
    finalState.revision,
    {
      id: 'backup-atomic-success',
      filename: 'atomic-success.zip',
      contentType: 'application/zip',
      payload: backupBytes,
    }
  );
  assert.equal(backupRevision, 4);
  const published = await storeA.read();
  assert.deepEqual(published, {
    payload: {
      value: 'backup-published',
      backups: [{ id: 'backup-atomic-success' }],
      backupConfig: { zipBackups: [{ id: 'backup-atomic-success' }] },
    },
    revision: 4,
  });
  assert.deepEqual(await storeA.inspectBackupConsistency(), {
    orphanedBlobIds: [],
    missingBlobIds: [],
  }, 'a committed backup must have matching metadata and bytes');
  const storedBytes = await poolB.query<{ payload: Buffer }>(
    'SELECT payload FROM zero_backup_files WHERE id = $1',
    ['backup-atomic-success']
  );
  assert.deepEqual(storedBytes.rows[0]?.payload, backupBytes);

  // A failed backup-blob insert must roll back the state/revision update too.
  await assert.rejects(
    () => storeA.writeWithBackup(
      { value: 'must-rollback', backupId: 'backup-atomic-failure' },
      backupRevision,
      {
        id: 'backup-atomic-failure',
        filename: 'atomic-failure.zip',
        contentType: null as unknown as string,
        payload: Buffer.from('invalid backup metadata'),
      }
    ),
    (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === '23502',
    'invalid backup metadata must abort the shared transaction'
  );
  const afterFailedBackup = await storeA.read();
  assert.deepEqual(afterFailedBackup, published, 'failed backup publication must not advance state');
  const failedBlob = await poolB.query(
    'SELECT id FROM zero_backup_files WHERE id = $1',
    ['backup-atomic-failure']
  );
  assert.equal(failedBlob.rowCount, 0, 'failed backup publication must not leave orphaned bytes');

  // Restore is a full-state replacement: any intervening normal write must fence it off.
  // The read-only reconciliation report detects both orphaned bytes and missing blobs.
  await poolB.query(
    `INSERT INTO zero_backup_files (id, filename, content_type, payload)
     VALUES ('orphaned-blob', 'orphan.zip', 'application/zip', $1)`,
    [Buffer.from('orphan')]
  );
  const reconciliationRevision = await storeB.write({
    value: 'reconciliation-check',
    backups: [{ id: 'backup-atomic-success' }, { id: 'missing-backup' }],
    backupConfig: { zipBackups: [{ id: 'backup-atomic-success' }] },
  }, backupRevision);
  assert.equal(reconciliationRevision, 5);
  assert.deepEqual(await storeA.inspectBackupConsistency(), {
    orphanedBlobIds: ['orphaned-blob'],
    missingBlobIds: ['missing-backup'],
  }, 'reconciliation must report orphaned bytes and metadata without blobs');
  await poolB.query("DELETE FROM zero_backup_files WHERE id = 'orphaned-blob'");

  // A session-level lease prevents duplicate automatic backups across independent pools.
  // The success marker must commit atomically with the backup bytes and state metadata.
  const autoLeaseA = await storeA.acquireAutoBackupLease();
  assert.ok(autoLeaseA, 'first pool must acquire the automatic backup lease');
  const autoLeaseB = await storeB.acquireAutoBackupLease();
  assert.equal(autoLeaseB, null, 'second pool must not acquire the active automatic backup lease');

  // Pool A's only connection is held by the session-level lease; read via independent pool B.
  const beforeAutoBackup = await storeB.read();
  assert.ok(beforeAutoBackup);
  await assert.rejects(
    () => storeB.writeWithBackup(
      { value: 'auto-backup-must-rollback' },
      beforeAutoBackup.revision,
      {
        id: 'auto-backup-atomic-failure',
        filename: 'auto-failure.zip',
        contentType: null as unknown as string,
        payload: Buffer.from('invalid auto backup'),
      },
      true
    ),
    (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === '23502',
    'failed automatic backup publication must roll back its throttle marker'
  );
  const failedAutoMarker = await poolB.query(
    "SELECT last_success_at FROM zero_backup_auto_state WHERE id = 'zip-auto'"
  );
  assert.equal(failedAutoMarker.rowCount, 0, 'failed publication must not record an auto-backup success');

  const autoPayload = {
    value: 'auto-backup-committed',
    backups: [{ id: 'backup-atomic-success' }, { id: 'auto-backup-atomic-success' }],
    backupConfig: { zipBackups: [{ id: 'backup-atomic-success' }, { id: 'auto-backup-atomic-success' }] },
  };
  const autoRevision = await storeB.writeWithBackup(
    autoPayload,
    beforeAutoBackup.revision,
    {
      id: 'auto-backup-atomic-success',
      filename: 'auto-success.zip',
      contentType: 'application/zip',
      payload: Buffer.from('valid auto backup'),
    },
    true
  );
  assert.equal(autoRevision, beforeAutoBackup.revision + 1);
  const committedAutoMarker = await poolB.query<{ last_success_at: Date }>(
    "SELECT last_success_at FROM zero_backup_auto_state WHERE id = 'zip-auto'"
  );
  assert.equal(committedAutoMarker.rowCount, 1, 'successful publication must commit the throttle marker');
  assert.ok(committedAutoMarker.rows[0].last_success_at instanceof Date);

  await autoLeaseA.complete();
  const throttledLease = await storeB.acquireAutoBackupLease();
  assert.equal(throttledLease, null, 'successful automatic backup must enforce the 15-minute throttle');

  const restoreSnapshot = await storeA.read();
  assert.ok(restoreSnapshot);
  const concurrentWriteRevision = await storeB.write(
    { value: 'newer-normal-write' },
    restoreSnapshot.revision
  );
  assert.equal(concurrentWriteRevision, restoreSnapshot.revision + 1);
  await assert.rejects(
    () => storeA.write({ value: 'stale-restored-state' }, restoreSnapshot.revision),
    (error: unknown) => error instanceof PersistentStateConflictError,
    'a restore based on a stale revision must abort instead of overwriting a newer write'
  );
  const afterRestoreRace = await storeA.read();
  assert.deepEqual(afterRestoreRace, {
    payload: { value: 'newer-normal-write' },
    revision: restoreSnapshot.revision + 1,
  });

  // Exercise the real HTTP restore handler while two independent PostgreSQL pools
  // deterministically interleave a restore snapshot and a newer normal write.
  let announceRestorePaused!: () => void;
  const restorePaused = new Promise<void>((resolve) => { announceRestorePaused = resolve; });
  let releaseRestore!: () => void;
  const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
  const restoreHandlers = createRestoreHandlers({
    restoreSystemBackup: async () => ({ projects: [], memories: [] }),
    restoreZipBackup: async (backupId) => {
      assert.equal(backupId, 'http-race-backup');
      const snapshot = await storeA.read();
      assert.ok(snapshot);
      announceRestorePaused();
      await restoreGate;
      await storeA.write({ value: 'stale-http-restore' }, snapshot.revision);
      return {
        restoredVersion: '1.0.0',
        safetyBackup: {},
        db: { backupConfig: {} },
      };
    },
  });
  const routeApp = express();
  routeApp.use(express.json());
  routeApp.post('/api/system/zip-backups/:id/restore', restoreHandlers.zip);
  const httpServer = routeApp.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const httpRestore = fetch(`http://127.0.0.1:${address.port}/api/system/zip-backups/http-race-backup/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  try {
    await restorePaused;
    const beforeWrite = await storeB.read();
    assert.ok(beforeWrite);
    const winningHttpWriteRevision = await storeB.write(
      { value: 'newer-http-normal-write' },
      beforeWrite.revision
    );
    assert.equal(winningHttpWriteRevision, beforeWrite.revision + 1);
    releaseRestore();
    const response = await httpRestore;
    assert.equal(response.status, 409, 'HTTP restore must expose a revision conflict');
    const responseBody = await response.json() as { code?: string; expectedRevision?: number; actualRevision?: number };
    assert.equal(responseBody.code, 'PERSISTENCE_REVISION_CONFLICT');
    assert.equal(responseBody.expectedRevision, beforeWrite.revision);
    assert.equal(responseBody.actualRevision, winningHttpWriteRevision);
    assert.deepEqual(await storeA.read(), {
      payload: { value: 'newer-http-normal-write' },
      revision: winningHttpWriteRevision,
    }, 'the newer normal write must survive the rejected HTTP restore');
  } finally {
    releaseRestore();
    httpServer.close();
    await once(httpServer, 'close');
  }


  // Exercise the complete production ZIP restore orchestration with real ZIP
  // construction/verification, a committed safety archive, HTTP routing, and a
  // deterministic normal-write race across two independent PostgreSQL pools.
  const makeRestoreDb = (title: string): ZeroDatabase => ({
    models: [],
    budgetGuard: { auditLog: [], freeQuotaUsage: {} },
    memories: [],
    characters: [],
    projects: [{ id: 'restore-race-project', title, scenes: [], assets: [], characterIds: [] }],
    chatHistory: [],
    automationRuns: [],
    backups: [],
    backupConfig: {
      currentVersion: '1.2.0',
      autoZipOnChange: false,
      lastVerifiedAt: new Date().toISOString(),
      zipBackups: [],
      changelogHistory: [],
    },
    settings: {
      targetDevice: 'iPhone 16 Pro Max',
      maxVideoDurationSec: 60,
      preferredVideoDurationSec: 58,
      language: 'de-DE',
      offlineFirstPreferLocal: false,
    },
  } as unknown as ZeroDatabase);

  // Earlier reconciliation cases intentionally leave their fixture blobs orphaned;
  // clear those known test-only rows before asserting this restore's own consistency.
  await poolB.query(
    "DELETE FROM zero_backup_files WHERE id IN ('backup-atomic-success', 'auto-backup-atomic-success', 'verified-restore-safety')"
  );
  const liveBeforeRestore = makeRestoreDb('live-before-restore');
  const currentBeforeRestore = await storeA.read();
  assert.ok(currentBeforeRestore);
  const liveRevision = await storeA.write(liveBeforeRestore, currentBeforeRestore.revision);
  const archivedDb = makeRestoreDb('restored-from-verified-zip');
  const archive = await buildFullProjectZip(process.cwd(), {
    'data/zero-studio-db.json': Buffer.from(JSON.stringify(archivedDb), 'utf8'),
  });
  const archiveVerification = verifyZipBuffer(archive.buffer);
  assert.equal(archiveVerification.result.valid, true, 'the test archive must pass the production ZIP verifier');
  assert.ok(archiveVerification.extractedFiles.has('data/zero-studio-db.json'));

  const sourceRecord = {
    id: 'verified-restore-source',
    version: '1.2.3',
    filename: 'verified-source.zip',
    createdAt: new Date().toISOString(),
    changelog: 'Integration test restore source',
    trigger: 'manual',
    fileCount: archive.fileCount,
    sizeBytes: archive.buffer.length,
    verified: true,
    protected: true,
    excludedSecrets: [],
  } as unknown as ZipBackupVersion;

  let announceSafetyBackupCommitted!: () => void;
  const safetyBackupCommitted = new Promise<void>((resolve) => { announceSafetyBackupCommitted = resolve; });
  let releaseRestoreAfterSafety!: () => void;
  const restoreAfterSafetyGate = new Promise<void>((resolve) => { releaseRestoreAfterSafety = resolve; });
  const safetyRevisions = new WeakMap<ZipBackupVersion, number>();
  let safetyBackupCalls = 0;

  const completeRestoreService = createVerifiedZipRestoreService({
    getZipBackupFilePath: async (zipId) => {
      assert.equal(zipId, 'verified-restore-source');
      return { record: sourceRecord, buffer: archive.buffer };
    },
    verifyZipBuffer,
    assertRestorableDatabase,
    createSafetyBackup: async (source) => {
      safetyBackupCalls += 1;
      assert.equal(source.id, sourceRecord.id);
      const beforeSafetyBackup = await storeA.read();
      assert.ok(beforeSafetyBackup);
      const safetyArchive = await buildFullProjectZip(process.cwd(), {
        'data/zero-studio-db.json': Buffer.from(JSON.stringify(beforeSafetyBackup.payload), 'utf8'),
      });
      assert.equal(verifyZipBuffer(safetyArchive.buffer).result.valid, true, 'the safety archive must be a verified ZIP');
      const safetyRecord = {
        id: 'verified-restore-safety',
        version: '1.2.4',
        filename: 'verified-safety.zip',
        createdAt: new Date().toISOString(),
        changelog: 'Safety backup before verified ZIP restore',
        trigger: 'pre_restore',
        fileCount: safetyArchive.fileCount,
        sizeBytes: safetyArchive.buffer.length,
        verified: true,
        protected: true,
        excludedSecrets: [],
      } as unknown as ZipBackupVersion;
      const stateWithSafetyMetadata = {
        ...beforeSafetyBackup.payload,
        backupConfig: {
          ...beforeSafetyBackup.payload.backupConfig,
          zipBackups: [safetyRecord, ...beforeSafetyBackup.payload.backupConfig.zipBackups],
        },
      };
      const revision = await storeB.writeWithBackup(
        stateWithSafetyMetadata,
        beforeSafetyBackup.revision,
        {
          id: safetyRecord.id,
          filename: safetyRecord.filename,
          contentType: 'application/zip',
          payload: safetyArchive.buffer,
        }
      );
      safetyRevisions.set(safetyRecord, revision);
      announceSafetyBackupCommitted();
      await restoreAfterSafetyGate;
      return safetyRecord;
    },
    loadDb: async () => {
      const state = await storeA.read();
      assert.ok(state);
      return state.payload as ZeroDatabase;
    },
    getZipBackupRevision: (backup) => {
      const revision = safetyRevisions.get(backup);
      if (revision === undefined) throw new Error('Safety backup revision missing from test fixture');
      return revision;
    },
    saveDb: async (db, options) => {
      assert.notEqual(options.expectedRevision, undefined);
      await storeA.write(db, options.expectedRevision!);
    },
    enrichModelMetadata: (model) => model,
  });

  const completeRestoreHandlers = createRestoreHandlers({
    restoreSystemBackup: async () => ({ projects: [], memories: [] }),
    restoreZipBackup: completeRestoreService,
  });
  const completeRestoreApp = express();
  completeRestoreApp.use(express.json());
  completeRestoreApp.post('/api/system/zip-backups/:id/restore', completeRestoreHandlers.zip);
  const completeRestoreServer = completeRestoreApp.listen(0, '127.0.0.1');
  await once(completeRestoreServer, 'listening');
  const completeRestoreAddress = completeRestoreServer.address();
  assert.ok(completeRestoreAddress && typeof completeRestoreAddress !== 'string');
  const completeRestoreRequest = fetch(
    `http://127.0.0.1:${completeRestoreAddress.port}/api/system/zip-backups/verified-restore-source/restore`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }
  );

  try {
    await safetyBackupCommitted;
    const stateAfterSafetyBackup = await storeB.read();
    assert.ok(stateAfterSafetyBackup);
    assert.equal(stateAfterSafetyBackup.revision, liveRevision + 1, 'safety backup must commit before restore proceeds');
    const safetyBlob = await poolB.query<{ payload: Buffer }>(
      'SELECT payload FROM zero_backup_files WHERE id = $1',
      ['verified-restore-safety']
    );
    assert.equal(safetyBlob.rowCount, 1, 'verified safety ZIP bytes must be persisted in PostgreSQL');
    assert.equal(verifyZipBuffer(safetyBlob.rows[0].payload).result.valid, true, 'persisted safety ZIP must verify');

    const newerLiveDb = makeRestoreDb('newer-concurrent-normal-write');
    newerLiveDb.backupConfig = stateAfterSafetyBackup.payload.backupConfig;
    const winningRevision = await storeB.write(newerLiveDb, stateAfterSafetyBackup.revision);
    releaseRestoreAfterSafety();
    const response = await completeRestoreRequest;
    assert.equal(response.status, 409, 'full production ZIP restore must reject a write after its safety snapshot');
    const responseBody = await response.json() as { code?: string; expectedRevision?: number; actualRevision?: number };
    assert.equal(responseBody.code, 'PERSISTENCE_REVISION_CONFLICT');
    assert.equal(responseBody.expectedRevision, stateAfterSafetyBackup.revision);
    assert.equal(responseBody.actualRevision, winningRevision);
    const finalLiveState = await storeA.read();
    assert.ok(finalLiveState);
    assert.equal(
      (finalLiveState.payload as ZeroDatabase).projects[0]?.title,
      'newer-concurrent-normal-write',
      'the newer normal write must survive the rejected full ZIP restore'
    );
    assert.equal(safetyBackupCalls, 1);
    assert.deepEqual(await storeA.inspectBackupConsistency(), {
      orphanedBlobIds: [],
      missingBlobIds: [],
    }, 'safety backup metadata and ZIP bytes must remain consistent after the conflict');
  } finally {
    releaseRestoreAfterSafety();
    completeRestoreServer.close();
    await once(completeRestoreServer, 'close');
  }

  // Invalid archives must fail before the mandatory safety-backup operation.
  let invalidArchiveSafetyCalls = 0;
  const invalidArchiveService = createVerifiedZipRestoreService({
    getZipBackupFilePath: async () => ({ record: sourceRecord, buffer: Buffer.from('not a ZIP archive') }),
    verifyZipBuffer,
    assertRestorableDatabase,
    createSafetyBackup: async () => {
      invalidArchiveSafetyCalls += 1;
      throw new Error('Safety backup must not run for invalid archive');
    },
    loadDb: async () => {
      const state = await storeA.read();
      assert.ok(state);
      return state.payload as ZeroDatabase;
    },
    getZipBackupRevision: () => { throw new Error('Must not request revision for invalid archive'); },
    saveDb: async () => { throw new Error('Must not persist an invalid restore'); },
    enrichModelMetadata: (model) => model,
  });
  await assert.rejects(
    () => invalidArchiveService('corrupt-zip'),
    /ZIP beschädigt oder unvollständig/,
    'corrupt ZIP archives must be rejected by the production verifier'
  );
  assert.equal(invalidArchiveSafetyCalls, 0, 'corrupt ZIP must not trigger a safety backup');

  // A safety-backup failure must also stop before the restored payload is committed.
  const beforeSafetyFailure = await storeA.read();
  assert.ok(beforeSafetyFailure);
  const failedSafetyService = createVerifiedZipRestoreService({
    getZipBackupFilePath: async () => ({ record: sourceRecord, buffer: archive.buffer }),
    verifyZipBuffer,
    assertRestorableDatabase,
    createSafetyBackup: async () => { throw new Error('injected safety backup publication failure'); },
    loadDb: async () => {
      const state = await storeA.read();
      assert.ok(state);
      return state.payload as ZeroDatabase;
    },
    getZipBackupRevision: () => { throw new Error('Must not request revision after failed safety backup'); },
    saveDb: async () => { throw new Error('Must not persist restore after failed safety backup'); },
    enrichModelMetadata: (model) => model,
  });
  await assert.rejects(
    () => failedSafetyService('verified-restore-source'),
    /injected safety backup publication failure/,
    'restore must abort when mandatory safety backup publication fails'
  );
  assert.deepEqual(await storeA.read(), beforeSafetyFailure, 'failed safety backup must leave live state untouched');

  // The successful restore-race fixture above left its safety ZIP blob behind;
  // this next fixture replaces the metadata state, so remove that test-only blob first.
  await poolB.query("DELETE FROM zero_backup_files WHERE id = 'verified-restore-safety'");

  // The exact production ZIP-backup service is run against this isolated schema.
  // Its build and verification use the production ZIP builder/verifier; its save
  // dependency uses the same atomic PostgreSQL state+blob transaction as production.
  const makeBackupDb = makeRestoreDb('production-auto-backup-source');
  makeBackupDb.backupConfig.autoZipOnChange = true;
  const beforeProductionBackup = await storeA.read();
  assert.ok(beforeProductionBackup);
  await storeA.write(makeBackupDb, beforeProductionBackup.revision);

  const backupRevisions = new WeakMap<ZeroDatabase, number>();
  const backupRecordRevisions = new WeakMap<ZipBackupVersion, number>();
  const productionZipBackup = createVersionedZipBackupService({
    loadDb: async () => {
      const state = await storeA.read();
      assert.ok(state);
      backupRevisions.set(state.payload as ZeroDatabase, state.revision);
      return state.payload as ZeroDatabase;
    },
    getDbRevision: (db) => {
      const revision = backupRevisions.get(db);
      if (revision === undefined) throw new Error('Production backup fixture revision missing');
      return revision;
    },
    saveDb: async (db, options: SaveDbOptions = {}) => {
      assert.notEqual(options.expectedRevision, undefined);
      assert.ok(options.backupFile, 'ZIP publication must provide the archive blob');
      const revision = await storeA.writeWithBackup(
        db,
        options.expectedRevision!,
        options.backupFile,
        options.recordAutoBackupSuccess ?? false
      );
      backupRevisions.set(db, revision);
    },
    deleteBackupFile: async (id) => {
      await poolA.query('DELETE FROM zero_backup_files WHERE id = $1', [id]);
    },
    buildFullProjectZip,
    verifyZipBuffer,
    excludedSecrets: EXCLUDED_SECRETS_DOC,
    isPersistent: () => true,
    rootDir: () => process.cwd(),
    zipBackupDir: '/tmp/zero-test-zips',
    rememberBackupRevision: (record, revision) => backupRecordRevisions.set(record, revision),
  });

  // A malformed persisted version must stop before archive construction or publication;
  // silently resetting to 1.1.1 would break the long-term version chain.
  let malformedVersionBuildCalls = 0;
  const malformedVersionDb = makeRestoreDb('malformed-version-fixture');
  malformedVersionDb.backupConfig.currentVersion = '1.2';
  const malformedVersionService = createVersionedZipBackupService({
    loadDb: async () => malformedVersionDb,
    getDbRevision: () => 0,
    saveDb: async () => { throw new Error('Malformed version must not be persisted'); },
    deleteBackupFile: async () => undefined,
    buildFullProjectZip: async () => {
      malformedVersionBuildCalls += 1;
      throw new Error('Malformed version must fail before ZIP build');
    },
    verifyZipBuffer,
    excludedSecrets: EXCLUDED_SECRETS_DOC,
    isPersistent: () => true,
    rootDir: () => process.cwd(),
    zipBackupDir: '/tmp/zero-test-zips',
  });
  await assert.rejects(
    () => malformedVersionService({ changelog: 'Malformed version must be rejected', trigger: 'manual' }),
    /Ungültige ZIP-Backup-Version/,
    'malformed stored versions must not reset the sequence to 1.1.1'
  );
  assert.equal(malformedVersionBuildCalls, 0, 'version validation must happen before archive construction');

  const successfulProductionBackup = await withPersistentAutoBackupLease(
    () => storeB.acquireAutoBackupLease(0),
    () => productionZipBackup({
      changelog: 'Production ZIP service success-path integration',
      trigger: 'auto',
      recordAutoBackupSuccess: true,
    })
  );
  assert.ok(successfulProductionBackup, 'production ZIP backup must be created under the shared lease wrapper');
  const successfulBackupBlob = await poolB.query<{ payload: Buffer }>(
    'SELECT payload FROM zero_backup_files WHERE id = $1',
    [successfulProductionBackup.id]
  );
  assert.equal(successfulBackupBlob.rowCount, 1, 'production ZIP service must atomically publish archive bytes');
  assert.equal(verifyZipBuffer(successfulBackupBlob.rows[0].payload).result.valid, true);
  const afterProductionBackup = await storeA.read();
  assert.ok(afterProductionBackup);
  assert.ok(
    (afterProductionBackup.payload as ZeroDatabase).backupConfig.zipBackups.some(
      (backup) => backup.id === successfulProductionBackup.id
    ),
    'production ZIP service must publish matching backup metadata'
  );

  // Build two more consecutive production versions from distinct persisted states.
  // Read each committed blob back, verify the archive, and inspect its embedded DB snapshot.
  const versionChain: ZipBackupVersion[] = [successfulProductionBackup];
  for (const title of ['chain-snapshot-A', 'chain-snapshot-B']) {
    const beforeVersion = await storeA.read();
    assert.ok(beforeVersion);
    const nextDb = beforeVersion.payload as ZeroDatabase;
    nextDb.projects[0].title = title;
    await storeA.write(nextDb, beforeVersion.revision);
    const backup = await productionZipBackup({
      changelog: `Version chain snapshot ${title}`,
      trigger: 'manual',
      bumpVersion: true,
    });
    versionChain.push(backup);
  }
  assert.deepEqual(
    versionChain.map((backup) => backup.version),
    ['1.2.1', '1.2.2', '1.2.3'],
    'successive production backups must advance monotonically without resetting or duplicating versions'
  );
  for (const [index, backup] of versionChain.entries()) {
    const blob = await poolB.query<{ payload: Buffer }>(
      'SELECT payload FROM zero_backup_files WHERE id = $1',
      [backup.id]
    );
    assert.equal(blob.rowCount, 1, `version ${backup.version} must retain its ZIP bytes`);
    const verified = verifyZipBuffer(blob.rows[0].payload);
    assert.equal(verified.result.valid, true, `version ${backup.version} must remain independently verifiable`);
    const snapshotBytes = verified.extractedFiles.get('data/zero-studio-db.json');
    assert.ok(snapshotBytes, `version ${backup.version} must contain its database snapshot`);
    const snapshot = JSON.parse(snapshotBytes.toString('utf8')) as ZeroDatabase;
    assert.equal(snapshot.backupConfig.currentVersion, backup.version);
    if (index > 0) {
      assert.equal(snapshot.projects[0].title, index === 1 ? 'chain-snapshot-A' : 'chain-snapshot-B');
    }
  }

  // Restore in a deliberately non-creation order (A, then B). Each restore must
  // first publish a protected, verified safety ZIP through the production backup service.
  const orderedRestore = createVerifiedZipRestoreService({
    getZipBackupFilePath: async (zipId) => {
      const state = await storeA.read();
      assert.ok(state);
      const record = (state.payload as ZeroDatabase).backupConfig.zipBackups.find((item) => item.id === zipId);
      if (!record) throw new Error(`ZIP metadata missing for ${zipId}`);
      const blob = await poolB.query<{ payload: Buffer }>(
        'SELECT payload FROM zero_backup_files WHERE id = $1',
        [zipId]
      );
      if (!blob.rows[0]) throw new Error(`ZIP bytes missing for ${zipId}`);
      return { record, buffer: blob.rows[0].payload };
    },
    verifyZipBuffer,
    assertRestorableDatabase,
    createSafetyBackup: async (source) => productionZipBackup({
      changelog: `Safety before restoring ${source.version}`,
      trigger: 'pre_restore',
      bumpVersion: true,
    }),
    loadDb: async () => {
      const state = await storeA.read();
      assert.ok(state);
      return state.payload as ZeroDatabase;
    },
    getZipBackupRevision: (record) => {
      const revision = backupRecordRevisions.get(record);
      if (revision === undefined) throw new Error('Safety backup revision missing from version-chain test');
      return revision;
    },
    saveDb: async (db, options) => {
      assert.notEqual(options.expectedRevision, undefined);
      await storeA.write(db, options.expectedRevision!);
    },
    enrichModelMetadata: (model) => model,
  });
  const restoredA = await orderedRestore(versionChain[1].id);
  assert.equal(restoredA.restoredVersion, '1.2.2');
  assert.equal(restoredA.db.projects[0].title, 'chain-snapshot-A');
  assert.equal(restoredA.safetyBackup.trigger, 'pre_restore');
  assert.equal(restoredA.safetyBackup.protected, true);
  assert.equal(verifyZipBuffer((await poolB.query<{ payload: Buffer }>(
    'SELECT payload FROM zero_backup_files WHERE id = $1',
    [restoredA.safetyBackup.id]
  )).rows[0].payload).result.valid, true, 'first restore safety ZIP must remain verifiable');

  const restoredB = await orderedRestore(versionChain[2].id);
  assert.equal(restoredB.restoredVersion, '1.2.3');
  assert.equal(restoredB.db.projects[0].title, 'chain-snapshot-B');
  assert.equal(restoredB.safetyBackup.trigger, 'pre_restore');
  assert.equal(restoredB.safetyBackup.protected, true);
  assert.deepEqual(await storeA.inspectBackupConsistency(), {
    orphanedBlobIds: [],
    missingBlobIds: [],
  }, 'sequential restores must leave every retained metadata record paired with ZIP bytes');

  // Corrupt the bytes of an actually published PostgreSQL backup blob.
  // The production restore service must reject it before creating a safety backup or writing state.
  const sourceBlobResult = await poolB.query<{ payload: Buffer }>(
    'SELECT payload FROM zero_backup_files WHERE id = $1',
    [versionChain[0].id]
  );
  assert.equal(sourceBlobResult.rowCount, 1);
  const originalSourceBlob = Buffer.from(sourceBlobResult.rows[0].payload);
  const corruptedSourceBlob = Buffer.from(originalSourceBlob);
  const firstCentralEntry = corruptedSourceBlob.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.notEqual(firstCentralEntry, -1);
  const sourceLocalOffset = corruptedSourceBlob.readUInt32LE(firstCentralEntry + 42);
  const sourceNameLength = corruptedSourceBlob.readUInt16LE(sourceLocalOffset + 26);
  const sourceExtraLength = corruptedSourceBlob.readUInt16LE(sourceLocalOffset + 28);
  const sourceDataOffset = sourceLocalOffset + 30 + sourceNameLength + sourceExtraLength;
  corruptedSourceBlob[sourceDataOffset] ^= 0xff;
  await poolB.query('UPDATE zero_backup_files SET payload = $2 WHERE id = $1', [
    versionChain[0].id,
    corruptedSourceBlob,
  ]);
  const stateBeforeCorruptRestore = await storeA.read();
  assert.ok(stateBeforeCorruptRestore);
  let corruptBlobSafetyBackupCalls = 0;
  const corruptBlobRestore = createVerifiedZipRestoreService({
    getZipBackupFilePath: async (zipId) => {
      const state = await storeA.read();
      assert.ok(state);
      const record = (state.payload as ZeroDatabase).backupConfig.zipBackups.find((item) => item.id === zipId);
      if (!record) throw new Error('Corrupt-blob fixture metadata missing');
      const blob = await poolB.query<{ payload: Buffer }>(
        'SELECT payload FROM zero_backup_files WHERE id = $1',
        [zipId]
      );
      if (!blob.rows[0]) throw new Error('Corrupt-blob fixture bytes missing');
      return { record, buffer: blob.rows[0].payload };
    },
    verifyZipBuffer,
    assertRestorableDatabase,
    createSafetyBackup: async () => {
      corruptBlobSafetyBackupCalls += 1;
      throw new Error('Safety backup must not run for a corrupted persisted ZIP');
    },
    loadDb: async () => {
      const state = await storeA.read();
      assert.ok(state);
      return state.payload as ZeroDatabase;
    },
    getZipBackupRevision: () => { throw new Error('Must not request safety revision for corrupt ZIP'); },
    saveDb: async () => { throw new Error('Must not persist a corrupt restore'); },
    enrichModelMetadata: (model) => model,
  });
  await assert.rejects(
    () => corruptBlobRestore(versionChain[0].id),
    /ZIP beschädigt oder unvollständig/,
    'the production restore service must reject corrupted bytes read from PostgreSQL'
  );
  assert.equal(corruptBlobSafetyBackupCalls, 0, 'corrupted persisted bytes must be rejected before safety backup');
  assert.deepEqual(await storeA.read(), stateBeforeCorruptRestore, 'corrupt ZIP restore must not alter live PostgreSQL state');
  await poolB.query('UPDATE zero_backup_files SET payload = $2 WHERE id = $1', [
    versionChain[0].id,
    originalSourceBlob,
  ]);

  // A compression-bomb declaration in a persisted PostgreSQL blob must be
  // rejected by the production restore orchestrator before any safety backup.
  const oversizedEntryBlob = Buffer.from(originalSourceBlob);
  const oversizedCentral = oversizedEntryBlob.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.notEqual(oversizedCentral, -1);
  const oversizedLocalOffset = oversizedEntryBlob.readUInt32LE(oversizedCentral + 42);
  const forgedExpandedSize = MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1;
  oversizedEntryBlob.writeUInt32LE(forgedExpandedSize, oversizedCentral + 24);
  oversizedEntryBlob.writeUInt32LE(forgedExpandedSize, oversizedLocalOffset + 22);
  await poolB.query('UPDATE zero_backup_files SET payload = $2 WHERE id = $1', [
    versionChain[0].id,
    oversizedEntryBlob,
  ]);
  await assert.rejects(
    () => corruptBlobRestore(versionChain[0].id),
    /ZIP beschädigt oder unvollständig/,
    'the production restore service must reject a persisted decompression bomb before inflation'
  );
  assert.equal(corruptBlobSafetyBackupCalls, 0, 'decompression bomb rejection must happen before safety backup');
  assert.deepEqual(await storeA.read(), stateBeforeCorruptRestore, 'decompression bomb restore must not mutate live PostgreSQL state');
  await poolB.query('UPDATE zero_backup_files SET payload = $2 WHERE id = $1', [
    versionChain[0].id,
    originalSourceBlob,
  ]);

  // A persisted blob truncated inside PostgreSQL must be rejected by the same restore path.
  const truncatedSourceBlob = originalSourceBlob.subarray(0, originalSourceBlob.length - 1);
  await poolB.query('UPDATE zero_backup_files SET payload = $2 WHERE id = $1', [
    versionChain[0].id,
    truncatedSourceBlob,
  ]);
  await assert.rejects(
    () => corruptBlobRestore(versionChain[0].id),
    /gespeicherte Größe/,
    'the production restore service must reject a truncated PostgreSQL ZIP blob against its persisted size metadata'
  );
  assert.equal(corruptBlobSafetyBackupCalls, 0, 'truncated persisted bytes must not trigger a safety backup');
  assert.deepEqual(await storeA.read(), stateBeforeCorruptRestore, 'truncated ZIP restore must not alter live PostgreSQL state');
  await poolB.query('UPDATE zero_backup_files SET payload = $2 WHERE id = $1', [
    versionChain[0].id,
    originalSourceBlob,
  ]);

  // Simulate an application restart: construct entirely new pools, state stores,
  // backup service and restore service, then restore from the persisted ZIP blob.
  const restartPoolA = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1 });
  const restartPoolB = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1 });
  try {
    const restartStore = createPostgresStateStore(restartPoolA);
    await restartStore.ensureSchema();
    const restartBackupRevisions = new WeakMap<ZeroDatabase, number>();
    const restartBackupRecordRevisions = new WeakMap<ZipBackupVersion, number>();
    const restartBackupService = createVersionedZipBackupService({
      loadDb: async () => {
        const state = await restartStore.read();
        assert.ok(state);
        restartBackupRevisions.set(state.payload as ZeroDatabase, state.revision);
        return state.payload as ZeroDatabase;
      },
      getDbRevision: (db) => {
        const revision = restartBackupRevisions.get(db);
        if (revision === undefined) throw new Error('Restart backup revision missing');
        return revision;
      },
      saveDb: async (db, options: SaveDbOptions = {}) => {
        assert.notEqual(options.expectedRevision, undefined);
        assert.ok(options.backupFile);
        const revision = await restartStore.writeWithBackup(
          db,
          options.expectedRevision!,
          options.backupFile,
          options.recordAutoBackupSuccess ?? false
        );
        restartBackupRevisions.set(db, revision);
      },
      deleteBackupFile: async (id) => { await restartPoolA.query('DELETE FROM zero_backup_files WHERE id = $1', [id]); },
      buildFullProjectZip,
      verifyZipBuffer,
      excludedSecrets: EXCLUDED_SECRETS_DOC,
      isPersistent: () => true,
      rootDir: () => process.cwd(),
      zipBackupDir: '/tmp/zero-test-zips-restart',
      rememberBackupRevision: (record, revision) => restartBackupRecordRevisions.set(record, revision),
    });
    const restartRestoreService = createVerifiedZipRestoreService({
      getZipBackupFilePath: async (zipId) => {
        const state = await restartStore.read();
        assert.ok(state);
        const record = (state.payload as ZeroDatabase).backupConfig.zipBackups.find((item) => item.id === zipId);
        if (!record) throw new Error(`Restart restore metadata missing for ${zipId}`);
        const blob = await restartPoolB.query<{ payload: Buffer }>(
          'SELECT payload FROM zero_backup_files WHERE id = $1',
          [zipId]
        );
        if (!blob.rows[0]) throw new Error(`Restart restore ZIP bytes missing for ${zipId}`);
        return { record, buffer: blob.rows[0].payload };
      },
      verifyZipBuffer,
      assertRestorableDatabase,
      createSafetyBackup: (source) => restartBackupService({
        changelog: `Safety after restart before restoring ${source.version}`,
        trigger: 'pre_restore',
        bumpVersion: true,
      }),
      loadDb: async () => {
        const state = await restartStore.read();
        assert.ok(state);
        return state.payload as ZeroDatabase;
      },
      getZipBackupRevision: (record) => {
        const revision = restartBackupRecordRevisions.get(record);
        if (revision === undefined) throw new Error('Restart safety backup revision missing');
        return revision;
      },
      saveDb: async (db, options) => {
        assert.notEqual(options.expectedRevision, undefined);
        await restartStore.write(db, options.expectedRevision!);
      },
      enrichModelMetadata: (model) => model,
    });
    const restoredAfterRestart = await restartRestoreService(versionChain[0].id);
    assert.equal(restoredAfterRestart.restoredVersion, '1.2.1');
    assert.equal(restoredAfterRestart.safetyBackup.trigger, 'pre_restore');
    assert.equal(restoredAfterRestart.safetyBackup.protected, true);
    assert.equal(restoredAfterRestart.db.projects[0].title, 'production-auto-backup-source');
    assert.deepEqual(await restartStore.inspectBackupConsistency(), {
      orphanedBlobIds: [],
      missingBlobIds: [],
    }, 'a fresh pool and service instance must restore persisted ZIP bytes without metadata/blob drift');
    console.log('ZIP corruption, decompression-bomb rejection, bounded PostgreSQL BYTEA reads, truncated blob rejection, and fresh-pool restart restore tests passed.');
  } finally {
    await Promise.all([restartPoolA.end(), restartPoolB.end()]);
  }

  // Retention commits the new metadata/blob before deleting expired blobs.
  // An injected delete failure must be reported as cleanup-pending, not as if
  // publication had failed; every other deletion must still be awaited.
  const beforeCleanupFailure = await storeA.read();
  assert.ok(beforeCleanupFailure);
  const legacyBackups: ZipBackupVersion[] = Array.from({ length: 11 }, (_, index) => ({
    id: `retention-old-${index}`,
    version: '1.0.0',
    filename: `retention-old-${index}.zip`,
    createdAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
    changelog: 'Retention cleanup failure fixture',
    trigger: 'auto',
    fileCount: 1,
    sizeBytes: 1,
    verified: true,
    protected: false,
    excludedSecrets: [],
  }));
  const cleanupFixtureDb = beforeCleanupFailure.payload as ZeroDatabase;
  const protectedRetentionFixture: ZipBackupVersion = {
    id: 'retention-protected-manual',
    version: '1.0.0',
    filename: 'retention-protected-manual.zip',
    createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    changelog: 'Protected retention fixture',
    trigger: 'manual',
    fileCount: 1,
    sizeBytes: 1,
    verified: true,
    protected: true,
    excludedSecrets: [],
  };
  cleanupFixtureDb.backupConfig.zipBackups = [
    ...cleanupFixtureDb.backupConfig.zipBackups,
    protectedRetentionFixture,
    ...legacyBackups,
  ];
  const cleanupFixtureRevision = await storeA.write(
    cleanupFixtureDb,
    beforeCleanupFailure.revision
  );
  for (const backup of [...legacyBackups, protectedRetentionFixture]) {
    await poolB.query(
      `INSERT INTO zero_backup_files (id, filename, content_type, payload)
       VALUES ($1, $2, 'application/zip', $3)`,
      [backup.id, backup.filename, Buffer.from('legacy ZIP fixture')]
    );
  }
  const failedCleanupId = legacyBackups[8].id;
  const cleanupFailureService = createVersionedZipBackupService({
    loadDb: async () => {
      const state = await storeA.read();
      assert.ok(state);
      backupRevisions.set(state.payload as ZeroDatabase, state.revision);
      return state.payload as ZeroDatabase;
    },
    getDbRevision: (db) => {
      const revision = backupRevisions.get(db);
      if (revision === undefined) throw new Error('Cleanup fixture revision missing');
      return revision;
    },
    saveDb: async (db, options: SaveDbOptions = {}) => {
      assert.notEqual(options.expectedRevision, undefined);
      assert.ok(options.backupFile);
      const revision = await storeA.writeWithBackup(
        db,
        options.expectedRevision!,
        options.backupFile,
        options.recordAutoBackupSuccess ?? false
      );
      backupRevisions.set(db, revision);
    },
    deleteBackupFile: async (id) => {
      if (id === failedCleanupId) throw new Error('injected backup blob cleanup failure');
      await poolA.query('DELETE FROM zero_backup_files WHERE id = $1', [id]);
    },
    buildFullProjectZip,
    verifyZipBuffer,
    excludedSecrets: EXCLUDED_SECRETS_DOC,
    isPersistent: () => true,
    rootDir: () => process.cwd(),
    zipBackupDir: '/tmp/zero-test-zips',
  });
  await assert.rejects(
    () => cleanupFailureService({
      changelog: 'Retention cleanup failure integration',
      trigger: 'auto',
    }),
    (error: unknown) =>
      error instanceof BackupCleanupError &&
      error.orphanedBlobIds.length === 1 &&
      error.orphanedBlobIds[0] === failedCleanupId &&
      error.backup.verified,
    'a post-commit cleanup failure must identify the committed backup and remaining orphan'
  );
  const afterCleanupFailure = await storeA.read();
  assert.ok(afterCleanupFailure);
  assert.equal(afterCleanupFailure.revision, cleanupFixtureRevision + 1);
  assert.ok(
    (afterCleanupFailure.payload as ZeroDatabase).backupConfig.zipBackups.some(
      (backup) => backup.id !== failedCleanupId && backup.changelog === 'Retention cleanup failure integration'
    ),
    'the new backup metadata must remain committed despite old-blob cleanup failure'
  );
  assert.ok(
    (afterCleanupFailure.payload as ZeroDatabase).backupConfig.zipBackups.some(
      (backup) => backup.id === protectedRetentionFixture.id && backup.protected
    ),
    'retention must preserve explicitly protected manual backups even when older than the automatic retention window'
  );
  const protectedBlob = await poolB.query(
    'SELECT id FROM zero_backup_files WHERE id = $1',
    [protectedRetentionFixture.id]
  );
  assert.equal(protectedBlob.rowCount, 1, 'retention must not delete the blob of a protected backup');
  const cleanupReport = await storeA.inspectBackupConsistency();
  assert.deepEqual(cleanupReport, {
    orphanedBlobIds: [failedCleanupId],
    missingBlobIds: [],
  }, 'reconciliation must identify the one blob whose cleanup failed');
  const failedCleanupBlob = await poolB.query(
    'SELECT id FROM zero_backup_files WHERE id = $1',
    [failedCleanupId]
  );
  assert.equal(failedCleanupBlob.rowCount, 1, 'the failed deletion must leave its orphan blob for reconciliation');
  await poolB.query('DELETE FROM zero_backup_files WHERE id = $1', [failedCleanupId]);
  assert.deepEqual(await storeA.inspectBackupConsistency(), {
    orphanedBlobIds: [],
    missingBlobIds: [],
  }, 'removing the test orphan must restore backup consistency');

  const autoMarkerBeforeFailure = await poolB.query<{ last_success_at: Date }>(
    "SELECT last_success_at FROM zero_backup_auto_state WHERE id = 'zip-auto'"
  );
  assert.equal(autoMarkerBeforeFailure.rowCount, 1);

  // Inject a PostgreSQL publication failure at the backup-blob INSERT. This is
  // after the real ZIP has been built and verified, inside the real atomic write.
  await poolB.query(`
    CREATE FUNCTION reject_zip_backup_publication() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected ZIP publication failure' USING ERRCODE = 'P0001';
    END;
    $$;
    CREATE TRIGGER reject_zip_backup_publication
    BEFORE INSERT ON zero_backup_files
    FOR EACH ROW EXECUTE FUNCTION reject_zip_backup_publication();
  `);
  const beforeFailedProductionBackup = await storeA.read();
  assert.ok(beforeFailedProductionBackup);
  await assert.rejects(
    () => withPersistentAutoBackupLease(
      () => storeB.acquireAutoBackupLease(0),
      () => productionZipBackup({
        changelog: 'Injected failure during production ZIP publication',
        trigger: 'auto',
        recordAutoBackupSuccess: true,
      })
    ),
    /injected ZIP publication failure/,
    'the real production ZIP service must surface a failed PostgreSQL blob publication'
  );
  const afterFailedProductionBackup = await storeA.read();
  assert.deepEqual(
    afterFailedProductionBackup,
    beforeFailedProductionBackup,
    'failed production ZIP publication must roll back metadata and revision'
  );
  const markerAfterFailure = await poolB.query<{ last_success_at: Date }>(
    "SELECT last_success_at FROM zero_backup_auto_state WHERE id = 'zip-auto'"
  );
  assert.equal(markerAfterFailure.rowCount, 1);
  assert.equal(
    markerAfterFailure.rows[0].last_success_at.getTime(),
    autoMarkerBeforeFailure.rows[0].last_success_at.getTime(),
    'failed publication must not advance the automatic-backup success marker'
  );
  await poolB.query('DROP TRIGGER reject_zip_backup_publication ON zero_backup_files');
  await poolB.query('DROP FUNCTION reject_zip_backup_publication()');

  // A second independent pool must acquire the same lease immediately after the
  // failed publication path, proving the production wrapper released the lock.
  const leaseAfterPublicationFailure = await storeB.acquireAutoBackupLease(0);
  assert.ok(leaseAfterPublicationFailure, 'failed ZIP publication must not strand the session-level advisory lock');
  await leaseAfterPublicationFailure.release();
  const leaseAfterRelease = await storeA.acquireAutoBackupLease(0);
  assert.ok(leaseAfterRelease, 'the lock must be reusable by the other independent pool');
  await leaseAfterRelease.release();

  // If the explicit unlock query itself fails, the pool client must be destroyed,
  // not returned to the pool with a session-level advisory lock still held.
  let failedUnlockRelease: Error | boolean | undefined;
  const failingUnlockClient = {
    query: async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('pg_advisory_unlock')) throw new Error('injected advisory unlock transport failure');
      if (sql.includes('last_success_at')) return { rows: [] };
      return { rows: [] };
    },
    release: (error?: Error | boolean) => { failedUnlockRelease = error; },
  };
  const failingUnlockPool = {
    query: async () => ({ rows: [] }),
    connect: async () => failingUnlockClient,
  } as unknown as Pool;
  const failingUnlockStore = createPostgresStateStore(failingUnlockPool);
  const failingUnlockLease = await failingUnlockStore.acquireAutoBackupLease(0);
  assert.ok(failingUnlockLease);
  await assert.rejects(
    () => failingUnlockLease.release(),
    /injected advisory unlock transport failure/
  );
  assert.equal(failedUnlockRelease, true, 'an uncertain unlock must destroy the physical pooled connection');

  // Failure while inspecting throttle state after acquiring the lock must also
  // destroy the session if its compensating unlock cannot be confirmed.
  let failedAcquireRelease: Error | boolean | undefined;
  const failingAcquireClient = {
    query: async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('last_success_at')) throw new Error('injected lease-state query failure');
      if (sql.includes('pg_advisory_unlock')) throw new Error('injected compensating unlock failure');
      return { rows: [] };
    },
    release: (error?: Error | boolean) => { failedAcquireRelease = error; },
  };
  const failingAcquirePool = {
    query: async () => ({ rows: [] }),
    connect: async () => failingAcquireClient,
  } as unknown as Pool;
  const failingAcquireStore = createPostgresStateStore(failingAcquirePool);
  await assert.rejects(
    () => failingAcquireStore.acquireAutoBackupLease(0),
    /injected lease-state query failure/
  );
  assert.equal(failedAcquireRelease, true, 'an uncertain compensating unlock must destroy the connection');
  console.log('PostgreSQL revision, persistence restore-race, HTTP restore-vs-write, and atomic-backup tests passed using two independent pools.');
} finally {
  await Promise.all([poolA.end(), poolB.end()]);
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await adminPool.end();
}
