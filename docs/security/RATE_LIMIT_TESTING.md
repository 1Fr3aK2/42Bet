# Rate Limit & Brute-Force Testing Report — 42Bet

## Context

This document records the security tests performed against the brute-force and DoS protection implemented on the `/auth/login` endpoint, complementing `SECURITY_TESTING.md` ("Future Tests — Rate limiting" section). It covers the two mechanisms implemented: rate limiting by IP (nginx) and rate limiting by account (backend + Redis).

> **Revision (3 Nov 2026):** the per-account counter now belongs to the account
> (`login_attempts:user:<id>`), not to the text typed in the login field, so the
> username and the email of the same account share one counter. The login field
> is `username` (it also accepts the email); a payload with an `email` field is
> refused by the validation (400) before the rate limit even runs. Tests 10-13
> were updated, and Tests 14 and 15 were added.

---

## Test Environment

- **System**: WSL2 (Ubuntu) on Windows
- **Docker Compose**: all services running (`docker compose up -d --build`)
- **Services tested**: nginx (rate limit by IP), backend/Redis (rate limit by account)
- **Prerequisite**: confirm that `/auth/login` returns 401 for invalid credentials (not 500) before running these tests — a 500 error masks the rate limit's actual behavior
- **Redis commands**: use the Redis password of your `.env` in place of `<REDIS_PASSWORD>`. In zsh, paste the commands without `#` comment lines (zsh does not accept comments in an interactive shell by default)

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
    -d '{"username":"test@test.com","password":"wrong"}'
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
  curl -k -s -w " -> %{http_code}\n" \
    -X POST https://localhost/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"victim","password":"wrong"}'
  sleep 7
done
```

**Expected result**:
- Attempts 1-5 → `401` with `Invalid username or password`
- Attempt 6 → `401` with `Too many login attempts. Please try again later.` (blocked by the account rate limit, not just a wrong password)

**How to confirm it passed:** the status code is `401` in every case, but the message of the 6th attempt is different, which shows the block. To confirm in Redis that the 6th attempt was blocked by the counter, see Test 11.

---

### Test 11 — Direct Verification of the Counter in Redis

**Objective**: Confirm that `RateLimiterService` is actually incrementing and setting a TTL on the correct key, and that there is one key per account.

**Command**:
```bash
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning --scan --pattern 'login_attempts:*'
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning GET login_attempts:user:<id>
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning TTL login_attempts:user:<id>
```

The first command lists the counters. Use the `login_attempts:user:<id>` key that appeared for the account tested (the `<id>` is the user id).

**Expected result**:
- `GET` returns the current number of failed attempts (e.g. `"6"` after Test 10)
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
  -d '{"username":"realuser","password":"wrong"}'
```
2. Log in with the correct password:
```bash
curl -k -s -X POST https://localhost/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"realuser","password":"<correct_password>"}'
```
3. Confirm in Redis that the key is gone (use the id of the account):
```bash
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning GET login_attempts:user:<id>
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
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning EXPIRE login_attempts:user:<id> 5
```
Wait 5 seconds, then:
```bash
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning GET login_attempts:user:<id>
```

**Expected result**: `(nil)` — the key has expired. A new login attempt recreates the key from scratch (`INCR` returns `1`).

---

### Test 14 — Username and Email Share One Counter

**Objective**: Verify that logging in with the username and with the email of the same account uses the same counter. This is the regression test for the bypass found in the review of the final-version PR: with a key built from the typed text, one account had two counters, so an attacker got up to 10 attempts, and an account locked through the username could still be logged into through the email.

**Steps** (space the requests ~7s apart to stay below the per-IP limit; use a disposable account):
```bash
for i in 1 2 3; do
  curl -k -s -w " -> %{http_code}\n" \
    -X POST https://localhost/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"<username>","password":"wrong"}'
  sleep 7
done

for i in 1 2 3; do
  curl -k -s -w " -> %{http_code}\n" \
    -X POST https://localhost/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"<email>","password":"wrong"}'
  sleep 7
done
```
Then log in through the **email** with the **correct** password.

**Expected result**:
- The first 5 attempts → `401` with `Invalid username or password`
- The 6th attempt (the third through the email) → `401` with `Too many login attempts. Please try again later.`
- The login through the email with the correct password → `401` with `Too many login attempts...` (**not** `200`)
- In Redis, `--scan --pattern 'login_attempts:*'` shows **one** key for the account, `login_attempts:user:<id>`, with `6`

**Automated version:** section S1 of `scripts/test-security.sh` runs this scenario (5 failures through the username, then the correct password through the email) and fails with `200 (bypass total)` if the two spellings do not share the counter.

---

### Test 15 — Unknown Identifiers Are Counted Without Storing the Typed Text

