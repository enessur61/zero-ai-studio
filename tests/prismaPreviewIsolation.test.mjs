import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../module.mjs');
const serviceSource = read('../service.mjs');
const computeSource = read('../compute-server.ts');
const workflowSource = read('../.github/workflows/prisma-deploy.yml');

// The Composer module must provision its own branch-scoped PostgreSQL resource
// and inject that exact resource into the Compute service.
assert.match(moduleSource, /rawPostgres\(\s*\{\s*name:\s*["']database["']\s*\}\s*\)/);
assert.match(moduleSource, /deps:\s*\{\s*db:\s*database\s*\}/);

const serviceProvision = moduleSource.match(/provision\(zeroAiStudioService,\s*\{([\s\S]*?)\n\s*\}\);/);
assert.ok(serviceProvision, 'Prisma module must provision the ZERO service explicitly.');
const inputBlock = serviceProvision[1].match(/input:\s*\{([\s\S]*?)\n\s*\},/);
assert.ok(inputBlock, 'Prisma module must declare an explicit environment input allowlist.');
const injectedNames = [...inputBlock[1].matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(
  injectedNames,
  ['ZERO_ADMIN_PASSWORD', 'ZERO_SESSION_SECRET'],
  'Only dedicated preview auth/session secrets may be injected by this module.'
);
assert.doesNotMatch(moduleSource, /DATABASE_URL|GEMINI_API_KEY|CLOUDFLARE_API_TOKEN|ZERO_WEB_SEARCH_TOKEN|ZERO_TTS_WORKER_TOKEN|ZERO_VIDEO_ENGINE_TOKEN/);

// The service's database dependency is supplied by the module, not by a
// manually copied production connection string.
assert.match(serviceSource, /deps:\s*\{\s*db:\s*rawPostgres\(\)\s*\}/);
assert.match(computeSource, /const\s+databaseUrl\s*=\s*db\.url/);
assert.match(computeSource, /DATABASE_URL:\s*databaseUrl/);
assert.doesNotMatch(computeSource, /process\.env\.DATABASE_URL/);

// The deploy workflow is intentionally branch-pinned. Manual dispatch is
// still constrained by the job-level exact-ref guard.
const targetBranch = 'prisma-cloud/setup-v3icl3cvq646n2a35puh95r3';
assert.match(workflowSource, new RegExp('branches:[\\s\\S]*?-\\s*' + targetBranch.replaceAll('/', '\\/')));
assert.match(
  workflowSource,
  new RegExp("if:\\s*github\\.ref\\s*==\\s*'refs/heads/" + targetBranch.replaceAll('/', '\\/') + "'")
);
assert.doesNotMatch(workflowSource, /^\s*pull_request\s*:/m);
assert.match(workflowSource, /permissions:[\s\S]*?contents:\s*read/);
assert.match(workflowSource, /id-token:\s*write/);
assert.match(workflowSource, /s5j2brwlvh3d4mkm2cyrycm5\.fra\.prisma\.build/);

console.log(
  'Prisma preview code-boundary tests passed. External Prisma variable scopes, ' +
  'environment-group links, secret files, and actual database destinations still require separate read-only verification.'
);
