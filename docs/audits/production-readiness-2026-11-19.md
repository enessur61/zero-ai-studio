# ZERO production-readiness audit — 2026-11-19

## Scope and evidence

This audit is based on the source and CI configuration on PR #104, branch `feat/zero-resource-guard-schema`. It does not claim a live deployment test. No external provider, production database, DNS zone, certificate authority, or hosting account was contacted.

## Findings

### ARM64 runtime

- The Node.js 22 runtime image and Piper image are built and started under QEMU for `linux/arm64`.
- The Piper image pins ONNX Runtime and requires `CPUExecutionProvider`; it does not require CUDA.
- QEMU is an architecture/build smoke test, not a native Oracle Ampere performance or long-running memory test.
- Wan remains an NVIDIA/CUDA-only optional profile and must stay disabled on Ampere A1.

### Piper voice files

- Production Compose mounts the named `piper-voice-cache` volume at `/var/lib/zero-piper`; this is the correct persistence boundary.
- The German `de_DE-thorsten-medium` model and JSON config are downloaded lazily on first synthesis from immutable Piper-voices revision `cf910fb59f1d79ab3b625a63993a108751c6c25d`, with exact byte-size, published MD5 and model LFS SHA-256 checks before atomic rename. The cache is reused only when all pinned metadata matches.
- Health means the worker process and authentication configuration are healthy; it does not mean the voice is already downloaded or loaded.
- CI now verifies cache reuse, corrupt-cache replacement, cleanup after an interrupted download, and that the Compose volume survives a Piper container restart. These tests use fake local bytes and a marker file; they do not download model weights or run speech synthesis.

### PostgreSQL

- `DATABASE_URL` is external to the Compose stack. Compose intentionally does not start a database or expose a PostgreSQL port.
- The application readiness endpoint checks database connectivity and required schemas; liveness remains database-independent.
- CI uses an isolated PostgreSQL 16 service for schema/concurrency integration and now adds a custom-format `pg_dump` → `pg_restore` round trip into a separate empty database.
- This proves the CI database can be dumped and restored with PostgreSQL tools. It does not prove a managed provider's TLS, network policy, connection limits, backups, or production credentials.

### Backup and restore

- Application JSON/ZIP backups are stored through the application's PostgreSQL-backed backup subsystem and have separate integrity/restore tests.
- A named Docker volume is persistence, not a backup. The Piper voice can be re-downloaded from its pinned source; PostgreSQL still needs independent, off-host backups.
- Before any production restore, restore into a separate database, verify application health and representative records, then perform a controlled connection-string switch. Never test destructive restore against the live database.
- Keep backup files outside the repository, restrict permissions, encrypt them before off-host storage, and periodically test restore. Do not commit credentials or dumps.

### DNS and TLS

- Caddy requires `ZERO_DOMAIN`, validates the Caddyfile, and proxies only to host-loopback `127.0.0.1:3000`.
- Production Compose publishes only ZERO on loopback; Piper and SearXNG remain private to the Compose network.
- CI validates Caddy syntax with a disposable hostname and rejects an unset hostname. It does not resolve real DNS, open public ports, request certificates, or prove browser trust. Those checks are intentionally not run here.

## Zero-cost hosting reality check

- **Oracle Cloud Always Free A1:** the published allowance is 1,500 OCPU-hours and 9,000 GB-hours per month (equivalent to 2 OCPUs and 12 GB RAM when fully allocated), subject to region capacity and idle-resource reclamation. Oracle may reclaim A1 instances that remain below its CPU, network, and memory utilization thresholds for a seven-day period. This is not an uptime guarantee.
- **Neon Free:** the current published Free allowance is 100 CU-hours per project/month, 1 GB storage per project, and 5 GB public network transfer per project/month; compute scales to zero after five minutes idle and can suspend when quotas are exhausted. Treat this as a constrained prototype/small-project database, not a 24/7 SLA.
- **Cloudflare Free:** useful for DNS, proxying, and edge delivery; it does not host this Node/Piper workload as a persistent general-purpose VM.
- **Wan video:** no sustainable, always-on, genuinely free GPU host has been verified. Keep the GPU profile disabled rather than silently falling back to a paid service.
- A domain name, backup storage, outbound bandwidth, and account verification requirements may still prevent a literal 0 € deployment. No paid fallback is configured.

