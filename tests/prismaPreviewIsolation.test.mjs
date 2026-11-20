import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../module.mjs');
const serviceSource = read('../service.mjs');
const computeSource = read('../compute-server.ts');
const workflowSource = read('../.github/workflows/prisma-deploy.yml');

const targetBranch = 'prisma-cloud/setup-v3icl3cvq646n2a35puh95r3';

// Composer must create a branch-local database and pass that exact resource
// into the Compute service. A manually copied DATABASE_URL is not accepted.
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
assert.deepEqual(
  injectedNames,
  ['ZERO_ADMIN_PASSWORD', 'ZERO_SESSION_SECRET'],
  'Only the dedicated preview admin/session secrets may be injected by this module.'
);

// The service declares a Composer-managed raw PostgreSQL dependency, and the
// Compute bootstrap derives DATABASE_URL from that dependency, never process.env.
assert.match(serviceSource, /deps:\s*\{\s*db:\s*rawPostgres\(\)\s*\}/);
assert.match(computeSource, /const\s+databaseUrl\s*=\s*db\.url/);
assert.match(computeSource, /DATABASE_URL:\s*databaseUrl/);
assert.doesNotMatch(computeSource, /process\.env\.DATABASE_URL/);

// Push deployment must be restricted to exactly one branch. Manual dispatch
// is also guarded at job level, so selecting another ref cannot deploy.
const pushBlock = workflowSource.match(/^  push:\s*\n([\s\S]*?)(?=^  workflow_dispatch:)/m);
assert.ok(pushBlock, 'Deploy workflow must declare a push trigger.');
const pushBranches = [...pushBlock[1].matchAll(/^\s{4}-\s*(\S.*?)\s*$/gm)]
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

console.log(
  'Prisma preview code-boundary tests passed. This static test does not prove external Prisma ' +
  'variable scopes, environment-group links, secret files, or the actual database destination.'
);
