# Rate Limit & Brute-Force Testing Report — ft_transcendence

## Context

This document records the security tests performed against the brute-force and DoS protection implemented on the `/auth/login` endpoint, complementing `SECURITY_TESTING.md` ("Future Tests — Rate limiting" section). It covers the two mechanisms implemented: rate limiting by IP (nginx) and rate limiting by account (backend + Redis).

---

## Test Environment

- **System**: WSL2 (Ubuntu) on Windows
- **Docker Compose**: all services running (`docker compose up -d --build`)
- **Services tested**: nginx (rate limit by IP), backend/Redis (rate limit by account)
- **Prerequisite**: confirm that `/auth/login` returns 401 for invalid credentials (not 500) before running these tests — a 500 error masks the rate limit's actual behavior

---

## Tests Performed

---

### Test 9 — Rate Limit by IP: Excessive Requests

**Objective**: Verify that nginx blocks excessive requests to `/auth/login` coming from the same IP.

**Attack vector**: Burst of fast requests, simulating a brute-force script from a single IP.

**Command**:
```bash
for i in {1..20}; do
  curl -k -s -o /dev/null -w "%{http_code}\n" \
    -X POST https://localhost/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@test.com","password":"wrong"}'
done
```

**Expected result**:
- First ~6 requests (rate `10r/m` + `burst=5`) → `401` (reach the backend, invalid credentials)
- Remaining requests → `503` (rejected by nginx before reaching the backend)

**How to confirm it passed:** count how many `401`s and `503`s appear in the output; there should be a clear transition from `401` to `503` starting around the 6th/7th request, with no accepted requests afterwards.

---

### Test 10 — Rate Limit by Account: Distributed Across Multiple IPs

