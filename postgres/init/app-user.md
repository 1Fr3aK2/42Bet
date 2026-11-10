# Postgres Least-Privilege User (`postgres/init/ensure-app-user.sh`)

Rafael Matos · ft\_42Bet · 05/11/2026 · Audit finding S9

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

|  | `POSTGRES_USER` (owner) | `app_user` | `postgres_exporter` |
| --- | --- | --- | --- |
| Used by | `backend_migrate`, `postgres_backup` | `backend` (through Vault) | `postgres_exporter` (metrics) |
| Superuser | Yes | No | No |
| System Role | — | — | `pg_monitor` |
| DDL (CREATE, ALTER, DROP) | Yes | No | No |
| SELECT, INSERT, UPDATE, DELETE (Tables) | Yes | Yes | **No** (Zero table access) |
| System Statistics (`pg_stat_*`) | Yes | Own queries only | Yes (Server-wide) |
| `COPY ... TO PROGRAM`, `CREATE ROLE` | Yes | No | No |

## The script

```bash
#!/bin/sh
set -e

export PGPASSWORD="$POSTGRES_PASSWORD"

POSTGRES_EXPORTER_USER="${POSTGRES_EXPORTER_USER:-postgres_exporter}"
POSTGRES_EXPORTER_PASSWORD="${POSTGRES_EXPORTER_PASSWORD:-$POSTGRES_PASSWORD}"

psql -v ON_ERROR_STOP=1 \
  -v app_user="$APP_DB_USER" \
  -v app_password="$APP_DB_PASSWORD" \
  -v exporter_user="$POSTGRES_EXPORTER_USER" \
  -v exporter_password="$POSTGRES_EXPORTER_PASSWORD" \
  -v owner="$POSTGRES_USER" \
  -v dbname="$POSTGRES_DB" \
  -h postgres --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
SELECT format(
  CASE WHEN EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user')
       THEN 'ALTER ROLE %I WITH PASSWORD %L'
       ELSE 'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE'
  END,
  :'app_user', :'app_password')
\gexec

GRANT CONNECT ON DATABASE :"dbname" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_user";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

SELECT format(
  CASE WHEN EXISTS (SELECT FROM pg_roles WHERE rolname = :'exporter_user')
       THEN 'ALTER ROLE %I WITH PASSWORD %L'
       ELSE 'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE'
  END,
  :'exporter_user', :'exporter_password')
\gexec

GRANT CONNECT ON DATABASE :"dbname" TO :"exporter_user";
GRANT pg_monitor TO :"exporter_user";
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

- **`SELECT format(CASE ...) \gexec`** — Postgres has no
  `CREATE ROLE IF NOT EXISTS`. The query checks `pg_roles` and returns the text
  of either `CREATE ROLE ...` (first run) or `ALTER ROLE ... PASSWORD ...`
  (every later run, since the service runs on every `docker compose up`, which
  also keeps the role's password in sync if `APP_DB_PASSWORD` is ever rotated
  in `.env`). `\gexec` then executes each returned row as SQL.
- **Why not a `DO $$ ... $$` block.** `psql` does not substitute variables such
  as `:'app_user'` inside a dollar-quoted string, so the server would receive
  the `:` literally and fail with `syntax error at or near ":"` (this is
  exactly what happened with the first version of this script, and it left the
  one-shot service restarting in a loop). Running `format()` outside the `$$`
  block lets `psql` substitute the variables first; `%I` and `%L` still quote
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
      - 42Bet
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      APP_DB_USER: ${APP_DB_USER}
      APP_DB_PASSWORD: ${APP_DB_PASSWORD}
      POSTGRES_EXPORTER_USER: ${POSTGRES_EXPORTER_USER:-postgres_exporter}
      POSTGRES_EXPORTER_PASSWORD: ${POSTGRES_EXPORTER_PASSWORD:-${POSTGRES_PASSWORD}}
    volumes:
      - ./postgres/init/ensure-app-user.sh:/ensure-app-user.sh:ro
    entrypoint: ["sh", "/ensure-app-user.sh"]
    depends_on:
      postgres:
        condition: service_healthy
    security_opt:
      - no-new-privileges:true
    restart: on-failure
```

