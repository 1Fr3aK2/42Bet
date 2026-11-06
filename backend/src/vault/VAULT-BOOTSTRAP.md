# Vault Secrets Loader

Module of **ft_transcendence** responsible for loading the application's secrets from [HashiCorp Vault](https://www.vaultproject.io/) at service startup, using **AppRole** authentication. No secret lives in a `.env` file, in the source code or in the Docker image: they are fetched from Vault at runtime and injected into `process.env`.

## How it works

```
┌──────────────┐  1. reads role_id + secret_id ┌──────────────────┐
│   Service    │ ◄──────────────────────────── │ /vault/approle/  │
│   (backend)  │                               │ (mounted volume) │
└──────┬───────┘                               └──────────────────┘
       │ 2. POST /v1/auth/approle/login
       │    { role_id, secret_id }
       ▼
┌──────────────┐
│    Vault     │ ──► returns client_token
└──────┬───────┘
       │ 3. GET /v1/secret/data/<path>   (X-Vault-Token header)
       │    postgres · redis · admin-api · admin-account · jwt
       ▼
┌──────────────┐
│ process.env  │  DATABASE_URL, REDIS_URL, ADMIN_API_KEY,
│              │  ADMIN_USERNAME, ADMIN_EMAIL, ADMIN_PASSWORD, JWT_SECRET
└──────────────┘
```

1. Reads `role_id` and `secret_id` from the files in `/vault/approle/`.
2. Logs in to Vault via AppRole and obtains a `client_token`.
3. Uses the token to read the secrets from the KV v2 engine (`secret/`).
4. Validates that the expected fields exist and writes them to `process.env`.

If **any** step fails, the function throws an error, and the service should not start without its secrets.

## Configuration

### Environment variable

| Variable     | Required | Description                                  |
|--------------|----------|----------------------------------------------|
| `VAULT_ADDR` | yes      | Vault URL, e.g. `https://vault:8200`         |

### AppRole files

They must exist before startup (usually mounted as a read-only volume):

```
/vault/approle/role_id
/vault/approle/secret_id
```

The path is defined by the `APPROLE_DIR` constant at the top of the file.

### Expected secrets in Vault (KV v2, `secret/` mount)

| Path                   | Required fields                     | Resulting environment variable(s)                       |
|------------------------|-------------------------------------|---------------------------------------------------------|
| `secret/postgres`      | `user`, `password`                  | `DATABASE_URL` (derived dynamically)                    |
| `secret/redis`         | `password`                          | `REDIS_URL` (derived dynamically)                       |
| `secret/admin-api`     | `key`                               | `ADMIN_API_KEY`                                         |
| `secret/admin-account` | `username`, `email`, `password`     | `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`       |
| `secret/jwt`           | `secret`                            | `JWT_SECRET`                                            |

Example of how to create the secrets:

```bash
vault kv put secret/admin-api key="<value>"
vault kv put secret/admin-account username="admin" email="admin@example.com" password="<value>"
vault kv put secret/jwt secret="<value>"
```

### Minimal policy for the AppRole

The role only needs read access to these three paths (least privilege):

```hcl
path "secret/data/postgres"      { capabilities = ["read"] }
path "secret/data/redis"         { capabilities = ["read"] }
path "secret/data/admin-api"     { capabilities = ["read"] }
path "secret/data/admin-account" { capabilities = ["read"] }
path "secret/data/jwt"           { capabilities = ["read"] }
```

## Usage

Call it **once**, before any code that depends on the secrets (server creation, JWT setup, admin seeding, etc.):

```typescript
import { loadSecretsFromVault } from './vault';

async function bootstrap() {
  await loadSecretsFromVault();

  // From here on, process.env.JWT_SECRET, ADMIN_*, etc. are defined
  const app = await createServer();
  await app.listen({ port: 3000, host: '0.0.0.0' });
}

bootstrap().catch((err) => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
```

## Possible errors

| Error                                                        | Likely cause                                                           |
|--------------------------------------------------------------|------------------------------------------------------------------------|
| `VAULT_ADDR not defined`                                     | Missing environment variable                                           |
| `ENOENT ... role_id` / `secret_id`                           | AppRole volume not mounted or files not generated                      |
| `Error logging AppRole to Vault: 400/403 ...`                | Invalid or expired `role_id`/`secret_id`, or already used (if `secret_id_num_uses` is limited) |
| `Error reading secret/<path> from Vault: 403 ...`            | AppRole policy doesn't grant `read` on that path                       |
| `Error reading secret/<path> from Vault: 404 ...`            | Secret hasn't been created in Vault yet                                |
| `secret/<path> does not have "<field>" ...`                  | Secret exists but a required field is missing                          |
| `fetch failed` (with a certificate cause)                    | Vault uses TLS and the CA isn't trusted by Node (see note below)       |

> **TLS:** if Vault uses a certificate from a private CA, Node must trust it, for example with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. Do not disable certificate validation (`NODE_TLS_REJECT_UNAUTHORIZED=0`).

## Security notes

- **Secrets in `process.env`:** they are accessible to all code in the process and inherited by child processes. Never log `process.env` and avoid passing it wholesale to subprocesses.
- **`secret_id`:** treat it as a credential. Ideally it has a short TTL and/or limited number of uses, and the file is mounted read-only with restricted permissions.
- **`client_token`:** it is neither stored nor reused; it only exists during loading. The token remains valid until its TTL expires unless explicitly revoked.
- **Rotation:** secrets are read **only at startup**. Applying a new value requires restarting the service.
- **Vault dependency:** if Vault is unavailable at startup, the service fails. With Docker Compose, use `depends_on` with a healthcheck to guarantee ordering.

## Requirements

- Node.js ≥ 18 (uses native `fetch`)
- TypeScript
- Vault with the **KV v2** secrets engine mounted at `secret/` and the **AppRole** auth method enabled