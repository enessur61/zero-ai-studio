# ZERO ARM64 production stack

This Compose stack targets a Linux ARM64 host (including Oracle Ampere A1). It builds Node.js 22 for the host architecture, connects the app to private Piper/SearXNG services, and publishes only the app on host loopback. Caddy runs on the host and is the only public HTTP entry point.

## 1. Prepare secrets

Copy the examples and replace every placeholder with independent cryptographically random values. Keep these files outside version control and readable only by the service administrator:

```sh
cp production.env.example production.env
cp workers.env.example .env.workers
cp searxng/searxng.env.example searxng/searxng.env
chmod 600 production.env .env.workers searxng/searxng.env
```

Set `DATABASE_URL` to your PostgreSQL connection string, a unique `ZERO_ADMIN_PASSWORD` (at least 12 characters), and a random `ZERO_SESSION_SECRET` (at least 32 characters). Generate a random `ZERO_TTS_WORKER_TOKEN` of at least 32 characters and put the identical value in `production.env` and `.env.workers`. Set an independent `SEARXNG_SECRET` of at least 32 characters in `searxng/searxng.env`. Do not use example placeholders.

The example keeps `ZERO_GEMINI_FREE_TIER_ONLY=false`; Gemini calls remain disabled. A managed PostgreSQL free tier is not guaranteed to be always available or free indefinitely; verify limits and billing independently.

## 2. Build and start on ARM64

Run from the repository root on the target ARM64 host:

```sh
docker compose --file docker-compose.workers.yml config --quiet
docker compose --file docker-compose.workers.yml up -d --build zero-app
docker compose --file docker-compose.workers.yml ps
```

Compose starts SearXNG and checks its secret/readiness, then starts Piper and waits for its authenticated health check before starting ZERO. The app connects to Piper over the private Compose network at `http://zero-worker:8000`. The app is published as `127.0.0.1:3000`; Piper and SearXNG have no public host ports. Named volumes persist Piper voice weights and SearXNG cache.

The Piper voice is downloaded lazily on first synthesis into `piper-voice-cache`. Image builds and health checks do not download voice weights or perform inference. First actual synthesis needs outbound access to the pinned model files.

## 3. Caddy HTTPS edge

Install Caddy on the host using its official package instructions. Set `ZERO_DOMAIN` in the Caddy systemd service environment to the exact DNS name pointing to this host. Install `deploy/Caddyfile` as `/etc/caddy/Caddyfile`, then validate with the same environment the service receives:

```sh
sudo env ZERO_DOMAIN=your.real.domain caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Allow inbound TCP 80 and 443. Keep ports 3000, 8000, 8080, 8001 and PostgreSQL private. There is no default hostname: an unset `ZERO_DOMAIN` must fail validation. Caddy manages HTTPS certificates automatically when DNS and inbound ports are correct.

## 4. Operations and limitations

- Update with a reviewed image build and controlled container recreation; never use `docker compose down -v` because it deletes named data volumes.
- Named volumes are persistence, not backups. Back up PostgreSQL and test restore procedures independently.
- The app container healthcheck probes `/api/live` only. Monitor `/api/health` separately for PostgreSQL/schema readiness.
- Piper is CPU-only and resource-limited. Voice weights download on first synthesis.
- Wan is an optional NVIDIA/CUDA profile and is not compatible with Oracle Ampere A1. Do not enable `--profile gpu` on Ampere.
- Domain registration, DNS, PostgreSQL, hosting and outbound bandwidth are not guaranteed to be free. No paid fallback is configured.

CI validates Compose syntax, Caddy configuration and QEMU-emulated ARM64 images. It does not prove native Ampere performance, external PostgreSQL availability, DNS, TLS issuance or live deployment.

## 5. PostgreSQL backup and restore

Use PostgreSQL's own tools for an independent database backup; the app's JSON/ZIP exports are useful application-level recovery artifacts, not a substitute for a database dump. Run from a trusted host with a verified TLS connection string and PostgreSQL client tools installed:

```sh
umask 077
BACKUP_FILE="$HOME/zero-postgres-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --no-acl --file="$BACKUP_FILE" "$DATABASE_URL"
sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256"
```

Keep the dump and checksum outside the repository, encrypt the dump before copying it off-host, and restrict access. For a local GnuPG AES-256 envelope, create and protect a passphrase file once, keep it separate from backup storage, and retain a tested recovery copy of the key:

```sh
umask 077
PASSPHRASE_FILE="$HOME/.zero-backup-passphrase"
test -s "$PASSPHRASE_FILE" || openssl rand -hex 32 > "$PASSPHRASE_FILE"
chmod 600 "$PASSPHRASE_FILE"
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" \
  --symmetric --cipher-algo AES256 --output "$BACKUP_FILE.gpg" "$BACKUP_FILE"
