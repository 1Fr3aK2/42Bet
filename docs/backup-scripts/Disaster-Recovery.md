# Disaster Recovery Procedures

## Context

This document is part of the Devops Minor module "Health check and status page
system with automated backups and disaster recovery procedures". It covers two
kinds of failure:

1. **Database loss or corruption** — recoverable, with a documented step-by-step
   procedure, using the backups already produced by the `postgres_backup` service.
2. **Loss of Vault's unseal material or Docker volumes** — a different class of
   problem. Some of it (application data, images, metrics) is genuinely
   recoverable from backups or is acceptable to lose and rebuild. Some of it
   (Vault's unseal keys) is **irrecoverable by design** — that is the point of
   how Vault works — so the correct response is prevention (backing up the right
   volume) rather than a recovery procedure for after the fact.

---

## 1. Automated backups (already in place)

The `postgres_backup` service (`docker-compose.yml`) runs continuously and calls
`scripts/backup-postgres.sh` once every 24 hours (`sleep 86400` loop). Each run:

- Produces a **plain-text SQL dump** with `pg_dump` (no custom/compressed format),
  authenticated via `PGPASSWORD`/`POSTGRES_USER`/`POSTGRES_PASSWORD` against the
  `postgres` service on port 5432.
- Names the file `appdb_<YYYY-MM-DD_HH-MM-SS>.sql`, timestamped at creation time.
- Writes it to `$BACKUP_DIR` (defaults to `/backups/postgres` inside the
  container), which is bind-mounted to `./backups/postgres` on the host — so
  backups survive container recreation and `make re`, since they live outside
  any named Docker volume.
- Deletes any `appdb_*.sql` file older than `$RETENTION_DAYS` (defaults to 7)
  using `find -mtime +7 -delete`, after a successful dump. A failed dump removes
  its own partial output (`rm -f "$BACKUP_FILE"`) and exits non-zero, so a broken
  run never displaces a good backup during cleanup.

No further setup is needed for backups to exist — this section documents what
already runs automatically; the rest of this document covers how to use it.

---

## 2. Restoring the database from a backup

Use this procedure whenever the database is corrupted, was mistakenly modified
or dropped, or a container rebuild is needed from a known-good state.

### 2.1 Identify the backup to restore

List available backups, newest first:

```bash
ls -lt backups/postgres/appdb_*.sql | head -n 10
```

Pick the most recent backup that predates the incident. If the exact time of
the incident is known, match it against the timestamp in the filename
(`appdb_YYYY-MM-DD_HH-MM-SS.sql`).

### 2.2 Stop services that write to the database

Prevent new writes from racing with the restore:

```bash
docker compose stop backend backend_seed backend_migrate
```

`postgres` itself is left running — the restore is performed against the live
server, not by recreating the container.

### 2.3 (Recommended) Take a safety dump of the current state

Even when the current database is believed to be corrupted, dumping it first
costs little and allows inspecting or partially recovering data later if the
chosen backup turns out to be a worse choice than expected:

```bash
docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > backups/postgres/pre-restore-safety-dump_$(date +%Y-%m-%d_%H-%M-%S).sql
```

### 2.4 Drop and recreate the database

The dump produced by `pg_dump` in plain-text mode contains `CREATE TABLE`
statements but does not drop pre-existing objects, so restoring into a database
that still has the old (corrupted) schema/data can fail or produce duplicates.
The database is dropped and recreated cleanly first:

```bash
docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d postgres -c \
   "DROP DATABASE IF EXISTS \"$POSTGRES_DB\";"'

docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d postgres -c \
   "CREATE DATABASE \"$POSTGRES_DB\";"'
```

(Connecting to the default `postgres` maintenance database to run these two
statements, since a database cannot drop itself while connected to it.)

### 2.5 Restore the chosen backup

```bash
docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < backups/postgres/appdb_<TIMESTAMP>.sql
```

Replace `<TIMESTAMP>` with the filename chosen in step 2.1. Watch the output for
errors — a plain-text `psql` restore does not stop on the first error by
default, so scroll back through the output rather than assuming silence means
success.

### 2.6 Restart the application services

```bash
docker compose up -d backend
```

(`backend_migrate` and `backend_seed` are one-shot `on-failure` services; they
are not expected to need to run again after a restore of an already-seeded
database. If Prisma's migration state table was part of the restored dump, the
schema and migration history are already consistent — no need to re-run
migrations.)

### 2.7 Verify

```bash
curl -sk https://localhost/health
```

Confirm `"database": "up"` in the response, then spot-check the restored data
through the application itself (log in, check that expected records are
present).

---

## 3. Scenario: total loss of Docker volumes

A full `docker system prune` (as `make re` performs) removes every named
volume — including `postgres-data`, `redis-data`, `elasticsearch-data`,
`vault-data`, `vault-keys`, `vault-approle`, `grafana-db`, and
`prometheus-data`. Each has a different recovery story:

| Volume | Recoverable? | How |
|---|---|---|
| `postgres-data` | Yes | Restore from `backups/postgres/` as in Section 2 (the bind-mounted directory is not touched by volume removal) |
| `elasticsearch-data` | Not meaningfully | Logs/audit data are not currently backed up separately; loss is acceptable since ILM already limits their value to 14 days of operational data, not a system of record |
| `redis-data` | No | Acceptable loss — Redis here is used as a cache/session store, not a source of truth |
| `grafana-db`, `prometheus-data` | No | Acceptable loss — dashboards are defined as code in `monitoring/grafana/provisioning` and are recreated automatically on next boot; metrics history is not required to survive a rebuild |
| `vault-data`, `vault-keys`, `vault-approle` | **No — by design** | See Section 4 |

In practice, the only volume in this list with an actual recovery procedure is
`postgres-data`, because it is the only one holding data that is both a source
of truth and not trivially regenerated. This is intentional: the project's
sensitive configuration (JWT signing secret, admin credentials, API keys) lives
in Vault rather than in the database specifically so that losing the database
does not also mean losing those secrets, and vice versa.

---

## 4. Scenario: loss of Vault's unseal keys

This is the one failure in this project that is **not recoverable after the
fact**, and that is a deliberate property of Vault, not a gap in this project's
tooling.

### Why this is unrecoverable by design

Vault encrypts everything it stores (`secret/jwt`, `secret/admin`, the AppRole
credentials the backend uses, etc.) with a master key that is itself split into
key shares (Shamir's Secret Sharing) at `vault operator init` time. Those shares
— along with the initial root token — are what `vault-init.sh` writes to
`/vault/keys/init.json`, backed by the `vault-keys` named volume. Without a
quorum of those key shares, the encrypted data in `vault-data` cannot be
decrypted by anyone, including someone with full filesystem access to the
container — this is the entire point of Vault's security model. There is no
"recovery procedure" for this the way there is for a database: if the unseal
keys are gone, the secrets are gone.

### What this means in practice for this project

- If `vault-keys` is lost (e.g. wiped independently of `vault-data`), Vault
  becomes permanently sealed and undecryptable, even though the encrypted data
  in `vault-data` still physically exists.
- If both `vault-data` and `vault-keys` are lost together — which is exactly
  what happens on a `make re`, since `docker system prune` removes all volumes
  at once — Vault is reinitialized from scratch by `vault_init` on the next
  boot. This is not a recovery; it is starting over. `vault_init.sh` reads the
  current `.env` values (`JWT_SECRET`, `ADMIN_PASSWORD`, `ADMIN_API_KEY`, etc.)
  and writes them into the freshly initialized Vault, so the *values* the
  application ends up using come from the `.env` file, not from any backup of
  Vault itself.

### Mitigation

Since there is no after-the-fact recovery, the mitigation is preventive:

- **Do not rely on Vault's internal storage as the backup of a secret's
  value.** The values that matter (`JWT_SECRET`, `ADMIN_PASSWORD`, etc.) are
  already kept in `.env`, which is the actual source of truth for this project
  — Vault is the *runtime* store the backend reads from, not the canonical
  record of what the secrets are. As long as `.env` is preserved (outside Git,
  per the project's `.gitignore`, but backed up separately by whoever manages
  the deployment), a full Vault reinitialization reproduces the same secret
  values automatically via `vault_init`.
- **Changing `.env` after Vault has already been initialized does not
  propagate on its own** (observed directly during this project's work: a
  `restart` does not re-read `.env` into a running container, and `vault_init`
  does not re-run its provisioning steps against an already-bootstrapped
  Vault — see `VAULT_PRODUCTION.md`, "Idempotent bootstrap and root token
  revocation"). If a secret value needs to change without a full `make re`,
  it has to be written into Vault directly with `vault kv put`.
  **The root token saved in `/vault/keys/init.json` is no longer usable for
  this by default** — `vault_init.sh` now revokes it automatically once
  bootstrap completes, as a security hardening measure. A fresh root token
  has to be generated first, using the unseal key shares (still valid; only
  the root token itself was revoked):
  ```bash
  docker compose exec vault vault operator generate-root -init
  # supply 3 of the 5 unseal key shares from init.json when prompted
  docker compose exec vault sh -c 'VAULT_TOKEN=<new_root_token> vault kv put secret/jwt secret="<new_value>"'
  ```
  Update `.env` as well, so a future full reinitialization stays consistent
  with whatever was changed manually.
- **If unsealing an existing Vault after a partial restart is ever needed**
  (Vault seals itself on every restart of the `vault` container, unlike a full
  `make re` which wipes it), the key shares from `/vault/keys/init.json` are
  required:
  ```bash
  docker compose exec vault sh -c 'vault operator unseal <key_share>'
  ```
  repeated for each key share up to the configured threshold. This only works
  if `vault-keys` (and therefore `init.json`) survived the restart — which is
  the normal case for `docker compose restart vault`, but not for `make re`.

---

## 5. Summary

| Failure | Recoverable? | Procedure |
|---|---|---|
| Database corrupted/lost | Yes | Section 2 — restore from `backups/postgres/*.sql` |
| Full volume wipe (`make re`) — app data (Postgres, Redis, ES, Grafana, Prometheus) | Partially | Postgres via Section 2; the rest is acceptable, regenerable loss |
| Full volume wipe (`make re`) — Vault | No, by design | Vault reinitializes from `.env`; see Section 4 |
| Vault sealed after a partial restart (keys intact) | Yes | `vault operator unseal`, Section 4 |
| Vault keys lost independently of Vault data | No | Unrecoverable; this is why `.env` is treated as the real source of truth for secret values |