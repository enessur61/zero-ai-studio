import assert from 'node:assert/strict';
import { readinessForStage } from '../server/healthReadiness.ts';

assert.deepEqual(readinessForStage('not_configured'), {
  database: 'not_checked',
  authentication: 'not_configured',
  resourceGuard: 'not_checked',
});

assert.deepEqual(readinessForStage('database'), {
  database: 'unavailable',
  authentication: 'not_checked',
  resourceGuard: 'not_checked',
});

assert.deepEqual(readinessForStage('authentication'), {
  database: 'ready',
  authentication: 'unavailable',
  resourceGuard: 'not_checked',
});

assert.deepEqual(readinessForStage('resource_guard'), {
  database: 'ready',
  authentication: 'ready',
  resourceGuard: 'unavailable',
});

assert.deepEqual(readinessForStage('ready'), {
  database: 'ready',
  authentication: 'ready',
  resourceGuard: 'ready',
});

console.log('Health readiness stage tests passed.');
