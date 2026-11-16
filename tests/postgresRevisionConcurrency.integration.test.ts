import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  createPostgresStateStore,
  PersistentStateConflictError,
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

  const beforeAutoBackup = await storeA.read();
  assert.ok(beforeAutoBackup);
  await assert.rejects(
    () => storeA.writeWithBackup(
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
  const autoRevision = await storeA.writeWithBackup(
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

  console.log('PostgreSQL revision, restore-race, and atomic-backup tests passed using two independent pools.');
} finally {
  await Promise.all([poolA.end(), poolB.end()]);
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await adminPool.end();
}
