# Backend Vault Policy (`vault/config/backend-policy.hcl`)

## What it does

Defines an ACL policy in Vault that grants read-only access to exactly five
secret paths — Postgres, Redis, the Admin Public API key, the seeded admin
account's credentials, and the JWT signing secret — and nothing else.

```hcl
path "secret/data/postgres" {
    capabilities = ["read"]
}

path "secret/data/redis" {
    capabilities = ["read"]
}

path "secret/data/admin-api" {
  capabilities = ["read"]
}

path "secret/data/admin-account" {
  capabilities = ["read"]
}

path "secret/data/jwt" {
  capabilities = ["read"]
}
```

> **Note on this revision:** this document previously described only the
> first two paths (`postgres`, `redis`), from before `ADMIN_API_KEY`,
> `ADMIN_USERNAME`/`ADMIN_EMAIL`/`ADMIN_PASSWORD`, and `JWT_SECRET` were
> migrated into Vault. The policy file itself already had all five paths;
> this document is now updated to match. See `SECURITY_REPORT.md` §3 for the
> context of that migration.

## Why it was needed

By default, a Vault token has no permissions at all — every capability has
to be explicitly granted through a policy. Without this file, the backend
would either need a much broader (and riskier) token, or no way to read its
own secrets from Vault at all.

This policy follows the principle of least privilege: the backend can only
**read** these five specific paths. It cannot list other secrets, write or
delete anything, or access any secret outside this list — even if new
secrets are added to Vault later for other services, this policy doesn't
grant access to them unless explicitly extended.

| Path | Secret | Used by |
|---|---|---|
| `secret/data/postgres` | Postgres connection credentials | `backend` |
| `secret/data/redis` | Redis connection credentials | `backend` |
| `secret/data/admin-api` | `ADMIN_API_KEY` (Admin Public API auth) | `backend` |
| `secret/data/admin-account` | `ADMIN_USERNAME`/`ADMIN_EMAIL`/`ADMIN_PASSWORD` | `backend_seed` (creates the admin account on first run) |
| `secret/data/jwt` | `JWT_SECRET` (token signing) | `backend` |

## How it's used

The policy is loaded into Vault and attached to an AppRole
(`backend-role`, defined in `vault-init.sh`) via `token_policies =
"backend-policy"`. When the backend authenticates with its RoleID/SecretID,
the token it receives is scoped to exactly these permissions — not the
Vault root token, and not unrestricted access.

```bash
vault policy write backend-policy /etc/vault/config/backend-policy.hcl
```

The same policy and AppRole are used by both `backend` and `backend_seed` —
both read their RoleID/SecretID from the same persisted files on the
`vault-approle` volume (see `VAULT_PRODUCTION.md`, "AppRole credential
persistence"). `backend_seed` only actually needs `secret/data/admin-account`
in practice, but sharing one policy across both services was chosen over
maintaining two near-identical policies, since neither service is
externally reachable on its own and the extra read access `backend_seed`
technically has (to the other four paths) isn't exploitable beyond what
`backend` itself already has.

## Path structure

The `secret/data/...` prefix (rather than plain `secret/...`) is specific to
Vault's KV **v2** secrets engine — v2 stores actual secret data under a
`data/` sub-path (separate from `metadata/`, which tracks versioning). Using
v1-style paths here would silently fail to match, since the policy engine
checks the literal path.