# Vault Config (`vault/config/vault.hcl`)

## What it does

Replaces `vault server -dev` with a real, persistent Vault server
configuration, used to run Vault outside of development mode.

## Why it was needed

The project previously ran Vault with `vault server -dev`, which keeps
everything — secrets, policies, the AppRole setup — entirely in memory. Every
container restart wiped all of it, and there was no real encryption at rest.
This doesn't meet the subject's requirement of managing secrets "encrypted
and isolated" in Vault, and it's fragile in practice (a crash mid-demo would
lose all backend credentials).

`vault.hcl` configures a production-style Vault server with persistent,
encrypted storage and a TLS-protected API, replacing the dev-mode shortcut.

## Configuration

```hcl
storage "raft" {
  path    = "/vault/data"
  node_id = "vault-1"
}

listener "tcp" {
  address       = "0.0.0.0:8200"
  tls_cert_file = "/etc/vault/certs/vault.cert"
  tls_key_file  = "/etc/vault/certs/vault.key"
}

api_addr     = "https://vault:8200"
cluster_addr = "https://vault:8201"

ui = true
disable_mlock = false
```

### `storage "raft"`

Integrated storage backend, HashiCorp's current recommendation (the older
`file` backend is in maintenance mode). Data is persisted to disk at
`/vault/data`, backed by the `vault-data` Docker volume, instead of living
only in memory. `node_id` is required by raft even for a single-node setup
like this one — no clustering is being used, but the field is mandatory.

The volume is created root-owned, but Vault runs as an unprivileged user
(uid 100, gid 1000) in the official image. The one-shot `vault-data-init`
service runs `chown -R 100:1000 /vault/data` before `vault` starts (enforced
with `depends_on: service_completed_successfully`), otherwise Vault can't
write to its own storage.

### `listener "tcp"`

