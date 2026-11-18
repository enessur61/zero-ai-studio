import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createApiAuthMiddleware } from '../server/apiAuth.ts';

function responseRecorder() {
  let code = 200;
  let body: unknown;
  const response = {
    status(value: number) { code = value; return this; },
    json(value: unknown) { body = value; return this; },
  };
  return { response: response as unknown as Response, status: () => code, body: () => body };
}

async function invoke(path: string, hasValidSession: () => Promise<boolean>, configured = true) {
  let nextCalled = false;
  const recorder = responseRecorder();
  const middleware = createApiAuthMiddleware({
    isProduction: true,
    adminPassword: configured ? 'a-secure-ci-password' : '',
    sessionSecret: configured ? 'a-secure-session-secret-that-is-long-enough-123' : '',
    hasValidSession,
  });
  middleware({ path } as unknown as Request, recorder.response, (() => { nextCalled = true; }) as never);
  await new Promise((resolve) => setImmediate(resolve));
  return { ...recorder, nextCalled };
}

for (const path of [
  '/video/engine/status',
  '/video/engine/jobs',
  '/video/engine/jobs/00000000-0000-4000-8000-000000000001',
  '/video/engine/jobs/00000000-0000-4000-8000-000000000001/cancel',
  '/video/engine/jobs/00000000-0000-4000-8000-000000000001/video',
]) {
  let sessionChecks = 0;
  const denied = await invoke(path, async () => { sessionChecks += 1; return false; });
  assert.equal(denied.status(), 401, `${path} must require a ZERO session`);
  assert.equal(denied.nextCalled, false);
  assert.equal(sessionChecks, 1);

  const allowed = await invoke(path, async () => true);
  assert.equal(allowed.nextCalled, true, `${path} must proceed for a valid ZERO session`);
}

const unconfigured = await invoke('/video/engine/status', async () => true, false);
assert.equal(unconfigured.status(), 503);
assert.equal(unconfigured.nextCalled, false);

const publicHealth = await invoke('/health', async () => false);
assert.equal(publicHealth.nextCalled, true);
assert.equal(publicHealth.status(), 200);

console.log('Wan API session-authentication regression tests passed.');
