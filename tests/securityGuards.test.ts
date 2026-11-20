import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAuthConfigurationValid, requireSessionSecret, validatePostgresConnectionString } from '../server/securityGuards.ts';
import { clearRuntimeConfig, configureRuntimeConfig } from '../server/runtimeConfig.ts';

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

// Exercise the same environment reset used by Prisma Compute without retaining
// or exposing any developer/CI environment values.
const inheritedKeys = [
  'ZERO_ADMIN_PASSWORD', 'ZERO_SESSION_SECRET', 'GEMINI_API_KEY',
  'ZERO_GEMINI_FREE_TIER_ONLY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN',
  'ZERO_WEB_SEARCH_URL', 'ZERO_WEB_SEARCH_TOKEN', 'ZERO_TTS_WORKER_URL',
  'ZERO_TTS_WORKER_TOKEN', 'ZERO_VIDEO_ENGINE_URL', 'ZERO_VIDEO_ENGINE_TOKEN',
  'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
];
const previousValues = new Map(inheritedKeys.map((key) => [key, process.env[key]]));
try {
  for (const key of inheritedKeys) process.env[key] = 'inherited-test-only';
  clearRuntimeConfig(inheritedKeys);
  for (const key of inheritedKeys) assert.equal(process.env[key], undefined, 'Inherited setting must be cleared: ' + key);
  configureRuntimeConfig({ ZERO_ADMIN_PASSWORD: 'preview-admin-only', ZERO_SESSION_SECRET: 'p'.repeat(32) });
  assert.equal(process.env.ZERO_ADMIN_PASSWORD, 'preview-admin-only');
  assert.equal(process.env.ZERO_SESSION_SECRET, 'p'.repeat(32));
  assert.equal(process.env.GEMINI_API_KEY, undefined, 'Unmapped provider keys must remain absent.');
} finally {
  for (const key of inheritedKeys) {
    const previous = previousValues.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}


const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const compute = read('../compute-server.ts');
const prismaModule = read('../module.mjs');
const serviceDefinition = read('../service.mjs');
const persistence = read('../server/persistence.ts');
const gemini = read('../server/geminiClient.ts');
const cloudflare = read('../server/cloudflareWorkersAi.ts');
const server = read('../server.ts');
const postgresEnvironmentKeys = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGOPTIONS', 'PGTARGETSESSIONATTRS', 'PGCHANNELBINDING'];
const providerKeys = ['GEMINI_API_KEY', 'ZERO_GEMINI_FREE_TIER_ONLY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'ZERO_WEB_SEARCH_URL', 'ZERO_WEB_SEARCH_TOKEN', 'ZERO_TTS_WORKER_URL', 'ZERO_TTS_WORKER_TOKEN', 'ZERO_VIDEO_ENGINE_URL', 'ZERO_VIDEO_ENGINE_TOKEN'];
const clearIndex = compute.indexOf('clearRuntimeConfig([');
const configureIndex = compute.indexOf('configureRuntimeConfig({');
assert.ok(clearIndex >= 0 && configureIndex > clearIndex, 'Preview must clear inherited provider settings before injecting scoped inputs.');
const clearBlock = compute.slice(clearIndex, configureIndex);
assert.ok(clearBlock.includes('"ZERO_ADMIN_PASSWORD"') && clearBlock.includes('"ZERO_SESSION_SECRET"'), 'Preview must clear inherited authentication secrets before applying branch-scoped values.');
assert.ok(compute.includes('const { db } = service.load();') && compute.includes('const databaseUrl = db.url;'), 'Preview DATABASE_URL must originate only from its branch-provisioned Composer database.');
assert.ok(compute.includes('DATABASE_URL: databaseUrl'), 'The branch-provisioned database URL must override any inherited DATABASE_URL.');
assert.ok(prismaModule.includes('rawPostgres({ name: "database" })') && prismaModule.includes('deps: { db: database }'), 'Each Composer branch must provision and wire its own raw PostgreSQL resource.');
for (const key of postgresEnvironmentKeys) assert.ok(compute.includes('"' + key + '"'), 'Preview must clear inherited PostgreSQL override ' + key);
for (const key of providerKeys) assert.ok(compute.includes('"' + key + '"'), 'Preview must clear inherited ' + key);
assert.ok(prismaModule.includes('ZERO_ADMIN_PASSWORD: envSecret("ZERO_ADMIN_PASSWORD")'));
assert.ok(prismaModule.includes('ZERO_SESSION_SECRET: envSecret("ZERO_SESSION_SECRET")'));
for (const key of providerKeys) assert.ok(!prismaModule.includes(key), 'Preview module must not bind optional provider or worker input ' + key);
assert.ok(serviceDefinition.includes('input: serviceInput'), 'Provider and worker settings may only enter through typed service inputs.');
assert.ok(persistence.includes('validatePostgresConnectionString(runtimeConfig.DATABASE_URL)'), 'Pool creation must validate the explicit DATABASE_URL.');
assert.ok(persistence.includes('connectionString: databaseUrl') && persistence.includes('url: databaseUrl'), 'Both PostgreSQL drivers must receive the same validated explicit URL.');
assert.ok(!persistence.includes('new Pool()'), 'PostgreSQL must never create a pool from implicit PG* environment defaults.');
assert.ok(server.includes("if (IS_PRODUCTION && !runtimeConfig.DATABASE_URL)"), 'Production server startup must stop when DATABASE_URL is missing.');
assert.ok(server.includes('isAuthConfigurationValid(ZERO_ADMIN_PASSWORD, ZERO_SESSION_SECRET)'), 'Production auth readiness must require both secrets.');
assert.ok(server.includes('requireSessionSecret(ZERO_SESSION_SECRET)'), 'Session HMAC operations must fail closed without a valid secret.');
assert.ok(gemini.includes("ZERO_GEMINI_FREE_TIER_ONLY !== 'true'"), 'Gemini must reject calls without the explicit free-tier gate.');
assert.ok(cloudflare.includes('ZERO startet keinen kostenpflichtigen Fallback'), 'Cloudflare quota errors must not trigger paid fallback.');
assert.ok(server.includes('runtimeConfig.ZERO_TTS_WORKER_URL?.trim()') && server.includes('runtimeConfig.ZERO_TTS_WORKER_TOKEN?.trim()'), 'Piper worker must require an explicitly configured URL and token.');
assert.ok(server.includes('runtimeConfig.ZERO_WEB_SEARCH_URL?.trim()') && server.includes('runtimeConfig.ZERO_WEB_SEARCH_TOKEN?.trim()'), 'Web-search worker must require an explicitly configured URL and token.');
assert.ok(server.includes('runtimeConfig.ZERO_VIDEO_ENGINE_URL?.trim()') && server.includes('runtimeConfig.ZERO_VIDEO_ENGINE_TOKEN?.trim()'), 'Video worker must require an explicitly configured URL and token.');
assert.ok(server.includes("!['https:', ...(IS_PRODUCTION ? [] : ['http:'])].includes(baseUrl.protocol)"), 'Configured TTS, search and video worker URLs must use HTTPS in production.');
assert.ok(server.includes("endpoint.protocol !== 'https:'"), 'Video health checks must reject non-HTTPS production destinations.');
assert.ok(server.includes("redirect: 'error'"), 'Worker requests must not follow redirects to an unreviewed destination.');
assert.ok(server.includes('paidFallback: false') && server.includes('costFallback: false'), 'Worker outages must not trigger paid provider fallbacks.');
const section = (start: string, end: string): string => {
  const startAt = server.indexOf(start);
  const endAt = server.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0 && endAt > startAt, 'Expected worker source section: ' + start);
  return server.slice(startAt, endAt);
};
const workerConfigSections = [
  ['Web search', section('function getZeroWebSearchWorker()', "app.post('/api/web/research'")],
  ['Piper TTS', section('function getPiperTtsWorkerConfig()', "app.post('/api/audio/tts/piper'")],
  ['Wan video', section('function getWanWorkerConfig()', "app.post('/api/video/engine/jobs'")],
] as const;
for (const [name, source] of workerConfigSections) {
  assert.ok(source.includes('runtimeConfig.') && source.includes('_URL?.trim()'), name + ' must use an explicit runtime URL.');
  assert.ok(source.includes('_TOKEN?.trim()'), name + ' must require an explicit worker token.');
  assert.ok(source.includes("!['https:', ...(IS_PRODUCTION ? [] : ['http:'])].includes(baseUrl.protocol)"), name + ' must reject non-HTTPS production URLs.');
}
assert.ok((server.match(/redirect: 'error'/g) ?? []).length >= 5, 'Every worker proxy must reject redirects rather than forwarding credentials to another host.');



console.log('ZERO fail-closed security guard tests passed.');
