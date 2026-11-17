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
- At this audit stage, browser IndexedDB scene clips remained outside server ZIP backups; Phase 1 below records the later server-side project-media mirror and backup coverage.
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


## ZIP archive tamper resistance, PostgreSQL blob integrity and restart restore — CI #762

**Validated implementation head:** `74d04b1dc720a0de15e2ff91e8503e028dad30e2`  
**Workflow run:** [CI #762](https://github.com/enessur61/zero-ai-studio/actions/runs/43978442314) — run `43978442314`, job `133688369006` (`verify`)  
**Result:** `completed / success`; all 19 job steps passed. Complete job log retrieved and reviewed: 1,021 lines / 94,374 characters.

### Verified code risks and corrections

- The prior ZIP verifier found the EOCD signature but did not prove that the EOCD comment ended exactly at the archive boundary, nor that the Central Directory size/offset terminated exactly at the EOCD. It now validates both boundaries and rejects unsupported multi-disk and ZIP64 layouts.
- Each Central Directory record is bounds-checked. The verifier now rejects truncated records, duplicate paths, unsafe absolute/traversal/backslash paths, non-UTF-8-only exporter flags, encryption/data-descriptor flags, and unsupported compression methods.
- Local File Header flags, method, CRC, compressed/uncompressed sizes, and filename bytes must agree with the authoritative Central Directory record. Compressed data must end before the Central Directory.
- Deflate output is bounded by the entry's declared uncompressed size; actual output length must match exactly. Stored entries must have matching compressed and uncompressed sizes. CRC32 is recomputed over every extracted member and compared with the archive value.
- The restore orchestrator now compares the persisted `ZipBackupVersion.sizeBytes` metadata with the actual PostgreSQL blob length before parsing the ZIP. A mismatch stops restore before safety-backup creation or live-state writes.

### Reproducible regression coverage

- Unit tests exercise truncated EOCD, unaccounted trailing bytes, altered compressed payload, incorrect CRC with matching local/central CRC fields, local/central method disagreement, out-of-range Central Directory offset, size disagreement, unsupported compression, and duplicate paths.
- PostgreSQL integration tests publish ZIP bytes through the shared production backup service and then alter the actual `zero_backup_files.payload` row. Both same-length payload corruption and a truncated stored blob are rejected by the production restore service before safety-backup creation; the live JSONB state/revision remains unchanged.
- Restart recovery is simulated with entirely new PostgreSQL pools, new state-store instances, and newly constructed backup and restore service instances. The new service reads a previously persisted ZIP blob, creates a protected pre-restore safety ZIP, restores the older snapshot, and finishes with zero orphaned or missing blobs.
- CI #761 (run `43978347520`, head `aa976f9a8641d585c8abf1fa0b15d2db618db52a`) passed all 19 steps and logged the explicit corruption/truncation/restart test marker. CI #762 validates the additional persisted-size check and the final test state.

### Intermediate CI failures and correction

- CI #757 and #758 failed at TypeScript lint because the first generated verifier source had escaped template delimiters. The complete logs were reviewed; the delimiters were corrected.
- CI #759 passed lint and unit tests but its PostgreSQL test file contained escaped template delimiters in the fresh-pool fixture. The complete log identified the exact syntax location; it was corrected before CI #760.
- CI #760 then passed all 19 steps (head `e14547b32b8d7fa716a531df14fa95279b1b6105`; 1,020 log lines / 94,246 characters). CI #761 and #762 subsequently passed all 19 steps each.
- CI #762's expected PostgreSQL `NOT NULL` violations and injected `injected ZIP publication failure` are negative-test fixtures. Non-blocking warnings remain: Go cache cannot find `go.sum`; GitHub Actions reports Node.js 20 action deprecation. No actionable failure remained on CI #762.

**Coverage boundary:** The restart test uses fresh PostgreSQL pools and newly constructed service instances against an isolated local schema; it is a deterministic restart simulation, not a restart/restore drill against a deployed production database. No production database, deployed service, or production backup blob was accessed or modified. PR #84 remains open and Draft; no merge or deployment was performed.


## CI #763 — persisted ZIP size guard and final archive-integrity verification

**Validated documentation head:** `b3ec3402b933c781e5fcd443dbf153a5c8120f36`  
**Workflow run:** [CI #763](https://github.com/enessur61/zero-ai-studio/actions/runs/43978687981) — run `43978687981`, job `133689200325` (`verify`)  
**Result:** `completed / success`; all 19 job steps passed. Complete job log retrieved and reviewed: 1,021 lines / 94,374 characters.

- CI #762 validated the implementation commit `74d04b1dc720a0de15e2ff91e8503e028dad30e2`, including the persisted ZIP `sizeBytes` comparison in the restore orchestrator.
- CI #763 validates the audit documentation commit and the exact PR head. The standalone PostgreSQL integration step explicitly logged: `ZIP corruption, truncated PostgreSQL blob rejection, and fresh-pool restart restore tests passed.`
- All phases passed: secret scan, dependency installation, Gemini free-only billing guard, lint, npm tests, PostgreSQL revision/concurrency integration, production build, authenticated production smoke test, post-job hooks, and PostgreSQL container cleanup.
- The PostgreSQL `NOT NULL` errors and `injected ZIP publication failure` in the server log are intentional negative-test fixtures. Non-blocking warnings: Go cache cannot find `go.sum`; GitHub Actions warns that the selected actions still target deprecated Node.js 20. No actionable CI failure remained.
- Restart coverage remains an isolated local PostgreSQL simulation with fresh pools and newly constructed service instances; it is not a deployed production database restart drill. No production data was accessed or modified.

**Scope:** PR #84 remains open and Draft. No merge and no deployment.


## ZIP decompression-bomb and resource-exhaustion audit — CI #771

**Validated implementation head:** 786a858503c658b73bd359e0118ed67329d52d80  
**Workflow run:** [CI #771](https://github.com/enessur61/zero-ai-studio/actions/runs/43979643004) — run 43979643004, job 133692489069  
**Result:** completed / success; all 19 job steps passed. Complete job log retrieved and reviewed: 1,021 lines / 94,374 characters.

### Verified limits and enforcement

- Maximum compressed ZIP archive: **160 MiB**.
- Maximum expanded size per entry: **32 MiB**.
- Maximum total expanded size: **128 MiB**.
- Maximum entry count: **10,000**.
- ZIP creation preflights every source with filesystem stat / supplied Buffer sizes before reading or compressing any file; it rejects per-entry and aggregate overflow.
- ZIP verification rejects archive size and entry-count overflow before central-directory processing, and checks each declared expanded size and the running aggregate before invoking inflateRawSync. The existing per-entry maxOutputLength remains an additional bound.
- ZIP restore checks metadata size before reading. In PostgreSQL mode, readBackupFile uses octet_length(payload) in SQL and returns the BYTEA only when within the cap, preventing an oversized blob from being transferred into the Node.js process. Filesystem mode checks stat.size before readFile.

### Regression evidence

- Unit fixtures forge oversized entry declarations and aggregate expansion declarations while leaving compressed payloads small; the verifier rejects them before inflation.
- Sparse-file fixtures prove ZIP creation rejects a single oversized source and aggregate source size from metadata, without reading the oversized content.
- PostgreSQL integration uses an isolated schema and two independent pools. It verifies the bounded BYTEA query rejects a blob over the supplied cap but still reads an allowed blob.
- The production restore orchestrator is given a persisted PostgreSQL ZIP with a forged expansion declaration; restore is rejected before safety-backup creation or live-state mutation.
- Existing ZIP corruption, truncated-blob, restore-race, restart, production build, and authenticated smoke tests remain green.

**Scope and caveats:** Limits are application-level safeguards for this ZIP format; the full archive is still read into one bounded Buffer and verified entries are retained in memory up to the 128 MiB aggregate ceiling. This is not a streaming restore. The integration suite uses local isolated PostgreSQL test schemas, not production data. No production database was accessed or changed.

**CI warnings:** Missing go.sum cache pattern and GitHub Actions Node.js 20 deprecation warnings are non-blocking. PostgreSQL NOT NULL errors and injected ZIP publication failure are deliberate negative-test fixtures.

PR #84 remains Open and Draft. No merge and no deployment.


## CI #777 — bounded concurrent ZIP downloads and restores

- Production routes `GET /api/system/zip-backups/:id/download` and `POST /api/system/zip-backups/:id/restore` now share a process-local concurrency gate with a maximum of **2 simultaneous ZIP operations**.
- A third simultaneous request is rejected with HTTP 429, `Retry-After: 5`, and code `ZIP_CONCURRENCY_LIMIT`; it never enters the download/restore handler.
- Slots are released on response `finish` or `close`, guarded against double release. This bounds the number of concurrent operations retaining archive/decompression buffers within one Node.js process. It is not a distributed/global limit across multiple server instances.
- Added a real Express HTTP test that holds one request open, proves the concurrent request is rejected, then releases the first and proves a later request is admitted. The test exercises the same middleware mounted on the production routes.
- CI #777: https://github.com/enessur61/zero-ai-studio/actions/runs/43980913650 — all 19 job steps succeeded. Full job log reviewed: 1,022 lines / 94,575 characters.
- Log confirms `ZIP concurrent request gate tests passed.`, existing ZIP decompression-bomb/resource-limit tests, PostgreSQL restore/concurrency integration tests, build, and production smoke test.
- CI #776 initially failed in the first version of the new concurrency test due to a race in the test's slot-reuse assertion. The test was simplified to a deterministic single-slot HTTP scenario; CI #777 then passed. No production failure was observed.
- Non-blocking warnings: missing `go.sum` cache key, Node.js 20 action deprecation notices, `punycode` deprecation, and existing Vite chunk-size warning. PostgreSQL NOT NULL and injected ZIP publication errors are intentional negative-test fixtures.
- Scope: tests use CI's isolated PostgreSQL database and a local Express HTTP server. No production database restart, live deployment, or production data mutation was performed.


## Phase 1 — production foundations (2026-11-17)

### Confirmed findings before the changes

- Production authentication, login throttling, and Gemini quota enforcement relied on process-local state or lacked a shared atomic reservation boundary. Two server instances could disagree about sessions, attempts, or remaining quota.
- ZIP download/restore admission was bounded per process, not across processes. A response closing before an asynchronous handler settled could release capacity too early.
- PostgreSQL-backed application reads could return a process-local `dbCache` without observing a write committed by another instance.
- Generated scene clips were kept in browser-local IndexedDB/object URLs and were not reliably available to another device or after browser storage loss.
- The Wan worker kept job metadata in memory and wrote output files to its configured output directory; restart durability depended on an external persistent mount and was not enforced.

### Changes on the PR branch

1. **Shared authentication**
   - Added PostgreSQL-backed session records containing SHA-256 token hashes, with HMAC-signed session cookies and expiry checks.
   - Added atomic PostgreSQL login-attempt upserts keyed by an HMAC of the client IP; expired windows are cleaned opportunistically and indexed by `reset_at`.
   - Serialized first-use authentication schema DDL with a transaction-scoped PostgreSQL advisory lock so simultaneous instance starts do not race table creation.
   - Production session creation, validation, and revocation now use the shared store; logout on one instance revokes the session on another.

2. **Shared Gemini quota reservations**
   - Added an atomic per-model reservation ledger in PostgreSQL. Reservations are made before a Gemini provider call and are bounded by the configured daily limit/reset date.
   - Provider quota exhaustion marks the shared reservation row exhausted for all instances. An explicit, persisted quota reset clears the shared row only after the application reset state is saved.
   - Reservations are intentionally conservative: a request that fails before the provider accepts it may still consume one application reservation. No live paid-provider fallback was introduced.

3. **Global ZIP operation admission**
   - HTTP ZIP downloads/restores and background ZIP publication share PostgreSQL session-level advisory-lock slots, with a global maximum of two operations across application instances.
   - The lock is retained until both the asynchronous handler has settled and the response has finished/closed. Client disconnect alone does not release a slot while restore work continues.
   - Uncertain lock acquisition/unlock failures destroy the PostgreSQL connection so an ambiguous session-level lock cannot be returned to the pool. Pool acquisition errors are forwarded to Express error handling.
   - The PostgreSQL pool maximum was raised to five to leave room for two held ZIP leases and normal request/database work.

4. **Cross-instance application-state reads**
   - When `DATABASE_URL` is configured, `loadDb()` now reads the current PostgreSQL state instead of returning the process-local cache.
   - State normalization is persisted only when the JSON-serializable normalized shape differs from the stored payload; unchanged reads do not intentionally rewrite the full state.
   - Concurrent writes remain revision-checked. A stale writer receives a conflict rather than silently overwriting a newer revision.
   - Local-runtime verification metadata is reset to unverified on server reads. Only the user's availability preference is retained for matching local adapters; a server-side probe cannot certify browser/iPhone inference.

5. **Project scene-media persistence**
   - Scene clips are still cached in IndexedDB, but are now also mirrored into the owning project's persisted assets so another instance/device can retrieve them.
   - Uploads are bounded to 8 MB per clip and 24 MB of encoded scene-clip data per project. The upload response does not echo the large data URL.
   - The production smoke test verifies cross-instance read-after-write and that clips survive JSON backup restore and ZIP backup restore.
   - A PostgreSQL integration test additionally opens the actual published production ZIP blob, verifies its archive integrity, extracts `data/zero-studio-db.json`, and checks the exact saved scene media URL is present.

6. **GPU worker job persistence**
   - Added a standard-library SQLite job store under `WAN_OUTPUT_DIR`; completed job metadata and output MP4 paths survive process restarts when the directory is on a persistent mounted volume.
   - Jobs interrupted in `queued` or `running` state are marked failed after restart; they are not automatically replayed. Successful records whose MP4 is missing are marked failed.
   - The Docker image defaults to `/data/zero-wan-jobs` and `WAN_REQUIRE_PERSISTENT_STORAGE=true`, failing closed when the configured output directory is not on a mounted volume.
   - The SQLite job store is for a single worker instance. It is not a distributed multi-worker queue.

### Reproducible verification

- Production-mode CI smoke test starts two independent Node/Express server processes against the same isolated PostgreSQL service.
- Cross-instance HTTP assertions cover: session creation on A / access on B / logout on B / revocation on A; login-attempt limits shared across A and B; project read-after-write; scene media read-after-write from the other instance; and media availability after JSON and ZIP restore.
- PostgreSQL integration tests use independent pools and cover atomic concurrent login attempts, session expiry/revocation, simultaneous schema bootstrap, shared Gemini reservations/exhaustion/reset, shared ZIP lock capacity, response completion, client disconnect while handler work continues, background ZIP leases, uncertain connection cleanup, and pool connection acquisition failure forwarding.
- GPU worker storage tests reopen the SQLite store after a simulated process restart, verify interrupted-job handling and completed-file retention, and test persisted job deletion.
- CI #868 passed all 20 job steps on commit `e3c66a4267a74f270d28fa58647eb91e5fa47b05`: [full workflow run](https://github.com/enessur61/zero-ai-studio/actions/runs/43986189954). The complete job log was retrieved and reviewed (1,107 lines / 103,699 characters). Lint, npm tests, Python worker tests, PostgreSQL integration, build, production smoke test, post-job cleanup, and container stop all succeeded.

### Remaining limits — not a production deployment certification

- CI uses an isolated local PostgreSQL service and two local production-mode server processes. No live Render deployment, production database restart, or production data mutation was performed.
- Scene video bytes are currently stored in project JSONB assets, not a dedicated media/blob store. The per-clip and per-project limits bound the payload, but full-state reads and project snapshots can amplify database and memory usage. A dedicated media table/object store is preferable before larger clips or high project volume.
- Database-backed `loadDb()` reads the full JSONB state per request. Correctness across instances is improved, but a representative production load/performance test is still required.
- Revision-checked writes prevent silent lost updates, but concurrent edits can still return a conflict; client-wide reload/retry behavior has not been proven for every mutation workflow.
- The global ZIP gate has no explicit operation deadline/cancellation mechanism. A genuinely hung handler retains its slot until it settles or its PostgreSQL connection/process is lost.
- The PostgreSQL pool size and total connection budget must be re-evaluated against the actual number of Render instances and database connection limits.
- The GPU worker still requires an actual persistent disk mount in its deployment environment. No Render disk was provisioned and no GPU inference/restart was run against a live worker. SQLite job storage is single-instance only; interrupted jobs are marked failed rather than resumed.
- Gemini reservations were tested with isolated PostgreSQL pools, not a live Gemini provider key. The application ledger is a conservative guard, not a guarantee of Google's external quota state.
- No native iPhone device test was performed in this phase.

**Safety boundary:** PR #84 remains Open and Draft. No merge and no deployment were performed.
