import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { asyncRoute } from '../server/asyncRoute.ts';

const expected = new Error('simulated asynchronous route failure');
let forwardedError: unknown;
let resolveForwarded!: (error: unknown) => void;
const forwarded = new Promise<unknown>((resolve) => {
  resolveForwarded = resolve;
});

const middleware = asyncRoute(async () => {
  throw expected;
});

middleware({} as Request, {} as Response, (error?: unknown) => {
  forwardedError = error;
  resolveForwarded(error);
});

assert.equal(await forwarded, expected);
assert.equal(forwardedError, expected);
console.log('Express async route error forwarding test passed.');
