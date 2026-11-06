# Postgres Least-Privilege User (`postgres/init/ensure-app-user.sh`)

Rafael Matos · ft\_transcendence · 05/11/2026 · Audit finding S9

## What it does

A dedicated one-shot service, `postgres_app_user_init`, runs this script against
the running Postgres server on every `docker compose up` (not just the first
one). It creates — or, on later runs, updates the password of — a second
database user for the backend: `app_user`. That user can only read and write
rows (SELECT, INSERT, UPDATE, DELETE) in the application's tables. The
original user (`POSTGRES_USER`, a superuser) stays in charge of migrations and
backups.

## Why it was needed

The backend used to connect to PostgreSQL as `POSTGRES_USER`, which the
official image creates as a superuser. The application only needs to read and
write rows, but a superuser can also drop tables and databases, create roles,
read files from the container and run operating-system commands
(`COPY ... TO PROGRAM`).

Today nothing in the backend builds raw SQL, so none of this is exploitable.
But if a SQL injection ever appears, the attacker inherits whatever the
database user can do. With a superuser, that means executing commands inside
the database container and wiping the database. With `app_user`, the damage
stops at reading and modifying rows.

This is the principle of least privilege (audit finding **S9**): the component
that serves requests must not have the permissions of the component that
changes the schema.

|  | `POSTGRES_USER` (owner) | `app_user` |
| --- | --- | --- |
| Used by | `backend_migrate`, `postgres_backup`, `postgres_exporter` | `backend` (through Vault) |
| Superuser | Yes | No |
| DDL (CREATE, ALTER, DROP) | Yes | No |
| SELECT, INSERT, UPDATE, DELETE | Yes | Yes |
| `COPY ... TO PROGRAM`, `CREATE ROLE` | Yes | No |

## The script

```bash
#!/bin/sh
set -e

export PGPASSWORD="$POSTGRES_PASSWORD"

psql -v ON_ERROR_STOP=1 \
  -v app_user="$APP_DB_USER" \
  -v app_password="$APP_DB_PASSWORD" \
  -v owner="$POSTGRES_USER" \
  -v dbname="$POSTGRES_DB" \
  -h postgres --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
DO
$$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user') THEN
    EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', :'app_user', :'app_password');
  ELSE
    EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', :'app_user', :'app_password');
  END IF;
END
$$;

GRANT CONNECT ON DATABASE :"dbname" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_user";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EOSQL
```

### The shell part

- **`#!/bin/sh`** — the script runs inside a plain `postgres:16` container used
  only as a `psql` client, not inside the server's own entrypoint, so it no
  longer needs to match the server image's shell.
- **`export PGPASSWORD`** — the client connects over the network
  (`-h postgres`) rather than through the server's own Unix socket, so it now
  needs a password; `PGPASSWORD` is the standard way to supply it to `psql`
  non-interactively.
- **`set -e`** stops the script on the first failing command.
- **`-v ON_ERROR_STOP=1`** makes `psql` stop and return an error code on the
  first SQL error. Without it `psql` keeps going and exits with `0`, so
  `set -e` would never notice that something failed.
- **`-v name=value`** copies the container's environment variables into `psql`
  variables.
- **`<<'EOSQL'` (quoted heredoc).** The quotes stop the shell from expanding
  anything inside the SQL, so the substitution is done by `psql`, which knows
  how to quote values safely.

### The SQL part

- **`DO $$ ... $$` block with `IF NOT EXISTS`** — Postgres has no
  `CREATE ROLE IF NOT EXISTS`. The block checks `pg_roles` first: on the first
  run it creates the role; on every later run (the service runs on every
  `docker compose up`) it instead runs `ALTER ROLE ... PASSWORD`, which also
  keeps the role's password in sync if `APP_DB_PASSWORD` is ever rotated in
  `.env`.
- **`EXECUTE format('...', %I, %L)`** — the role name comes from a variable, so
  it can't be interpolated directly inside the dynamic SQL string the way
  `:"app_user"` works in a plain statement; `format()` with `%I`/`%L` quotes
  the identifier and the literal safely.
- **`GRANT ... ON ALL TABLES/SEQUENCES IN SCHEMA public`** — grants access to
  whatever tables and sequences already exist in `public` at the moment the
  script runs. This is what makes the script safe to run against an
  **already-populated** database (an existing environment that already ran
  its migrations before this change was introduced), not only a fresh one.
- **`ALTER DEFAULT PRIVILEGES FOR ROLE owner ... ON TABLES`** — covers tables
  that don't exist *yet*: anything `backend_migrate` creates in a future
  migration, as the owner, is automatically granted to `app_user` too. The
  `FOR ROLE` has to be the user that runs the migrations (`POSTGRES_USER`),
  because default privileges only apply to objects created by that role.
  `ON SEQUENCES` does the same for the sequences backing Prisma's
  `@default(autoincrement())` ids; without `USAGE` on them every INSERT fails
  with `permission denied for sequence`.
- **`GRANT CONNECT ON DATABASE`** / **`GRANT USAGE ON SCHEMA public`** — lets
  `app_user` open a connection and see the objects in `public`, without being
  able to create new ones there.
- **`REVOKE CREATE ON SCHEMA public FROM PUBLIC`** — makes sure nobody without
  an explicit grant can create objects in `public`. PostgreSQL 16 already does
  this by default; it is written out so the protection does not depend on the
  image version.

Nothing grants TRUNCATE, REFERENCES, TRIGGER or any DDL. The application never
needs them. Every statement in the script is safe to run repeatedly — Postgres
does not complain about granting a privilege that is already granted, or
altering a role that already has the given password.

## How it's wired up

