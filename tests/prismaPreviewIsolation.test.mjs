import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../module.mjs');
const serviceSource = read('../service.mjs');
const computeSource = read('../compute-server.ts');
const runtimeConfigSource = read('../server/runtimeConfig.ts');
const workflowSource = read('../.github/workflows/prisma-deploy.yml');

const targetBranch = 'prisma-cloud/setup-v3icl3cvq646n2a35puh95r3';

assert.match(moduleSource, /rawPostgres\(\s*\{\s*name:\s*["']database["']\s*\}\s*\)/);
assert.match(moduleSource, /deps:\s*\{\s*db:\s*database\s*\}/);
assert.doesNotMatch(moduleSource, /DATABASE_URL/);

const serviceProvision = moduleSource.match(/provision\(zeroAiStudioService,\s*\{([\s\S]*?)\n\s*\}\);/);
assert.ok(serviceProvision, 'Prisma module must provision the ZERO service explicitly.');
const inputBlock = serviceProvision[1].match(/input:\s*\{([\s\S]*?)\n\s*\},/);
assert.ok(inputBlock, 'Prisma module must declare an explicit environment input allowlist.');
const injectedNames = [...inputBlock[1].matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(injectedNames, ['ZERO_ADMIN_PASSWORD', 'ZERO_SESSION_SECRET']);
assert.match(inputBlock[1], /ZERO_ADMIN_PASSWORD:\s*envSecret\(["']ZERO_ADMIN_PASSWORD["']\)/);
assert.match(inputBlock[1], /ZERO_SESSION_SECRET:\s*envSecret\(["']ZERO_SESSION_SECRET["']\)/);

assert.match(serviceSource, /deps:\s*\{\s*db:\s*rawPostgres\(\)\s*\}/);
assert.doesNotMatch(serviceSource, /DATABASE_URL/);
assert.match(computeSource, /const\s+databaseUrl\s*=\s*db\.url/);
assert.match(computeSource, /DATABASE_URL:\s*databaseUrl/);
assert.doesNotMatch(computeSource, /process\.env\.DATABASE_URL/);

const pushBlock = workflowSource.match(/^  push:\s*\n([\s\S]*?)(?=^  workflow_dispatch:)/m);
assert.ok(pushBlock, 'Deploy workflow must declare a push trigger.');
const pushBranches = [...pushBlock[1].matchAll(/^ {6}-\s*(\S.*?)\s*$/gm)]
  .map((match) => match[1]);
assert.deepEqual(pushBranches, [targetBranch], 'Deploy push trigger must allow only the dedicated Prisma branch.');
assert.match(workflowSource, /^  workflow_dispatch:\s*$/m);
assert.match(
  workflowSource,
  new RegExp("if:\\s*github\\.ref\\s*==\\s*'refs/heads/" + targetBranch.replaceAll('/', '\\/') + "'")
);
assert.doesNotMatch(workflowSource, /^\s*pull_request\s*:/m);
assert.match(workflowSource, /permissions:\s*\n\s+contents:\s*read/);
assert.match(workflowSource, /id-token:\s*write/);
assert.match(workflowSource, /s5j2brwlvh3d4mkm2cyrycm5\.fra\.prisma\.build/);

const providerKeys = [
  'GEMINI_API_KEY',
  'ZERO_GEMINI_FREE_TIER_ONLY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'ZERO_WEB_SEARCH_URL',
  'ZERO_WEB_SEARCH_TOKEN',
  'ZERO_TTS_WORKER_URL',
  'ZERO_TTS_WORKER_TOKEN',
  'ZERO_VIDEO_ENGINE_URL',
  'ZERO_VIDEO_ENGINE_TOKEN',
];
assert.ok(runtimeConfigSource.includes('export function clearRuntimeConfig(keys: readonly string[]): void'));
assert.ok(runtimeConfigSource.includes('delete runtimeConfig[key]'));
const clearCall = computeSource.indexOf('clearRuntimeConfig([');
const configureCall = computeSource.indexOf('configureRuntimeConfig({');
assert.ok(clearCall >= 0 && configureCall > clearCall, 'Inherited provider configuration must be cleared before explicit inputs are applied.');
for (const key of providerKeys) {
  assert.ok(computeSource.includes(`"${key}"`), `Preview must clear inherited ${key}.`);
}

console.log(
  'Prisma preview code-boundary tests passed. This static test does not prove external Prisma ' +
  'variable scopes, environment-group links, secret files, or the actual database destination.'
);
