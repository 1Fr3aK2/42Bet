# Rate Limit & Brute-Force Testing Report — 42Bet

## Context

This document records the security tests performed against the brute-force and DoS protection implemented on the `/auth/login` endpoint, complementing `docs/security/SECURITY_TESTING.md` ("Future Tests — Rate limiting" section). It covers the two mechanisms implemented: rate limiting by IP (nginx) and rate limiting by account (backend + Redis).

> **Revision (3 Nov 2026):** the per-account counter now belongs to the account
> (`login_attempts:user:<id>`), not to the text typed in the login field, so the
> username and the email of the same account share one counter. The login field
> is `username` (it also accepts the email); a payload with an `email` field is
> refused by the validation (400) before the rate limit even runs. Tests 10-13
> were updated, and Tests 14 and 15 were added.

> **Revision (12 Nov 2026):** the expected result of Test 9 was corrected to `429`
> (the `/auth` location sets `limit_req_status 429`; the previous text said `503`,
> which is only nginx's default). Tests 10, 11, 13, 14 and 15 were clarified: which
> account to use, what each test does and does not prove, and what to record.
> Isolation rules between tests were added to the environment section. Test 13 now
> documents that the counter window is fixed: the TTL is set by the first failed
> attempt and later attempts do not renew it.

---

## Test Environment

- **System**: WSL2 (Ubuntu) on Windows
- **Docker Compose**: all services running (`docker compose up -d --build`)
- **Services tested**: nginx (rate limit by IP), backend/Redis (rate limit by account)
- **Prerequisite**: confirm that `/auth/login` returns 401 for invalid credentials (not 500) before running these tests — a 500 error masks the rate limit's actual behavior
- **Redis commands**: use the Redis password of your `.env` in place of `<REDIS_PASSWORD>`. In zsh, paste the commands without `#` comment lines (zsh does not accept comments in an interactive shell by default)
- **Isolation between tests**: wait about 1 minute after a test that exhausts the per-IP limit (Test 9) before starting the next one, so the nginx bucket drains. Use a disposable account, and remember that a locked account stays locked while its counter lives (window of 1800s). To unlock it between runs, delete its counter:
```bash
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning --scan --pattern 'login_attempts:*'
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning DEL login_attempts:user:<id>
```

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
done | uniq -c
```

`uniq -c` (without `sort`) collapses consecutive equal codes, so the output shows the counts and also the order.

**Expected result**:
- First 6 requests → `401` (reach the backend, invalid credentials). The rate `10r/m` lets 1 request through and `burst=5` accepts up to 5 more above the rate (1 + 5 = 6)
- Remaining 14 requests → `429` (rejected by nginx before reaching the backend; the `/auth` location sets `limit_req_status 429`, otherwise nginx would answer its default `503`)

**How to confirm it passed:** the output has exactly two lines, `6 401` followed by `14 429`. Any other shape (for example a `401` after a `429`) means the limit is not behaving as a burst limit.

**Result (12 Nov 2026):** ✅ 6 × `401` and 14 × `429`.

---

### Test 10 — Rate Limit by Account: Spaced Attempts Below the IP Limit

**Objective**: Verify that the per-account limit blocks an attacker whose requests stay below the per-IP limit, which is what a botnet does (each IP sends little, the account receives a lot). The per-IP limit alone doesn't cover this.

**Attack vector**: Several login attempts against the same account, spaced out enough to avoid triggering the per-IP limit (`10r/m`).

**What this test does and does not prove**: all requests come from the same IP, spaced so that nginx never fires, so any block seen can only come from the account counter. It proves that the account counter works independently of the IP limit. It does not send requests from different IPs (see Future Tests).

**Prerequisite**: `victim` must be the username of an **existing** disposable account. For a name that matches no account, the attempts are counted under `login_attempts:unknown:<hash>` (Test 15) and there is no `login_attempts:user:<id>` key to inspect in Test 11.

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

**How to confirm it passed:** the status code is `401` in every case, but the message of the 6th attempt is different, which shows the block. To confirm in Redis that the 6th attempt was blocked by the counter, see Test 11 (run it right after this test, with the same account).

**Result (12 Nov 2026):** ✅ Account `ratetest1` (id 29): attempts 1-5 → `401 Invalid username or password`, attempt 6 → `401 Too many login attempts. Please try again later.`

---

### Test 11 — Direct Verification of the Counter in Redis

**Objective**: Confirm that `RateLimiterService` is actually incrementing and setting a TTL on the correct key, and that there is one key per account.

**Command** (run right after Test 10, with the same account):
```bash
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning --scan --pattern 'login_attempts:*'
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning GET login_attempts:user:<id>
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning TTL login_attempts:user:<id>
```

The first command lists the counters. Use the `login_attempts:user:<id>` key that appeared for the account tested (the `<id>` is the user id).

**Expected result**:
- `GET` returns the current number of failed attempts (`"6"` after Test 10: the blocked 6th attempt is counted too)
- `TTL` returns a positive, decreasing value in seconds, up to 1800 (30 min) — confirms `EXPIRE` was applied

**Security note:** direct access to Redis requires the password (`-a <password>`) — if this command works without a password, that's a configuration issue to fix (see Test 1 in `docs/security/SECURITY_TESTING.md`, already validated as secure).

**Result (12 Nov 2026):** ✅ `--scan` showed a single key, `login_attempts:user:29`; `GET` = `6`; `TTL` = `1757` (1800 minus the ~43s since the first attempt of Test 10).

---

### Test 12 — Counter Reset After a Successful Login

**Objective**: Verify that a correct login clears the failed-attempts history (the key is deleted from Redis).

**Steps**:
1. Make 3 failed attempts for an account with a known password (spaced ~7s apart):
```bash
for i in 1 2 3; do
  curl -k -s -o /dev/null -w "%{http_code}\n" \
    -X POST https://localhost/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"realuser","password":"wrong"}'
  sleep 7
done
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

**Automated version:** `bash scripts/test-rate-limit-reset.sh` registers a disposable account, builds up three failed attempts (the Redis counter reads `3`) and confirms that a correct login deletes `login_attempts:user:<id>`. It spaces the logins 7 seconds apart and takes about 35 seconds.

**Result (12 Nov 2026):** ✅ 9 passed, 0 failed.

---

### Test 13 — Behavior After the Window Expires

**Objective**: Verify that the counter resets on its own when `windowSeconds` (1800s) expires, that the key is recreated from scratch afterwards, and which kind of window the code implements (fixed or sliding).

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

**Expected result**: `(nil)` — the key has expired.

Option B tests Redis' expiry of the key, and the TTL set by the application is checked in Test 11. What is left to check is the application's behavior after the expiry.

**Part 2 — recreation of the key and type of window** (use the same account, after the key has expired):
```bash
curl -k -s -w " -> %{http_code}\n" \
  -X POST https://localhost/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<username>","password":"wrong"}'
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning GET login_attempts:user:<id>
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning TTL login_attempts:user:<id>
sleep 30
curl -k -s -w " -> %{http_code}\n" \
  -X POST https://localhost/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<username>","password":"wrong"}'
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning TTL login_attempts:user:<id>
```

**Expected result**:
- First `GET` → `"1"` (the key was recreated from scratch, `INCR` returned 1) and first `TTL` ≈ 1800
- Second `TTL` shows which window the code implements: ≈ 1800 again would mean each attempt renews the TTL (sliding window); ≈ 1770 means the TTL is set only on the first attempt of the window (fixed window)

**Result (12 Nov 2026):** ✅ `EXPIRE 5` → `1`, then `GET` returned `nil`. A new failed attempt recreated the key (`GET` = `1`, `TTL` = `1800`). Thirty seconds and one more failed attempt later, `TTL` = `1769`: the window is **fixed**. The TTL is set by the first failed attempt of the window and later attempts do not renew it, so the counter expires 1800s after the first failed attempt, not 1800s after the last one.

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
Check Redis **before** the next step:
```bash
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning --scan --pattern 'login_attempts:*'
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning GET login_attempts:user:<id>
```
Then log in through the **email** with the **correct** password, and read the counter again:
```bash
curl -k -s -w " -> %{http_code}\n" \
  -X POST https://localhost/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<email>","password":"<correct_password>"}'
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning GET login_attempts:user:<id>
```

**Expected result**:
- The first 5 attempts → `401` with `Invalid username or password`
- The 6th attempt (the third through the email) → `401` with `Too many login attempts. Please try again later.`
- In Redis, before the correct-password login, `--scan --pattern 'login_attempts:*'` shows **one** key for the account, `login_attempts:user:<id>`, and `GET` returns `6`
- The login through the email with the correct password → `401` with `Too many login attempts...` (**not** `200`)
- The last `GET` returns `7`: a blocked attempt is still counted (it does not extend the lock, since the TTL is not renewed)

**Automated version:** section S1 of `scripts/test-security.sh` runs this scenario (5 failures through the username, then the correct password through the email) and fails with `200 (bypass total)` if the two spellings do not share the counter.

**Result (12 Nov 2026):** ✅ Account `ratetest1` (id 29): 5 × `Invalid username or password`, and the 6th attempt (the third through the email) → `Too many login attempts`. `--scan` showed only `login_attempts:user:29` and `GET` = `6`. The correct password through the email → `401 Too many login attempts` (not `200`). Final `GET` = `7`.

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
Then repeat with different capitalization, and compare the key name with the SHA-256 of the lowercased text:
```bash
curl -k -s -w " -> %{http_code}\n" \
  -X POST https://localhost/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"NoBody@Example.com","password":"wrong"}'
H=$(printf '%s' 'nobody@example.com' | sha256sum | cut -d' ' -f1)
echo $H
docker exec -it redis redis-cli -a <REDIS_PASSWORD> --no-auth-warning GET login_attempts:unknown:$H
```

**Expected result**:
- The response is `401` with `Invalid username or password`
- Redis shows a key `login_attempts:unknown:<64 hexadecimal characters>` (the SHA-256 of the lowercased text) with the number of attempts, and **no email appears in any key name**
- The hash printed by `echo $H` is the one in the key name, and the last `GET` returns `2`: the capitalized attempt incremented the **same** key

**Result (12 Nov 2026):** ✅ The key name matched the SHA-256 of `nobody@example.com` (`e788ea20…842b`), and after one attempt with `nobody@example.com` and one with `NoBody@Example.com`, `GET` returned `2` (same key). No email in any key name. With no account behind them, a username and an email are counted in separate `unknown` keys, which is why Test 14 needs an existing account.

---

## Results Summary

| # | Mechanism | Attack Vector | Expected Result | Status |
|---|---|---|---|---|
| 9 | Rate limit by IP (nginx) | Burst of requests, same IP | `429` after burst | ✅ Confirmed (6x 401, then 429; reproduced three times, last on 12 Nov 2026) |
| 10 | Rate limit by account (Redis) | Spaced-out attempts, same account | 401, then `Too many login attempts` on the 6th | ✅ Confirmed on 12 Nov 2026 (account id 29: 5 × `Invalid username or password`, then `Too many login attempts` on the 6th) |
| 11 | Redis — direct verification | `GET`/`TTL` on the key | Correct counter and TTL, one key per account | ✅ Confirmed on 12 Nov 2026 (single key `login_attempts:user:29`, `GET`=6, `TTL`=1757) |
| 12 | Reset on success | Correct login after failures | Key deleted (`nil`) | ✅ Confirmed on 12 Nov 2026 (`scripts/test-rate-limit-reset.sh`: counter at `3` after three failures, key deleted after the correct login; 9 passed, 0 failed) |
| 13 | Window expiration | Wait / manual EXPIRE | Counter resets | ✅ Confirmed (manual `EXPIRE 5`, then `GET` returned `nil`; on 12 Nov 2026 the key was recreated with `GET`=1 and `TTL`=1800, and the window is fixed: `TTL`=1769 thirty seconds later) |
| 14 | Username and email share one counter | Alternate the two spellings of one account | 6th attempt blocked, one Redis key | ✅ Confirmed on 3 Nov 2026 (S1 of `scripts/test-security.sh` went from `200 (bypass total)` to `OK`; one key per account in Redis; re-run on 12 Nov 2026 with counter `6`, then `7` after the blocked correct-password login) |
| 15 | Unknown identifiers | Attempts on an email without account | Counted by hash, no email in clear | ✅ Confirmed on 3 Nov 2026 (key `login_attempts:unknown:<hash>` observed in Redis, no email in any key name; on 12 Nov 2026 the key name matched the SHA-256 of the lowercased text and the capitalized attempt incremented the same key, counter `2`) |

*(Update the "Status" column with ✅/❌ after running each test.)*

**Note:** the initial test run was affected by an unrelated backend bug (HTTP 500 on `/auth/login` due to a pending Prisma migration — see `backend/src/rate-limiter/README.md`). Tests 9-11 and 13 were re-run/run after the fix (`backend_migrate` service added to `docker-compose.yml`) and confirmed correct with the backend fully functional. Test 12 was run later, once registration worked: `scripts/test-rate-limit-reset.sh` passes (see Test 12 above).

---

## Design Notes

- The per-account rate limit uses the **account id** as the key (`login_attempts:user:<id>`), so the username and the email of the same account share one counter. For identifiers that match no account it uses a SHA-256 of the lowercased text (`login_attempts:unknown:<hash>`). It doesn't protect against account enumeration through other means (e.g. a registration endpoint confirming whether an email already exists). Out of scope for this document.
- Blocking an account doesn't notify the legitimate user by email/SMS that their account is being targeted — could be a future improvement (outside the MVP).
- Anyone who knows a username can lock that account with a handful of requests from any IP. The lock lasts until the 1800s window that started with the first failed attempt expires: blocked attempts are counted but do not renew the TTL (Test 13), so the lock cannot be prolonged. This is the usual trade-off of limiting by account: it stops the brute force, at the price of letting an attacker deny access to a known account.
- The window is fixed, so the limit is 5 failed attempts per window, not a rolling 5 per 30 minutes: an attacker can fit the end of one window and the start of the next together in a short span (up to about twice the limit). The average stays at 5 attempts per window per account.
- Tests 10 and 14 send every request from one IP. They prove the account counter acts independently of the IP limit, not that it holds against requests from several origins.
- Only tested in a local environment (WSL2) — behavior under real load (multiple simultaneous attackers, real network latency) has not been validated.

---

## Future Tests

- ~~Repeat Test 12 once `/auth/login` no longer depends on a blocked registration flow~~ — **done:** registration works and `scripts/test-rate-limit-reset.sh` passes (see Test 12).
- ~~Rate limiting on the remaining endpoints, once they exist (forum, trades)~~ — **done for the forum.** All three write endpoints (`createPost`, `createComment`, `createReport`) now have per-user rate limiting via the same `RateLimiterService` used here (`forum_post:${userId}` 5/10min, `forum_comment:${userId}` 20/10min, `forum_report:${userId}` 10/hour), unblocked once `JwtAuthGuard` was added to those routes. `createPost` has been tested in production with the same methodology as Tests 9-11 (5×`201`, then `429` on the 6th/7th, Redis counter confirmed) — see `docs/security/SECURITY_REPORT.md` §4 and `docs/security/AUTH_HARDENING_REPORT.md` §5 for the full detail; not duplicated here since this document's scope is specifically the login endpoint. A similar per-request test log for `createComment`/`createReport`, and for trades (if/when that module gets its own write-heavy endpoints), remains open.
- Test the per-IP rate limit's behavior when nginx sits behind a shared NAT (simulate multiple "users" from the same IP) to confirm the current values (`10r/m`, `burst=5`) don't cause excessive false lockouts.
- Repeat Test 10 with requests that really come from different IPs (a second machine or network), to cover the botnet scenario literally.