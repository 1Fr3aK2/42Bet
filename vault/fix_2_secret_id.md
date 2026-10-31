# Fix: AppRole SecretID Expiration (TTL = 0)

## The Original Problem

In the initial configuration, the creation of the Vault AppRole role (used by the backend to authenticate) had the parameter `secret_id_ttl=24h`. This meant that the `secret_id` generated during initialization (in `vault-init.sh`) would expire in 24 hours.

Since `vault-init.sh` only runs once when the containers start, if the infrastructure remained running continuously for more than 24 hours, the `secret_id` would become invalid. When the backend tried to renew its authentication (the `token_ttl` is 1 hour) using that expired `secret_id`, the authentication would fail, resulting in service outages (503 errors, loss of connection to secrets, etc.).

## The Applied Change

In the `vault/config/vault-init.sh` file, the AppRole configuration parameter was changed:

```diff
  vault write auth/approle/role/backend-role \
    token_policies="backend-policy" \
    token_ttl=1h \
    token_max_ttl=4h \
-   secret_id_ttl=24h
+   secret_id_ttl=0
```

The value `0` instructs Vault not to apply any expiration time to the generated `secret_id`.

## What this Affects

1. **Greater Uptime Stability:** The backend will be able to run continuously for weeks or months without encountering re-authentication failures related to the expiration of the initial credential.
2. **Access Token Lifecycle:** The temporary token generated upon login continues to have a 1-hour expiration (`token_ttl=1h`) and requires continuous renewal by the backend. This maintains session security without compromising the base credential.
3. **Regeneration on Initialization:** Despite not having a time expiration, the `secret_id` is not perpetual. Whenever the *stack* is fully restarted (`docker compose down` and `docker compose up`), the `vault-init.sh` script will run again and a new random `secret_id` will be generated to replace the previous one, maintaining credential hygiene.
