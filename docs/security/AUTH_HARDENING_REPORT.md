# Auth & Rate Limiting Hardening Report

**Date:** 2026-09-21
**Branch:** `fix/modsecurity+`
**Author:** Rafael Matos (Cybersecurity / DevOps / Monitoring)

## Summary

During a security review of the backend and network configuration, six
security vulnerabilities/gaps were identified, all fixed and tested in this
session. Each is documented below with the problem, root cause, applied
fix, and test evidence.

---

## 1. Login rate limit with a global lockout

**File:** `backend/src/auth/auth.service.ts`

**Problem:** the `RateLimiterService` used in `AuthService.login()` had a
fixed key:
```ts
const key = "login_attempts:";
```
With no variable in it, this key was shared by **every** login request,
from every user. After 5 failed logins from any source (no valid
credentials required), login was locked out for the entire platform for
30 minutes — a trivial, unauthenticated DoS.

**Fix:**
```ts
const key = `login_attempts:${dto.email}`;
```
The counter is now isolated per account. The existing `resetLimit(key)`
call at the end of the method inherited the correct behaviour
automatically, since it reuses the same variable.

> **Correction to this revision:** this section previously referred to
> `dto.username`. Confirmed against the actual login payload (`POST
> /auth/login` takes `email`/`password`, per the team's Authentication
> Module doc) that the field is `email`, matching what `RATE_LIMITING.md`
> already showed. Updated here to match the real code rather than leaving
> two documents disagreeing with each other.

**Test:** confirmed that failed attempts against one account no longer
affect login for other accounts.

---

## 2. Hardcoded `JWT_SECRET` fallback

**Files:** `backend/src/auth/auth.module.ts`, `backend/src/auth/jwt.strategy.ts`

**Problem:** both files had `process.env.JWT_SECRET || 'secret'`. If the
environment variable was not set (confirmed to be the case in production
at the time), the app signed and validated every JWT with the literal
string `'secret'`, public in the source code. Anyone could forge a valid
token for any `userId`, including admin, with no authentication at all.

**Fix:**
- Removed the fallback in both files.
- `jwt.strategy.ts` now throws an explicit error at startup if
  `JWT_SECRET` is not set (fail-fast).
- Found and fixed a secondary bug: `JwtModule.register({...})` in
  `auth.module.ts` was evaluated at import time (before
  `loadSecretsFromVault()` ran in `bootstrap()`), so `JWT_SECRET` was
  always `undefined` in that module, even after Vault responded. Fixed by
  switching to `JwtModule.registerAsync({ useFactory: ... })`, which
  defers config resolution to the instantiation phase.

**Test:**
- Confirmed in logs: without `JWT_SECRET`, the backend fails to start
  with `Error: JWT_SECRET environment variable is not set`.
- Proof of concept: a JWT manually forged with the `'secret'` secret was
  accepted by the API (`GET /auth/me`) *before* the fix, and returned
  `401` *after* the fix, using the same token.

---

## 3. `JWT_SECRET` migrated to Vault

Following the same pattern already used for `ADMIN_API_KEY`/
`ADMIN_USERNAME`/`ADMIN_EMAIL`/`ADMIN_PASSWORD`:

- New secret `secret/jwt` (field `secret`) written by `vault_init.sh`.
- New `path "secret/data/jwt"` with `capabilities = ["read"]` in
  `backend-policy.hcl`.
- `JWT_SECRET` now only lives in the `environment:` of the `vault_init`
  service in `docker-compose.yml` — never in the `backend` service's
  environment.
- `vault-bootstrap.ts` reads `secret/jwt` via the existing generic
  `readVaultSecret()` and assigns it to `process.env.JWT_SECRET` before
  `NestFactory.create()` runs.

**Test:** confirmed `docker compose exec backend env | grep JWT_SECRET`
returns empty (the secret never exists as a container environment
variable, only in the Node process's memory after the AppRole login to
Vault) — same behaviour already validated for `ADMIN_API_KEY`.

> **Note:** the team's separate Authentication Module documentation still
> shows `JWT_SECRET=secret123` living in `.env` as current config, and
> lists "Move JWT secret to Hashicorp Vault" under its own "Future
> Improvements" — that document has not been updated to reflect that this
> migration is already done. Worth fixing there too, not just here.

---

## 4. ModSecurity audit log leaking credentials in plaintext

**File:** `docker-compose.yml` (`nginx` service)

**Problem (reported by a teammate):** the image's default
`SecAuditLogParts` (`ABIJDEFHZ`) includes part `B` (request headers),
meaning the `X-API-Key` header — and potentially any `Authorization`
header — was logged in plaintext in the ModSecurity audit log.

**Investigation:** the teammate's initial attempt to use the
`sanitiseRequestHeader:X-API-Key` action failed because that action
belongs to legacy ModSecurity v2 and is not supported by the nginx v3
connector (libModSecurity3) used by the
`owasp/modsecurity-crs:4-nginx-*` image. Confirmed as a known, documented
limitation of that connector.

**Fix:** since selective header redaction isn't available, part `B` was
removed from the audit log entirely:
```yaml
MODSEC_AUDIT_LOG_PARTS: "AIJDEFHZ"
```
This eliminates any credential exposure via headers, at the cost of
losing visibility into non-sensitive headers (`User-Agent`,
`Content-Type`) in audit log entries.

