import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const compute = read('../compute-server.ts');
const prismaModule = read('../module.mjs');
const persistence = read('../server/persistence.ts');
const gemini = read('../server/geminiClient.ts');
const cloudflare = read('../server/cloudflareWorkersAi.ts');
const providerKeys = ['GEMINI_API_KEY', 'ZERO_GEMINI_FREE_TIER_ONLY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'ZERO_WEB_SEARCH_URL', 'ZERO_WEB_SEARCH_TOKEN', 'ZERO_TTS_WORKER_URL', 'ZERO_TTS_WORKER_TOKEN', 'ZERO_VIDEO_ENGINE_URL', 'ZERO_VIDEO_ENGINE_TOKEN'];
const clearIndex = compute.indexOf('clearRuntimeConfig([');
const configureIndex = compute.indexOf('configureRuntimeConfig({');
assert.ok(clearIndex >= 0 && configureIndex > clearIndex, 'Preview must clear inherited provider settings before injecting scoped inputs.');
for (const key of providerKeys) assert.ok(compute.includes('"' + key + '"'), 'Preview must clear inherited ' + key);
assert.match(prismaModule, /ZERO_ADMIN_PASSWORD:\\s*envSecret\\(['"]ZERO_ADMIN_PASSWORD['"]\\)/);
assert.match(prismaModule, /ZERO_SESSION_SECRET:\\s*envSecret\\(['"]ZERO_SESSION_SECRET['"]\\)/);
assert.doesNotMatch(prismaModule, /GEMINI_API_KEY|CLOUDFLARE_API_TOKEN|ZERO_WEB_SEARCH_TOKEN|ZERO_TTS_WORKER_TOKEN|ZERO_VIDEO_ENGINE_TOKEN/);
assert.ok(persistence.includes('validatePostgresConnectionString(runtimeConfig.DATABASE_URL)'), 'Pool creation must validate the explicit DATABASE_URL.');
assert.ok(gemini.includes("ZERO_GEMINI_FREE_TIER_ONLY !== 'true'"), 'Gemini must reject calls without the explicit free-tier gate.');
assert.ok(cloudflare.includes('ZERO startet keinen kostenpflichtigen Fallback'), 'Cloudflare quota errors must not trigger paid fallback.');

console.log('ZERO fail-closed security guard tests passed.');
