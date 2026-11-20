import assert from 'node:assert/strict';
import { isAuthConfigurationValid, requireSessionSecret, validatePostgresConnectionString } from '../server/securityGuards.ts';

const validDb = 'postgresql://zero_user:dummy-password@preview-db.example.invalid:5432/zero_preview?sslmode=require';
assert.equal(validatePostgresConnectionString(validDb), validDb);
for (const invalid of [undefined, '', 'not-a-url', 'https://db.example.invalid/zero', 'postgresql:///zero', 'postgresql://user@/zero', 'postgresql://user:pass@host1,host2/zero', 'postgresql://user:pass@host/zero?host=other', 'postgresql://user:pass@host/zero?service=prod']) {
  assert.throws(() => validatePostgresConnectionString(invalid));
}

assert.equal(isAuthConfigurationValid('a'.repeat(12), 's'.repeat(32)), true);
assert.equal(isAuthConfigurationValid(undefined, 's'.repeat(32)), false);
assert.equal(isAuthConfigurationValid('a'.repeat(11), 's'.repeat(32)), false);
assert.equal(isAuthConfigurationValid('a'.repeat(12), undefined), false);
assert.equal(isAuthConfigurationValid('a'.repeat(12), 's'.repeat(31)), false);
assert.throws(() => requireSessionSecret(undefined));
assert.throws(() => requireSessionSecret('short'));
assert.equal(requireSessionSecret('s'.repeat(32)), 's'.repeat(32));

console.log('ZERO fail-closed security guard tests passed.');
