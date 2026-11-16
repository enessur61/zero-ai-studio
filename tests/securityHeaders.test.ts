import assert from 'node:assert/strict';
import { applySecurityHeaders, configureTrustProxy } from '../server/securityHeaders.ts';

const headers = new Map<string, string>();
const response = {
  setHeader(name: string, value: string) {
    headers.set(name.toLowerCase(), value);
    return this;
  },
};

applySecurityHeaders(response, false);
assert.equal(headers.get('x-content-type-options'), 'nosniff');
assert.equal(headers.get('x-frame-options'), 'DENY');
assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
assert.equal(
  headers.get('permissions-policy'),
  'camera=(self), microphone=(self), geolocation=()'
);
assert.equal(headers.has('strict-transport-security'), false);

headers.clear();
applySecurityHeaders(response, true);
assert.equal(headers.get('strict-transport-security'), 'max-age=31536000');

const proxySettings: Array<[string, number]> = [];
configureTrustProxy(
  { set(setting, value) { proxySettings.push([setting, value]); } },
  '1'
);
assert.deepEqual(proxySettings, [['trust proxy', 1]]);

configureTrustProxy(
  { set(setting, value) { proxySettings.push([setting, value]); } },
  ''
);
assert.equal(proxySettings.length, 1);
assert.throws(
  () => configureTrustProxy({ set() {} }, '1.5'),
  /ZERO_TRUST_PROXY_HOPS/
);
assert.throws(
  () => configureTrustProxy({ set() {} }, '-1'),
  /ZERO_TRUST_PROXY_HOPS/
);

console.log('Security headers and explicit reverse-proxy trust configuration verified.');