sha256sum "$BACKUP_FILE.gpg" > "$BACKUP_FILE.gpg.sha256"
```

Copy only the encrypted dump and its checksum off-host; do not store the passphrase beside it. Store database credentials in a protected PostgreSQL password file or secret manager; do not place passwords in shell history or commit them. Restore only into a separate, empty recovery database first:

```sh
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" \
  --output "$BACKUP_FILE.restored.dump" --decrypt "$BACKUP_FILE.gpg"
pg_restore --exit-on-error --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL" "$BACKUP_FILE.restored.dump"
rm -f "$BACKUP_FILE.restored.dump"
```

Verify application readiness and representative records against that recovery database before any controlled cutover. Never use the production database as a restore-test target. The CI workflow now performs a disposable custom-format `pg_dump`/`pg_restore` round trip against its isolated PostgreSQL service; it does not access a production database or prove a provider's backup service.

## 6. Free-tier constraints (verify before relying on them)

- Oracle Cloud Always Free A1 publishes a monthly allowance equivalent to 2 OCPUs and 12 GB RAM, but capacity is region-dependent and idle instances may be reclaimed. It is not a 24/7 uptime commitment.
- Neon Free currently publishes 100 CU-hours/project/month, 1 GB storage/project, 5 GB public transfer/project/month, and mandatory scale-to-zero after five idle minutes. Exhausted quotas can suspend compute.
- Cloudflare Free can cover DNS/edge delivery; it does not provide a persistent general-purpose Node.js/Piper VM.
- Wan's NVIDIA/CUDA worker has no verified sustainable always-free GPU host. Keep it disabled on ARM64/Ampere and do not add a paid fallback.
- Domain registration, backup storage, outbound transfer, account verification and hosting availability can prevent a literal 0 € deployment.

See [the detailed production-readiness audit](../docs/audits/production-readiness-2026-11-19.md) and its official provider references.


## 7. PostgreSQL TLS and reconnect configuration

For a managed PostgreSQL endpoint, use the provider's current root CA certificate and a connection URL that explicitly verifies both the certificate chain and hostname. With node-postgres, the supported connection-string parameters are:

```text
postgresql://USER:PASSWORD@DB_HOST:5432/DB_NAME?sslmode=verify-full&sslrootcert=/run/secrets/postgres-ca.pem
```

Mount the CA file read-only into the app container, restrict its permissions, and URL-encode credentials and query parameters correctly. Do not disable certificate validation, do not use `rejectUnauthorized=false`, and do not treat encryption-only `sslmode=require` as hostname verification. Keep the database endpoint private and set provider-side connection limits with room for the app pool and administrative/backup sessions.

The CI workflow now creates a disposable local PostgreSQL TLS server and CA. It verifies trusted-CA success, wrong-CA rejection, TLS negotiation, and pool recovery after restarting the database container. A second CI drill encrypts a disposable PostgreSQL dump with GnuPG AES-256, checks wrong-passphrase rejection, decrypts it, and restores it into another disposable database. Neither test contacts a managed provider or uploads backup data. A real provider CA, DNS hostname, firewall/network policy, connection limits and failover behavior must still be verified separately.


## CI #1228 verification record (2026-11-19)

[CI run #1228](https://github.com/enessur61/zero-ai-studio/actions/runs/44603992615) passed all three jobs on PR #104 head `ddfa0214968ebea071c567be83728778c101178b`. The local PostgreSQL TLS test accepted the trusted CA, rejected an unrelated CA, confirmed TLS through `pg_stat_ssl`, and reconnected the pool over verified TLS after a database restart. The local backup drill passed GnuPG AES-256 encryption, byte-for-byte decryption, wrong-passphrase rejection, and restore into a second isolated database. These are disposable CI-only checks; they do not certify a managed provider or off-host backup target. See the [production-readiness audit](../docs/audits/production-readiness-2026-11-19.md) for full evidence and limitations.
