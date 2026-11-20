import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPostgresPool } from '../server/persistence.ts';
import {
  isProjectDeletionIdempotentRetry,
  recordProjectDeletionIdempotency,
} from '../server/projectDeletionIdempotency.ts';

if (!process.env.DATABASE_URL || process.env.ZERO_POSTGRES_TESTS !== 'true') {
  throw new Error('Project deletion idempotency integration requires the isolated PostgreSQL CI database.');
}

const pool = getPostgresPool();
const projectId = 'project-delete-test-' + randomUUID();
const principalId = 'admin:primary';
const originalKey = 'project-delete-key-123';
const replacementKey = 'project-delete-key-456';

try {
  await recordProjectDeletionIdempotency(projectId, principalId, originalKey);
  assert.equal(await isProjectDeletionIdempotentRetry(projectId, principalId, originalKey), true);
  assert.equal(await isProjectDeletionIdempotentRetry(projectId, principalId, 'different-key-999'), false);
  assert.equal(await isProjectDeletionIdempotentRetry(projectId, 'admin:other', originalKey), false);

  await recordProjectDeletionIdempotency(projectId, principalId, replacementKey);
  assert.equal(await isProjectDeletionIdempotentRetry(projectId, principalId, originalKey), false);
  assert.equal(await isProjectDeletionIdempotentRetry(projectId, principalId, replacementKey), true);

  console.log('ZERO project deletion idempotency PostgreSQL integration tests passed.');
} finally {
  await pool.query(
    'DELETE FROM zero_project_deletion_idempotency WHERE project_id = $1 AND principal_id = $2',
    [projectId, principalId],
  );
  await pool.end();
}
