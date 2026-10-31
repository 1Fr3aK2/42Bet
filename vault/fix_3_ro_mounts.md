# Fix: Read-Only (RO) Permissions on Vault Volumes

## The Original Problem

In the `docker-compose.yml`, the `vault` service was mounting two local directories into its container without explicit write restrictions:

1. `./vault/config` (mounted to `/etc/vault/config`)
2. `./vault/certs` (mounted to `/etc/vault/certs`)

The absence of the *read-only* flag meant that the main Vault process — or any attacker who managed to execute commands inside that container due to a vulnerability — would have file-system level permissions to alter the configuration files themselves (e.g., `vault.hcl`) or modify/replace the TLS certificates.

## The Applied Change

In the `docker-compose.yml` file, the `volumes` section of the `vault` service was adjusted with the `:ro` flag:

```diff
     volumes:
-      - ./vault/config:/etc/vault/config
-      - ./vault/certs:/etc/vault/certs
+      - ./vault/config:/etc/vault/config:ro
+      - ./vault/certs:/etc/vault/certs:ro
       - vault-data:/vault/data
```

## What this Affects

1. **Isolation and Hardening:** This follows best practices and rigorous security requirements (in line with the "hardened" aspect of the subject). It is physically guaranteed at the Docker level that Vault can only **read** its configuration and certificates. Any write attempt will result in an immediate `Read-only file system` error.
2. **Prevention Against Tampering:** It prevents privilege escalation or injection attacks through modification of the policy (`backend-policy.hcl`) or the local initialization script from within the compromised container.
3. **No Operational Impact:** The `vault` service does not need, under any operational circumstances, to write to these files. Therefore, applying the `:ro` restriction generates no side effects on the infrastructure's operability. The `vault-data` volume, used for Raft storage where writes actually occur, maintained its permissions unchanged.