Official references:
- [Oracle Always Free resources and idle-instance reclamation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Neon Free plan limits and quotas](https://github.com/neondatabase/website/blob/main/content/faqs/free-plan-limits-and-quotas.md)
- [Cloudflare SSL/TLS encryption modes](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/)
- [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html) and [pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html)

## CI additions on this PR

- Piper cache integrity/reuse/interrupted-download unit tests, with no network requests.
- Piper named-volume persistence check across a container restart.
- PostgreSQL custom-format backup and restore round trip into a disposable CI database.
- Existing ARM64/QEMU, ONNX CPU provider, Piper auth, Compose isolation, and Caddy syntax checks remain in place.

## Remaining production gates

1. Native ARM64/Ampere soak test with representative CPU, memory, and disk measurements.
2. One controlled first-synthesis test after explicitly downloading the pinned voice files; verify cache reuse after container recreation.
3. Configure the actual PostgreSQL provider with TLS certificate verification, connection pooling and bounded connection count; test reconnect after database suspension/restart.
4. Establish encrypted off-host database backups and a documented recovery point/recovery time target; conduct a restore into a separate database.
5. Configure actual DNS A/AAAA records, firewall ports 80/443, Caddy certificate issuance and renewal monitoring.
6. Verify actual account-specific hosting quotas and idle-reclamation rules before treating any provider as a dependable production host.

**Status:** CI/configuration gates only. No production deployment certification, no provider invocation, no account creation, no merge, and no paid resource use.


## CI #1222 final verification (2026-11-19)

Workflow run [#1222](https://github.com/enessur61/zero-ai-studio/actions/runs/44602009197), run ID `44602009197`, completed successfully on commit `6939b51a8d4a6ac64edaea4e5ee74a5d5edbc4a7`.

- `verify`: success.
- `Validate production Compose and Caddy configuration`: success. Compose assertions passed; Piper's named voice volume survived a worker-container restart; Caddy validation and unset-domain rejection passed.
- `ARM64 Node and Piper container smoke tests`: success. The ARM64 runtime reports `aarch64`; ONNX Runtime exposes `CPUExecutionProvider` (alongside `AzureExecutionProvider`). Piper authenticated health returned HTTP 200 with `voice_loaded=false`; invalid TTS bearer token returned HTTP 401; health without a configured worker token returned HTTP 503.
- The three network-free Piper cache tests all passed: verified cache is reused without a second network request; corrupted cache is replaced after checksum verification; interrupted download leaves neither a final model nor a partial `.part` file.
- The test suite completed with `Ran 3 tests` and `OK`. No tracebacks or GitHub Actions error annotations appeared in the ARM64 job log.

Limitations remain: this is QEMU ARM64 emulation, not native Ampere performance/soak evidence; model cache tests use mocked local bytes, and no real voice weights were downloaded or synthesized. CI success does not certify a live database provider, public DNS, TLS issuance, backup storage, or production hosting availability.

**CI status:** all 3 required workflow jobs completed successfully. **PR #104:** open, Draft, not merged; head remains `6939b51a8d4a6ac64edaea4e5ee74a5d5edbc4a7`.


## PostgreSQL transport and encrypted recovery gates — next milestone (2026-11-19)

- Added a CI-only PostgreSQL TLS fixture using a disposable local CA and server certificate with localhost/127.0.0.1 SANs. No production endpoint or provider is contacted.
- The pg client is exercised with sslmode=verify-full and an explicit sslrootcert. CI must confirm that the trusted CA succeeds, an unrelated CA fails closed, and pg_stat_ssl reports TLS on the authenticated session.
- The same pool is tested across a PostgreSQL container restart; it must establish a new verified-TLS connection after the old server connection is dropped. This tests the Node PostgreSQL driver's pool recovery, not the availability/reconnect behavior of any managed provider.
- Extended the disposable backup drill to encrypt the custom-format dump with GnuPG AES-256, verify byte-for-byte decryption, reject a deliberately wrong passphrase, and restore the decrypted dump into a second isolated database. The passphrase is generated ephemerally in CI and removed at the end; no backup is uploaded or retained.
- These are local CI tests only. Production must still use the database provider's current CA certificate, sslmode=verify-full, restricted network access, and independent connection limits. Never set rejectUnauthorized=false or use sslmode=require as a substitute for hostname and CA verification.
- For off-host backup operations, keep the encryption key/passphrase separate from the backup storage, rotate it under a documented recovery process, restrict file permissions, and verify restore before any production cutover.

**Pending evidence:** the new CI workflow commit is awaiting its run. Until that run completes, TLS, pool recovery, encrypted backup and encrypted restore checks are implementation-in-progress, not passed evidence.


## CI #1228 final verification — PostgreSQL TLS and encrypted recovery (2026-11-19)

- Workflow [#1228](https://github.com/enessur61/zero-ai-studio/actions/runs/44603992615) completed successfully on the exact PR #104 head `ddfa0214968ebea071c567be83728778c101178b`. All three jobs passed: `verify`, production Compose/Caddy configuration, and ARM64 Node/Piper smoke tests.
- Full `verify` job logs were inspected. PostgreSQL TLS used `sslmode=verify-full` with an explicit trusted root CA; `pg_stat_ssl` confirmed the session negotiated TLS. The trusted CA was accepted and an unrelated CA was rejected.
- After restarting the disposable PostgreSQL server, the same node-postgres pool established a fresh connection and verified TLS again.
- The custom-format PostgreSQL dump was encrypted with GnuPG AES-256. Decryption with the generated ephemeral passphrase matched the original dump byte-for-byte; a deliberately wrong passphrase was rejected; the decrypted dump restored successfully into a second isolated database and the sentinel row matched.
- The passphrase and dump artifacts were temporary CI files and removed; no backup was uploaded or sent off-runner. These tests exercised local disposable PostgreSQL only, not a managed production provider.
- ARM64 job logs were inspected: Node ARM64 image health and `/api/live` passed; readiness correctly returned 503 without PostgreSQL. Piper built for `aarch64`, exposed ONNX `CPUExecutionProvider`, authenticated health returned 200, invalid bearer token was rejected, and health without a configured worker token returned 503. All three network-free model-cache tests passed (`Ran 3 tests`, `OK`). No voice weights were downloaded and no TTS inference was performed.
- The first GPG workflow attempt had a shell continuation defect; it was corrected in `ddfa021`. CI #1228 on that exact head is the authoritative successful result. Earlier overlapping runs on superseded commits are not used as evidence.
- The PostgreSQL log contains expected injected constraint/trigger failures from atomic-backup negative tests; the workflow step completed successfully and the expected test assertions passed.

**Final CI status:** 3/3 jobs successful on current PR head. **PR #104:** remains open and Draft, not merged. No deployment, provider invocation, account creation, or paid resource was used. QEMU ARM64 validation is not native Ampere performance/soak evidence; production database CA/hostname, managed-provider failover, off-host backup storage and real recovery operations remain external deployment gates.


## CI #1229 final verification and current production gates (2026-11-19)

- Workflow [#1229](https://github.com/enessur61/zero-ai-studio/actions/runs/44605302895) completed successfully on exact PR #104 head `a0d20cbe497220d2678250bad89edbea78093dd9`; all three jobs passed: `verify`, production Compose/Caddy, and ARM64 Node/Piper.
- Full ARM64 job logs were inspected. Node.js 22 ARM64 build/runtime, healthcheck, and `/api/live` passed; production/worker secret files were absent from the runtime image.
- Piper built for `aarch64`; `piper-tts==1.3.0` and ONNX Runtime 1.22.0 loaded, and `CPUExecutionProvider` was available (alongside `AzureExecutionProvider`). Authenticated Piper health returned HTTP 200, invalid-token TTS returned HTTP 401, and health without a configured worker token returned HTTP 503.
- All three network-free model-cache tests passed: verified cache reuse, corrupted-cache replacement after integrity check, and interrupted-download cleanup (`Ran 3 tests`, `OK`). A GitHub Actions cache-save contention warning was non-fatal; the ARM64 job conclusion was success.
- No voice weights were downloaded and no TTS synthesis was executed. ARM64 is QEMU-emulated evidence only, not native Ampere performance/soak evidence.
- The PostgreSQL TLS/reconnect and encrypted backup/restore checks also passed in `verify`, but only against disposable local CI PostgreSQL: trusted CA accepted, unrelated CA rejected, TLS verified, pool reconnected after server restart, GPG AES-256 round-trip succeeded, wrong passphrase rejected, and restore into a second isolated DB succeeded. No backup was uploaded off-runner.

### Current gate classification after CI #1229

| Gate | Evidence now available | Still required before production claim |
|---|---|---|
| Native ARM64 | QEMU image build, runtime and smoke tests | Native Ampere A1 run; CPU/RAM/disk/network baseline; sustained load, restart and memory-soak test |
| Piper speech | ARM64 package/provider import, authenticated health, cache unit tests | Verify the exact pinned model-card/provenance at revision `cf910fb59f1d79ab3b625a63993a108751c6c25d` and the Piper 1.5+ requirement (worker pins 1.8.0); then, only after separately approved download, perform one controlled German WAV synthesis, validate duration/sample rate/audio quality, restart container and confirm cached reuse |
| PostgreSQL TLS | Local disposable CA, `verify-full`, wrong-CA rejection and pool reconnect | Actual provider hostname and current provider CA, TLS verification, private network policy, bounded pool/connection budget, and reconnect after provider suspend/failover |
| Backup/recovery | Local custom-format dump, AES-256 encryption, wrong-key rejection and restore into isolated DB | Encrypted off-host destination, key kept separately with recoverable escrow, retention/rotation, scheduled backup, checksum/integrity monitoring, and timed restore drill into a separate database |
| DNS/HTTPS | Caddy syntax, required domain variable and loopback-only upstream validated | Real DNS A/AAAA, firewall 80/443, certificate issuance/renewal and external browser verification |
| Free hosting | Deployment configuration and public free-tier limits documented | Verify actual account/region capacity, eligibility, reclamation, outbound/storage quotas; no paid upgrade or paid fallback |

### Recommended zero-cost sequence

1. First perform a no-cloud, native ARM64 acceptance test on any already-owned ARM64 Linux device/server (if one is available): build the exact images, run Piper inference with a separately approved test voice download, and record resource usage. If no native ARM64 machine is already available, keep this gate explicitly blocked rather than creating an account or a paid resource.
2. The immutable voice revision and model-card provenance are now pinned in source; before any download, separately approve one bounded first-synthesis test with a short German sentence, confirm valid WAV metadata and audible output, restart the container, and confirm that the model is reused from the persistent volume. Do not interpret health HTTP 200 as voice readiness.
3. Only after a database provider is explicitly selected and its free-tier constraints are independently confirmed, configure its real CA and hostname with `sslmode=verify-full`; test app connection, bounded pool, reconnect and readiness. No production credentials are part of this audit.
4. Before real data exists, implement the backup schedule and off-host destination selection as a documented design. Keep encryption keys separate from storage and prove a full restore to an isolated target. Do not upload backups to an unverified or paid destination.
5. Treat DNS/HTTPS and account-specific hosting as final deployment gates. They require an explicit domain/host choice; none is contacted or configured by this audit.

**Current status:** CI/configuration evidence is green, but ZERO is not production-certified. No native Ampere test, real Piper inference, managed PostgreSQL/provider test, off-host backup, public DNS/TLS test, account action, deployment, merge, or paid resource was performed.


## Piper Thorsten immutable revision pin — implementation update (2026-11-19)

- Replaced the former Lessac-derived Thorsten revision `95119a449dcd66ed7ad199313f76bda3eda7e286`; it is explicitly excluded and is not a fallback. Runtime URLs now use only immutable commit `cf910fb59f1d79ab3b625a63993a108751c6c25d`.
- Revision MODEL_CARD identifies the German `de_DE` medium voice (one speaker, 22,050 Hz), fine-tuned from the rdh medium base (nl_BE, one Flemish speaker, CC0) with MRD and SDP. It specifies `noise_scale=0.5`, `noise_w=0.333`, and Piper 1.5+.
- Pinned files: ONNX 63,221,984 bytes, MD5 `e2fe077168bfe802e951e717dfa85873`, LFS SHA-256 `fd270eb3d1ebf91d763f8a0f949b1b1bebdfefaea18c3aaf8577dd34536e064f`; JSON config 6,455 bytes, MD5 `dac4f7530c978753aeb40f214245659f`; MODEL_CARD 427 bytes, MD5 `77302e0f4569b902d16e49db4a43492d`.
- Runtime cache validation now requires exact file sizes and MD5 values, plus the ONNX LFS SHA-256. Partial, wrong-size, corrupt, or old-revision cache files are rejected and replaced only after successful verification. No model weights were fetched during this repository change.
- The worker pins `piper-tts==1.8.0`, satisfying the model card's Piper 1.5+ minimum; synthesis defaults now match the revision metadata. PyPI publishes an ARM64 Linux wheel for the pinned engine.
- Added network-free tests for exact revision/hash/settings metadata and wrong-size rejection. The existing cache-reuse, corruption-replacement and interrupted-download tests remain offline.
- Provenance note: the model card names CC0 for the German training dataset and rdh base. This is not a legal opinion or blanket guarantee of all downstream rights. No TTS inference, provider call, deployment, account action, merge or paid resource was used.
- Remaining gate: run the free CI suite on this new commit. Real voice download and inference remain intentionally unperformed and require separate approval.


## CI #1234 final verification — Piper Thorsten revision and current gates (2026-11-19)

- Workflow [#1234](https://github.com/enessur61/zero-ai-studio/actions/runs/44609998847), run ID `44609998847`, completed with conclusion `success` on the exact PR #104 head `06badb79310ceed009bdb4b89ac80c339d61a228`.
- All three required jobs completed successfully: `verify`; `Validate production Compose and Caddy configuration`; and `ARM64 Node and Piper container smoke tests`.
- The ARM64 job's `Build Piper ARM64 image and verify ONNX CPU provider` step also completed successfully. This is QEMU-emulated ARM64 build/runtime evidence, not a native Ampere performance or soak test.
- This run includes the immutable Piper Thorsten revision pin `cf910fb59f1d79ab3b625a63993a108751c6c25d`, `piper-tts==1.8.0`, exact model/config integrity metadata, and offline cache-metadata tests. The model files were not downloaded; no TTS inference was performed.
- **Correction to earlier pending notes:** the statement that free CI on the new Piper revision remains pending is superseded by this completed successful run. CI/configuration checks for this exact revision are green. This does not close the separate real-synthesis gate.

### Evidence boundary and remaining production gates after CI #1234

| Area | Verified by local CI/source checks | Still open before production certification |
|---|---|---|
| Application and resource guard | Unit tests, PostgreSQL integration/concurrency tests, fail-closed schema checks, reservation/idempotency coverage | Production traffic/operational validation and real deployment environment review |
| ARM64 runtime | QEMU ARM64 Node/Piper build and smoke test; ONNX CPU provider check | Native ARM64/Ampere hardware, resource baseline, sustained load, restart and memory soak |
| Piper | Immutable revision and file metadata pinned; engine version requirement met; offline cache tests; ARM64 package/provider smoke | Separately approved bounded model download and real German WAV synthesis; validate WAV/sample rate/audio quality, then restart and verify persistent cache reuse |
| PostgreSQL transport | Disposable local PostgreSQL TLS with `verify-full`, trusted-CA acceptance, wrong-CA rejection and pool reconnect after test-server restart | Actual selected provider hostname/CA, private network policy, bounded connection pool, and provider suspend/failover reconnect |
| Backup/recovery | Disposable local custom-format dump, GPG-encrypted backup round trip, invalid-passphrase rejection and isolated restore | Encrypted off-host destination, separately protected recovery material, retention, rotation, scheduling, integrity monitoring and timed restore drill |
| DNS/HTTPS | Caddy syntax, required domain variable, loopback-only upstream and Compose exposure assertions | Real DNS A/AAAA, firewall 80/443, certificate issuance/renewal and external browser verification |
| Hosting and cost | Public free-tier limits documented; no paid fallback configured | Actual account/region capacity, eligibility, reclamation, storage and outbound quotas. No provider account or resource has been tested or created |
| Wan video | GPU-only profile isolated/opt-in; resource reservation protections and idempotency tests | A sustainable genuinely free GPU environment and controlled operational validation. Keep disabled; do not silently fall back to paid compute |

**Current status:** PR #104 remains open and Draft, not merged. CI #1234 is fully green on the exact head above. This is CI/configuration evidence only, not production certification. No model weights, provider endpoints, production database, DNS zone, certificate authority, hosting account, or external backup destination was accessed for this verification. No deployment, merge, account creation, or paid resource was used.
