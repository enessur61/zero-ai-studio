# ZERO AUTOPILOT — Cloud control plane

This is the first cloud-only operations layer for ZERO AI STUDIO. It is deliberately
read-only: it validates repository code and dependencies, but cannot push commits,
open or merge pull requests, change repository settings, deploy production, or call
an AI provider.

## Run it from an iPhone

1. Open the repository on GitHub in Safari or the GitHub app.
2. Open **Actions** → **ZERO AUTOPILOT**.
3. Tap **Run workflow** and choose **full** for lint, tests, and production build,
   or **dependencies** for the production dependency audit only.
4. Open the resulting run to inspect each job and its summary.

The workflow also runs weekly on Monday at 03:17 UTC. GitHub scheduled workflows
are best-effort and can be delayed; they are not a continuously running agent.

## Safety model

- Workflow token permission is limited to `contents: read`.
- Third-party actions are pinned to immutable commit SHAs.
- Node.js is pinned to major version 22 and dependencies are installed from the lockfile.
- The dependency audit fails on high or critical production dependency advisories.
- The full validation runs the repository's existing lint, test, and build commands.
- No secrets are referenced, printed, or required.
- No provider endpoints are contacted by this workflow.
- No deploy, merge, code mutation, or paid AI API is configured.

## What this does not claim

This workflow is not yet an autonomous coding agent. It does not generate patches,
understand failing tests, or repair code by itself. A genuine agent requires a
separately evaluated model/runtime and narrowly scoped credentials. ZERO will not
silently add a paid API, grant write access, or deploy generated changes.

## Next engineering stage

Continue Phase 2.1 in a separate pull request: resource quotas, atomic PostgreSQL
reservations, idempotency, operation leases, and PostgreSQL 16.16 integration tests.
Do not merge until the full CI and security checks pass.
