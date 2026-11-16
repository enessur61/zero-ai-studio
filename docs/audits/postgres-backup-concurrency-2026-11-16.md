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
- Automatic ZIP backup throttling is still a check-then-act workflow. The state lock prevents simultaneous state commits from corrupting the revision, but a database-level uniqueness/lease rule is still needed to guarantee one auto-backup per 15-minute window across multiple processes.
- Pruning backup blobs occurs after metadata publication. A cleanup failure can leave orphaned bytes; a reconciliation/diagnostic task is still needed.
- Browser IndexedDB scene clips remain outside server ZIP backups.
- Integration tests run only against an explicitly local PostgreSQL endpoint and do not inspect production data.

The integration test is wired as a dedicated CI step. Its assertions are not considered passed until the corresponding GitHub Actions job completes successfully on the latest PR head SHA.


## Automatic ZIP throttle and backup reconciliation follow-up

- PostgreSQL-backed automatic ZIP creation now holds a dedicated session-level advisory lock across archive generation and publication. Independent server instances cannot both pass the throttle check and create overlapping automatic backups.
- A successful automatic backup records `last_success_at` in `zero_backup_auto_state`; the next automatic attempt is refused for 15 minutes. A failed attempt releases the lock without advancing the successful-backup timestamp.
- Local file-only development retains the existing process-local 15-minute check; it is not a multi-process coordination mechanism.
- A read-only `inspectBackupConsistency` diagnostic compares backup metadata IDs in the primary JSONB state with IDs in `zero_backup_files`, reporting orphaned blob IDs and metadata entries whose blob is missing.
- The diagnostic deliberately does not delete or rewrite anything. Automated cleanup remains a separate, approval-sensitive maintenance operation.
- The PostgreSQL integration test now checks lease exclusion across two pools, the 15-minute throttle after success, a clean backup consistency report, and detection of both orphaned bytes and missing blobs.

**Residual recovery window:** if a process commits an automatic ZIP backup but crashes before it records `last_success_at`, the session lock is released and a subsequent process could retry earlier than 15 minutes. The backup row and primary state remain transactionally consistent; only the throttle timestamp can lag. A future improvement could commit the throttle success marker in the same transaction as backup publication.
