# ZERO Film Production and Continuity

The release candidate adds an autonomous, bounded film-production workflow and a persistent continuity workspace.

## Film Director

- Creates a German-language short-film concept, screenplay and four scenes.
- Enforces a total runtime between 20 and 60 seconds; no export is allowed above the 60-second hard limit.
- Validates camera movement values and keeps character appearance prompts consistent.
- Can attach the project to a continuity series. Existing contradictions stop generation until they are resolved.
- Scene revisions are versioned. A targeted correction must be explicitly confirmed and is rejected if the conflict remains.

## Autonomous production

The production pipeline coordinates project/scene persistence, Wan job submission and polling, clip restoration, and local timeline rendering. It keeps temporary Blob URLs out of persisted project JSON and revokes object URLs when their owner is released.

The current Video Studio also persists timeline edits with optimistic project-version checks. Wan job history is normalized before it reaches the iPhone UI, and queued/running jobs can be cancelled through the authenticated worker proxy.

## Continuity and dramaturgy

Continuity state is stored with the ZERO database and initialized when older database or backup payloads are loaded. It tracks series, character knowledge, events, relationships, locations, scene versions, semantic conflicts, and dramaturgy analyses.

The dramaturgy analysis endpoint uses only an enabled, tested free model through ZERO's provider gates. Cloudflare Workers AI is blocked until both free-plan attestations are explicitly enabled. Gemini requests remain blocked unless the free-tier-only switch is explicitly confirmed. There is no paid fallback.

## Wan and Piper limits

- Wan remains optional and GPU-only. The self-hosted Compose profile is opt-in; CI does not run GPU inference.
- Wan jobs are persisted by the worker, scoped by an authenticated principal hash, and support cancellation.
- Wan MP4 responses are size/type checked and streamed with a 100 MB upper bound instead of being fully buffered in server memory.
- Piper uses the pinned German Thorsten model revision and validates model integrity. CI validates metadata, cache behavior and the ARM64 container, but does not download voice weights or synthesize speech.
- The Render preview service does not automatically include the optional GPU/Piper workers. Their URLs and tokens must be configured separately; no production secrets are copied.

## Validation boundary

A green CI run validates the exact repository commit, including unit/integration tests, PostgreSQL resource reservations, worker API tests, ARM64 container smoke tests and Compose/Caddy startup. It does not prove native Ampere performance, a real GPU job, real Piper inference, or physical iPhone Safari behavior. Those remain separate acceptance tests.
