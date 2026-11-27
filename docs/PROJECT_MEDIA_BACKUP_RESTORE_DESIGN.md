# ZERO Project Media Backup / Restore Design

Status: design record for the separate PostgreSQL video-asset archive. The existing JSON/ZIP backup remains unchanged until this protocol is implemented and tested.

## Current boundaries

- Project video bytes live in `zero_project_video_assets` as principal- and project-bound PostgreSQL BYTEA.
- The video store enforces a 100 MiB per-clip limit, 500 MiB per-project total and 50 clips per project.
- The ordinary ZIP exporter limits an uncompressed entry to 32 MiB and the archive to 128 MiB total.
- The versioned ZIP currently embeds `data/zero-studio-db.json`; it does not include the separate PostgreSQL video table.
- Therefore a successful ordinary ZIP restore is not a complete video-media restore. Do not imply otherwise.

## Required archive format

Create a sidecar media archive for each versioned backup, linked to the main ZIP by a manifest:

- `manifest.json`: format version, backup ID, creation time, project ID, principal hash, asset ID, scene ID, job ID, content type, byte length, SHA-256 and chunk count.
- `chunks/<asset-id>/<zero-padded-index>.bin`: fixed 4 MiB chunks, streamed from PostgreSQL; never buffer an entire project in application memory.
- Each project sidecar is independently bounded by the existing 500 MiB project limit. The overall backup operation must enforce an explicit configurable cap and report a deterministic failure before publishing a backup version.
- The manifest must not contain session tokens, worker credentials, or raw principal identifiers.

## Backup transaction

1. Acquire the existing project lifecycle / backup lock and capture the project metadata revision.
2. Enumerate only assets belonging to the selected principal and project.
3. Stream each asset in 4 MiB ranges. Verify observed byte count and SHA-256 against the database row while writing chunks.
4. Write the manifest last, then verify every chunk against its manifest entry.
5. Re-check the project metadata revision. If it changed during capture, discard the staged sidecar and retry or fail; never publish a mixed-time snapshot.
6. Publish the sidecar and main ZIP as one backup-set record only after both are verified. Use staging names and atomic rename / manifest commit so an interrupted backup cannot appear complete.
7. Retain and delete the main ZIP and sidecar as one unit; protection applies to the entire set.

## Restore transaction

1. Verify the main ZIP and sidecar manifests before changing live state.
2. Validate format version, project ownership mapping, project/asset IDs, allowed MIME types, per-clip/per-project/count limits, chunk count, total bytes and SHA-256 values.
3. Stream chunks into a staging table or temporary object store. Do not overwrite current rows during validation.
4. Verify reconstructed asset hashes and exact sizes.
5. Restore project metadata and video bytes under one project lifecycle lock and a database transaction. Rebind assets only to the authenticated restore principal; never trust a principal hash from the archive as authorization.
6. Commit only after every asset is present and verified. On any failure, roll back metadata and staged media together.
7. Return a restore report with restored, skipped and failed asset IDs. A partial media restore must be explicit and must not be reported as a full restore.

## Operational safeguards

- Use bounded concurrency (one or two asset streams), cancellation and per-chunk timeouts.
- Apply archive-size and decompression-ratio limits before extracting.
- Reject path traversal, duplicate manifest IDs, symlinks and unknown archive entries.
- Keep SHA-256 integrity checks separate from authorization checks.
- Do not put 500 MiB video data into the existing 32 MiB JSON ZIP entry.
- Add round-trip tests covering multiple chunks, range boundaries, tampering, missing chunks, wrong principal, duplicate IDs, quota overflow, interrupted backup, rollback and full project restore.
- Keep the current video store's range-streaming and principal/project scoping as the source of truth.

## Rollout

1. Introduce versioned sidecar manifest and read-only verifier.
2. Add backup creation and retention as a linked backup set.
3. Add staged restore with transaction/rollback tests.
4. Run a migration/compatibility test against existing backups; old ZIPs must be labeled metadata-only for video assets.
5. Only then advertise full video backup and recovery.