**Objective**: Verify that the per-account limit blocks an attacker even when attempts come from different IPs (a botnet scenario, which the per-IP limit alone doesn't cover).

**Attack vector**: Several login attempts against the same account, spaced out enough to avoid triggering the per-IP limit (`10r/m`), simulating several different origins.

**Command** (space requests ~7s apart to avoid being blocked by nginx first):
```bash
for i in {1..6}; do
  curl -k -s -o /dev/null -w "Attempt $i: %{http_code}\n" \
    -X POST https://localhost/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"victim@test.com","password":"wrong"}'
  sleep 7
done
```

**Expected result**:
- Attempts 1-5 → `401` (generic "Invalid email or password" message)
- Attempt 6 → `401` (same message, but now blocked by the account rate limit, not just a wrong password)

**How to confirm it passed:** the HTTP response is identical in every case (it's not possible to distinguish "wrong password" from "blocked" from the outside — this is intentional). To confirm the 6th attempt was actually blocked by Redis rather than just another wrong password, check Redis directly (see Test 11).

---

### Test 11 — Direct Verification of the Counter in Redis

**Objective**: Confirm that `RateLimiterService` is actually incrementing and setting a TTL on the correct key.

**Command**:
```bash
docker exec -it redis redis-cli -a <REDIS_PASSWORD>
GET login_attempts:victim@test.com
TTL login_attempts:victim@test.com
```

**Expected result**:
- `GET` returns the current number of failed attempts (e.g. `"5"` after Test 10)
- `TTL` returns a positive, decreasing value in seconds, up to 1800 (30 min) — confirms `EXPIRE` was applied

**Security note:** direct access to Redis requires the password (`-a <password>`) — if this command works without a password, that's a configuration issue to fix (see Test 1 in `SECURITY_TESTING.md`, already validated as secure).

---

### Test 12 — Counter Reset After a Successful Login

**Objective**: Verify that a correct login clears the failed-attempts history (the key is deleted from Redis).

**Steps**:
1. Make 2-3 failed attempts for an account with a known password:
```bash
curl -k -s -o /dev/null -w "%{http_code}\n" \
  -X POST https://localhost/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"realuser@test.com","password":"wrong"}'
```
2. Log in with the correct password:
```bash
curl -k -s -X POST https://localhost/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"realuser@test.com","password":"<correct_password>"}'
```
3. Confirm in Redis that the key is gone:
```bash
docker exec -it redis redis-cli -a <REDIS_PASSWORD> GET login_attempts:realuser@test.com
```

**Expected result**:
- Step 2 → `200` with `access_token` in the response body
- Step 3 → `(nil)` (the key no longer exists — deleted by `resetLimit`)

**Expected conclusion:** confirms that a legitimate user, even after a few mistaken attempts, doesn't end up with "leftover history" after logging in correctly.

---

### Test 13 — Behavior After the Window Expires

**Objective**: Verify that after `windowSeconds` (1800s) passes with no new attempts, the counter resets on its own.

**Practical note:** 30 minutes is too long to comfortably test manually. Two alternatives:

**Option A — temporarily lower the value for testing** (don't leave this in production):
Temporarily change `windowSeconds` from `1800` to `30` in `auth.service.ts`, test, then revert.

**Option B — force expiration manually in Redis** (no code changes):
```bash
docker exec -it redis redis-cli -a <REDIS_PASSWORD>
EXPIRE login_attempts:victim@test.com 5
```
Wait 5 seconds, then:
```bash
GET login_attempts:victim@test.com
```

**Expected result**: `(nil)` — the key has expired. A new login attempt recreates the key from scratch (`INCR` returns `1`).

---

## Results Summary

| # | Mechanism | Attack Vector | Expected Result | Status |
|---|---|---|---|---|
| 9 | Rate limit by IP (nginx) | Burst of requests, same IP | 503 after burst | ✅ Confirmed (6x 401, then 503; reproduced twice) |
| 10 | Rate limit by account (Redis) | Spaced-out attempts, same account | Consistent 401, block on 6th | ✅ Confirmed (6x 401, generic message) |
| 11 | Redis — direct verification | `GET`/`TTL` on the key | Correct counter and TTL | ✅ Confirmed (`GET`=6, `TTL`≈1708s) |
| 12 | Reset on success | Correct login after failures | Key deleted (`nil`) | ⏳ Blocked — registration endpoint not yet functional, no test account available |
| 13 | Window expiration | Wait / manual EXPIRE | Counter resets | ✅ Confirmed (manual `EXPIRE 5`, then `GET` returned `nil`) |

*(Update the "Status" column with ✅/❌ after running each test.)*

**Note:** the initial test run was affected by an unrelated backend bug (HTTP 500 on `/auth/login` due to a pending Prisma migration — see `RATE_LIMITING.md`). Tests 9-11 and 13 were re-run/run after the fix (`backend_migrate` service added to `docker-compose.yml`) and confirmed correct with the backend fully functional. Test 12 remains blocked until the registration endpoint is confirmed functional and a test account is available to log in with correct credentials (also see `SECURITY_REPORT.md` §11, which tracks this same open item).

---

## Design Notes

- The per-account rate limit uses the **email** as the key — it doesn't protect against account enumeration through other means (e.g. a registration endpoint confirming whether an email already exists). Out of scope for this document.
- Blocking an account doesn't notify the legitimate user by email/SMS that their account is being targeted — could be a future improvement (outside the MVP).
- Only tested in a local environment (WSL2) — behavior under real load (multiple simultaneous attackers, real network latency) has not been validated.

---

## Future Tests

- **Repeat Test 12 once `/auth/login` no longer depends on a blocked registration flow** — the original blocker (the 500-on-migration bug) was fixed long ago (`backend_migrate` service), but Test 12 specifically still needs a working registration endpoint to create a disposable test account; this is the one remaining item in this document.
- ~~Rate limiting on the remaining endpoints, once they exist (forum, trades)~~ — **done for the forum.** All three write endpoints (`createPost`, `createComment`, `createReport`) now have per-user rate limiting via the same `RateLimiterService` used here (`forum_post:${userId}` 5/10min, `forum_comment:${userId}` 20/10min, `forum_report:${userId}` 10/hour), unblocked once `JwtAuthGuard` was added to those routes. `createPost` has been tested in production with the same methodology as Tests 9-11 (5×`201`, then `429` on the 6th/7th, Redis counter confirmed) — see `SECURITY_REPORT.md` §4 and `AUTH_HARDENING_REPORT.md` §5 for the full detail; not duplicated here since this document's scope is specifically the login endpoint. A similar per-request test log for `createComment`/`createReport`, and for trades (if/when that module gets its own write-heavy endpoints), remains open.
- Test the per-IP rate limit's behavior when nginx sits behind a shared NAT (simulate multiple "users" from the same IP) to confirm the current values (`10r/m`, `burst=5`) don't cause excessive false lockouts.