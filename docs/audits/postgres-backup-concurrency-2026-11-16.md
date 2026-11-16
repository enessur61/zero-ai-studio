# PostgreSQL, concurrency and backup audit

**Date:** 2026-11-16  
**Audited revision:** `5891e51c7213662a7ad35e5b48828bd10a80fd5e` (the current PR #82 base)  
**Scope:** `server/persistence.ts`, `server/store.ts`, project write/restore routes in `server.ts`, and `server/zipExporter.ts`.  
**Status:** Read-only audit. No production database, backup, or user media was changed.

## Executive summary

ZERO currently persists the entire application state as one JSONB value in `zero_app_state`. This is workable for a small single-instance application, but it is not a safe multi-instance write architecture: the SQL upsert has no revision check or transaction that protects a read-modify-write cycle. The process-local cache also means each server process can hold a different copy of the full state.

Backup creation and restore are multi-step operations spanning JSONB state and a separate backup-file table (or filesystem). Those steps are not one transaction. A failure between steps can leave orphaned files or metadata that refers to a backup which was not completed. Concurrent automatic backup requests can also pass the 15-minute check before either request records its backup.

No merge, deployment, schema change, migration, or database write was performed as part of this audit.

## Findings

### P1 / High — No cross-instance concurrency control for the primary state

**Evidence**
- `server/persistence.ts`: `zero_app_state` contains one `payload JSONB` row, keyed by `primary`.
- `readPersistentState` reads the payload without a revision.
- `writePersistentState` performs an unconditional `INSERT ... ON CONFLICT ... DO UPDATE`; it does not compare an expected version, acquire an application-wide lock, or merge changed fields.
- `server/store.ts`: `loadDb` caches the full mutable `ZeroDatabase` in process-global `dbCache` and returns it on subsequent calls. `saveDb` replaces the cache and writes the complete object.
- PostgreSQL pool is configured with `max: 3`, so more than one query can be active. Separate app instances have separate caches.

**Impact**
If two server instances load the same starting payload, then mutate different fields, the later full-payload upsert can overwrite the earlier instance's change. This is a lost-update risk. A single-instance cache reduces some local races because handlers share an object, but it does not protect multiple processes or stale objects passed through restore flows.

**Recommendation**
Before scaling or enabling multiple app instances, introduce a revisioned state-write protocol (for example, a `revision BIGINT` column and compare-and-swap update) and explicit conflict handling. A process-local promise queue alone is not a multi-instance fix. Prefer eventually splitting frequently changed domains into relational rows/tables with narrow transactions rather than rewriting the entire JSONB state for every mutation.

### P1 / High — Backup metadata and backup bytes are not committed atomically

**Evidence**
- `zero_backup_files` stores backup bytes in a separate `BYTEA` table with no foreign key to the JSONB metadata.
- `createSystemBackup` writes the backup file first, then adds metadata to `db.backups` and saves the main state, then prunes older files.
- `createVersionedZipBackup` first mutates the version/changelog and saves the main state, then builds and verifies the ZIP, writes the ZIP bytes, updates backup metadata, saves the main state again, and finally deletes pruned files.
- Filesystem mode follows the same multi-step pattern with separate file writes/removals.

**Impact**
A failure during ZIP creation can leave a bumped version/changelog without a corresponding archive. A failure saving metadata after writing bytes can leave an orphaned backup file. A failure deleting a pruned file can leave bytes without a metadata entry. These are recoverable in many cases, but the current flow does not reconcile them automatically.

**Recommendation**
Design backup creation as a recoverable state machine: stage the archive, verify it, persist its bytes, then atomically publish its metadata and version pointer. Add a reconciliation routine for orphaned/missing backup records. Use PostgreSQL transactions for metadata changes and explicit cleanup/compensation for BYTEA/filesystem operations; filesystem writes cannot participate in a PostgreSQL transaction.

### P1 / High — Automatic backup throttle is check-then-act, not concurrency-safe

**Evidence**
- `maybeAutoCreateZipBackup` reads the latest automatic backup and checks whether it is younger than 15 minutes.
- It then calls `createVersionedZipBackup` without a lock or database uniqueness constraint.
- `createVersionedZipBackup` increments the version and derives a filename with second-level timestamp precision.

**Impact**
Two requests arriving together can both see no recent backup and both create archives. They can compute the same next version and potentially the same filesystem filename. This defeats the intended 15-minute coalescing rule and can cause duplicate metadata or file replacement in filesystem mode.

**Recommendation**
Enforce the throttle in PostgreSQL, not only in process memory: use a transaction/advisory lock or a dedicated backup-job row with a uniqueness/lease rule. Add a concurrency test that fires multiple simultaneous auto-backup requests and asserts only one automatic archive is published.

### P1 / High — Restore can race normal writes and replaces the whole cached state

**Evidence**
- `restoreFromVerifiedZipBackup` verifies the archive and JSON, creates a safety backup, then calls `saveDb(parsedRestoredDb)`.
- `restoreSystemBackup` similarly creates a safety backup, then replaces the database state with the parsed backup.
- Neither restore path takes an application-wide write lock or checks whether the live state changed after the backup was selected.

**Impact**
A normal write that occurs during a restore can be lost when the restored full-state object is saved. A restore also replaces the process cache object, while another handler may still hold a reference to the previous object.

**Recommendation**
Treat restore as an exclusive maintenance operation. Acquire the same database-level write lock used by all state mutations, re-read the live revision after taking the lock, create the safety backup from that locked revision, then atomically replace state and increment the revision. Return a conflict rather than silently overwriting concurrent changes.

### P2 / Medium — Backup coverage differs from browser-local media coverage

**Evidence**
- ZIP backup embeds `data/zero-studio-db.json` and repository files.
- Generated scene clips are held in browser IndexedDB by `lib/sceneVideoStore.ts`; they are not available to the server-side ZIP builder.
- Temporary `blob:` object URLs are intentionally stripped from persisted project data.

**Impact**
A verified ZIP can restore project metadata and server-persisted assets but cannot recreate browser-only scene clip bytes. This is an architectural limitation, not corruption of the ZIP.

**Recommendation**
Until a genuinely free durable media-storage design is approved and implemented, label backups accurately and require users to export local scene clips separately. Any future media migration must include stable IDs, backward-compatible reads, backup inclusion, restore validation, and a verified rollback path.

### P2 / Medium — No PostgreSQL/backup integration tests were found in the current test tree

**Evidence**
- The repository test tree contains ZIP security tests and state-related unit tests, but no dedicated PostgreSQL persistence, backup creation, concurrent-write, or restore round-trip integration test.
- CI currently validates lint, the existing test suite, build, and server smoke test; that does not exercise a live PostgreSQL backup/restore lifecycle.

**Impact**
The most consequential data-integrity paths are not covered by automated end-to-end tests.

**Recommendation**
Add an isolated PostgreSQL service-backed test suite for: schema initialization, initial-state bootstrap, concurrent revisions, backup metadata/blob consistency, automatic-backup coalescing, restore with a safety backup, and rollback on injected failures. Keep production data completely out of these tests.

### P2 / Medium — Single JSONB payload and embedded media amplify every write and snapshot

**Evidence**
- Project assets accept data URLs up to 16 MiB of URL text and up to 200 assets per project.
- Project update snapshots preserve full prior scene and asset state, up to 15 snapshots.
- `saveDb` serializes and replaces the full application state on every write.
- ZIP and JSON backups serialize the full state again.

**Impact**
Large media can be duplicated across snapshots and backups. This increases JSON serialization, database write amplification, memory use, backup size, and restore time. The audit did not inspect live production row size or measure actual bloat.

**Recommendation**
Measure production JSONB row size and backup growth before choosing thresholds. Longer term, move media bytes out of JSONB into content-addressed blobs and keep stable references in project/snapshot state. Preserve a resolver for existing inline data URLs until all records and backups have been migrated and verified.

## Recommended implementation order

1. **Do not scale to multiple server instances** until revisioned writes and restore locking are implemented.
2. Add PostgreSQL integration tests and failure-injection tests before changing persistence semantics.
3. Make automatic backup creation concurrency-safe and make metadata/blob publication recoverable.
4. Add exclusive restore locking with revision checks and mandatory safety-backup verification.
5. Measure live JSONB and backup sizes; then design a backward-compatible media-reference migration.
6. Add reconciliation/diagnostics for missing and orphaned backup blobs.

## Validation boundary

This is a source-code audit, not a live production database inspection. No production row sizes, Render instance count, backup contents, or restore drill were queried. Findings describe code paths and risks visible in the audited revision; they do not assert that data has already been lost.


## PR #84 implementation follow-up

**Implementation branch:** `feat/postgres-revision-control-concurrency`  
**Scope:** PostgreSQL state writes, JSON/ZIP backup publication, and restore conflict handling.

Implemented in the follow-up draft:
- Every primary-state write acquires the same PostgreSQL transaction-scoped advisory lock before checking/advancing the revision. The revision compare remains mandatory; the lock is not a substitute for the CAS check.
- Restore creates its safety backup from a detached snapshot. The exact revision committed with that safety backup is retained and used as the expected revision for the full-state replacement. If a normal write commits after the safety backup, restore is rejected as a revision conflict rather than overwriting that write.
- JSON and ZIP backup bytes are inserted in the same PostgreSQL transaction as the state payload/revision containing their metadata. Backup creation uses a detached state snapshot and captured base revision; ZIP version/changelog changes are not published before archive verification. If a concurrent write commits while a ZIP is being built, the final revision check aborts publication instead of creating a backup for stale state.
- Filesystem backup publication uses compensating cleanup if the state save fails.
- Integration tests cover two independent pools racing on the same revision, stale restore rejection after a normal write, atomic state-plus-backup publication, and rollback/no orphan blob after an injected backup metadata constraint failure.

**Remaining limitations / follow-up risks**
- The advisory lock serializes each primary-state transaction. The complete restore workflow is not held inside one long-lived transaction while archive verification and filesystem work execute; instead the final revision fence aborts restore if the live state changed after the safety snapshot. This favors safety over automatic retry.
- PostgreSQL automatic ZIP throttling is now coordinated by a dedicated session-level advisory-lock lease across archive generation and publication; the 15-minute throttle is checked while holding that lease. The lease and throttle are exercised across two independent pools in the integration test.
- Pruning backup blobs occurs after metadata publication. A cleanup failure can leave orphaned bytes; a reconciliation/diagnostic task is still needed.
- Browser IndexedDB scene clips remain outside server ZIP backups.
- Integration tests run only against an explicitly local PostgreSQL endpoint and do not inspect production data.

The integration test is wired as a dedicated CI step and passed on PR #84 head `221366f56ebc957f02590ac3f4db842446cd7e86` in CI run #728 (`43971499532`): all 19 job steps completed successfully, including PostgreSQL revision/concurrency integration, production build, and production server smoke test. The HTTP restore-vs-write test also passed using two independent PostgreSQL pools.


## Automatic ZIP throttle and backup reconciliation follow-up

- PostgreSQL-backed automatic ZIP creation now holds a dedicated session-level advisory lock across archive generation and publication. Independent server instances cannot both pass the throttle check and create overlapping automatic backups.
- A successful automatic backup records `last_success_at` in `zero_backup_auto_state`; the next automatic attempt is refused for 15 minutes. A failed attempt releases the lock without advancing the successful-backup timestamp.
- Local file-only development retains the existing process-local 15-minute check; it is not a multi-process coordination mechanism.
- A read-only `inspectBackupConsistency` diagnostic compares backup metadata IDs in the primary JSONB state with IDs in `zero_backup_files`, reporting orphaned blob IDs and metadata entries whose blob is missing.
- The diagnostic deliberately does not delete or rewrite anything. Automated cleanup remains a separate, approval-sensitive maintenance operation.
- The PostgreSQL integration test now checks lease exclusion across two pools, the 15-minute throttle after success, a clean backup consistency report, and detection of both orphaned bytes and missing blobs.

**Atomic throttle marker:** for PostgreSQL-backed automatic ZIP backups, the `last_success_at` success marker is written in the same transaction as the primary state/revision and backup bytes. A failed publication rolls back the marker as well, so there is no post-commit crash window between publishing the backup and recording throttle success. Filesystem-only development still uses a process-local throttle and does not provide multi-process coordination.


## Verified production ZIP restore race coverage — CI #733

**Validated head:** `22d7d6851d572c28005e9c201b6357d1f534a670`  
**Workflow run:** [CI #733](https://github.com/enessur61/zero-ai-studio/actions/runs/43972823709) — run `43972823709`, job `133669126987` (`verify`)  
**Result:** `completed / success`; all 19 executed job steps passed. The complete job log was retrieved and reviewed (1,006 lines / 92,580 characters).

The production ZIP restore orchestration is factored into `server/verifiedZipRestore.ts`; `server/store.ts` wires the production dependencies into that same service. The PostgreSQL integration test invokes the shared orchestration through the ZIP restore HTTP handler and verifies:

- A real ZIP is built with the production ZIP builder and accepted by the production ZIP verifier before any safety backup is attempted.
- The safety-backup dependency creates a ZIP snapshot, verifies it, and persists its bytes plus metadata through the PostgreSQL atomic backup write path before restore proceeds.
- A normal write through the independent second PostgreSQL pool advances the revision after the safety snapshot. The resumed restore is rejected with HTTP 409 / `PERSISTENCE_REVISION_CONFLICT`; the newer write remains intact.
- The persisted safety ZIP remains verifiable and its metadata/blob relationship remains consistent after the conflict.
- A corrupt ZIP is rejected before safety-backup creation; a safety-backup publication failure aborts before restore persistence.

**Coverage boundary:** the test exercises the production restore orchestration, real ZIP builder/verifier, HTTP handler, PostgreSQL atomic backup persistence, and final revision fence. The safety-backup creation function itself is supplied as an injected test dependency; its ZIP and PostgreSQL persistence effects are tested, while the production wiring uses `createVersionedZipBackup`. This is not a full production deployment or a test against production data.

CI #733 also passed secret scanning, Gemini free-only billing guard, lint, all npm tests, PostgreSQL integration, production build, production server smoke test, all post-job hooks, and container cleanup. The complete log contained only known non-blocking warnings (Node.js 20 action deprecation, Go cache without `go.sum`, and `punycode` deprecation) plus intentional PostgreSQL `NOT NULL` violations used by rollback-negative tests. No actionable failure was found.

PR #84 remains Draft and open. No merge or deployment was performed.

## Verified production ZIP backup publication and advisory-lock failure paths — CI #741

**Validated head:** `2985473b86d2fd7febdec85363c67b106e25c1a8`  
**Workflow run:** [CI #741](https://github.com/enessur61/zero-ai-studio/actions/runs/43974270033) — run `43974270033`, job `133674077867` (`verify`)  
**Result:** `completed / success`; all 19 job steps, including post-job hooks, container cleanup, and job completion, passed. The complete job log was retrieved and reviewed (1,012 lines / 93,247 characters).

The shared production ZIP backup implementation is in `server/versionedZipBackup.ts` as `createVersionedZipBackupService`. Production wiring in `server/store.ts` supplies the actual database read/write functions, `writePersistentStateWithBackupFile`, production ZIP builder/verifier, and backup-file deletion. PostgreSQL automatic backup creation is run through `withPersistentAutoBackupLease` and `acquirePersistentAutoBackupLease`.

The PostgreSQL integration test invokes this exact shared production ZIP backup service against an isolated test schema and two independent pools. It uses the production ZIP builder and verifier and the same atomic state/revision + ZIP blob + optional automatic-success-marker transaction. Verified cases:

- **Successful publication:** the service builds and verifies a ZIP, persists the archive bytes and corresponding metadata, and the stored archive is read back and verified.
- **Injected publication failure:** a PostgreSQL trigger rejects the backup-blob INSERT after the real ZIP has been built and verified. The service surfaces the failure; primary state, metadata, and revision remain unchanged by transaction rollback.
- **Success marker:** `last_success_at` remains at its prior value when publication fails; the marker is not advanced by a failed attempt.
- **Lease release after publication failure:** a second independent pool immediately acquires and releases the advisory lease, then the first pool also reacquires it. This verifies that the failure path does not strand the session-level lock.
- **Unlock transport failure:** when the explicit `pg_advisory_unlock` query fails, the checked-out physical client is destroyed rather than returned to the reusable pool.
- **Lease-state query plus compensating-unlock failure:** if the state query fails after lock acquisition and the compensating unlock cannot be confirmed, the physical connection is likewise destroyed.

The lease implementation checks the boolean result of `pg_advisory_unlock`, not merely whether the SQL query returned without throwing. Its release operation is idempotent through a cached completion promise. The shared wrapper releases the lease on archive/publication errors and propagates an `AggregateError` if both backup work and release fail.

**Coverage boundary:** these are integration tests against isolated PostgreSQL pools/schema, not production customer data or a live deployed service. The production orchestration, ZIP builder/verifier, and atomic persistence path are shared; test dependencies point those operations at the isolated schema. Filesystem-only development mode remains a separate path and does not provide PostgreSQL multi-instance coordination.

The full CI run also passed secret scanning, Gemini free-only billing guard, lint, npm tests, PostgreSQL revision/concurrency integration, production build, production server smoke test, all post-job hooks, and container cleanup. The log's PostgreSQL `NOT NULL` violations and `injected ZIP publication failure` are expected negative-test fixtures. Non-blocking warnings included Node.js 20 action deprecation, absent `go.sum` for the Go cache, `punycode`/dependency deprecations, and local PostgreSQL test-container trust authentication. No actionable CI failure was found.

PR #84 remains open and Draft. No merge or deployment was performed.


## ZIP backup retention cleanup and operational reconciliation — CI #751

**Validated code head:** `50686d8ca7b1d46819645abc5dfa99ad3d4d655d`  
**Workflow run:** [CI #751](https://github.com/enessur61/zero-ai-studio/actions/runs/43975616542) — run `43975616542`, job `133678685930` (`verify`)  
**Result:** `completed / success`; all 19 job steps passed, including post-job hooks and PostgreSQL container cleanup. The complete job log was retrieved and reviewed (1,020 lines / 94,227 characters).

### Findings and implemented corrections

- The PostgreSQL consistency inspector previously existed only as an internal persistence helper; no production route called it. Added authenticated, read-only `GET /api/system/zip-backups/reconciliation`, returning orphaned blob IDs, missing blob IDs, and counts. It does not delete or repair data.
- The inspector previously read state metadata and blob IDs with separate pool queries. Those statements could observe different commits and produce a transient false orphan/missing report. It now checks both through one checked-out connection inside `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, then commits or rolls back and always releases the connection.
- ZIP retention previously used `Promise.all` after the metadata+new-blob publication had already committed. A deletion rejection could make the caller see a generic backup failure even though the new backup was durable, while other cleanup tasks could still be running. Cleanup now awaits every attempt with `Promise.allSettled` and throws a typed `BackupCleanupError` containing the committed backup and exact IDs whose old blobs remain.
- Manual ZIP creation and explicit deletion return HTTP 202 with `cleanupPending` and the affected IDs when publication/metadata removal succeeded but blob cleanup failed. Automatic backup creation logs the pending cleanup and returns the already-committed backup rather than misreporting it as unpublished. The read-only reconciliation endpoint provides the follow-up diagnostic.
- ZIP deletion retains metadata-first ordering: if blob deletion fails, the backup is no longer offered as downloadable metadata, and the orphan can be identified without leaving a live entry that points to missing bytes.

### Regression coverage

- A focused fake-pool assertion verifies reconciliation starts a read-only repeatable-read transaction, uses one checked-out client, commits, and releases it.
- PostgreSQL integration coverage seeds old unprotected ZIP metadata and blobs, injects one deletion failure during retention, and verifies the new backup and metadata remain committed, successful deletions complete, the exact failed blob is reported as an orphan, and the report returns clean after the test removes that fixture blob.
- The production server smoke test authenticates and calls the new reconciliation endpoint after JSON/ZIP backup and restore; it asserts both orphan and missing counts are zero.
- The integration tests run against isolated local PostgreSQL schemas and two independent pools. They do not inspect or modify production customer data.

### CI evidence and remaining boundaries

CI #751 passed secret scanning, dependency installation, Gemini free-only billing guard, TypeScript lint, npm tests, PostgreSQL revision/restore-race/backup cleanup integration, production build, authenticated production smoke test including reconciliation, post-job hooks, and container cleanup. The PostgreSQL `NOT NULL` violations and `injected ZIP publication failure` in the service logs are intentional negative-test fixtures. Non-blocking warnings included Node.js 20 action deprecation, absent `go.sum` for the Go cache, dependency/`punycode` deprecations, and local PostgreSQL trust authentication. No actionable CI failure remained.

The reconciliation endpoint is intentionally read-only; no automatic orphan deletion or missing-blob repair was added. A future destructive maintenance operation would require a separate reviewed workflow and explicit safeguards. PR #84 remains open and Draft. No merge or deployment was performed.


## Multi-version ZIP chain and restore-order audit — CI #755

**Validated code head:** `124f1261717580bb2b792b76e4675931b847ca4d`  
**Workflow run:** [CI #755](https://github.com/enessur61/zero-ai-studio/actions/runs/43976914776) — run `43976914776`, job `133683134182` (`verify`)  
**Result:** `completed / success`; all 19 job steps passed, including PostgreSQL integration, production build, authenticated production smoke test, post-job hooks, and PostgreSQL container cleanup. The complete job log was retrieved and reviewed (1,020 lines / 94,227 characters).

### Findings and implemented correction

- `bumpPatchVersion` previously fell back to `1.1.1` for malformed stored versions. That could silently move a backup history backwards. It now accepts only a three-part numeric MAJOR.MINOR.PATCH value with safe integer components and rejects malformed or overflowing values before ZIP generation or persistence.
- The PostgreSQL integration test now invokes the shared production `createVersionedZipBackupService` repeatedly against isolated PostgreSQL pools. It creates three consecutive versions (`1.2.1`, `1.2.2`, `1.2.3`) from distinct persisted project states.
- Each version's committed PostgreSQL blob is read back, checked with the production ZIP verifier, and its embedded `data/zero-studio-db.json` is parsed. The test verifies the archive's embedded current version and the expected project snapshot.
- The same production `createVerifiedZipRestoreService` is then exercised in non-creation order: restore `1.2.2`, then `1.2.3`. Each restore creates its safety archive through the shared production versioned-backup service; the test verifies the safety record is `pre_restore`, protected, and the stored safety ZIP passes the production verifier.
- The retention failure fixture now includes an older protected manual backup. The test verifies both its metadata and blob survive pruning, while the injected failed deletion remains identifiable as an orphan and all other cleanup attempts finish.
- After the two restores, PostgreSQL reconciliation must report no missing or orphaned backup blobs.

### Intermediate CI failures and correction

- CI #753 (run `43976710113`, head `ca72ecf64cd053a373044388e593780153b1e7f3`) and CI #754 (run `43976843812`, head `96a365bb787176dd37799ac459f2b5e715cd2e2e`) both reached the PostgreSQL integration step and failed because the newly introduced version regex was over-escaped and rejected the valid existing version `1.2.0`. Their full job logs were retrieved (651 lines each). The regex was corrected to match literal dots and numeric components; no database or production data was involved.
- CI #755 validates the corrected code head and the complete new integration sequence. Secret scanning, dependency installation, Gemini free-only billing guard, lint, all npm tests, PostgreSQL integration, production build, authenticated production smoke test, post-job hooks, and container cleanup all passed.
- Expected PostgreSQL `NOT NULL` violations and the injected `injected ZIP publication failure` are negative-test fixtures proving rollback behavior, not CI failures. Non-blocking warnings: Go cache cannot find `go.sum`; GitHub Actions reports Node.js 20 action deprecation. No actionable warning or failure remained on CI #755.

**Coverage boundary:** tests use isolated local PostgreSQL schemas and independent pools, plus the production ZIP builder/verifier and shared backup/restore orchestration. They do not inspect or modify production rows, production backup blobs, or a live deployed service. PR #84 remains open and Draft. No merge or deployment was performed.
