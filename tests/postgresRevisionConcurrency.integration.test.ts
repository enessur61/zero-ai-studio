import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  createPostgresStateStore,
  PersistentStateConflictError,
  writePersistentStateWithBackupFile,
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

  await Promise.all([storeA.ensureSchema(), storeB.ensureSchema()]);
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
  const backupRevision = await writePersistentStateWithBackupFile(
    { value: 'backup-published', backupId: 'backup-atomic-success' },
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
    payload: { value: 'backup-published', backupId: 'backup-atomic-success' },
    revision: 4,
  });
  const storedBytes = await poolB.query<{ payload: Buffer }>(
    'SELECT payload FROM zero_backup_files WHERE id = $1',
    ['backup-atomic-success']
  );
  assert.deepEqual(storedBytes.rows[0]?.payload, backupBytes);

  // A failed backup-blob insert must roll back the state/revision update too.
  await assert.rejects(
    () => writePersistentStateWithBackupFile(
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
  const restoreSnapshot = await storeA.read();
  assert.ok(restoreSnapshot);
  const concurrentWriteRevision = await storeB.write(
    { value: 'newer-normal-write' },
    restoreSnapshot.revision
  );
  assert.equal(concurrentWriteRevision, 5);
  await assert.rejects(
    () => storeA.write({ value: 'stale-restored-state' }, restoreSnapshot.revision),
    (error: unknown) => error instanceof PersistentStateConflictError,
    'a restore based on a stale revision must abort instead of overwriting a newer write'
  );
  const afterRestoreRace = await storeA.read();
  assert.deepEqual(afterRestoreRace, {
    payload: { value: 'newer-normal-write' },
    revision: 5,
  });

  console.log('PostgreSQL revision, restore-race, and atomic-backup tests passed using two independent pools.');
} finally {
  await Promise.all([poolA.end(), poolB.end()]);
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await adminPool.end();
}
