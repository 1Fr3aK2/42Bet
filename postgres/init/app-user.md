# Postgres Init Script (`postgres/init/01-app-user.sh`)

Rafael Matos · ft\_transcendence · 05/11/2026 · Audit finding S9

## What it does

The first time the PostgreSQL container starts with an empty data volume, this script creates a second database user for the backend: `app_user`. That user can only read and write rows (SELECT, INSERT, UPDATE, DELETE) in the application's tables. The original user (`POSTGRES_USER`, a superuser) stays in charge of migrations and backups.

## Why it was needed

The backend used to connect to PostgreSQL as `POSTGRES_USER`, which the official image creates as a superuser. The application only needs to read and write rows, but a superuser can also drop tables and databases, create roles, read files from the container and run operating-system commands (`COPY ... TO PROGRAM`).

Today nothing in the backend builds raw SQL, so none of this is exploitable. But if a SQL injection ever appears, the attacker inherits whatever the database user can do. With a superuser, that means executing commands inside the database container and wiping the database. With `app_user`, the damage stops at reading and modifying rows.

This is the principle of least privilege (audit finding **S9**): the component that serves requests must not have the permissions of the component that changes the schema.

|  | `POSTGRES_USER` (owner) | `app_user` |
| --- | --- | --- |
| Used by | `backend_migrate`, `postgres_backup`, `postgres_exporter` | `backend` (through Vault) |
| Superuser | Yes | No |
| DDL (CREATE, ALTER, DROP) | Yes | No |
| SELECT, INSERT, UPDATE, DELETE | Yes | Yes |
| `COPY ... TO PROGRAM`, `CREATE ROLE` | Yes | No |

## The script

```bash
#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 \
  -v app_user="$APP_DB_USER" \
  -v app_password="$APP_DB_PASSWORD" \
  -v owner="$POSTGRES_USER" \
  -v dbname="$POSTGRES_DB" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE :"app_user" WITH LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE :"dbname" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EOSQL
```

### The shell part

- **`#!/bin/bash` and the executable bit.** The official image runs every file in `/docker-entrypoint-initdb.d/`, in alphabetical order (hence the `01-` prefix). It executes files that have the executable bit and merely sources the ones that do not, so the script needs `chmod +x`.
- **A `.sh` file instead of a `.sql` file.** A plain `.sql` file cannot read environment variables, and the password must not be written into a file in the repository.
- **`set -e`** stops the script on the first failing command.
- **`-v ON_ERROR_STOP=1`** makes `psql` stop and return an error code on the first SQL error. Without it `psql` keeps going and exits with `0`, so `set -e` would never notice that something failed.
- **`-v name=value`** copies the container's environment variables into `psql` variables.
- **`--username` and `--dbname`** connect as the owner to the application database. During initialization the image runs a temporary server that listens only on a Unix socket, so no password is needed.
- **`<<'EOSQL'` (quoted heredoc).** The quotes stop the shell from expanding anything inside the SQL, so the substitution is done by `psql`, which knows how to quote values safely.

### The SQL part

- **`:"app_user"`** is replaced by the variable as a quoted identifier. **`:'app_password'`** is replaced as a quoted, escaped string literal, so even unusual characters in the password cannot break the statement.
- **`CREATE ROLE ... LOGIN ... NOSUPERUSER NOCREATEDB NOCREATEROLE`** creates a user that can log in but has no special powers. These three flags are the defaults; they are written out so the intent is visible in the file.
- **`GRANT CONNECT ON DATABASE`** lets `app_user` open a connection to the application database.
- **`GRANT USAGE ON SCHEMA public`** lets it see and use the objects in the `public` schema, but not create new ones.
- **`ALTER DEFAULT PRIVILEGES FOR ROLE owner ... ON TABLES`** gives `app_user` SELECT, INSERT, UPDATE and DELETE on every table that the owner creates in `public` from now on. The tables do not exist yet when this script runs: `backend_migrate` creates them afterwards, as the owner. Without this line, every table created by a migration would be inaccessible to the backend. The `FOR ROLE` has to be the user that runs the migrations (`POSTGRES_USER`), because default privileges only apply to objects created by that role.
- **`ALTER DEFAULT PRIVILEGES ... ON SEQUENCES`** does the same for sequences. The Prisma ids (`@default(autoincrement())`) are backed by sequences, and without `USAGE` on them every INSERT fails with `permission denied for sequence`.
- **`REVOKE CREATE ON SCHEMA public FROM PUBLIC`** makes sure nobody without an explicit grant can create objects in `public`. PostgreSQL 16 already does this by default; it is written out so the protection does not depend on the image version.

