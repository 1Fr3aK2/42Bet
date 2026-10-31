# Fix: Vault Root Token Revocation

## The Original Problem

The `vault-init.sh` script initialized Vault and, as a byproduct, retained an active `root_token` with absolute privileges. This token was necessary during the *bootstrap* phase (to create policies, roles, and write initial secrets). However, the token was never revoked at the end of the process, remaining valid indefinitely. This exposed the system to unnecessary risk: if an attacker managed to read the initialization keys stored in the shared volume, they could immediately use the `root_token` to completely compromise Vault.

## The Applied Change

The following lines of code were added to the end of the `vault/config/vault-init.sh` file:

```bash
# 10. Revoke the root token — no longer needed after bootstrap.
echo "[*] Revoking the root token..."
vault token revoke "$ROOT_TOKEN" \
  && echo "[*] Root token successfully revoked" \
  || echo "[!] Warning: root token was not revoked (might have already expired or been revoked)"
```

## What this Affects

1. **Increased Security:** Immediately after the initial setup, the super-administrator token ceases to exist. Vault remains functional using only the limited credentials (AppRole) that were generated for the backend services.
2. **Restart Resilience:** The use of `||` in the command line ensures that if the script is executed again (e.g., container restart) and the token has already been revoked or has expired, the script will not fail, allowing the normal initialization to proceed.
3. **No Subject Conflict:** The change is aligned with the Vault hardening requirements ("encrypted and isolated") described in the subject, reducing the attack surface without breaking any backend functionality. If a root token is needed in the future, it must be explicitly generated using the unseal keys via `vault operator generate-root`.