Serves the Vault API over `0.0.0.0:8200` inside the container. Unlike the
project's other internal service-to-service traffic (Postgres, Redis — which
the subject explicitly allows to run unencrypted), this listener uses TLS
even for internal Docker-network traffic. This is a deliberate
defense-in-depth choice: Vault holds the most sensitive secrets in the
system, so it's held to a stricter standard than the general internal-traffic
exception. `tls_cert_file`/`tls_key_file` point to the certificate generated
by `setup-certs.sh` (see that script's own documentation), issued for the
`vault` hostname and trusted via the shared local mkcert CA. The certificates
reach the container through the `./vault/certs` bind mount.

The port is not published to the host: Vault is only reachable from other
containers on the `transcendence` network.

### `api_addr` / `cluster_addr`

Required by the raft storage backend even in a single-node deployment — Vault
uses these to advertise its own address. Both use `https://`, consistent with
the TLS listener above.

### `ui = true`

Enables Vault's web UI, reachable at `https://vault:8200/ui` from inside the
network — useful for manual inspection/debugging, not required by the
subject. Since the port isn't published, it isn't reachable from the host
unless a port mapping is added temporarily.

### `disable_mlock = false`

Keeps Vault's memory-locking protection enabled, which prevents secret
material from being swapped to disk. Requires the `IPC_LOCK` capability and an
unlimited `memlock` ulimit, both set on the `vault` service in
`docker-compose.yml` (`cap_add: [IPC_LOCK]` and `ulimits.memlock: -1`).

## How it's wired up

Everything the config depends on is now in place.

### The `vault` service

- Starts with `vault server -config=/etc/vault/config/vault.hcl` (no more
  `-dev`).
- Mounts `./vault/config` (this file and the policy), `./vault/certs` (TLS
  material) and the `vault-data` volume (raft storage).
- Has `VAULT_ADDR` and `VAULT_CACERT` in its environment so the Vault CLI
  used by its healthcheck talks HTTPS and trusts the shared CA.

### Healthcheck

```yaml
test: ["CMD-SHELL", "vault status; [ $? -ne 1 ]"]
```

`vault status` exits with `0` when unsealed, `2` when sealed, and `1` on error
(e.g. the server isn't reachable yet). The container is considered healthy as
long as the exit code is **not** `1`, so a sealed Vault still counts as
healthy. This is intentional: Vault starts sealed after every restart, and
unsealing is done by `vault_init`, which itself waits for `vault` to be
healthy. If sealed counted as unhealthy, the stack would deadlock.

### Init and unseal (`vault_init` → `vault-init.sh`)

`vault_init` is a one-shot container (`restart: on-failure`) that runs
`vault-init.sh` once the `vault` service is healthy. The script is idempotent
and does, in order:

1. **Initialize** (`vault operator init -key-shares=5 -key-threshold=3`) only
   if `/vault/keys/init.json` doesn't exist yet. The output (unseal keys and
   root token) is saved there with mode `600`.
2. **Unseal** if Vault reports `sealed: true`, using 3 of the 5 keys from
   `init.json`. This runs on every start, since Vault is sealed again after
   each container restart.
3. **Enable the KV v2 engine** at `secret/` (automatic in dev mode, explicit
   outside it).
4. **Store the secrets** (Postgres, Redis, admin API key, admin account, JWT
   secret) from environment variables passed to `vault_init`.
5. **Load the policy** (`backend-policy`) and **enable AppRole**.
6. **Create `backend-role`** with `token_ttl=1h`, `token_max_ttl=4h` and
   `secret_id_ttl=0` (no expiry — see Known limitations for the rationale).
7. **Write `role_id` and `secret_id`** to `/vault/approle` (mode `600`).
8. **Revoke the root token** — it is no longer needed after bootstrap.

The keys live in the `vault-keys` volume and the AppRole credentials in the
`vault-approle` volume. Both are created root-owned, so `vault-keys-init` and
`vault-approle-init` chown them to `100:1000` first.

### TLS trust in the clients

- `VAULT_ADDR` (now `https://vault:8200`) and `VAULT_CACERT` come from the
  `.env` file and are passed to `vault`, `vault_init`, `backend` and
  `backend_seed`.
- Vault CLI environment variables don't affect a generic Node.js HTTP client,
  so the backend and the seed job also set `NODE_EXTRA_CA_CERTS` to the same CA
  file. `./vault/certs` is mounted read-only into both.
- The backend and the seed job read `role_id` and `secret_id` from the
  `vault-approle` volume (mounted read-only) to log in through AppRole.

### Startup order

```
vault-data-init ─▶ vault ─▶ vault_init ─▶ backend_seed ─▶ backend
                    ▲            ▲
        (healthy)───┘            └── vault-keys-init, vault-approle-init
```

`backend` waits for `vault` (healthy) and `vault_init` (completed
successfully), so it never starts before Vault is initialized, unsealed and
populated. `backend_seed` also waits for `vault_init`, since seeding needs
the AppRole credentials.

## Architecture trade-offs & Security notes

These are the accepted trade-offs for a local, single-node project:

- **Unseal keys and root token sit together** in `init.json` on the `vault-keys` volume. This is what lets the stack unseal itself automatically, but it defeats the purpose of Shamir's secret sharing: anyone with access to that volume has everything. In a real deployment the keys would be split between different people, or replaced by auto-unseal through a cloud KMS or HSM. 
- **Root token revocation**: The root token is automatically revoked at the end of the bootstrap process (in `vault-init.sh` step 10). This reduces the impact of the shared volume: an attacker with the volume still has the unseal keys, but no longer has a valid root token ready to use — they would need to run `vault operator generate-root` (an auditable operation) to obtain a new one.
- **The `secret_id` never expires** (`secret_id_ttl=0`). A previous value of `24h` caused the backend to fail re-authentication after a day without a `docker compose up`. Since the `secret_id` is regenerated on every `vault_init` run anyway (each `docker compose up` produces a new random value), a time-based TTL adds operational fragility without meaningful security benefit in this setup. Setting it to `0` removes the expiry.
- **Read-only mounts for config and certs**: `./vault/config` and `./vault/certs` are mounted with `:ro` in `docker-compose.yml`. Vault only reads these files; the strict mount prevents any in-container process from modifying its own configuration or TLS certificates.