**Objective**: Verify that attempts on a username or email that matches no account are still counted (otherwise unknown names could be tried without limit), and that the typed text is not stored in Redis in clear.

**Steps**:
```bash
curl -k -s -w " -> %{http_code}\n" \
  -X POST https://localhost/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"nobody@example.com","password":"wrong"}'
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning --scan --pattern 'login_attempts:unknown:*'
```

**Expected result**:
- The response is `401` with `Invalid username or password`
- Redis shows a key `login_attempts:unknown:<64 hexadecimal characters>` (the SHA-256 of the lowercased text) with the number of attempts, and **no email appears in any key name**
- Repeating the attempt with different capitalization (`NoBody@Example.com`) increments the **same** key

---

## Results Summary

| # | Mechanism | Attack Vector | Expected Result | Status |
|---|---|---|---|---|
| 9 | Rate limit by IP (nginx) | Burst of requests, same IP | 503 after burst | ✅ Confirmed (6x 401, then 503; reproduced twice) |
| 10 | Rate limit by account (Redis) | Spaced-out attempts, same account | 401, then `Too many login attempts` on the 6th | ✅ Confirmed (re-checked on 3 Nov 2026 with the S1 test of `scripts/test-security.sh`) |
| 11 | Redis — direct verification | `GET`/`TTL` on the key | Correct counter and TTL, one key per account | ✅ Confirmed (keys `login_attempts:user:<id>`; the older check gave `GET`=6, `TTL`≈1708s) |
| 12 | Reset on success | Correct login after failures | Key deleted (`nil`) | ⏳ Blocked — registration endpoint not yet functional, no test account available |
| 13 | Window expiration | Wait / manual EXPIRE | Counter resets | ✅ Confirmed (manual `EXPIRE 5`, then `GET` returned `nil`) |
| 14 | Username and email share one counter | Alternate the two spellings of one account | 6th attempt blocked, one Redis key | ✅ Confirmed on 3 Nov 2026 (S1 of `scripts/test-security.sh` went from `200 (bypass total)` to `OK`; one key per account in Redis) |
| 15 | Unknown identifiers | Attempts on an email without account | Counted by hash, no email in clear | ✅ Confirmed on 3 Nov 2026 (key `login_attempts:unknown:<hash>` observed in Redis, no email in any key name) |

*(Update the "Status" column with ✅/❌ after running each test.)*

**Note:** the initial test run was affected by an unrelated backend bug (HTTP 500 on `/auth/login` due to a pending Prisma migration — see `RATE_LIMITING.md`). Tests 9-11 and 13 were re-run/run after the fix (`backend_migrate` service added to `docker-compose.yml`) and confirmed correct with the backend fully functional. Test 12 remains blocked until the registration endpoint is confirmed functional and a test account is available to log in with correct credentials (also see `SECURITY_REPORT.md` §11, which tracks this same open item).

---

## Design Notes

- The per-account rate limit uses the **account id** as the key (`login_attempts:user:<id>`), so the username and the email of the same account share one counter. For identifiers that match no account it uses a SHA-256 of the lowercased text (`login_attempts:unknown:<hash>`). It doesn't protect against account enumeration through other means (e.g. a registration endpoint confirming whether an email already exists). Out of scope for this document.
- Blocking an account doesn't notify the legitimate user by email/SMS that their account is being targeted — could be a future improvement (outside the MVP).
- Only tested in a local environment (WSL2) — behavior under real load (multiple simultaneous attackers, real network latency) has not been validated.

---

## Future Tests

- **Repeat Test 12 once `/auth/login` no longer depends on a blocked registration flow** — the original blocker (the 500-on-migration bug) was fixed long ago (`backend_migrate` service), but Test 12 specifically still needs a working registration endpoint to create a disposable test account; this is the one remaining item in this document.
- ~~Rate limiting on the remaining endpoints, once they exist (forum, trades)~~ — **done for the forum.** All three write endpoints (`createPost`, `createComment`, `createReport`) now have per-user rate limiting via the same `RateLimiterService` used here (`forum_post:${userId}` 5/10min, `forum_comment:${userId}` 20/10min, `forum_report:${userId}` 10/hour), unblocked once `JwtAuthGuard` was added to those routes. `createPost` has been tested in production with the same methodology as Tests 9-11 (5×`201`, then `429` on the 6th/7th, Redis counter confirmed) — see `SECURITY_REPORT.md` §4 and `AUTH_HARDENING_REPORT.md` §5 for the full detail; not duplicated here since this document's scope is specifically the login endpoint. A similar per-request test log for `createComment`/`createReport`, and for trades (if/when that module gets its own write-heavy endpoints), remains open.
- Test the per-IP rate limit's behavior when nginx sits behind a shared NAT (simulate multiple "users" from the same IP) to confirm the current values (`10r/m`, `burst=5`) don't cause excessive false lockouts.