Nothing grants TRUNCATE, REFERENCES, TRIGGER or any DDL. The application never needs them.

## How it's wired up

### Variables

`APP_DB_USER` and `APP_DB_PASSWORD` live in `.env` (with placeholders in `.env.example`). The password is generated with `openssl rand -hex 32`: it contains only hexadecimal characters, because the backend builds the connection URL from it and special characters would need escaping.

### The `postgres` service

```yaml
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      APP_DB_USER: ${APP_DB_USER}
      APP_DB_PASSWORD: ${APP_DB_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./postgres/init/01-app-user.sh:/docker-entrypoint-initdb.d/01-app-user.sh:ro
```

The script is mounted read-only, in line with the other config mounts in the stack.

### When it runs

Only when the `postgres-data` volume is empty, that is, on the first start of a new database. `make re` runs `fclean`, which does `down -v` and removes the volumes, so the script runs again. `make update` and `make down` followed by `make up` keep the volume, so the script does not run again.

### Interaction with migrations

`backend_migrate` keeps using `POSTGRES_USER` (its `DATABASE_URL` comes straight from the compose file) and runs `prisma migrate deploy` before the backend starts. The tables it creates belong to the owner, and the default privileges from this script give `app_user` access to them automatically, including tables added by future migrations.

### Vault and the backend

The same `.env` values reach Vault: `vault_init` receives `APP_DB_USER` and `APP_DB_PASSWORD` and stores them in `secret/postgres-app`. The backend policy allows reading that secret, and `vault-bootstrap.ts` uses it to build the `DATABASE_URL` in memory at startup. The backend therefore connects as `app_user`, and the superuser credentials in `secret/postgres` are no longer readable with the backend's token.

`backend_seed` also calls `loadSecretsFromVault()`. It only looks up and creates one user, so it works with either database user.

### Startup order

```
postgres (creates app_user on first boot) ─▶ backend_migrate (owner) ─▶ backend_seed ─▶ backend (app_user)
```

## Verification

Check that the script ran:

```bash
docker compose logs postgres | grep 01-app-user
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

The first statement must return `f` in every column. The other three must fail with `permission denied`. A SELECT and an INSERT on an application table must work. To prove the default privileges, apply a throwaway migration and confirm the backend can use the new table.

## Architecture trade-offs & Security notes

- **Defence in depth, not a fix for an active flaw.** There is no raw SQL in the backend and Prisma parametrizes its queries, so nothing is exploitable today. The script limits the impact of a future mistake.
- **The password lives in two places.** The same `.env` value is given to Postgres (at initialization) and to Vault. This follows the existing pattern of the project, where `.env` is the source of truth for secrets.
- **Changing `APP_DB_PASSWORD` later does not change the database.** The script only runs once. To rotate the password on an existing database, run `ALTER ROLE app_user PASSWORD '...'` as the owner and update the Vault secret, or rebuild the stack with `make re`.
- **No guard against missing variables.** If `APP_DB_USER` or `APP_DB_PASSWORD` is empty, `CREATE ROLE` fails with an empty identifier or creates a role without a usable password. A line such as `: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"` near the top would make the script fail loudly instead.
- **`app_user` can touch `_prisma_migrations`.** The default privileges cover every table the owner creates, including Prisma's migration history table. It is harmless in practice, but a `REVOKE` on that table would be stricter.
- **PostgreSQL's defaults still apply.** `PUBLIC` keeps the CONNECT and TEMPORARY privileges on the database, so `app_user` can create temporary tables.
- **Other superuser consumers remain.** `postgres_exporter` also connects with `POSTGRES_USER`. It is the same problem in the monitoring stack and can be handled with a dedicated role granted `pg_monitor`.
- **Backups are unchanged.** `postgres_backup` keeps using the owner, which is what `pg_dump` needs.