### Variables

`APP_DB_USER` and `APP_DB_PASSWORD` live in `.env` (with placeholders in
`.env.example`). The password is generated with `openssl rand -hex 32`: it
contains only hexadecimal characters, because the backend builds the
connection URL from it and special characters would need escaping.

### The `postgres_app_user_init` service

```yaml
  postgres_app_user_init:
    container_name: postgres_app_user_init
    image: postgres:16
    networks:
      - transcendence
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      APP_DB_USER: ${APP_DB_USER}
      APP_DB_PASSWORD: ${APP_DB_PASSWORD}
    volumes:
      - ./postgres/init/ensure-app-user.sh:/ensure-app-user.sh:ro
    entrypoint: ["sh", "/ensure-app-user.sh"]
    depends_on:
      postgres:
        condition: service_healthy
    restart: on-failure
```

A one-shot `postgres:16` container, used only as a `psql` client against the
already-running `postgres` service — it is not the Postgres server's own
`docker-entrypoint-initdb.d` mechanism, which only runs once, on an empty
volume. Running it as a separate service, the same pattern already used for
`vault_init`, `backend_migrate` and `backend_seed`, means it runs — and can
safely re-run — on every `docker compose up`, whether the database is brand
new or already populated.

The `postgres` service itself no longer mounts anything under
`/docker-entrypoint-initdb.d`.

### When it runs

On every `docker compose up` / `make update` / `make re`, right after
`postgres` reports healthy. Because every statement in the script is
idempotent (see "The SQL part" above), running it again on a database that
already has `app_user` provisioned is harmless — it just re-grants the same
privileges and re-syncs the password.

This also means there is **no special step needed for an existing
environment**: pulling this change and running `make update` provisions
`app_user` on the current database and grants it access to the tables that
already exist, without requiring a full `make re`.

### Interaction with migrations

`backend_migrate` keeps using `POSTGRES_USER` (its `DATABASE_URL` comes
straight from the compose file) and now depends on
`postgres_app_user_init: condition: service_completed_successfully`, in
addition to `postgres` being healthy — so migrations only run once `app_user`
exists. `backend_migrate` then creates tables as the owner; the default
privileges configured by this script give `app_user` access to them
automatically, including tables added by future migrations.

### Vault and the backend

The same `.env` values reach Vault: `vault_init` receives `APP_DB_USER` and
`APP_DB_PASSWORD` and stores them in `secret/postgres` — the same path and the
same `user`/`password` fields that previously held the superuser's
credentials, so the backend's Vault policy and `vault-bootstrap.ts` needed no
changes. `vault-init.sh` simply writes `app_user`'s values there instead of
`POSTGRES_USER`'s. The backend therefore connects as `app_user` with no other
code change required.

`backend_seed` also calls `loadSecretsFromVault()`. It only looks up and
creates one user, so it works with either database user.

### Startup order

```
postgres (healthy) ─▶ postgres_app_user_init ─▶ backend_migrate (owner) ─▶ backend_seed ─▶ backend (app_user)
```

## Verification

Check that the service ran successfully:

```bash
docker compose logs postgres_app_user_init
docker compose ps postgres_app_user_init
```

Open a session as `app_user`:

```bash
docker compose exec postgres sh -c 'psql -U app_user -d $POSTGRES_DB'
```

Then run:

```sql
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user;
CREATE TABLE teste_app_user (id int);
COPY (SELECT 1) TO PROGRAM 'id';
CREATE ROLE intruso;
```

The first statement must return `f` in every column. The other three must
fail with `permission denied`. A SELECT and an INSERT on an application table
must work.

To confirm the fix for pre-existing environments specifically: run
`make update` (not `make re`) against a database that was populated **before**
this change, and confirm `app_user` can already `SELECT` from tables that
existed before `postgres_app_user_init` ever ran.

## Architecture trade-offs & Security notes

- **Defence in depth, not a fix for an active flaw.** There is no raw SQL in
  the backend and Prisma parametrizes its queries, so nothing is exploitable
  today. The script limits the impact of a future mistake.
- **The password lives in two places.** The same `.env` value is given to
  Postgres (via this service) and to Vault. This follows the existing pattern
  of the project, where `.env` is the source of truth for secrets.
- **Rotating `APP_DB_PASSWORD` is now self-service.** Unlike the earlier,
  entrypoint-based version of this script, re-running
  `postgres_app_user_init` (which happens automatically on every
  `docker compose up`) picks up a changed `APP_DB_PASSWORD` via the
  `ALTER ROLE` branch — no manual `ALTER ROLE` or full `make re` needed, as
  long as the corresponding Vault secret is updated the same way described in
  `VAULT_PRODUCTION.md`.
- **No guard against missing variables.** If `APP_DB_USER` or
  `APP_DB_PASSWORD` is empty, the role ends up with an empty identifier or an
  unusable password. A line such as
  `: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"` near the top would
  make the script fail loudly instead.
- **`app_user` can touch `_prisma_migrations`.** The blanket
  `GRANT ... ON ALL TABLES IN SCHEMA public` covers Prisma's migration history
  table along with everything else. It is harmless in practice, but a
  `REVOKE` on that one table would be stricter.
- **PostgreSQL's defaults still apply.** `PUBLIC` keeps the CONNECT and
  TEMPORARY privileges on the database, so `app_user` can create temporary
  tables.
- **Other superuser consumers remain.** `postgres_exporter` also connects with
  `POSTGRES_USER`. It is the same problem in the monitoring stack and can be
  handled with a dedicated role granted `pg_monitor`.
- **Backups are unchanged.** `postgres_backup` keeps using the owner, which is
  what `pg_dump` needs.