A one-shot `postgres:16` container, used only as a `psql` client against the
already-running `postgres` service — it is not the Postgres server's own
`docker-entrypoint-initdb.d` mechanism, which only runs once, on an empty
volume. Running it as a separate service, the same pattern already used for
`vault_init`, `backend_migrate` and `backend_seed`, means it runs — and can
safely re-run — on every `docker compose up`, whether the database is brand
new or already populated.

The `postgres` service itself neither mounts anything under
`/docker-entrypoint-initdb.d` nor receives `APP_DB_USER` / `APP_DB_PASSWORD`:
the server never reads them, so keeping them there would only expose the
`app_user` password in the `docker inspect` output of the database container.

### When it runs

On every `docker compose up` / `make update` / `make re`, right after
`postgres` reports healthy. Because every statement in the script is
idempotent (see "The SQL part" above), running it again on a database that
already has `app_user` provisioned is harmless — it just re-grants the same
privileges and re-syncs the password.

This also means the database side needs no special step for an existing
environment: pulling this change and running `make update` provisions
`app_user` and grants it access to the tables that already exist. The backend,
however, only switches to `app_user` once `secret/postgres` in Vault holds its
credentials. Vault's root token is revoked after the first bootstrap, so
re-running `vault_init` does not rewrite the secret (see `VAULT_PRODUCTION.md`,
"Practical consequence"). On an existing environment, generate a new root token and update
`secret/postgres` with `vault kv put` (on Vault 2.x, `generate-root` first
needs a temporary configuration change — see `VAULT_PROD_MODE.md`,
"Recovering a root token on Vault 2.x"), or rebuild with `make re`.

### Interaction with migrations

`backend_migrate` keeps using `POSTGRES_USER` (its `DATABASE_URL` comes
straight from the compose file) and now depends on
`postgres_app_user_init: condition: service_completed_successfully`, in
addition to `postgres` being healthy — so migrations only run once `app_user`
exists. `backend_migrate` then creates tables as the owner; the default
privileges configured by this script give `app_user` access to them
automatically, including tables added by future migrations.

A consequence worth knowing: if `postgres_app_user_init` fails and keeps
restarting, `backend_migrate` waits for it indefinitely and `docker compose up`
appears to hang. Check `docker compose logs postgres_app_user_init` first.

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
docker compose ps -a postgres_app_user_init
```

It must show `Exited (0)`, with `CREATE ROLE` (or `ALTER ROLE`) and the
`GRANT` lines in the log, and no errors.

Check that the role has no special attributes:

```bash
docker compose exec postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -c "\du"'
```

`app_user` must appear with an empty attribute list.

Check that the backend really connects as `app_user` (with the backend
running):

```bash
docker compose exec postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT usename, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY usename;"'
```

An `app_user` row must appear. The `user` rows come from the `psql` session
itself and from `postgres_exporter`.

Open a session as `app_user`:

```bash
docker compose exec postgres sh -c 'psql -U app_user -d $POSTGRES_DB'
```

Then run:

```sql
SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user;
SELECT count(*) FROM "User";
CREATE TABLE teste_app_user (id int);
COPY (SELECT 1) TO PROGRAM 'id';
CREATE ROLE intruso;
```

The first statement must return `f` in every column and the second must work.
The last three must fail with `permission denied`.

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
- **The password is visible in `docker inspect`.** `postgres_app_user_init`
  and `vault_init` receive it through `environment`, which anyone with access
  to the Docker daemon can read. Removing it from the `postgres` service
  reduces the exposure but does not eliminate it. This is an accepted
  trade-off for a local, single-host project.
- **Rotating `APP_DB_PASSWORD` is self-service on the database side.** Unlike
  an entrypoint-based script, re-running `postgres_app_user_init` (which
  happens automatically on every `docker compose up`) picks up a changed
  `APP_DB_PASSWORD` via the `ALTER ROLE` branch. The Vault secret must be
  updated as well, the way `VAULT_PRODUCTION.md` describes, because
  `vault_init` no longer rewrites it once the root token is revoked.
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