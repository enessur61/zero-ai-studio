# ZERO Development Factory — strict €0 operating policy

**Product:** ZERO AI STUDIO — BEYOND LIMITS.  
**Operating target:** iPhone-first, verifiable engineering, no paid services or surprise charges.

## Non-negotiable cost boundary

1. Do not start OpenHands Cloud conversations, hosted agents, remote GPU workers, paid API calls, paid build minutes, hosted databases, paid storage, or paid fallback providers without a separately verified €0 cost path.
2. A free API key, free-tier label, open model weights, or successful authentication is not proof that execution is free.
3. If a quota, billing state, usage price, or remaining allowance cannot be verified, treat the service as potentially chargeable and do not invoke it.
4. Never enable billing, upgrade a plan, add a payment method, or accept a paid fallback.
5. Stop when a free quota is exhausted. Do not retry through another provider if that could incur cost.
6. Do not run cloud/GPU workloads for convenience. Prefer local development on user-owned hardware and static analysis that does not require external paid services.
7. GitHub Actions, hosted CI, artifact storage, and deployment can have quotas or billing. Do not assume they are unlimited or free. Keep workflows manual/disabled until the repository owner's remaining free allowance and billing safeguards are verified.

## Agent roles and parallel work

Use these roles as task templates, not as a requirement to run multiple paid agents:

- **Architect:** maps current modules, dependencies, data flow, and interfaces; proposes small, reviewable tasks.
- **Implementer:** changes one isolated module/branch at a time; preserves existing behavior.
- **QA:** identifies and runs only locally available checks; reports exact commands and results.
- **Security reviewer:** checks authentication, authorization, input validation, secrets, media handling, dependency risk, and data exposure.
- **Release reviewer:** checks the diff, documentation, iPhone/PWA behavior, rollback path, and cost boundary.

Parallelize only independent tasks on separate branches. Never let multiple agents edit the same files concurrently. No agent may merge or deploy its own changes.

## Required task lifecycle

1. Inspect repository state and current open PRs before editing.
2. Write a bounded task with target files, acceptance criteria, and explicit non-goals.
3. Create a dedicated branch and preserve the current baseline.
4. Make the smallest coherent change. Do not delete or rewrite existing features without evidence and approval.
5. Run locally available checks where possible: `npm run lint`, `npm test`, `npm run build`. Report unavailable tools honestly; do not claim a check passed unless it ran and passed.
6. Review the full diff for secrets, paid endpoints, unbounded loops/retries, and accidental production changes.
7. Open a draft pull request with summary, changed files, test evidence, risks, and rollback notes.
8. Human review is required before merge, deployment, billing changes, or external service activation.

## ZERO-specific acceptance criteria

- iPhone-first responsive UI and real Safari/PWA verification; do not label native iOS readiness without a real device build/test.
- Every model/provider has a truthful state: source available, adapter implemented, credentials required, quota/cost unknown, live test passed/failed, and device requirements.
- A model is not "working" merely because it appears in the catalog or an API key authenticates.
- Keep paid and unverified providers disabled. No paid fallback.
- Every video creation/export path enforces a hard maximum of 60 seconds.
- Keep user projects, memory, backups, and secrets protected; never commit credentials.
- Distinguish local inference from hosted inference. Open weights do not make compute, storage, or hosting free.

## Current repository checks

The repository's `package.json` defines:
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run ci:verify` (runs the three checks above)

These commands are not evidence of a successful run until executed in the current revision.

## Stop conditions

Stop and request human review if:
- any step may incur a charge or requires a payment method;
- provider pricing/quota/billing status is unclear;
- a secret, account permission, production deployment, or destructive migration is involved;
- tests fail or a check cannot be run;
- a task requires broad refactoring outside its agreed scope.

## First implementation sequence

1. Finish and review the currently running OpenHands assessment; do not launch another cloud task.
2. Review the existing security PR and its CI evidence; do not merge blindly.
3. Inventory actual local/offline functionality and all external provider calls.
4. Add regression tests around the €0 guard and the 60-second video ceiling.
5. Separate independent UI, backend, model-adapter, and security tasks into reviewable PRs.
6. Only consider hosted automation after verifying a no-charge execution path and account billing protections.
