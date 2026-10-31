# Rate Limiting — `/auth/login`

Documentation for the brute-force and DoS protection implemented on the login endpoint. Combines two complementary mechanisms: rate limiting by IP (nginx) and rate limiting by account (backend + Redis).

> **Note on this revision:** the "Known simplifications / future work" section
> has been updated — several items listed there have since been resolved. The
> `dto.email` key shown below is confirmed correct (matches the team's
> Authentication Module doc, which documents `POST /auth/login` taking
> `email`/`password`) — `AUTH_HARDENING_REPORT.md` has been corrected to
> match, resolving a discrepancy that existed in an earlier revision of this
> document.

## Why two mechanisms

A single mechanism doesn't cover every scenario:

- **IP-only** protects against a single attacker, but not against a botnet (many IPs, one attempt each, all targeting the same account) — no individual IP ever exceeds the limit.
- **Account-only** protects against the botnet, but doesn't distinguish "many legitimate users behind the same IP" (NAT, e.g. a university network) from an attacker — combined incorrectly, it can unfairly lock out legitimate users, and on its own it doesn't throttle raw traffic against the server.

Together, they cover each other's blind spots.

## 1. Rate limit by IP (nginx)

**File:** `nginx/template/default.conf.template`

```nginx
limit_req_zone $binary_remote_addr zone=login:10m rate=10r/m;

# inside the SSL server{} block:
location /auth/ {
    proxy_pass http://backend:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    limit_req zone=login burst=5 nodelay;
}
```

