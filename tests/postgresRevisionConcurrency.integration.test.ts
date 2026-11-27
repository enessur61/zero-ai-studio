import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
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
import { POSTGRES_POOL_MAX } from '../server/persistence.ts';
import { createPostgresAuthStore } from '../server/postgresAuthStore.ts';
import { createMultiUserAuthStore, ZERO_LEGACY_ADMIN_USER_ID } from '../server/multiUserAuthStore.ts';
import { createProjectVideoAssetStore, ProjectVideoLimitError, ProjectVideoProjectNotFoundError } from '../server/projectVideoStore.ts';
import { sendProjectVideoStream } from '../server/projectVideoHttp.ts';
import { ensureZeroCostResourceSchema } from '../server/zeroCostResourceGuard.ts';
import { ZERO_SCHEMA_MIGRATIONS, getZeroSchemaMigrationChecksum } from '../server/schemaMigrations.ts';
import { ensureZeroResourceSchemaWithPool, reserveZeroResourceWithPool, settleZeroResourceReservationWithPool, getZeroResourceReservationWithPool } from '../server/zeroResourceGuard.ts';
import { getZeroCostGuardStatus, reserveZeroCostProviderRequestWithPool, setZeroCostGuardPaused } from '../server/zeroCostGuard.ts';
import { ensureWanJobReservationSchemaWithPool, linkWanJobReservationWithPool, settleWanJobReservationWithPool } from '../server/wanResourceReservation.ts';
import {
  createPostgresStateStore,
  PersistentStateConflictError,
  withPersistentAutoBackupLease,
  acquirePersistentZipOperationLease,
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
const gatePoolA = new Pool({ connectionString, options: `-c search_path=${schema}`, max: POSTGRES_POOL_MAX });
const gatePoolB = new Pool({ connectionString, options: `-c search_path=${schema}`, max: POSTGRES_POOL_MAX });

try {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  // Legacy persistence DDL: the principal_hash regex lacks its final anchor.
  await adminPool.query(`
    CREATE TABLE "${schema}".zero_project_video_assets (
      asset_id UUID PRIMARY KEY,
      project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
      scene_id TEXT NOT NULL CHECK (length(scene_id) BETWEEN 1 AND 128),
      principal_hash CHAR(64) NOT NULL CHECK (principal_hash ~ '^[a-f0-9]{64}'),
      job_id UUID,
      content_type TEXT NOT NULL CHECK (content_type IN ('video/mp4', 'video/webm')),
      size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 1024 AND 104857600),
      sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      payload BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (principal_hash, job_id)
    )
  `);
  await adminPool.query(`
    CREATE INDEX zero_project_video_assets_project_idx_legacy
    ON "${schema}".zero_project_video_assets (principal_hash, project_id, created_at DESC)
  `);
  // Simulate an installation where migration 3 is already recorded and the
  // equivalent index exists under a legacy name. This keeps migration 3 from
  // creating its canonical index before migration 4 can inspect the catalog.
  const migration3 = ZERO_SCHEMA_MIGRATIONS.find((migration) => migration.version === 3);
  assert.ok(migration3);
  await adminPool.query(`
    CREATE TABLE "${schema}".zero_schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL,
      checksum CHAR(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await adminPool.query(
    `INSERT INTO "${schema}".zero_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
    [migration3.version, migration3.name, getZeroSchemaMigrationChecksum(migration3)],
  );
  const storeA = createPostgresStateStore(poolA);
  const storeB = createPostgresStateStore(poolB);

  // Two independent pools bootstrap together; the schema advisory lock must
  // serialize CREATE TABLE IF NOT EXISTS and the backward-compatible ALTER.
  await Promise.all([storeA.ensureSchema(), storeB.ensureSchema()]);

  // Principal-bound durable video assets use versioned PostgreSQL schema and
  // binary storage. Exercise >8 MB payloads across independent DB pools.
  await ensureZeroCostResourceSchema(poolA);
  await ensureZeroCostResourceSchema(poolB);
  const migrationVersions = await poolA.query('SELECT version FROM zero_schema_migrations ORDER BY version');
  assert.deepEqual(migrationVersions.rows.map((row) => Number(row.version)), [1, 2, 3, 4],
    'project video archive schema is reconciled through the versioned migration chain');

  const principalChecks = await poolA.query<{ conname: string; convalidated: boolean; definition: string }>(
    `SELECT conname, convalidated, pg_get_constraintdef(oid, false) AS definition
     FROM pg_constraint
     WHERE conrelid = 'zero_project_video_assets'::regclass AND contype = 'c'`
  );
  const legacyPrincipalCheck = principalChecks.rows.find((row) => row.conname === 'zero_project_video_assets_principal_hash_check');
  const strictPrincipalCheck = principalChecks.rows.find((row) => row.conname === 'zero_project_video_assets_principal_hash_v4_check');
  assert.ok(legacyPrincipalCheck, 'legacy unanchored principal_hash check remains identifiable');
  assert.ok(!legacyPrincipalCheck.definition.includes('{64}$'), 'legacy check must not be mistaken for the strict check');
  assert.ok(strictPrincipalCheck?.convalidated, 'migration 4 adds and validates the strict principal_hash check');
  assert.ok(strictPrincipalCheck.definition.includes("'^[a-f0-9]{64}'"), 'strict check matches exactly 64 lowercase hex characters');
  assert.ok(strictPrincipalCheck.definition.includes('chr(36)'), 'strict check appends the dollar end anchor');

  const validatedChecks = await poolA.query<{ conname: string; convalidated: boolean }>(
    `SELECT conname, convalidated FROM pg_constraint
     WHERE conrelid = 'zero_project_video_assets'::regclass AND contype = 'c'`
  );
  for (const constraintName of [
    'zero_project_video_assets_project_id_v4_check',
    'zero_project_video_assets_scene_id_v4_check',
    'zero_project_video_assets_principal_hash_v4_check',
    'zero_project_video_assets_content_type_v4_check',
    'zero_project_video_assets_size_bytes_v4_check',
    'zero_project_video_assets_sha256_v4_check',
  ]) {
    assert.equal(validatedChecks.rows.find((row) => row.conname === constraintName)?.convalidated, true,
      `migration 4 validates ${constraintName}`);
  }

  const videoColumns = await poolA.query<{ attname: string; data_type: string; attnotnull: boolean }>(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull
     FROM pg_attribute a
     WHERE a.attrelid = 'zero_project_video_assets'::regclass
       AND a.attnum > 0 AND NOT a.attisdropped`
  );
  const videoColumnByName = new Map(videoColumns.rows.map((row) => [row.attname, row]));
  assert.equal(videoColumnByName.get('principal_hash')?.data_type, 'character(64)');
  assert.equal(videoColumnByName.get('sha256')?.data_type, 'character(64)');
  assert.equal(videoColumnByName.get('job_id')?.attnotnull, false, 'job_id remains nullable for normal PostgreSQL UNIQUE semantics');
  assert.equal(videoColumnByName.get('payload')?.data_type, 'bytea');
  assert.equal(videoColumnByName.get('created_at')?.data_type, 'timestamp with time zone');

  const createdAtDefault = await poolA.query<{ expression: string }>(
    `SELECT pg_get_expr(d.adbin, d.adrelid) AS expression
     FROM pg_attribute a JOIN pg_attrdef d
       ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'zero_project_video_assets'::regclass AND a.attname = 'created_at'`
  );
  assert.equal(createdAtDefault.rows[0]?.expression, 'now()');

  const videoKeys = await poolA.query<{ contype: string; key_columns: string[] }>(
    `SELECT c.contype, array_agg(a.attname::text ORDER BY k.ordinality)::text[] AS key_columns
     FROM pg_constraint c
     CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality)
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.conrelid = 'zero_project_video_assets'::regclass AND c.contype IN ('p', 'u')
     GROUP BY c.oid, c.contype`
  );
  assert.ok(videoKeys.rows.some((row) => row.contype === 'p' && row.key_columns.join(',') === 'asset_id'));
  assert.ok(videoKeys.rows.some((row) => row.contype === 'u' && row.key_columns.join(',') === 'principal_hash,job_id'));

  const videoIndex = await poolA.query<{ index_name: string; indisvalid: boolean; indisready: boolean; indisunique: boolean; no_predicate: boolean; indnkeyatts: number; indnatts: number; options: number[]; definition: string }>(
    `SELECT idx.relname AS index_name, i.indisvalid, i.indisready, i.indisunique, i.indpred IS NULL AS no_predicate,
            i.indnkeyatts, i.indnatts,
            (SELECT array_agg(option_value::integer ORDER BY ordinality)
             FROM unnest(i.indoption) WITH ORDINALITY AS option_row(option_value, ordinality)) AS options,
            pg_get_indexdef(i.indexrelid) AS definition
     FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
     WHERE i.indrelid = 'zero_project_video_assets'::regclass
       AND idx.relname = 'zero_project_video_assets_project_idx_legacy'`
  );
  assert.equal(videoIndex.rowCount, 1);
  assert.equal(videoIndex.rows[0].index_name, 'zero_project_video_assets_project_idx_legacy', 'equivalent index under a legacy name is reused');
  assert.equal(videoIndex.rows[0].indisvalid, true);
  assert.equal(videoIndex.rows[0].indisready, true);
  assert.equal(videoIndex.rows[0].indisunique, false);
  assert.equal(videoIndex.rows[0].no_predicate, true);
  assert.equal(videoIndex.rows[0].indnkeyatts, 3);
  assert.equal(videoIndex.rows[0].indnatts, 3);
  assert.deepEqual(videoIndex.rows[0].options, [0, 0, 3], 'index sort bits encode ASC, ASC, DESC NULLS FIRST');
  assert.match(videoIndex.rows[0].definition, /principal_hash, project_id, created_at DESC/);

  // A separate empty schema exercises the fresh-install path where migration 3
  // creates the strict check and migration 4 must recognize it via the catalog.
  const freshSchema = `zero_revision_fresh_${randomUUID().replaceAll('-', '')}`;
  await adminPool.query(`CREATE SCHEMA "${freshSchema}"`);
  const freshPool = new Pool({ connectionString, options: `-c search_path=${freshSchema}`, max: 1 });
  try {
    await ensureZeroCostResourceSchema(freshPool);
    const freshVersions = await freshPool.query('SELECT version FROM zero_schema_migrations ORDER BY version');
    assert.deepEqual(freshVersions.rows.map((row) => Number(row.version)), [1, 2, 3, 4]);
    const freshPrincipalChecks = await freshPool.query<{ conname: string; convalidated: boolean; definition: string }>(
      `SELECT conname, convalidated, pg_get_constraintdef(oid, false) AS definition
       FROM pg_constraint
       WHERE conrelid = 'zero_project_video_assets'::regclass AND contype = 'c'`
    );
    const freshStrictCheck = freshPrincipalChecks.rows.find((row) => row.conname === 'zero_project_video_assets_principal_hash_check');
    assert.ok(freshStrictCheck?.convalidated, 'fresh schema keeps the already strict migration 3 principal check');
    assert.ok(freshStrictCheck.definition.includes('{64}$'), 'fresh strict check remains end anchored');
    assert.ok(
      freshPrincipalChecks.rows.every((row) => row.convalidated),
      'fresh migration 3 and migration 4 checks must all be validated',
    );
  } finally {
    await freshPool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${freshSchema}" CASCADE`);
  }

  // Invalid legacy rows must abort the complete migration transaction and leave
  // both the source row and the absence of migration metadata intact.
  const invalidSchema = `zero_revision_invalid_${randomUUID().replaceAll('-', '')}`;
  await adminPool.query(`CREATE SCHEMA "${invalidSchema}"`);
  const invalidPool = new Pool({ connectionString, options: `-c search_path=${invalidSchema}`, max: 1 });
  try {
    await adminPool.query(`
      CREATE TABLE "${invalidSchema}".zero_project_video_assets (
        asset_id UUID NOT NULL, project_id TEXT NOT NULL, scene_id TEXT NOT NULL,
        principal_hash CHAR(64) NOT NULL, job_id UUID, content_type TEXT NOT NULL,
        size_bytes BIGINT NOT NULL, sha256 CHAR(64) NOT NULL, payload BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await adminPool.query(
      `INSERT INTO "${invalidSchema}".zero_project_video_assets
       (asset_id, project_id, scene_id, principal_hash, content_type, size_bytes, sha256, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), 'invalid-legacy-project', 'invalid-legacy-scene', 'f'.repeat(64),
        'application/invalid', 1024, 'a'.repeat(64), Buffer.alloc(1024)]
    );
    await assert.rejects(
      () => ensureZeroCostResourceSchema(invalidPool),
      /ZERO-Ressourcenschema konnte nicht sicher initialisiert werden/,
    );
    const migrationTable = await invalidPool.query<{ migration_table: string | null }>(
      "SELECT to_regclass('zero_schema_migrations')::text AS migration_table"
    );
    assert.equal(migrationTable.rows[0]?.migration_table, null,
      'failed migration must not leave the version table or a version 4 record behind');
    const preservedInvalidRow = await invalidPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM zero_project_video_assets'
    );
    assert.equal(preservedInvalidRow.rows[0]?.count, '1',
      'migration failure must preserve the legacy row rather than silently deleting it');
  } finally {
    await invalidPool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${invalidSchema}" CASCADE`);
  }
  const projectVideoStore = createProjectVideoAssetStore(poolA);
  const projectVideoStoreB = createProjectVideoAssetStore(poolB);
  const videoPrincipal = 'd'.repeat(64);
  const otherVideoPrincipal = 'e'.repeat(64);
  const videoJobId = randomUUID();
  const mp4Payload = Buffer.alloc(8 * 1024 * 1024 + 1, 0x5a);
  mp4Payload.write('ftyp', 4, 'ascii');
  const archivedVideo = await projectVideoStore.put({
    projectId: 'project-video-integration',
    sceneId: 'scene-video-integration',
    principalHash: videoPrincipal,
    jobId: videoJobId,
    contentType: 'video/mp4',
    payload: mp4Payload,
  });
  assert.equal(archivedVideo.sizeBytes, mp4Payload.length);
  assert.match(archivedVideo.sha256, /^[a-f0-9]{64}$/);
  const backupVideoAssets = await projectVideoStoreB.listForBackup(videoPrincipal);
  assert.equal(backupVideoAssets.length, 1, 'ZIP backup enumeration includes all principal-owned clips');
  assert.deepEqual(backupVideoAssets[0].payload, mp4Payload,
    'ZIP backup enumeration returns the exact durable video bytes');
  assert.equal((await projectVideoStoreB.listForBackup(otherVideoPrincipal)).length, 0,
    'ZIP backup enumeration never crosses authenticated principal boundaries');
  await assert.rejects(
    () => projectVideoStoreB.listForBackup(videoPrincipal, 2048),
    /ZIP-Backup-Limit/,
    'backup enumeration must reject the full payload set before loading oversized media into memory',
  );
  await assert.rejects(
    () => projectVideoStore.put({
      projectId: 'project-video-integration', sceneId: 'scene-video-integration',
      principalHash: videoPrincipal, contentType: 'video/mp4', payload: mp4Payload.subarray(0, 2048),
      isProjectActive: async () => false,
    }),
    (error) => error instanceof ProjectVideoProjectNotFoundError,
    'an upload that waited behind project deletion must re-check authoritative project state',
  );
  assert.equal((await projectVideoStoreB.list('project-video-integration', videoPrincipal)).length, 1);
  assert.equal((await projectVideoStoreB.list('project-video-integration', otherVideoPrincipal)).length, 0);
  assert.equal(await projectVideoStoreB.get(archivedVideo.id, 'project-video-integration', otherVideoPrincipal), null);
  assert.equal(await projectVideoStoreB.remove(archivedVideo.id, 'project-video-integration', otherVideoPrincipal), false);
  assert.equal(await projectVideoStoreB.removeProject('project-video-integration', otherVideoPrincipal), 0);

  const archivedVideoBytes = await projectVideoStoreB.get(
    archivedVideo.id, 'project-video-integration', videoPrincipal
  );
  assert.deepEqual(archivedVideoBytes?.payload, mp4Payload,
    'large binary clip bytes survive cross-pool PostgreSQL readback');
  assert.equal(
    (await projectVideoStoreB.getLatestForScene('project-video-integration', 'scene-video-integration', videoPrincipal))?.id,
    archivedVideo.id,
  );
  const idempotentArchive = await projectVideoStoreB.put({
    projectId: 'project-video-integration',
    sceneId: 'scene-video-integration',
    principalHash: videoPrincipal,
    jobId: videoJobId,
    contentType: 'video/mp4',
    payload: mp4Payload,
  });
  assert.equal(idempotentArchive.id, archivedVideo.id, 'retrying the same Wan job must not duplicate the project clip');

  // Exercise the actual PostgreSQL BYTEA chunk reader through HTTP. The test
  // principal is bound by each route closure, never supplied by the request.
  const videoHttpApp = express();
  let maxVideoChunkBytes = 0;
  videoHttpApp.get('/owner/:assetId', asyncRoute(async (req, res) => {
    const opened = await projectVideoStoreB.openRead(req.params.assetId, 'project-video-integration', videoPrincipal);
    if (!opened) return res.sendStatus(404);
    const chunksForRange = (start?: number, end?: number) => (async function* () {
      for await (const chunk of opened.chunksForRange(start, end)) {
        maxVideoChunkBytes = Math.max(maxVideoChunkBytes, chunk.length);
        yield chunk;
      }
    })();
    return sendProjectVideoStream(req, res, { ...opened, chunksForRange });
  }));
  videoHttpApp.get('/other/:assetId', asyncRoute(async (req, res) => {
    const opened = await projectVideoStoreB.openRead(req.params.assetId, 'project-video-integration', otherVideoPrincipal);
    if (!opened) return res.sendStatus(404);
    return sendProjectVideoStream(req, res, opened);
  }));
  const videoHttpServer = videoHttpApp.listen(0);
  await once(videoHttpServer, 'listening');
  const videoHttpAddress = videoHttpServer.address();
  if (!videoHttpAddress || typeof videoHttpAddress === 'string') throw new Error('Project video HTTP test server did not bind.');
  const videoHttpBase = `http://127.0.0.1:${videoHttpAddress.port}`;
  try {
    const firstRange = await fetch(`${videoHttpBase}/owner/${archivedVideo.id}`, {
      headers: { Range: 'bytes=0-65535' },
    });
    assert.equal(firstRange.status, 206);
    assert.equal(firstRange.headers.get('accept-ranges'), 'bytes');
    assert.equal(firstRange.headers.get('content-range'), `bytes 0-65535/${mp4Payload.length}`);
    const reader = firstRange.body?.getReader();
    assert.ok(reader);
    const firstChunk = await reader.read();
    assert.ok(firstChunk.value && firstChunk.value.length > 0);
    const resumedPrefix = Buffer.from(firstChunk.value.subarray(0, 4096));
    await reader.cancel();

    const resumed = await fetch(`${videoHttpBase}/owner/${archivedVideo.id}`, {
      headers: {
        Range: `bytes=${resumedPrefix.length}-`,
        'If-Range': firstRange.headers.get('etag') ?? '',
      },
    });
    assert.equal(resumed.status, 206);
    assert.equal(resumed.headers.get('content-range'), `bytes ${resumedPrefix.length}-${mp4Payload.length - 1}/${mp4Payload.length}`);
    const resumedBytes = Buffer.from(await resumed.arrayBuffer());
    assert.deepEqual(Buffer.concat([resumedPrefix, resumedBytes]), mp4Payload,
      'an interrupted iPhone-style range download can resume byte-exactly');

    const forbidden = await fetch(`${videoHttpBase}/other/${archivedVideo.id}`);
    assert.equal(forbidden.status, 404, 'another principal must not stream the asset');
    const invalidRange = await fetch(`${videoHttpBase}/owner/${archivedVideo.id}`, {
      headers: { Range: `bytes=${mp4Payload.length}-` },
    });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get('content-range'), `bytes */${mp4Payload.length}`);
    assert.ok(maxVideoChunkBytes <= 256 * 1024,
      'PostgreSQL streaming must never materialize a database chunk larger than 256 KiB');
  } finally {
    await new Promise<void>((resolve, reject) => videoHttpServer.close((error) => error ? reject(error) : resolve()));
  }

  // Slow/parallel video streams intentionally retain a shared row lock and
  // one pool connection each for a byte-consistent response. Verify the
  // configured stream pool can serve concurrent readers, exposes bounded
  // queueing rather than opening unbounded connections, and blocks deletion
  // until all readers close their transactions.
  const concurrentVideo = await projectVideoStore.put({
    projectId: 'project-video-integration',
    sceneId: 'scene-video-parallel',
    principalHash: videoPrincipal,
    contentType: 'video/mp4',
    payload: mp4Payload,
  });
  const concurrentStreamStore = createProjectVideoAssetStore(gatePoolA);
  const appStateStoreDuringStreams = createPostgresStateStore(gatePoolA);
  await appStateStoreDuringStreams.ensureSchema();
  await concurrentStreamStore.list('project-video-integration', videoPrincipal); // initialize schema before parallel opens
  assert.equal(POSTGRES_POOL_MAX, 5, 'test imports exact production PostgreSQL pool maximum');
  const concurrentStreams = await Promise.all(Array.from({ length: 2 }, () =>
    concurrentStreamStore.openRead(concurrentVideo.id, 'project-video-integration', videoPrincipal)
  ));
  assert.ok(concurrentStreams.every(Boolean), 'both admitted stream readers acquire a row snapshot');
  assert.equal(gatePoolA.totalCount, 2, 'only two of five production connections are reserved by video streams');
  const concurrentIterators = concurrentStreams.map((stream) =>
    stream!.chunksForRange(0, 512 * 1024 - 1)[Symbol.asyncIterator]()
  );
  let deleteCompleted = false;
  let thirdStreamCompleted = false;
  let thirdStreamPromise: Promise<Awaited<ReturnType<typeof concurrentStreamStore.openRead>>> | null = null;
  let deleteGuardStream: Awaited<ReturnType<typeof concurrentStreamStore.openRead>> = null;
  let deleteGuardIterator: AsyncIterator<Buffer> | null = null;
  try {
    const firstChunks = await Promise.all(concurrentIterators.map((iterator) => iterator.next()));
    assert.ok(firstChunks.every((entry) => entry.value && entry.value.length > 0));
    assert.ok(firstChunks.every((entry) => entry.value!.length <= 256 * 1024),
      'slow streams still read no more than 256 KiB per DB chunk');
    const thirdStream = concurrentStreamStore.openRead(
      concurrentVideo.id, 'project-video-integration', videoPrincipal
    ).then((stream) => { thirdStreamCompleted = true; return stream; });
    thirdStreamPromise = thirdStream;
    const appOperation = await appStateStoreDuringStreams.read();
    assert.equal(appOperation, null,
      'the actual persistent application-state read completes while two video streams are paused');
    assert.equal(gatePoolA.totalCount, 3, 'two video readers and one app query fit in production max=5');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(thirdStreamCompleted, false, 'third video stream waits before checking out another DB connection');

    await concurrentIterators[0].return?.();
    const third = await thirdStream;
    assert.ok(third, 'queued third stream is admitted as soon as one active slot is released');
    assert.equal(thirdStreamCompleted, true);
    await concurrentIterators[1].return?.();
    await third!.close();

    // Independently prove the row lock blocks deletion while a reader is active.
    deleteGuardStream = await concurrentStreamStore.openRead(
      concurrentVideo.id, 'project-video-integration', videoPrincipal
    );
    assert.ok(deleteGuardStream);
    deleteGuardIterator = deleteGuardStream!.chunksForRange(0, 512 * 1024 - 1)[Symbol.asyncIterator]();
    await deleteGuardIterator.next();
    const blockedDelete = projectVideoStoreB.remove(
      concurrentVideo.id, 'project-video-integration', videoPrincipal
    ).then((removed) => { deleteCompleted = true; return removed; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(deleteCompleted, false, 'shared row lock preserves bytes during an active stream');
    await deleteGuardIterator.return?.();
    await deleteGuardStream!.close();
    assert.equal(await blockedDelete, true, 'deletion proceeds after the active stream releases its row lock');
  } finally {
    await Promise.all(concurrentIterators.map(async (iterator) => {
      try { await iterator.return?.(); } catch { /* cleanup continues */ }
    }));
    if (deleteGuardIterator) await deleteGuardIterator.return?.().catch(() => undefined);
    if (deleteGuardStream) await deleteGuardStream.close().catch(() => undefined);
    if (thirdStreamPromise) await thirdStreamPromise.then((stream) => stream?.close()).catch(() => undefined);
    await projectVideoStoreB.remove(concurrentVideo.id, 'project-video-integration', videoPrincipal).catch(() => false);
  }

  const projectCleanupVideo = await projectVideoStore.put({
    projectId: 'project-video-integration',
    sceneId: 'scene-project-cleanup',
    principalHash: videoPrincipal,
    contentType: 'video/mp4',
    payload: mp4Payload.subarray(0, 2048),
  });
  assert.ok(projectCleanupVideo.id);
  assert.equal(await projectVideoStoreB.remove(archivedVideo.id, 'project-video-integration', videoPrincipal), true);
  assert.equal(await projectVideoStore.removeProject('project-video-integration', videoPrincipal), 1,
    'project deletion removes remaining archived clip bytes');
  assert.equal(await projectVideoStoreB.removeProject('project-video-integration', videoPrincipal), 0,
    'project cleanup is safe to retry after an uncertain response');

  // Limits are checked under the same cross-instance project advisory lock,
  // so concurrent uploads cannot exceed count or byte budgets.
  const limitedA = createProjectVideoAssetStore(poolA, {
    maxProjectVideoBytes: 4096, maxProjectStorageBytes: 4096, maxProjectVideoCount: 2,
  });
  const limitedB = createProjectVideoAssetStore(poolB, {
    maxProjectVideoBytes: 4096, maxProjectStorageBytes: 4096, maxProjectVideoCount: 2,
  });
  const limitedPayload = Buffer.alloc(2048);
  limitedPayload.write('ftyp', 4, 'ascii');
  const limitedWrites = await Promise.allSettled([
    limitedA.put({ projectId: 'project-video-limits', sceneId: 'scene-a', principalHash: videoPrincipal, jobId: randomUUID(), contentType: 'video/mp4', payload: limitedPayload }),
    limitedB.put({ projectId: 'project-video-limits', sceneId: 'scene-b', principalHash: videoPrincipal, jobId: randomUUID(), contentType: 'video/mp4', payload: limitedPayload }),
    limitedA.put({ projectId: 'project-video-limits', sceneId: 'scene-c', principalHash: videoPrincipal, jobId: randomUUID(), contentType: 'video/mp4', payload: limitedPayload }),
  ]);
  assert.equal(limitedWrites.filter((item) => item.status === 'fulfilled').length, 2,
    'concurrent uploads cannot exceed the project clip count/byte limits');
  assert.equal(limitedWrites.filter((item) => item.status === 'rejected' && item.reason instanceof ProjectVideoLimitError).length, 1);
  assert.equal((await limitedB.list('project-video-limits', videoPrincipal)).length, 2);

  const byteLimitedA = createProjectVideoAssetStore(poolA, {
    maxProjectVideoBytes: 3000, maxProjectStorageBytes: 3000, maxProjectVideoCount: 5,
  });
  const byteLimitedB = createProjectVideoAssetStore(poolB, {
    maxProjectVideoBytes: 3000, maxProjectStorageBytes: 3000, maxProjectVideoCount: 5,
  });
  const byteLimitedWrites = await Promise.allSettled([
    byteLimitedA.put({ projectId: 'project-video-byte-limit', sceneId: 'scene-a', principalHash: videoPrincipal, contentType: 'video/mp4', payload: limitedPayload }),
    byteLimitedB.put({ projectId: 'project-video-byte-limit', sceneId: 'scene-b', principalHash: videoPrincipal, contentType: 'video/mp4', payload: limitedPayload }),
  ]);
  assert.equal(byteLimitedWrites.filter((item) => item.status === 'fulfilled').length, 1,
    'concurrent uploads cannot exceed the byte budget even when the clip-count limit is not reached');
  assert.equal(byteLimitedWrites.filter((item) => item.status === 'rejected' && item.reason instanceof ProjectVideoLimitError).length, 1);
  assert.equal((await byteLimitedA.list('project-video-byte-limit', videoPrincipal)).length, 1);

  // Production auth state must be shared across independent Node-process pools.
  const authA = createPostgresAuthStore(poolA);
  const authB = createPostgresAuthStore(poolB);
  const unavailableAuthPool = {
    connect: async () => { throw new Error('injected unavailable PostgreSQL auth store'); },
  } as unknown as Pool;
  const unavailableAuthStore = createPostgresAuthStore(unavailableAuthPool);
  await assert.rejects(
    () => unavailableAuthStore.hasSession('d'.repeat(64)),
    /injected unavailable PostgreSQL auth store/,
    'session validation must fail closed when PostgreSQL cannot be reached',
  );
  await assert.rejects(
    () => unavailableAuthStore.consumeLoginAttempt('e'.repeat(64), new Date(), 60_000, 3),
    /injected unavailable PostgreSQL auth store/,
    'login attempts must not be admitted when persistent rate-limit storage is unavailable',
  );
  await Promise.all([authA.ensureSchema(), authB.ensureSchema()]);
  const sessionHash = 'a'.repeat(64);
  await authA.createSession(sessionHash, new Date(Date.now() + 60_000));
  assert.equal(await authB.hasSession(sessionHash), true, 'a session created on pool A must validate on pool B');
  await authB.deleteSession(sessionHash);
  assert.equal(await authA.hasSession(sessionHash), false, 'logout on pool B must revoke the session on pool A');
  await authA.createSession('b'.repeat(64), new Date(Date.now() - 1));
  assert.equal(await authB.hasSession('b'.repeat(64)), false, 'expired sessions must fail closed across pools');

  // Additive multi-user migration: legacy admin sessions and state are copied
  // once into user-bound tables without mutating their original records.
  const legacySessionHash = 'c'.repeat(64);
  const legacyExpiry = new Date(Date.now() + 120_000);
  await authA.createSession(legacySessionHash, legacyExpiry);
  let legacyAdminStateBefore = await poolA.query<{ payload: unknown; revision: string }>(
    "SELECT payload, revision FROM zero_app_state WHERE id = 'primary'",
  );
  if (!legacyAdminStateBefore.rows[0]) {
    const fixture = { projects: [{ id: 'legacy-admin-project', title: 'Preserve me' }] };
    await poolA.query(
      `INSERT INTO zero_app_state (id, payload, revision) VALUES ('primary', $1::jsonb, 7)`,
      [JSON.stringify(fixture)],
    );
    legacyAdminStateBefore = await poolA.query<{ payload: unknown; revision: string }>(
      "SELECT payload, revision FROM zero_app_state WHERE id = 'primary'",
    );
  }
  const legacyAdminPayload = legacyAdminStateBefore.rows[0].payload;
  const legacyAdminRevision = Number(legacyAdminStateBefore.rows[0].revision);
  const multiUserA = createMultiUserAuthStore(poolA);
  const multiUserB = createMultiUserAuthStore(poolB);
  await Promise.all([multiUserA.ensureSchema(), multiUserB.ensureSchema()]);
  const migratedAdmin = await poolA.query<{ user_id: string; role: string }>(
    'SELECT user_id, role FROM zero_users WHERE user_id = $1',
    [ZERO_LEGACY_ADMIN_USER_ID],
  );
  assert.deepEqual(migratedAdmin.rows[0], { user_id: 'admin:primary', role: 'admin' });
  assert.equal((await multiUserB.getSession(legacySessionHash))?.id, ZERO_LEGACY_ADMIN_USER_ID,
    'an existing valid admin session must migrate to the original admin principal');
  assert.equal(await authB.hasSession(legacySessionHash), true,
    'migration must preserve the original legacy session for rollback compatibility');
  const migratedState = await multiUserB.readState<typeof legacyAdminPayload>(ZERO_LEGACY_ADMIN_USER_ID);
  assert.deepEqual(migratedState, { payload: legacyAdminPayload, revision: legacyAdminRevision },
    'legacy primary state must be copied intact to the admin account exactly once');

  const account = await multiUserA.createUser('  Studio.User@Example.com ', 'a-long-user-password-123');
  assert.equal(account.email, 'studio.user@example.com');
  assert.equal((await multiUserB.authenticateUser('STUDIO.USER@example.com', 'a-long-user-password-123'))?.id, account.id,
    'normalized email and scrypt password credentials must authenticate across pools');
  assert.equal(await multiUserB.authenticateUser(account.email!, 'incorrect-password-123'), null,
    'invalid passwords must not authenticate');
  await assert.rejects(() => multiUserA.createUser('second@example.com', 'short'),
    /zwischen 12 und 1024 Zeichen/);
  await assert.rejects(() => multiUserA.createUser('not-an-email', 'a-long-user-password-123'),
    /Ungültige E-Mail-Adresse/);

  const userSessionHash = 'd'.repeat(64);
  await multiUserA.createSession(userSessionHash, account.id, new Date(Date.now() + 120_000));
  assert.equal((await multiUserB.getSession(userSessionHash))?.id, account.id,
    'user sessions must resolve to their own immutable principal across pools');
  assert.equal(await multiUserB.getSession('f'.repeat(64)), null);
  await multiUserB.deleteSession(userSessionHash);
  assert.equal(await multiUserA.getSession(userSessionHash), null, 'user logout must revoke the shared session');

  const adminRevision = await multiUserA.writeState(
    ZERO_LEGACY_ADMIN_USER_ID,
    { projects: [{ id: 'legacy-admin-project', title: 'Admin only' }] },
    legacyAdminRevision,
  );
  const userRevision = await multiUserB.writeState(account.id, { projects: [{ id: 'private-user-project' }] }, 0);
  assert.equal(adminRevision, legacyAdminRevision + 1);
  assert.equal(userRevision, 1);
  assert.equal((await multiUserA.readState<{ projects: Array<{ id: string }> }>(ZERO_LEGACY_ADMIN_USER_ID))?.payload.projects[0].id,
    'legacy-admin-project');
  assert.equal((await multiUserB.readState<{ projects: Array<{ id: string }> }>(account.id))?.payload.projects[0].id,
    'private-user-project');
  await assert.rejects(() => multiUserA.writeState(account.id, { projects: [] }, 0), /parallel geändert/,
    'stale user-state revisions must conflict rather than overwrite newer data');


  // If auth schema initialization cannot roll back, its checked-out session
  // must be destroyed instead of being returned to the pool in unknown state.
  let failedAuthSchemaRelease: Error | boolean | undefined;
  const failedAuthSchemaClient = {
    query: async (sql: string) => {
      if (sql === 'BEGIN') throw new Error('injected auth BEGIN transport failure');
      if (sql === 'ROLLBACK') throw new Error('injected auth ROLLBACK transport failure');
      return { rows: [] };
    },
    release: (error?: Error | boolean) => { failedAuthSchemaRelease = error; },
  };
  const failedAuthSchemaPool = {
    connect: async () => failedAuthSchemaClient,
  } as unknown as Pool;
  await assert.rejects(
    () => createPostgresAuthStore(failedAuthSchemaPool).ensureSchema(),
    /injected auth BEGIN transport failure/,
  );
  assert.equal(failedAuthSchemaRelease, true,
    'an auth schema connection with uncertain transaction state must be destroyed');

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
  const expiredWindow = await authB.consumeLoginAttempt(
    loginKeyHash, new Date(loginNow.getTime() + 16 * 60 * 1000), 15 * 60 * 1000, 8
  );
  assert.equal(expiredWindow.attempts, 1, 'expired login windows must reset atomically across pools');

  // A failed cost-reservation transaction must also destroy a client if
  // PostgreSQL cannot confirm rollback. This path never invokes a provider.
  let failedCostRollbackRelease: Error | boolean | undefined;
  const failedCostRollbackClient = {
    query: async (sql: string) => {
      if (sql === 'BEGIN') throw new Error('injected cost BEGIN transport failure');
      if (sql === 'ROLLBACK') throw new Error('injected cost ROLLBACK transport failure');
      return { rows: [] };
    },
    release: (error?: Error | boolean) => { failedCostRollbackRelease = error; },
  };
  const failedCostRollbackPool = {
    connect: async () => failedCostRollbackClient,
  } as unknown as Pool;
  await assert.rejects(
    () => reserveZeroCostProviderRequestWithPool(failedCostRollbackPool, {
      provider: 'cloudflare-workers-ai',
      modelId: '@cf/zai-org/glm-4.7-flash',
      studio: 'ZERO CORE',
      action: 'ROLLBACK_FAILURE_TEST',
    }, {
      DATABASE_URL: connectionString,
      ZERO_COST_GUARD_ENABLED: 'true',
      ZERO_COST_GUARD_FREE_ONLY_CONFIRMED: 'true',
      ZERO_COST_GUARD_DAILY_REQUEST_LIMIT: '5',
      ZERO_CLOUDFLARE_AI_ENABLED: 'true',
      ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'true',
    }),
    /Persistente Kostenreservierung fehlgeschlagen/,
  );
  assert.equal(failedCostRollbackRelease, true,
    'an uncertain cost reservation transaction must destroy its pooled connection');

  // Shared resource reservations are idempotent and transactional across
  // independent instances. This fixture performs database-only operations.
  await ensureZeroResourceSchemaWithPool(poolA);
  const resourceKey = `resource-idempotency-${randomUUID()}`;
  const resourceInput = {
    principalId: 'admin:primary',
    resourceId: 'piper-tts' as const,
    idempotencyKey: resourceKey,
    units: 12,
    requestFingerprint: createHash('sha256').update('same-piper-request').digest('hex'),
  };
  const [resourceReservationA, resourceReservationB] = await Promise.all([
    reserveZeroResourceWithPool(poolA, resourceInput),
    reserveZeroResourceWithPool(poolB, resourceInput),
  ]);
  assert.equal(resourceReservationA.reservationId, resourceReservationB.reservationId,
    'concurrent same-key requests across instances must resolve to one reservation');
  assert.equal([resourceReservationA, resourceReservationB].filter((entry) => !entry.duplicate).length, 1,
    'exactly one same-key request creates the reservation');
  await assert.rejects(
    () => reserveZeroResourceWithPool(poolB, {
      ...resourceInput,
      requestFingerprint: createHash('sha256').update('different-piper-request').digest('hex'),
    }),
    /Idempotenzschlüssel wurde bereits mit anderen Parametern verwendet/,
    'an idempotency key must not be replayed with a different request fingerprint',
  );
  assert.equal(
    await settleZeroResourceReservationWithPool(poolB, {
      principalId: 'admin:primary', reservationId: resourceReservationA.reservationId, outcome: 'completed',
    }),
    true,
    'a reservation can be completed from a second instance',
  );
  assert.equal(
    await settleZeroResourceReservationWithPool(poolA, {
      principalId: 'admin:primary', reservationId: resourceReservationA.reservationId, outcome: 'released',
    }),
    false,
    'a completed reservation cannot be settled a second time',
  );
  const recoveredResourceReservation = await getZeroResourceReservationWithPool(poolB, {
    principalId: 'admin:primary', reservationId: resourceReservationA.reservationId,
  });
  assert.equal(recoveredResourceReservation?.status, 'completed',
    'reservation status must survive independent-pool reads');

  // Wan GPU jobs hold their concurrency reservation until the durable worker
  // reaches a terminal state. The mapping must survive instance changes and retries.
  await ensureWanJobReservationSchemaWithPool(poolA);
  const wanInput = {
    principalId: 'admin:primary',
    resourceId: 'wan-video' as const,
    idempotencyKey: `wan-job-link-${randomUUID()}`,
    units: 1,
    requestFingerprint: createHash('sha256').update('wan-job-request').digest('hex'),
  };
  const [wanReservation, wanRetryReservation] = await Promise.all([
    reserveZeroResourceWithPool(poolA, wanInput),
    reserveZeroResourceWithPool(poolB, wanInput),
  ]);
  assert.equal(wanRetryReservation.reservationId, wanReservation.reservationId,
    'Wan retries across instances must share one durable reservation');
  assert.equal([wanReservation, wanRetryReservation].filter((entry) => !entry.duplicate).length, 1,
    'exactly one concurrent Wan request creates the reservation');
  const workerJobId = randomUUID();
  await linkWanJobReservationWithPool(poolA, {
    workerJobId, reservationId: wanReservation.reservationId, principalId: 'admin:primary',
  });
  await linkWanJobReservationWithPool(poolB, {
    workerJobId, reservationId: wanReservation.reservationId, principalId: 'admin:primary',
  });
  assert.equal(await getZeroResourceReservationWithPool(poolA, {
    principalId: 'admin:primary', reservationId: wanReservation.reservationId,
  }).then((value) => value?.status), 'reserved',
  'Wan reservation remains active while its worker job is queued or running');
  await assert.rejects(
    () => reserveZeroResourceWithPool(poolB, {
      principalId: 'admin:primary',
      resourceId: 'wan-video',
      idempotencyKey: `wan-concurrency-block-${randomUUID()}`,
      units: 1,
      requestFingerprint: createHash('sha256').update('second-wan-job').digest('hex'),
    }),
    /Parallelitätslimit/,
    'a second Wan job must be blocked while the first worker job is queued or running',
  );
  assert.equal(await settleWanJobReservationWithPool(poolB, {
    workerJobId, principalId: 'admin:primary', outcome: 'completed',
  }), true, 'successful Wan jobs complete their reservation from another instance');
  assert.equal(await getZeroResourceReservationWithPool(poolA, {
    principalId: 'admin:primary', reservationId: wanReservation.reservationId,
  }).then((value) => value?.status), 'completed');
  const completedWanRetry = await reserveZeroResourceWithPool(poolB, wanInput);
  assert.equal(completedWanRetry.duplicate, true);
  assert.equal(completedWanRetry.status, 'completed',
    'a completed Wan idempotency key must remain terminal and must never admit a new worker job');
  assert.equal(await settleWanJobReservationWithPool(poolA, {
    workerJobId, principalId: 'admin:primary', outcome: 'completed',
  }), false, 'terminal job settlement is idempotent');
  const conflictingWanReservation = await reserveZeroResourceWithPool(poolA, {
    principalId: 'admin:primary',
    resourceId: 'wan-video',
    idempotencyKey: `wan-job-conflict-${randomUUID()}`,
    units: 1,
    requestFingerprint: createHash('sha256').update('other-wan-request').digest('hex'),
  });
  await assert.rejects(
    () => linkWanJobReservationWithPool(poolB, {
      workerJobId, reservationId: conflictingWanReservation.reservationId, principalId: 'admin:primary',
    }),
    /already linked to a different resource reservation/,
    'a worker job must never be rebound to a different resource reservation',
  );
  await settleZeroResourceReservationWithPool(poolA, {
    principalId: 'admin:primary', reservationId: conflictingWanReservation.reservationId, outcome: 'released',
  });
  // The next assertions exercise a separate worker lifecycle. Reset only the
  // minute bucket so this scenario does not inherit the two reservations used
  // above; daily usage and all reservation history remain intact.
  await poolA.query(
    "DELETE FROM zero_resource_rate_windows WHERE principal_id = 'admin:primary' AND resource_id = 'wan-video'"
  );
  const failedWanReservation = await reserveZeroResourceWithPool(poolA, {
    principalId: 'admin:primary', resourceId: 'wan-video',
    idempotencyKey: `wan-job-failed-${randomUUID()}`, units: 1,
    requestFingerprint: createHash('sha256').update('failed-wan-job').digest('hex'),
  });
  const failedWorkerJobId = randomUUID();
  await linkWanJobReservationWithPool(poolA, {
    workerJobId: failedWorkerJobId, reservationId: failedWanReservation.reservationId,
    principalId: 'admin:primary',
  });
  assert.equal(await settleWanJobReservationWithPool(poolB, {
    workerJobId: failedWorkerJobId, principalId: 'admin:primary', outcome: 'released',
  }), true, 'failed or cancelled Wan jobs release their active slot');
  assert.equal(await getZeroResourceReservationWithPool(poolA, {
    principalId: 'admin:primary', reservationId: failedWanReservation.reservationId,
  }).then((value) => value?.status), 'released',
  'failed or cancelled Wan jobs must be recorded as released, not completed');
  assert.equal(await settleWanJobReservationWithPool(poolA, {
    workerJobId: failedWorkerJobId, principalId: 'admin:primary', outcome: 'released',
  }), false, 'failed-job settlement is idempotent');

  // A database-side failure during reservation must roll back the reservation,
  // daily usage and rate-window increment together; the same pool remains usable.
  await poolA.query(`
    CREATE FUNCTION reject_zero_resource_reservation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected resource reservation failure' USING ERRCODE = 'P0001';
    END;
    $$;
    CREATE TRIGGER reject_zero_resource_reservation
    BEFORE INSERT ON zero_resource_reservations
    FOR EACH ROW EXECUTE FUNCTION reject_zero_resource_reservation();
  `);
  const failedResourceKey = `resource-failure-${randomUUID()}`;
  const resourceUsageBeforeFailure = await poolA.query<{ jobs_started: string; units_used: string }>(
    `SELECT jobs_started::text, units_used::text FROM zero_resource_daily_usage
     WHERE principal_id = 'admin:primary' AND resource_id = 'piper-tts'
       AND day_utc = (NOW() AT TIME ZONE 'UTC')::date`,
  );
  const rateBeforeFailure = await poolA.query<{ request_count: number }>(
    `SELECT request_count FROM zero_resource_rate_windows
     WHERE principal_id = 'admin:primary' AND resource_id = 'piper-tts'
       AND window_start = date_trunc('minute', NOW())`,
  );
  await assert.rejects(
    () => reserveZeroResourceWithPool(poolA, { ...resourceInput, idempotencyKey: failedResourceKey }),
    /Reservierung fehlgeschlagen/,
    'a PostgreSQL trigger failure must fail the reservation closed',
  );
  await poolA.query('DROP TRIGGER reject_zero_resource_reservation ON zero_resource_reservations');
  await poolA.query('DROP FUNCTION reject_zero_resource_reservation()');
  const resourceUsageAfterFailure = await poolB.query<{ jobs_started: string; units_used: string }>(
    `SELECT jobs_started::text, units_used::text FROM zero_resource_daily_usage
     WHERE principal_id = 'admin:primary' AND resource_id = 'piper-tts'
       AND day_utc = (NOW() AT TIME ZONE 'UTC')::date`,
  );
  const rateAfterFailure = await poolB.query<{ request_count: number }>(
    `SELECT request_count FROM zero_resource_rate_windows
     WHERE principal_id = 'admin:primary' AND resource_id = 'piper-tts'
       AND window_start = date_trunc('minute', NOW())`,
  );
  assert.deepEqual(resourceUsageAfterFailure.rows, resourceUsageBeforeFailure.rows,
    'failed reservation must not consume daily job or unit budget');
  assert.deepEqual(rateAfterFailure.rows, rateBeforeFailure.rows,
    'failed reservation must not consume the minute rate limit');
  const afterResourceRollback = await reserveZeroResourceWithPool(poolB, {
    ...resourceInput, idempotencyKey: failedResourceKey,
  });
  assert.equal(afterResourceRollback.duplicate, false,
    'a rolled-back idempotency key must remain available for a later successful request');
  await settleZeroResourceReservationWithPool(poolA, {
    principalId: 'admin:primary', reservationId: afterResourceRollback.reservationId, outcome: 'released',
  });

  // Isolated cost-ledger fixture: an audit-write failure after the budget
  // UPSERT must roll the budget increment back in the same transaction.
  const costRollbackSchema = `zero_cost_rollback_${randomUUID().replaceAll('-', '')}`;
  await adminPool.query(`CREATE SCHEMA "${costRollbackSchema}"`);
  const costRollbackPool = new Pool({ connectionString, options: `-c search_path=${costRollbackSchema}`, max: 1 });
  try {
    const rollbackEnv = {
      DATABASE_URL: connectionString,
      ZERO_COST_GUARD_ENABLED: 'true',
      ZERO_COST_GUARD_FREE_ONLY_CONFIRMED: 'true',
      ZERO_COST_GUARD_DAILY_REQUEST_LIMIT: '4',
      ZERO_CLOUDFLARE_AI_ENABLED: 'true',
      ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'true',
    };
    const rollbackRequest = {
      provider: 'cloudflare-workers-ai' as const,
      modelId: '@cf/zai-org/glm-4.7-flash',
      studio: 'ZERO CORE',
      action: 'COST_ROLLBACK_FIXTURE',
    };
    const firstCostReservation = await reserveZeroCostProviderRequestWithPool(
      costRollbackPool, rollbackRequest, rollbackEnv,
    );
    assert.equal(firstCostReservation.requestsUsed, 1);
    await costRollbackPool.query(`
      CREATE FUNCTION reject_cost_audit_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'COST_ROLLBACK_TRIGGER_TEST' THEN
          RAISE EXCEPTION 'injected cost audit failure' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_cost_audit_insert
      BEFORE INSERT ON zero_cost_audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_cost_audit_insert();
    `);
    await assert.rejects(
      () => reserveZeroCostProviderRequestWithPool(costRollbackPool, {
        ...rollbackRequest, action: 'COST_ROLLBACK_TRIGGER_TEST',
      }, rollbackEnv),
      /Persistente Kostenreservierung fehlgeschlagen/,
      'an audit failure after the budget UPSERT must abort the provider reservation',
    );
    const budgetAfterFailedAudit = await costRollbackPool.query<{ requests_used: number }>(
      `SELECT requests_used FROM zero_cost_daily_budget WHERE scope = 'global'`,
    );
    assert.equal(budgetAfterFailedAudit.rows[0]?.requests_used, 1,
      'a failed audit insert must roll back the preceding global budget increment');
    await costRollbackPool.query('DROP TRIGGER reject_cost_audit_insert ON zero_cost_audit_events');
    await costRollbackPool.query('DROP FUNCTION reject_cost_audit_insert()');
    const retriedCostReservation = await reserveZeroCostProviderRequestWithPool(
      costRollbackPool, { ...rollbackRequest, action: 'COST_ROLLBACK_RETRY' }, rollbackEnv,
    );
    assert.equal(retriedCostReservation.requestsUsed, 2,
      'the same available budget slot must remain usable after the failed transaction');
  } finally {
    await costRollbackPool.end();
    await adminPool.query(`DROP SCHEMA "${costRollbackSchema}" CASCADE`);
  }

  // Simulated pool failures must fail closed without provider execution.
  const unavailablePool = { connect: async () => { throw new Error('injected unavailable PostgreSQL'); } } as unknown as Pool;
  await assert.rejects(
    () => reserveZeroResourceWithPool(unavailablePool, { ...resourceInput, idempotencyKey: `db-down-${randomUUID()}` }),
    /PostgreSQL nicht verfügbar/,
    'resource reservation must remain blocked when PostgreSQL is unreachable',
  );

  // The shared ZERO cost ledger is atomic across independent pools and survives
  // a fresh pool (process-restart simulation). No provider or network is called.
  const costGuardEnv = {
    DATABASE_URL: connectionString,
    NODE_ENV: 'test',
    ZERO_COST_GUARD_ENABLED: 'true',
    ZERO_COST_GUARD_FREE_ONLY_CONFIRMED: 'true',
    ZERO_COST_GUARD_DAILY_REQUEST_LIMIT: '5',
    ZERO_CLOUDFLARE_AI_ENABLED: 'true',
    ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'true',
    ZERO_GEMINI_FREE_TIER_ONLY: 'true',
  };
  const costRequest = {
    provider: 'cloudflare-workers-ai' as const,
    modelId: '@cf/zai-org/glm-4.7-flash',
    studio: 'ZERO CORE',
    action: 'POSTGRES_CONCURRENCY_TEST',
  };
  const costReservations = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    reserveZeroCostProviderRequestWithPool(index % 2 ? poolA : poolB, index % 2 ? costRequest : {
      provider: 'google-gemini-free' as const,
      modelId: 'gemini-2.5-flash-lite',
      studio: 'ZERO MEMORY',
      action: 'POSTGRES_CONCURRENCY_TEST',
    }, costGuardEnv)
      .then(() => true)
      .catch((error: unknown) => {
        assert.match(error instanceof Error ? error.message : String(error), /Tagesbudget ausgeschöpft/);
        return false;
      })
  ));
  assert.equal(costReservations.filter(Boolean).length, 5, 'global budget must admit exactly five concurrent reservations across pools');
  const restartPool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1 });
  try {
    await assert.rejects(
      () => reserveZeroCostProviderRequestWithPool(restartPool, costRequest, costGuardEnv),
      /Tagesbudget ausgeschöpft/,
      'a new pool must observe the persisted exhausted budget after a process restart'
    );
  } finally {
    await restartPool.end();
  }

  const exhaustedStatus = await getZeroCostGuardStatus(poolA, costGuardEnv);
  assert.equal(exhaustedStatus.requestsUsed, 5);
  assert.equal(exhaustedStatus.remainingRequests, 0);
  assert.equal(exhaustedStatus.providers.cloudflare, 'GESPERRT', 'exhausted budget must show Cloudflare blocked in dashboard');
  assert.equal(exhaustedStatus.providers.gemini, 'GESPERRT', 'exhausted budget must show Gemini blocked in dashboard');
  assert.equal(exhaustedStatus.recentEvents.length > 0, true);
  await setZeroCostGuardPaused(poolA, true, 5);
  const pausedStatus = await getZeroCostGuardStatus(poolB, costGuardEnv);
  assert.equal(pausedStatus.paused, true, 'manual pause must persist across independent pools');
  assert.equal(pausedStatus.providers.cloudflare, 'GESPERRT');
  assert.equal(pausedStatus.recentEvents[0]?.action, 'MANUAL_PAUSE');
  assert.equal(pausedStatus.recentEvents[0]?.decision, 'PAUSED');
  await assert.rejects(
    () => reserveZeroCostProviderRequestWithPool(poolB, costRequest, costGuardEnv),
    /manuell gesperrt/,
    'manual pause must block reservations before provider execution'
  );
  await setZeroCostGuardPaused(poolB, false, 5);
  const resumedStatus = await getZeroCostGuardStatus(poolA, costGuardEnv);
  assert.equal(resumedStatus.paused, false, 'manual resume must persist across fresh connections');
  assert.equal(resumedStatus.remainingRequests, 0, 'manual resume must not refill the exhausted daily budget');
  assert.equal(resumedStatus.recentEvents[0]?.action, 'MANUAL_RESUME');
  assert.equal(resumedStatus.recentEvents[0]?.decision, 'RESUMED');
  await assert.rejects(() => setZeroCostGuardPaused(poolA, true, 0), /Ungültiges Tagesbudget/);
  const afterInvalidPause = await getZeroCostGuardStatus(poolB, costGuardEnv);
  assert.equal(afterInvalidPause.paused, false, 'invalid budget configuration must not alter persisted pause state');

  // PostgreSQL failures in auth persistence must propagate instead of
  // silently authenticating or consuming a login attempt.
  await poolA.query(`
    CREATE FUNCTION reject_zero_login_attempt() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected login-attempt persistence failure' USING ERRCODE = 'P0001';
    END;
    $$;
    CREATE TRIGGER reject_zero_login_attempt
    BEFORE INSERT ON zero_login_attempts
    FOR EACH ROW EXECUTE FUNCTION reject_zero_login_attempt();
  `);
  const failedLoginKey = 'd'.repeat(64);
  await assert.rejects(
    () => authA.consumeLoginAttempt(failedLoginKey, new Date(), 15 * 60 * 1000, 8),
    /injected login-attempt persistence failure/,
    'login throttling must fail closed when PostgreSQL cannot persist the attempt',
  );
  await poolA.query('DROP TRIGGER reject_zero_login_attempt ON zero_login_attempts');
  await poolA.query('DROP FUNCTION reject_zero_login_attempt()');
  const recoveredLoginAttempt = await authB.consumeLoginAttempt(failedLoginKey, new Date(), 15 * 60 * 1000, 8);
  assert.equal(recoveredLoginAttempt.allowed, true);
  assert.equal(recoveredLoginAttempt.attempts, 1,
    'a failed database write must not create a phantom login attempt');

  await poolA.query(`
    CREATE FUNCTION reject_zero_auth_session() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected auth-session persistence failure' USING ERRCODE = 'P0001';
    END;
    $$;
    CREATE TRIGGER reject_zero_auth_session
    BEFORE INSERT ON zero_auth_sessions
    FOR EACH ROW EXECUTE FUNCTION reject_zero_auth_session();
  `);
  const failedSessionHash = 'e'.repeat(64);
  await assert.rejects(
    () => authA.createSession(failedSessionHash, new Date(Date.now() + 60_000)),
    /injected auth-session persistence failure/,
    'session creation must fail closed when PostgreSQL rejects persistence',
  );
  await poolA.query('DROP TRIGGER reject_zero_auth_session ON zero_auth_sessions');
  await poolA.query('DROP FUNCTION reject_zero_auth_session()');
  assert.equal(await authB.hasSession(failedSessionHash), false,
    'a failed session insert must never become visible on another instance');

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
  await authA.markGeminiQuotaExhausted(quotaParams.modelId, quotaParams.resetDate);
  assert.equal((await authB.reserveGeminiQuota(quotaParams)).allowed, false, 'provider quota exhaustion must block all instances');
  await authA.clearGeminiQuota(quotaParams.modelId);
  assert.equal((await authB.reserveGeminiQuota(quotaParams)).allowed, true, 'an explicitly confirmed reset must allow a new reservation');

  // A stale application snapshot must not bypass the limit when the shared
  // reservation row is absent (for example immediately after a manual reset).
  await authA.clearGeminiQuota(quotaParams.modelId);
  const staleAtLimit = await authB.reserveGeminiQuota({
    ...quotaParams,
    currentRequests: quotaParams.dailyLimit,
  });
  assert.equal(staleAtLimit.allowed, false, 'an empty reservation table must not admit a stale snapshot already at its daily limit');
  assert.equal(staleAtLimit.requestsToday, quotaParams.dailyLimit);
  const lastAvailableReservation = await authA.reserveGeminiQuota({
    ...quotaParams,
    currentRequests: quotaParams.dailyLimit - 1,
  });
  assert.equal(lastAvailableReservation.allowed, true, 'the last available quota slot must still be reservable');
  assert.equal(lastAvailableReservation.requestsToday, quotaParams.dailyLimit);
  const overLimitAfterLastSlot = await authB.reserveGeminiQuota({
    ...quotaParams,
    currentRequests: quotaParams.dailyLimit - 1,
  });
  assert.equal(overLimitAfterLastSlot.allowed, false, 'a stale snapshot must not admit a request after the final slot is reserved');
  await authA.clearGeminiQuota(quotaParams.modelId);

  // If a session-lock query fails before its result is received, destroy
  // the physical connection rather than returning a possibly locked session.
  let uncertainZipLockRelease: Error | boolean | undefined;
  const uncertainZipLockClient = {
    query: async () => { throw new Error('injected ZIP lock acquisition transport failure'); },
    release: (error?: Error | boolean) => { uncertainZipLockRelease = error; },
  };
  const uncertainZipLockPool = {
    connect: async () => uncertainZipLockClient,
  } as unknown as Pool;
  await assert.rejects(
    () => acquirePersistentZipOperationLease(uncertainZipLockPool),
    /injected ZIP lock acquisition transport failure/
  );
  assert.equal(uncertainZipLockRelease, true, 'an uncertain ZIP advisory-lock acquisition must destroy the pooled connection');

  // Background automatic ZIP backups must consume the exact same two
  // PostgreSQL advisory slots as HTTP ZIP operations across independent pools.
  const backgroundZipLeaseA = await acquirePersistentZipOperationLease(gatePoolA);
  const backgroundZipLeaseB = await acquirePersistentZipOperationLease(gatePoolB);
  assert.ok(backgroundZipLeaseA && backgroundZipLeaseB, 'two background ZIP operations may occupy the two global slots');
  assert.equal(
    await acquirePersistentZipOperationLease(gatePoolA),
    null,
    'a third background ZIP operation must be rejected while both global slots are occupied'
  );
  await backgroundZipLeaseA.release();
  const reusedBackgroundZipLease = await acquirePersistentZipOperationLease(gatePoolA);
  assert.ok(reusedBackgroundZipLease, 'a released background ZIP slot must be reusable from another process');
  await backgroundZipLeaseB.release();
  await reusedBackgroundZipLease.release();

  // Production ZIP middleware must enforce one shared limit across two pools.
  const gateA = createPostgresConcurrencyGate(gatePoolA, 2, 5);
  const gateB = createPostgresConcurrencyGate(gatePoolB, 2, 5);
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
    for (let attempt = 0; attempt < 100 && gateA.activeCount() + gateB.activeCount() > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(gateA.activeCount() + gateB.activeCount(), 0, 'both shared ZIP leases must be released after response completion');
    const afterRelease = await fetch(baseB + '/held/after-release');
    assert.equal(afterRelease.status, 200, 'a completed ZIP handler must release a global slot');

    const abort = new AbortController();
    const disconnectedRequest = fetch(baseA + '/disconnect', { signal: abort.signal }).catch(() => undefined);
    while (!disconnectedEntered) await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await disconnectedRequest;
    const occupy = fetch(baseB + '/held/occupied');
    while (heldRequests < 4) await new Promise((resolve) => setImmediate(resolve));
    const stillHeld = await fetch(baseA + '/held/blocked-after-disconnect');
    assert.equal(stillHeld.status, 429, 'client disconnect must not release a slot while async work is still running');
    releaseDisconnected();
    for (let attempt = 0; attempt < 100 && gateA.activeCount() > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(gateA.activeCount(), 0, 'disconnected handler must release after its async work settles');
    const afterDisconnectWork = await fetch(baseA + '/held/after-disconnect-work');
    assert.equal(afterDisconnectWork.status, 200, 'slot must release once disconnected handler work settles');
    releaseOccupied();
    await (await occupy).json();

    // A pool connection failure must be forwarded to Express, not become an
    // unhandled rejection from the async middleware.
    const failingPool = {
      connect: async () => { throw new Error('injected ZIP pool connection failure'); },
    } as unknown as Pool;
    const failingApp = express();
    failingApp.get('/zip', createPostgresConcurrencyGate(failingPool, 1).middleware, (_req, res) => res.json({ ok: true }));
    const failingServer = failingApp.listen(0, '127.0.0.1');
    await once(failingServer, 'listening');
    const failingAddress = failingServer.address();
    assert.ok(failingAddress && typeof failingAddress !== 'string');
    try {
      const failedConnectionResponse = await fetch(`http://127.0.0.1:${failingAddress.port}/zip`);
      assert.equal(failedConnectionResponse.status, 500, 'PostgreSQL pool failures must reach Express error handling');
    } finally {
      failingServer.close();
      await once(failingServer, 'close');
    }
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
  const snapshotBeginIndex = reconciliationSql.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const stateReadIndex = reconciliationSql.findIndex((sql) => sql.includes('FROM zero_app_state'));
  const blobReadIndex = reconciliationSql.findIndex((sql) => sql.includes('FROM zero_backup_files'));
  assert.ok(
    snapshotBeginIndex >= 0 && snapshotBeginIndex < stateReadIndex && stateReadIndex < blobReadIndex,
    'reconciliation must read metadata and blobs inside one stable read-only transaction'
  );
  assert.ok(reconciliationSql.includes('COMMIT'));
  assert.equal(reconciliationClientReleased, true, 'reconciliation must always release its checked-out client');

  const initialRevision = await storeA.write({ value: 0 }, 0);
  assert.equal(initialRevision, 1, 'initial insert must create revision 1');

  const restoreAssets = backupVideoAssets.map((asset) => ({
    id: asset.id, projectId: asset.projectId, sceneId: asset.sceneId, jobId: asset.jobId,
    contentType: asset.contentType, payload: asset.payload, sha256: asset.sha256, createdAt: asset.createdAt,
  }));
  const restoredRevision = await storeA.write(
    { value: 'restored-with-video' }, initialRevision, undefined, false,
    { principalHash: videoPrincipal, assets: restoreAssets },
  );
  assert.equal(restoredRevision, 2);
  assert.deepEqual(
    (await projectVideoStoreB.get(archivedVideo.id, 'project-video-integration', videoPrincipal))?.payload,
    mp4Payload,
    'video rows and JSONB revision become visible together through another pool',
  );
  await assert.rejects(
    () => storeA.write(
      { value: 'must-not-commit' }, restoredRevision - 1, undefined, false,
      { principalHash: videoPrincipal, assets: [] },
    ),
    (error) => error instanceof PersistentStateConflictError,
    'revision conflict must roll back the video replacement too',
  );
  assert.ok(
    await projectVideoStoreB.get(archivedVideo.id, 'project-video-integration', videoPrincipal),
    'failed JSONB restore must leave prior video rows untouched',
  );
  await assert.rejects(
    () => storeA.write(
      { value: 'bad-video-digest' }, restoredRevision, undefined, false,
      { principalHash: videoPrincipal, assets: [{ ...restoreAssets[0], sha256: '0'.repeat(64) }] },
    ),
    /Projektvideo-Backup enthält ungültige oder beschädigte Daten/,
    'invalid media digest must abort the transaction before replacing state or clips',
  );
  assert.ok(
    await projectVideoStoreB.get(archivedVideo.id, 'project-video-integration', videoPrincipal),
    'invalid media digest must preserve the existing clip',
  );
  const emptyManifestRevision = await storeA.write(
    { value: 'restore-empty-manifest' }, restoredRevision, undefined, false,
    { principalHash: videoPrincipal, assets: [] },
  );
  assert.equal(
    (await projectVideoStoreB.list('project-video-integration', videoPrincipal)).length,
    0,
    'an explicit empty manifest atomically removes all clips for that principal',
  );
  await projectVideoStore.put({
    projectId: 'project-video-integration', sceneId: 'scene-video-integration',
    principalHash: videoPrincipal, jobId: videoJobId, contentType: 'video/mp4', payload: mp4Payload,
  });

  const [snapshotA, snapshotB] = await Promise.all([storeA.read(), storeB.read()]);
  assert.ok(snapshotA);
  assert.ok(snapshotB);
  assert.equal(snapshotA.revision, emptyManifestRevision);
  assert.equal(snapshotB.revision, emptyManifestRevision,
    'both independent pools must observe the latest restore revision before racing');

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
  assert.equal(afterRace.revision, emptyManifestRevision + 1,
    'one successful race must advance the current restore revision exactly once');
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
  assert.equal(nextRevision, emptyManifestRevision + 2,
    'a caller using the latest revision may write successfully');
  const finalState = await storeA.read();
  assert.deepEqual(finalState, { payload: { value: 'after-conflict' }, revision: emptyManifestRevision + 2 });

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
  assert.equal(backupRevision, emptyManifestRevision + 3);
  const published = await storeA.read();
  assert.deepEqual(published, {
    payload: {
      value: 'backup-published',
      backups: [{ id: 'backup-atomic-success' }],
      backupConfig: { zipBackups: [{ id: 'backup-atomic-success' }] },
    },
    revision: emptyManifestRevision + 3,
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
  assert.equal(reconciliationRevision, emptyManifestRevision + 4);
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
      await storeA.write(db, options.expectedRevision!, undefined, false, options.projectVideoRestore);
    },
    enrichModelMetadata: (model) => model,
    getRestorePrincipalHash: () => videoPrincipal,
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

  // End-to-end ZIP video restore: use actual ZIP bytes, the production verifier,
  // the production restore orchestration, and PostgreSQL state/video stores on
  // two independent pools. Every malformed archive must leave both stores intact.
  const restoreProjectId = 'restore-video-project';
  const restoreSceneId = 'restore-video-scene';
  const makeVideoRestoreDb = (title: string): ZeroDatabase => ({
    ...makeRestoreDb(title),
    projects: [{
      id: restoreProjectId,
      title,
      scenes: [{ id: restoreSceneId, title: 'Restore scene', status: 'draft' }],
      assets: [],
      characterIds: [],
    }],
  } as unknown as ZeroDatabase);
  const videoRestoreLiveDb = makeVideoRestoreDb('live-video-state-before-restore');
  const videoRestoreInitialState = await storeA.read();
  assert.ok(videoRestoreInitialState);
  const videoRestoreInitialRevision = await storeA.write(videoRestoreLiveDb, videoRestoreInitialState.revision);
  const oldVideoPayload = Buffer.alloc(2048, 0x31);
  oldVideoPayload.write('ftyp', 4, 'ascii');
  const oldVideo = await projectVideoStore.put({
    projectId: restoreProjectId,
    sceneId: restoreSceneId,
    principalHash: videoPrincipal,
    jobId: randomUUID(),
    contentType: 'video/mp4',
    payload: oldVideoPayload,
  });
  const oldVideoId = oldVideo.id;
  const baselineVideoRestoreState = await storeA.read();
  assert.ok(baselineVideoRestoreState);
  assert.equal(baselineVideoRestoreState.revision, videoRestoreInitialRevision);
  const baselineOldVideo = await projectVideoStoreB.get(oldVideoId, restoreProjectId, videoPrincipal);
  assert.deepEqual(baselineOldVideo?.payload, oldVideoPayload);

  const makeVideoArchiveFixture = async (suffix: string) => {
    const mp4Id = randomUUID();
    const webmId = randomUUID();
    const mp4 = Buffer.alloc(3072, 0x41);
    mp4.write('ftyp', 4, 'ascii');
    const webm = Buffer.alloc(4096, 0x42);
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(webm, 0);
    const createdAt = new Date().toISOString();
    const assets = [
      {
        id: mp4Id, projectId: restoreProjectId, sceneId: restoreSceneId, jobId: randomUUID(),
        contentType: 'video/mp4' as const, sizeBytes: mp4.length,
        sha256: createHash('sha256').update(mp4).digest('hex'), createdAt,
        path: `media/project-videos/${mp4Id}.mp4`, payload: mp4,
      },
      {
        id: webmId, projectId: restoreProjectId, sceneId: restoreSceneId, jobId: randomUUID(),
        contentType: 'video/webm' as const, sizeBytes: webm.length,
        sha256: createHash('sha256').update(webm).digest('hex'), createdAt,
        path: `media/project-videos/${webmId}.webm`, payload: webm,
      },
    ];
    const manifest = {
      version: 1,
      assets: assets.map(({ payload: _payload, ...metadata }) => metadata),
    };
    const entries: Record<string, Buffer> = {
      'data/zero-studio-db.json': Buffer.from(JSON.stringify(makeVideoRestoreDb(`restored-from-${suffix}`))),
      'data/project-video-manifest.json': Buffer.from(JSON.stringify(manifest)),
    };
    for (const asset of assets) entries[asset.path] = asset.payload;
    const archiveResult = await buildFullProjectZip(process.cwd(), entries);
    assert.equal(verifyZipBuffer(archiveResult.buffer).result.valid, true);
    return { archive: archiveResult.buffer, assets, manifest, entries };
  };

  const createVideoRestoreService = (
    zipId: string,
    archiveBuffer: Buffer,
    afterSafetyBackup?: (revision: number) => Promise<void>,
  ) => {
    const record = {
      id: zipId,
      version: '1.2.5',
      filename: `${zipId}.zip`,
      createdAt: new Date().toISOString(),
      changelog: 'PostgreSQL video restore integration',
      trigger: 'manual',
      fileCount: verifyZipBuffer(archiveBuffer).extractedFiles.size,
      sizeBytes: archiveBuffer.length,
      verified: true,
      protected: true,
      excludedSecrets: [],
    } as unknown as ZipBackupVersion;
    const safetyRevisions = new WeakMap<ZipBackupVersion, number>();
    const service = createVerifiedZipRestoreService({
      getZipBackupFilePath: async (requestedId) => {
        assert.equal(requestedId, zipId);
        return { record, buffer: archiveBuffer };
      },
      verifyZipBuffer,
      assertRestorableDatabase,
      createSafetyBackup: async () => {
        const before = await storeB.read();
        assert.ok(before);
        const safetyZip = await buildFullProjectZip(process.cwd(), {
          'data/zero-studio-db.json': Buffer.from(JSON.stringify(before.payload)),
        });
        const safetyRecord = {
          id: `${zipId}-safety`,
          version: '1.2.6',
          filename: `${zipId}-safety.zip`,
          createdAt: new Date().toISOString(),
          changelog: 'Safety backup for video restore integration',
          trigger: 'pre_restore',
          fileCount: safetyZip.fileCount,
          sizeBytes: safetyZip.buffer.length,
          verified: true,
          protected: true,
          excludedSecrets: [],
        } as unknown as ZipBackupVersion;
        const nextDb = {
          ...before.payload,
          backupConfig: {
            ...before.payload.backupConfig,
            zipBackups: [safetyRecord, ...before.payload.backupConfig.zipBackups],
          },
        } as ZeroDatabase;
        const revision = await storeB.writeWithBackup(nextDb, before.revision, {
          id: safetyRecord.id,
          filename: safetyRecord.filename,
          contentType: 'application/zip',
          payload: safetyZip.buffer,
        });
        safetyRevisions.set(safetyRecord, revision);
        await afterSafetyBackup?.(revision);
        return safetyRecord;
      },
      loadDb: async () => {
        const state = await storeA.read();
        assert.ok(state);
        return state.payload as ZeroDatabase;
      },
      getZipBackupRevision: (safetyRecord) => {
        const revision = safetyRevisions.get(safetyRecord);
        if (revision === undefined) throw new Error('Video restore safety revision missing');
        return revision;
      },
      saveDb: async (db, options) => {
        assert.notEqual(options.expectedRevision, undefined);
        await storeA.write(db, options.expectedRevision!, undefined, false, options.projectVideoRestore);
      },
      enrichModelMetadata: (model) => model,
      getRestorePrincipalHash: () => videoPrincipal,
    });
    return { service, record };
  };

  const validVideoFixture = await makeVideoArchiveFixture('valid-video-zip');
  const validVideoRestore = createVideoRestoreService('valid-video-zip', validVideoFixture.archive);
  const successfulVideoRestore = await validVideoRestore.service('valid-video-zip');
  assert.equal(successfulVideoRestore.db.projects[0]?.title, 'restored-from-valid-video-zip');
  const stateAfterVideoRestore = await storeB.read();
  assert.ok(stateAfterVideoRestore);
  assert.equal(
    (stateAfterVideoRestore.payload as ZeroDatabase).projects[0]?.title,
    'restored-from-valid-video-zip',
    'the archived JSONB project state must be restored through the second pool',
  );
  const restoredVideoRows = await projectVideoStoreB.list(restoreProjectId, videoPrincipal);
  assert.deepEqual(
    restoredVideoRows.map((asset) => asset.id).sort(),
    validVideoFixture.assets.map((asset) => asset.id).sort(),
    'the manifest must replace the previous project clips with both archived MP4 and WebM assets',
  );
  for (const expected of validVideoFixture.assets) {
    const restored = await projectVideoStoreB.get(expected.id, restoreProjectId, videoPrincipal);
    assert.ok(restored, `restored ${expected.contentType} must be visible through the second pool`);
    assert.deepEqual(restored.payload, expected.payload, `restored ${expected.contentType} bytes must match exactly`);
    assert.equal(restored.sha256, expected.sha256);
  }
  assert.equal(
    await projectVideoStoreB.get(oldVideoId, restoreProjectId, videoPrincipal),
    null,
    'successful manifest restore must remove the replaced prior clip',
  );

  const malformedVideoCases: Array<{ name: string; mutate: (fixture: Awaited<ReturnType<typeof makeVideoArchiveFixture>>) => Record<string, Buffer> }> = [
    {
      name: 'unsupported manifest version',
      mutate: (fixture) => ({
        ...fixture.entries,
        'data/project-video-manifest.json': Buffer.from(JSON.stringify({ ...fixture.manifest, version: 99 })),
      }),
    },
    {
      name: 'unknown project ownership',
      mutate: (fixture) => {
        const manifest = structuredClone(fixture.manifest);
        manifest.assets[0].projectId = 'project-not-in-archive';
        return { ...fixture.entries, 'data/project-video-manifest.json': Buffer.from(JSON.stringify(manifest)) };
      },
    },
    {
      name: 'scene does not belong to project',
      mutate: (fixture) => {
        const manifest = structuredClone(fixture.manifest);
        manifest.assets[0].sceneId = 'scene-not-in-project';
        return { ...fixture.entries, 'data/project-video-manifest.json': Buffer.from(JSON.stringify(manifest)) };
      },
    },
    {
      name: 'manipulated asset path',
      mutate: (fixture) => {
        const manifest = structuredClone(fixture.manifest);
        manifest.assets[0].path = 'media/project-videos/../outside.mp4';
        return { ...fixture.entries, 'data/project-video-manifest.json': Buffer.from(JSON.stringify(manifest)) };
      },
    },
    {
      name: 'declared size mismatch',
      mutate: (fixture) => {
        const manifest = structuredClone(fixture.manifest);
        manifest.assets[0].sizeBytes += 1;
        return { ...fixture.entries, 'data/project-video-manifest.json': Buffer.from(JSON.stringify(manifest)) };
      },
    },
    {
      name: 'SHA-256 mismatch',
      mutate: (fixture) => {
        const manifest = structuredClone(fixture.manifest);
        manifest.assets[0].sha256 = '0'.repeat(64);
        return { ...fixture.entries, 'data/project-video-manifest.json': Buffer.from(JSON.stringify(manifest)) };
      },
    },
    {
      name: 'missing media payload',
      mutate: (fixture) => {
        const entries = { ...fixture.entries };
        delete entries[fixture.manifest.assets[0].path];
        return entries;
      },
    },
    {
      name: 'unreferenced extra media payload',
      mutate: (fixture) => ({
        ...fixture.entries,
        'media/project-videos/unreferenced.mp4': Buffer.alloc(2048, 0x55),
      }),
    },
  ];

  for (const [index, testCase] of malformedVideoCases.entries()) {
    const fixture = await makeVideoArchiveFixture(`invalid-${index}`);
    const entries = testCase.mutate(fixture);
    const malformedZip = await buildFullProjectZip(process.cwd(), entries);
    const invalidId = `invalid-video-restore-${index}`;
    let invalidSafetyBackupCalls = 0;
    // Replace the service's safety boundary with a counter: validation must fail
    // before any safety backup or PostgreSQL write is attempted.
    const serviceWithNoSafetyBackup = createVerifiedZipRestoreService({
      getZipBackupFilePath: async () => ({
        record: {
          id: invalidId, version: '1.2.5', filename: `${invalidId}.zip`,
          createdAt: new Date().toISOString(), changelog: 'Invalid video fixture',
          trigger: 'manual', fileCount: malformedZip.fileCount, sizeBytes: malformedZip.buffer.length,
          verified: true, protected: true, excludedSecrets: [],
        } as unknown as ZipBackupVersion,
        buffer: malformedZip.buffer,
      }),
      verifyZipBuffer,
      assertRestorableDatabase,
      createSafetyBackup: async () => {
        invalidSafetyBackupCalls += 1;
        throw new Error('Invalid manifest must fail before safety backup');
      },
      loadDb: async () => { throw new Error('Invalid manifest must not load live state'); },
      getZipBackupRevision: () => { throw new Error('Invalid manifest must not request a revision'); },
      saveDb: async () => { throw new Error('Invalid manifest must not persist'); },
      enrichModelMetadata: (model) => model,
      getRestorePrincipalHash: () => videoPrincipal,
    });
    await assert.rejects(
      () => serviceWithNoSafetyBackup(invalidId),
      /Projektvideo-Backup ungültig/,
      `${testCase.name} must be rejected by production ZIP restore`,
    );
    assert.equal(invalidSafetyBackupCalls, 0, `${testCase.name} must fail before safety backup`);
    assert.deepEqual(await storeA.read(), stateAfterVideoRestore, `${testCase.name} must not change JSONB state or revision`);
    const preservedClip = await projectVideoStoreB.get(
      validVideoFixture.assets[0].id, restoreProjectId, videoPrincipal,
    );
    assert.deepEqual(preservedClip?.payload, validVideoFixture.assets[0].payload, `${testCase.name} must preserve prior clip bytes`);
    assert.deepEqual(
      (await projectVideoStoreB.list(restoreProjectId, videoPrincipal)).map((asset) => asset.id).sort(),
      validVideoFixture.assets.map((asset) => asset.id).sort(),
      `${testCase.name} must preserve the entire prior clip set`,
    );
  }

  // A revision race after the safety snapshot must reject the restore without
  // changing either the winning JSONB state or the existing project video rows.
  const conflictLiveDb = makeVideoRestoreDb('live-before-video-restore-conflict');
  const conflictState = await storeA.read();
  assert.ok(conflictState);
  await storeA.write(conflictLiveDb, conflictState.revision);
  // Start the conflict scenario with a deliberately empty clip set. Use a
  // transaction so the fixture cannot expose a partially-cleared baseline.
  const clearConflictClips = await poolA.connect();
  try {
    await clearConflictClips.query('BEGIN');
    await clearConflictClips.query(
      'DELETE FROM zero_project_video_assets WHERE principal_hash = $1 AND project_id = $2',
      [videoPrincipal, restoreProjectId],
    );
    await clearConflictClips.query('COMMIT');
  } catch (error) {
    await clearConflictClips.query('ROLLBACK');
    throw error;
  } finally {
    clearConflictClips.release();
  }
  assert.deepEqual(
    await projectVideoStoreB.list(restoreProjectId, videoPrincipal),
    [],
    'revision-conflict fixture must begin with no previous project clips',
  );
  const conflictOldVideo = Buffer.alloc(2048, 0x33);
  conflictOldVideo.write('ftyp', 4, 'ascii');
  const conflictOldVideoAsset = await projectVideoStore.put({
    projectId: restoreProjectId, sceneId: restoreSceneId,
    principalHash: videoPrincipal, jobId: randomUUID(), contentType: 'video/mp4', payload: conflictOldVideo,
  });
  const conflictOldVideoId = conflictOldVideoAsset.id;
  const conflictFixture = await makeVideoArchiveFixture('revision-conflict');
  let concurrentWinnerSnapshot: Awaited<ReturnType<typeof storeA.read>> | null = null;
  const conflictRestore = createVideoRestoreService(
    'video-restore-revision-conflict',
    conflictFixture.archive,
    async (safetyRevision) => {
      const concurrentDbState = await storeB.read();
      assert.ok(concurrentDbState);
      const concurrentDb = {
        ...concurrentDbState.payload,
        projects: concurrentDbState.payload.projects.map((project) => ({
          ...project,
          title: 'newer-concurrent-writer-wins',
        })),
      } as ZeroDatabase;
      const winnerRevision = await storeB.write(concurrentDb, safetyRevision);
      concurrentWinnerSnapshot = await storeB.read();
      assert.ok(concurrentWinnerSnapshot);
      assert.equal(concurrentWinnerSnapshot.revision, winnerRevision);
    },
  );
  await assert.rejects(
    () => conflictRestore.service('video-restore-revision-conflict'),
    (error) => error instanceof PersistentStateConflictError,
    'production ZIP restore must reject the stale safety-backup revision',
  );
  assert.ok(concurrentWinnerSnapshot);
  assert.deepEqual(await storeA.read(), concurrentWinnerSnapshot, 'revision conflict must preserve the concurrent JSONB winner exactly');
  assert.deepEqual(
    (await projectVideoStoreB.get(conflictOldVideoId, restoreProjectId, videoPrincipal))?.payload,
    conflictOldVideo,
    'revision conflict must leave prior clip bytes unchanged',
  );
  assert.deepEqual(
    (await projectVideoStoreB.list(restoreProjectId, videoPrincipal)).map((asset) => asset.id).sort(),
    [conflictOldVideoId],
    'revision conflict must not partially replace the existing clip set',
  );

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
  // Project video media is stored in the PostgreSQL JSONB state, not only in
  // browser IndexedDB. Verify a second independent pool can recover the exact
  // data URL that the versioned ZIP backup service snapshots into its DB JSON.
  const beforeMediaWrite = await storeA.read();
  assert.ok(beforeMediaWrite);
  const mediaDataUrl = `data:video/mp4;base64,${Buffer.from('ZERO durable media fixture').toString('base64')}`;
  const mediaPayload = {
    projects: [{
      id: 'durable-media-project',
      scenes: [],
      assets: [{
        id: 'durable-media-asset',
        type: 'video',
        title: 'Durable scene clip',
        url: mediaDataUrl,
        modelId: 'zero-scene-video:durable-media-scene',
        durationSec: 5,
        createdAt: new Date().toISOString(),
      }],
    }],
  };
  const mediaRevision = await storeA.write(mediaPayload, beforeMediaWrite.revision);
  const recoveredMediaState = await storeB.read<typeof mediaPayload>();
  assert.equal(recoveredMediaState?.revision, mediaRevision);
  assert.equal(
    recoveredMediaState?.payload.projects[0].assets[0].url,
    mediaDataUrl,
    'server-persisted scene media must survive independent-pool reloads'
  );

  // Exercise the actual production ZIP service: a saved scene clip must be
  // embedded in the verified backup JSON and survive reading the published blob.
  const mediaBackupDb = makeRestoreDb('durable-media-backup-project');
  mediaBackupDb.projects[0].assets.push({
    id: 'durable-media-backup-asset',
    type: 'video',
    title: 'Durable scene clip',
    url: mediaDataUrl,
    modelId: 'zero-scene-video:durable-media-scene',
    durationSec: 5,
    createdAt: new Date().toISOString(),
  });
  const mediaBackupRevision = await storeA.write(mediaBackupDb, recoveredMediaState!.revision);
  assert.ok(mediaBackupRevision > recoveredMediaState!.revision);
  const mediaBackupRecord = await productionZipBackup({
    changelog: 'Verify durable scene media in production ZIP snapshot',
    trigger: 'manual',
  });
  const mediaBackupBlob = await poolB.query<{ payload: Buffer }>(
    'SELECT payload FROM zero_backup_files WHERE id = $1',
    [mediaBackupRecord.id]
  );
  assert.equal(mediaBackupBlob.rowCount, 1, 'published media backup blob must be available from the second pool');
  const mediaBackupVerification = verifyZipBuffer(mediaBackupBlob.rows[0].payload);
  assert.equal(mediaBackupVerification.result.valid, true, 'the published media backup must pass the production ZIP verifier');
  const mediaBackupJson = mediaBackupVerification.extractedFiles.get('data/zero-studio-db.json');
  assert.ok(mediaBackupJson, 'the verified ZIP must contain the PostgreSQL project snapshot');
  const restoredMediaDb = JSON.parse(mediaBackupJson.toString('utf8')) as ZeroDatabase;
  assert.equal(
    restoredMediaDb.projects[0].assets.find((asset) => asset.id === 'durable-media-backup-asset')?.url,
    mediaDataUrl,
    'the actual production ZIP snapshot must retain the exact saved scene video data URL'
  );

  console.log('PostgreSQL revision, persistence restore-race, HTTP restore-vs-write, media ZIP snapshot, and atomic-backup tests passed using two independent pools.');
} finally {
  await Promise.all([poolA.end(), poolB.end(), gatePoolA.end(), gatePoolB.end()]);
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await adminPool.end();
}