**Test:** confirmed in the current `docker-compose.yml`; the WAF remains
active (`modsecurity on`), only the headers part is no longer logged.

---

## 5. Per-user rate limiting on the forum

**Files:** `backend/src/forum/forum.module.ts`, `backend/src/forum/forum.service.ts`

**Context:** this fix had been blocked since it was identified that
`createPost`/`createComment`/`createReport` in `ForumController` had no
auth guard or reliable `userId`. A later team PR fixed that (all endpoints
now use `@UseGuards(JwtAuthGuard)`, `userId` always taken from
`request.user.id`), which unblocked this work.

**Implementation:**
- `RateLimiterModule` added to `ForumModule`'s imports.
- `RateLimiterService` injected into `ForumService`.
- Limits applied per `userId`, isolated from one another:
  - `createPost`: 5 requests / 10 min (`forum_post:${userId}`)
  - `createComment`: 20 requests / 10 min (`forum_comment:${userId}`)
  - `createReport`: 10 requests / 1 hour (`forum_report:${userId}`)
- Once exceeded, throws `HttpException(..., HttpStatus.TOO_MANY_REQUESTS)`.

**Test:** `createPost` confirmed in production — first 5 requests return
`201`, 6th and 7th return `429` with the correct message; counter
confirmed in Redis (`forum_post:<userId>`). `createComment`/
`createReport` use the exact same mechanism (`checkLimit`), already
validated.

---

## 6. Public Admin API's Swagger docs exposed with no authentication

**File:** `backend/src/main.ts`

**Problem:** `SwaggerModule.setup('api/admin/docs', app, document)` had no
guard at all — anyone could view the full Public Admin API documentation
(endpoints, DTOs, parameters) without the `ADMIN_API_KEY`.

**Fix:** since `SwaggerModule.setup` doesn't create controller routes
(there's nowhere to put `@UseGuards`), an Express middleware (`app.use(...)`)
was added **before** `SwaggerModule.setup`, reusing the same SHA-256 hash +
`timingSafeEqual` check already used in `AdminApiKeyGuard`. Applied to two
paths: `/api/admin/docs` (UI) and `/api/admin/docs-json` (the raw JSON
spec, auto-generated by Swagger and easy to overlook).

**Test:** confirmed — without `X-API-Key`, both paths return `401`; with
the correct key, `200`.

---

## 7. Shared global rate limit on the Public Admin API

**File:** `backend/src/public-api/admin-api-rate-limit.guard.ts`

**Problem:** the rate limiter key was the fixed string
`'admin_api_requests'`, shared by every API consumer. A single client with
heavy usage could exhaust the quota (100 req/60s) for everyone else.

**Fix:** key changed to include the client's IP (read from `X-Real-IP`,
populated by nginx, falling back to `request.ip`):
```ts
const clientIp = (request.headers['x-real-ip'] as string) || request.ip;
await this.rateLimiterService.checkLimit(`admin_api_requests:${clientIp}`, 100, 60);
```
Design note: consumers behind the same IP/NAT still share a quota —
a future improvement would be per-client API keys.

**Test:** tested directly against the backend (bypassing nginx's own rate
limit, which intercepted first since it's more restrictive at the network
level) — confirmed exactly 100 consecutive successes and `429` starting
from the 101st request.

---

## Side finding: stale nginx DNS resolution

During testing, a `502 Bad Gateway` (masked as `403` by the WAF itself,
which intercepts 5xx responses — rules 950100/959100) revealed that
nginx, running for 47h without a restart, had cached the old IP of the
`backend` container. Since nginx resolves hostnames once at worker
startup (it doesn't re-query Docker's internal DNS per request),
recreating only `backend` (via `make update SERVICE=backend`) leaves
nginx pointing at a dead IP until it's restarted.

**Mitigation applied now:** `docker compose restart nginx`.

**Known structural fix, not applied by the author's choice:** add
`resolver 127.0.0.11 valid=10s;` and use `proxy_pass` via a variable
(`set $backend_upstream http://backend:8000; proxy_pass
$backend_upstream;`) to force periodic DNS re-resolution.

---

## Changed files summary

| File | Change |
|---|---|
| `backend/src/auth/auth.service.ts` | Per-account login rate limit |
| `backend/src/auth/auth.module.ts` | Removed JWT fallback + `registerAsync` |
| `backend/src/auth/jwt.strategy.ts` | Removed JWT fallback + fail-fast |
| `backend/src/vault/vault-bootstrap.ts` | Reads `secret/jwt` |
| `vault/config/vault-init.sh` | `vault kv put secret/jwt` |
| `vault/config/backend-policy.hcl` | `path "secret/data/jwt"` |
| `docker-compose.yml` | `JWT_SECRET` in `vault_init`; `MODSEC_AUDIT_LOG_PARTS` in `nginx` |
| `.env` | `JWT_SECRET` generated |
| `backend/src/forum/forum.module.ts` | `RateLimiterModule` import |
| `backend/src/forum/forum.service.ts` | Per-user rate limit (post/comment/report) |
| `backend/src/main.ts` | Guard on the Public Admin API's Swagger |
| `backend/src/public-api/admin-api-rate-limit.guard.ts` | Per-IP rate limit |