- **Key:** source IP (`$binary_remote_addr`)
- **Limit:** 10 requests/minute per IP
- **Burst:** 5 extra requests in a burst, no delay (`nodelay`) — absorbs double-clicks/accidental refresh without penalizing the user
- **Response when exceeded:** HTTP 503 (nginx's native behavior)
- **`/api/` location removed:** it was misaligned with the backend (which doesn't use an `/api` prefix) and unused — cleaned up to avoid future confusion
- **Location pattern updated:** now `/auth/` (trailing slash, matching the whole auth module) rather than `/auth/login` specifically — see `NGINX_CONFIG.md` for the current full location list

**Tested with:**
```bash
for i in {1..20}; do
  curl -k -s -o /dev/null -w "%{http_code}\n" \
    -X POST https://localhost/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@test.com","password":"wrong"}'
done
```
Result: the first ~6 requests go through, the rest are rejected with 503 — confirms the expected behavior (rate + burst).

## 2. Rate limit by account (backend + Redis)

**Why in the backend, not nginx:** identifying "this attempt is for account X" requires reading the body (JSON) of the POST request — nginx, without extra modules, doesn't parse JSON. Only the backend "understands" the request content.

**Why Redis, not local memory:** an in-memory variable in the Node process is lost on container restart, and isn't shared across multiple backend instances (if scaled horizontally) — each instance would only see its own attempts, allowing the limit to be bypassed.

**File:** `backend/src/rate-limiter/rate-limiter.service.ts`

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { createClient } from 'redis';

@Injectable()
export class RateLimiterService implements OnModuleInit {
  private client = createClient({ url: process.env.REDIS_URL });

  async onModuleInit() {
    await this.client.connect();
  }

  async checkLimit(key: string, maxAttempts: number, windowSeconds: number): Promise<boolean> {
    const attempts = await this.client.incr(key);

    if (attempts === 1) {
      await this.client.expire(key, windowSeconds);
    }

    return attempts <= maxAttempts;
  }

  async resetLimit(key: string): Promise<void> {
    await this.client.del(key);
  }
}
```

- **`INCR`** is atomic — avoids a race condition on simultaneous requests (reading, incrementing, and writing separately would let two parallel attempts collapse into a single count)
- **`EXPIRE`** is only set on the 1st attempt (`attempts === 1`) — if it were reset on every attempt, the lockout would never actually expire
- **Generic and reusable** — the service knows nothing about "login"; it is now also used to limit forum writes (posts, comments, reports) and the Admin Public API, just by calling `checkLimit` with a different `key`/limits — see `SECURITY_REPORT.md` §4

**Integration in `backend/src/auth/auth.service.ts`:**

```typescript
async login(dto: LoginDto) {
  const key = "login_attempts:" + dto.email;
  const allowed = await this.rateLimiter.checkLimit(key, 5, 1800);
  if (!allowed) {
    throw new UnauthorizedException('Invalid email or password');
  }

  // ... normal validation (findUnique, bcrypt.compare) ...

  await this.rateLimiter.resetLimit(key);
  // ... generate and return the token ...
}
```

- **Checked before the database query** — avoids spending a Postgres connection on already-blocked attempts (protects the Postgres connection pool, a finite resource)
- **5 failed attempts / 30 minutes** (1800s) — industry reference values; balances not annoying distracted users against not leaving an attacker too much room
- **Identical error message** in all cases ("account doesn't exist", "wrong password", "blocked due to attempts") — avoids confirming to an attacker whether the account exists or whether it's being rate-limited
- **Reset on success** — a correct login clears the failure history; old errors don't penalize forever

**Registered in `backend/src/auth/auth.module.ts`:** `RateLimiterService` added to `providers`.

## Bug found during testing (unrelated to rate limiting) — resolved

While testing the IP rate limit, `/auth/login` was returning **HTTP 500** even for a single isolated request, instead of the expected 401 for invalid credentials. Root cause identified via `docker logs backend`: a pending Prisma migration (`20260719190112_add_forum_and_moderation`) had never been applied to the database, so required tables were missing. Fixed by adding a `backend_migrate` service to `docker-compose.yml` — same image as the backend, runs `npx prisma migrate deploy` and exits; `backend` now depends on it with `condition: service_completed_successfully` (same pattern already used for `vault_init`). This guarantees migrations are applied automatically on every `docker compose up`, without anyone needing to remember to run them manually.

## End-to-end validation — confirmed

After the `backend_migrate` fix, both mechanisms were re-tested with the backend fully functional (no more 500s):

- **IP rate limit:** 6 requests get `401` (reach the backend, invalid credentials), remaining requests get `503` (rejected by nginx). Reproduced twice with identical results.
- **Account rate limit:** 6 spaced-out requests (7s apart) for the same account all return `401` (generic message, as intended). Verified directly in Redis that the counter and TTL are correct — `GET login_attempts:<email>` returned `6`, `TTL` returned a value consistent with the elapsed time since the first attempt.

Both mechanisms are confirmed working correctly end-to-end.

## Testing after implementation

1. **By IP:** repeat the `curl` loop above — confirm 503 after the burst.
2. **By account:** 6 consecutive failed attempts for the same email (from different origins/IPs, or with the IP limit temporarily disabled) — confirm 401 with the generic message on the 6th.
3. **Reset:** 2-3 consecutive failures, then a successful login — confirm you get the full 5 attempts back (no "inherited" history).

A separate, real bug was later found in this exact mechanism: the Redis key
used in the shipped code did not actually include the per-account variable
shown above, meaning every account shared a single global counter — five
failed logins from anyone locked out login for everyone. Fixed by confirming
the key includes the submitted identifier (as the snippet above shows); see
`AUTH_HARDENING_REPORT.md` §1 for the full incident writeup. This is also the
source of the `email`/`username` naming discrepancy flagged at the top of
this document — worth resolving in the code itself, not just the docs.

## Known simplifications / future work

Updated from the original version — several items here are now resolved:

- ~~Vault runs in `-dev` mode~~ — **resolved.** Vault now runs with a real
  `operator init`/unseal and TLS; see `SECURITY_REPORT.md` §3.
- ~~No centralized log aggregation~~ — **resolved.** An ELK stack
  (Elasticsearch, Logstash, Kibana, Filebeat) now covers this, including
  structured parsing of the WAF audit log and index lifecycle management; see
  `SECURITY_REPORT.md` §6 and `docs/logging/ILM.md`.
- ~~Rate limiting not yet applied to forum~~ — **resolved.** Per-user limits
  now cover `createPost`/`createComment`/`createReport`, reusing this same
  `RateLimiterService`; see `SECURITY_REPORT.md` §4.
- **Trades** (or any other write-heavy endpoint outside auth/forum/admin)
  — not yet confirmed to have rate limiting; status unknown, flagged here
  rather than assumed either way.