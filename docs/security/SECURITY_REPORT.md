# Cybersecurity & DevOps Report — ft_transcendence

## Role & Scope

This report consolidates the work delivered under the **Cybersecurity / DevOps /
Monitoring** role for the ft_transcendence project: Docker, deployment, HTTPS,
secrets, WAF/Vault, logs, monitoring, health checks, backups/disaster recovery,
security testing, and technical documentation.

It brings together, into a single narrative, the individual documents produced
along the way:
- `SECURITY_TESTING.md` — infrastructure-level security tests (Redis, Postgres, WAF, Vault)
- `RATE_LIMITING.md` — brute-force/DoS protection design (login)
- `RATE_LIMIT_TESTING.md` — validation of the rate limiting mechanisms
- `NGINX_CONFIG.md` — full nginx configuration reference
- `METRICS.md` — Prometheus metrics exposed by the backend
- `AUTH_HARDENING_REPORT.md` — authentication/secrets hardening pass
- `docs/logging/ILM.md` — Elasticsearch index lifecycle management
- `docs/DISASTER_RECOVERY.md` — backup restore and disaster recovery procedures

Each linked document has the full technical detail; this report gives the
overall picture, the reasoning behind key decisions, and an honest account of
what's done versus still open.

This version supersedes the previous report: several sections below describe
work completed *after* the original write-up (Vault hardening, the ELK stack,
Elasticsearch ILM, the aggregated health check and status page), and a few
items previously listed as gaps have since been closed.

---

## 1. Infrastructure Overview

The stack runs entirely on Docker Compose, started with a single command:

- **nginx** (`owasp/modsecurity-crs` image, `PARANOIA=2`/`BLOCKING_PARANOIA=2`)
  — reverse proxy, TLS termination, WAF (ModSecurity + OWASP CRS), rate
  limiting, security headers, per-module routing.
- **Vault** — secrets management via AppRole, now running with a real
  `operator init`/unseal (5 key shares, threshold 3) and internal TLS, not dev
  mode. See Section 3.
- **Redis** — session/rate-limit storage, running with `--appendonly yes` and
  password authentication.
- **Postgres** — primary database (via Prisma), with automated daily backups.
- **Prometheus + Grafana + exporters** (nginx, redis, postgres) — metrics,
  custom dashboards, and alerting rules, exposed via nginx subpaths with
  authentication.
- **Elasticsearch + Logstash + Kibana + Filebeat** (ELK) — centralized log
  aggregation, including structured parsing of the WAF audit log, secured
  access, and index lifecycle management. See Section 6.
- **backend / frontend / backend_migrate / backend_seed** — the application
  itself, plus dedicated one-shot services for running migrations and seeding
  the admin account, both gated with `condition: service_completed_successfully`
  so the backend never starts against an inconsistent database.
- **postgres_backup** — automated daily `pg_dump`, 7-day retention.

Certificates are generated locally via `mkcert` with an automatic, native `openssl` fallback featuring Subject Alternative Name (SAN) extensions, completely eliminating any dependency on `sudo`. All inter-service traffic inside the Docker network is unencrypted by design (permitted by the project subject); every path reachable from a browser goes through nginx over HTTPS.

---

## 2. Security Testing (Infrastructure)

Manual tests were run against the core infrastructure services to validate
common attack vectors. Full detail in `SECURITY_TESTING.md`.

| Vector | Result |
|---|---|
| Redis access without authentication | ✅ Rejected (`NOAUTH required`) |
| Postgres default user (`postgres`) | ✅ Doesn't exist |
| Postgres external connection without password | ✅ Rejected |
| SQL Injection (WAF) | ✅ Blocked (403) |
| XSS (WAF) | ✅ Blocked (403) |
| Path Traversal | ✅ Blocked (404, path normalized) |
| Command Injection (WAF) | ✅ Blocked (403) |
| Vault access without token | ✅ Rejected (permission denied) |

**Gaps noted in the original pass — status updated:**
- ~~Vault dev mode (in-memory, no real seal)~~ — **resolved**, see Section 3.
- ~~Vault root token used directly, not scoped~~ — **resolved.**
  `vault_init.sh` now revokes the root token automatically once bootstrap
  (secrets, policy, AppRole) completes; the backend only ever authenticates
  with a scoped AppRole token afterwards. See Section 3 and
  `VAULT_PRODUCTION.md`, "Idempotent bootstrap and root token revocation".
- Exposed Redis/Postgres ports and self-signed certificates remain accepted
  trade-offs for this project's scope (not production deployment);
  documented rather than silently ignored.

---

## 3. Vault Hardening & Secrets Migration

Vault moved from dev mode to a properly initialized instance:

- `vault_init.sh` now runs `vault operator init -key-shares=5 -key-threshold=3`,
  persists the result to `/vault/keys/init.json` (backed by the `vault-keys`
  volume), and unseals using 3 of the 5 generated key shares — rather than the
  single-command, no-persistence dev-mode startup used previously.
- Vault and the `vault` client communicate over TLS, using certificates under
  `./vault/certs` (`VAULT_CACERT`).
- AppRole credentials (`role_id`/`secret_id`), previously only printed to
  stdout during initialization — meaning they had to be captured manually and
  were never actually usable by the backend — are now persisted to files under
  the `vault-approle` volume and consumed directly by the `backend` and
  `backend_seed` services at startup.

**Secrets migrated into Vault during this phase** (all following the same
pattern: value lives in Vault, is fetched via AppRole login at backend
bootstrap, and is never present as a plain environment variable on the
`backend` container):

- `DATABASE_URL` (PostgreSQL credentials fetched from secret `postgres` and assembled in-memory)
- `REDIS_URL` (Redis password fetched from secret `redis` and assembled in-memory)
- `ADMIN_API_KEY` (secret `admin-api`)
- `ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` (secret `admin-account`)
- `JWT_SECRET` (secret `jwt`)

A real ordering bug was found and fixed while migrating `JWT_SECRET`:
`JwtModule.register({ secret: process.env.JWT_SECRET })` in `auth.module.ts`
was evaluated at `AppModule` import time — before `loadSecretsFromVault()` ran
in `main.ts`'s `bootstrap()` — so `JWT_SECRET` was always `undefined` at the
point the module read it, despite `JwtStrategy` (which reads the env var
later, per-request) working correctly. This produced login failures that were
easy to misattribute to something else. Fixed by switching to
`JwtModule.registerAsync({ useFactory: ... })`, which defers the read to
instantiation time, after secrets have loaded. Verified end-to-end: tokens are
signed with the real Vault-sourced secret, accepted by `/auth/me`, and
`JWT_SECRET` does not appear in `docker compose exec backend env`.

A second, unrelated hardcoded-secret bug was found and fixed in the same pass:
both `auth.module.ts` and `jwt.strategy.ts` had a `|| 'secret'` fallback that
would silently sign/verify tokens with the literal string `"secret"` if the
environment variable was ever missing. The fallback was removed; `jwt.strategy.ts`
now fails fast (throws at startup) if `JWT_SECRET` is not set, rather than
running with a known, guessable signing key.

Full detail: `AUTH_HARDENING_REPORT.md`.

**A further hardening pass** on `vault-init.sh` removed the root token from
day-to-day operation entirely: once the five secrets, the policy, and the
AppRole are provisioned, the script now revokes the root token it used to
do so. An idempotent bootstrap-check (comparing whether the saved root
token is still valid against whether the AppRole credentials already exist)
makes this safe across restarts — a `vault_init` re-run after a plain
`vault` restart now only unseals and exits, without attempting to
re-provision anything with a token that's already gone. The AppRole's
`secret_id` was also changed from a 24-hour TTL to never expiring,
removing a previously-documented limitation around long-running backend
instances. Full detail, including the correct way to update a Vault secret
now that the root token isn't available by default
(`vault operator generate-root -init`, using the still-valid unseal key
shares): `VAULT_PRODUCTION.md`.

---

## 4. Rate Limiting & Brute-Force Protection

Implemented in two complementary layers on `/auth/login` (full detail in
`RATE_LIMITING.md` and `RATE_LIMIT_TESTING.md`):

- **By IP (nginx)** — `10r/m`, burst 5. Protects against a single attacker
  hammering the endpoint; doesn't protect against a distributed attack (many
  IPs, one attempt each against the same account).
- **By account (backend + Redis)** — a custom, reusable `RateLimiterService`
  in NestJS, using Redis `INCR`+`EXPIRE` for atomic, self-expiring counters.
  5 failed attempts / 30-minute window, reset on successful login.

**A real bug was found and fixed after the original report:** the per-account
limiter used a single fixed Redis key (`login_attempts:`) for *every* user,
meaning five failed logins by any one person would lock out login attempts for
everyone. Fixed by keying on the submitted username
(`login_attempts:${dto.username}`), tested and confirmed — each account now
has its own independent counter.

**Forum rate limiting, previously blocked, is now implemented.** The gap noted
in the original report (`createPost`/`createComment`/`createReport` had no
authentication guard, so there was no reliable user identity to key a limiter
on) was fixed by the teammate responsible for the forum module — all forum
endpoints now use `@UseGuards(JwtAuthGuard)`, with `authorId`/`userId` always
taken from the verified JWT, never from the request body. This unblocked
per-user limits using the existing `RateLimiterService`:
- `createPost`: 5 / 10 minutes (`forum_post:${userId}`)
- `createComment`: 20 / 10 minutes (`forum_comment:${userId}`)
- `createReport`: 10 / hour (`forum_report:${userId}`)

All three tested in production; `createPost` confirmed precisely (5×201, then
429 with the expected message on the 6th/7th attempt, Redis counter matching).

**The Admin Public API's rate limiting had a similar shared-key bug**, found
and fixed in this phase: `AdminApiRateLimitGuard` used a single global key
(`admin_api_requests`) for all callers instead of limiting per client. Fixed
to key on the client IP (`admin_api_requests:${clientIp}`, read from
`X-Real-IP` with a fallback to `request.ip`). Verified directly against the
backend (bypassing nginx): exactly 100 successes followed by `429` from the
101st request.

---

## 5. nginx Configuration & Security Headers

Full reference in `NGINX_CONFIG.md`. Highlights:

- **Per-module routing** — dedicated `location` blocks matching the backend's
  actual route prefixes: `/auth/login`, `/forum`, `/api/admin` (Admin Public
  API), `/users`, `/crypto`, `/ws` and `/socket.io/`, plus infrastructure UIs
  behind subpaths: `/grafana/`, `/prometheus/`, `/kibana/`, and — added in
  this phase — `/health` and `/status` (see Section 7).
- **Security headers**, applied to all HTTPS responses: `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`. Verified via `curl -I`.
- **WebSocket support** (`/socket.io/`, added by the frontend teammate for
  real-time crypto price data) required a scoped ModSecurity exclusion
  (`SecRuleRemoveById 920420`) rather than disabling the WAF for that location
  entirely — the WAF stays active (`modsecurity on;`) inside the location, only
  the one rule causing false positives on WebSocket upgrade requests is
  removed, scoped to that location only.
- **A second scoped WAF exclusion** was added for `/kibana/`
  (`SecRuleRemoveById 942340`): Kibana's search UI legitimately sends
  wildcard-containing queries to `/kibana/api/content_management/rpc/search`,
  which the SQLi rule 942340 flagged as an attack, adding to the inbound
  anomaly score and causing legitimate searches to be blocked with 403. Same
  scoped-exclusion pattern as the WebSocket fix — the rule is removed only for
  this one location, the rest of the WAF's SQLi protection is untouched
  elsewhere.
- **Rate-limited zones per module**: `login` (10r/m), `forum` (30r/s),
  `admin_api` (30r/s), and — added in this phase — `health` (10r/s, burst 20,
  `nodelay`).

---

## 6. Logs (ELK) — Centralized Log Aggregation

Previously listed as a known gap ("no centralized log aggregation"); fully
implemented since, covering both the functional pipeline and the two
requirements the project subject states explicitly for this module: **log
retention/archiving policies** and **secure access to all components**.

**Pipeline:** Docker container logs are collected by Filebeat (autodiscover,
with explicit `hints.default_config` — Docker labels alone were not enough to
trigger collection for containers without `co.elastic.logs/*` labels), shipped
to Logstash, and indexed into Elasticsearch as
`transcendence-logs-YYYY.MM.dd`. Filebeat is built from a small custom
Dockerfile (`COPY --chown=root:root filebeat.yml`) rather than bind-mounted,
after repeated friction with the file's required root ownership on every edit.

**WAF audit log parsing:** nginx writes the ModSecurity audit log to a file
(rather than stdout) on a dedicated volume; a separate Filebeat input and
Logstash filter parse it into a structured `waf-audit-YYYY.MM.dd` index —
`source_ip`, `http_method`, `uri`, `http_code` (as an integer), and,
extracted via a Ruby filter from the rule messages, `rule_id`,
`rule_message`, `rule_severity`, and `anomaly_score` (captured for both the
inbound rule `949110` and the outbound rule `959100` — a first version only
handled the inbound case).

**Secure access (subject requirement):** `xpack.security.enabled=true` on
Elasticsearch. Following the principle of least privilege, Logstash does not run as
the `elastic` superuser; instead, it authenticates as a dedicated `logstash_writer`
user with a restricted role (`logstash_writer_role` granting only index creation and
write permissions on `transcendence-logs-*` and `waf-audit-*`), provisioned automatically
during startup by `ilm-init.sh`. Kibana — which, unlike
Logstash, refuses to authenticate as `elastic` and requires a dedicated
service account — authenticates as `kibana_system`, with its password set by
a one-shot `kibana_user_init` service. Kibana is reachable only via nginx at
`/kibana/`, itself behind the project's TLS termination.

**A real production incident during this work, and its lesson:** after moving
`ELASTIC_PASSWORD`/`KIBANA_PASSWORD` into the `.env` file, `docker compose
restart` on the affected services did **not** pick up the new values — a
`restart` reuses the environment already baked into the existing container,
it does not re-read `.env`. The fix, used consistently since, is `docker
compose up -d --force-recreate <service>` whenever a secret change needs to
take effect. The same distinction mattered for `JWT_SECRET`: Vault only
re-reads `.env` values during `vault_init`, which itself only runs against an
uninitialized Vault — so a `.env` change to an already-initialized secret
needs either a full `make re` or a direct `vault kv put`.

**A separate audit-log leak was found and fixed:** ModSecurity's audit log
included full request headers by default, including `X-API-Key` in plain
text — and, by extension, any other sensitive header (e.g. `Authorization`)
on any future endpoint. The intended fix (`sanitiseRequestHeader`) isn't
supported by this image's libModSecurity version. Fixed instead at the
`MODSEC_AUDIT_LOG_PARTS` level: the `B` part (request headers) was dropped
from the configured parts (`AIJDEFHZ`), removing header capture from the
audit log entirely rather than attempting to redact individual header values.

**Index Lifecycle Management (ILM)** — the retention/archiving requirement.
A policy (`transcendence-logs-policy`: `hot` phase with daily/5GB rollover,
`delete` phase at 14 days) is applied automatically to both index families via
two index templates. Since `make re` recreates Elasticsearch from scratch, the
policy and templates are (re-)applied on every stack startup by a dedicated
`elasticsearch_ilm_init` one-shot service — confirmed, via a live `make re`
test, that the index of the day is already `"managed": true` immediately after
a full rebuild with no manual step. Full detail, including a real
`ignore_unavailable` bug found and fixed during implementation, in
`docs/logging/ILM.md`.

---

## 7. Health Check, Status Page, and Disaster Recovery

The project subject requires (verbatim): *"Health check and status page system
with automated backups and disaster recovery procedures."* All four parts are
now in place:

- **Automated backups** — `postgres_backup` runs `pg_dump` daily against
  Postgres, writing timestamped plain-SQL dumps to a host-mounted directory
  (surviving container/volume recreation), with 7-day retention via `find
  -mtime +7 -delete`.
- **Aggregated health check** — the backend exposes two endpoints, kept
  deliberately separate: `GET /health` (used by the Docker Compose
  `healthcheck:` for the `backend` service itself — checks database, Redis,
  and Vault only) and `GET /health/status` (a richer endpoint, always `200`,
  additionally checking Elasticsearch, meant for external/public consumption).
  They were kept separate so that Elasticsearch — which can legitimately take
  longer to become ready, e.g. after a `make re` — never causes the backend's
  own Docker healthcheck to fail and delay services that depend on
  `backend: condition: service_healthy`.
- **Public exposure** — `location /health` in nginx, proxying to
  `/health/status`, with a dedicated rate-limit zone (`10r/s`, burst 20).
- **Status page** — a standalone HTML/JS page served directly by nginx at
  `/status` (not bundled into the React frontend), polling `/health` every 10
  seconds and rendering overall status plus a per-component breakdown. Kept
  outside the frontend's React bundle deliberately: a status page is only
  useful if it can still report a problem when other parts of the stack
  (including the frontend itself) are degraded or failing to build/serve.
- **Disaster recovery procedures** — documented in full in
  `docs/DISASTER_RECOVERY.md`: a tested, step-by-step Postgres restore
  procedure (identify backup → stop writers → safety dump of current state →
  drop/recreate database → restore → restart → verify via `/health`); a
  recoverability table per Docker volume; and a dedicated explanation of why
  Vault's unseal key material is *not* recoverable after loss by design
  (Shamir's Secret Sharing), with the actual mitigation used in this project
  (`.env` is the real source of truth for secret values, not Vault's internal
  storage — a full Vault reinitialization reproduces the same secrets
  automatically from `.env`).

---

## 8. A Real Bug Found Through Testing: Missing Migrations

While validating rate limiting, both `/auth/login` and `/forum/posts`
intermittently returned `HTTP 500`. Root-caused via backend logs: a pending
Prisma migration (`add_forum_and_moderation`) had never been applied to the
database — required tables didn't exist.

**Fix:** added a `backend_migrate` service to `docker-compose.yml` — same
image as the backend, runs `prisma migrate deploy` once and exits; the
`backend` service now only starts after this completes successfully
(`condition: service_completed_successfully`). This mirrors the `vault_init`
pattern used elsewhere in the stack. A second one-shot service,
`backend_seed`, was added later on the same pattern to run `prisma db seed`
(creating the admin account from the Vault-sourced credentials) after
migrations complete.

---

## 9. A Real Bug Found in Production: Stale DNS Resolution in nginx

After recreating only the `backend` container (via a targeted `make update`,
not a full restart of nginx), nginx — which had been running for 47 hours —
kept the old IP address for `backend` cached from Docker's internal DNS. This
produced `502` responses from nginx which ModSecurity then classified as
attack-indicating anomalies (rules `950100`/`959100`), surfacing to the client
as `403` rather than `502` — a genuinely confusing failure mode to debug, since
the WAF's block masked the real cause.

**Immediate fix applied:** `docker compose restart nginx`, which forces a
fresh DNS lookup.

**Structural fix (resolving via the `127.0.0.11` Docker embedded DNS resolver
with `proxy_pass` built from a variable, so nginx re-resolves on every
request instead of caching for the container's lifetime) was identified but
deliberately not applied** — logged here as a known, accepted trade-off for
this project's scope rather than a silently dropped item.

---

## 10. Swagger / Admin API Documentation Exposure & Usability

The Admin Public API's Swagger UI (`/api/admin/docs`, `/api/admin/docs-json`)
provides full interactive endpoint documentation for the administrative API.
To prevent browser navigation lockout (since standard browsers cannot inject custom headers
like `X-API-Key` on address bar GET requests), the documentation UI is accessible directly,
while interactive endpoint execution is secured via Swagger's native `addApiKey` (Authorize 🔒)
configuration. Every API call made through Swagger or external clients strictly enforces the
`AdminApiKeyGuard` using SHA-256 hashing and `timingSafeEqual()` comparisons. Verified:
all protected endpoints return `401 Unauthorized` without the key, and execute successfully
with the valid key provided.

---

## 11. Known Gaps & Future Work

Updated from the original report — several previous gaps are now closed
(Vault dev mode, forum per-user rate limiting, centralized logging); what
remains open:

- **Container hardening** — `no-new-privileges`, `read_only` filesystems
  where feasible, not yet applied across services.
- **Rate limit reset test (Test 12)** — verifying that a successful login
  clears the failed-attempt counter for a real account remains dependent on
  the registration flow being fully exercised in a test environment; not a
  rate-limiting defect, a test-coverage gap.
- **nginx DNS caching** (Section 9) — accepted trade-off, structural fix
  identified but not applied, given the project's scope and timeline.
- **Elasticsearch/WAF-audit data has no backup** — by design: ILM already
  caps its useful lifetime at 14 days, and it is operational/diagnostic data,
  not a system of record (see `docs/DISASTER_RECOVERY.md` §3).

---

## 12. Deliverables Produced

- `SECURITY_TESTING.md` — infrastructure security tests
- `RATE_LIMITING.md` — rate limiting design and implementation
- `RATE_LIMIT_TESTING.md` — rate limiting validation tests
- `NGINX_CONFIG.md` — nginx configuration reference
- `METRICS.md` — Prometheus metrics module
- `AUTH_HARDENING_REPORT.md` — authentication/secrets hardening pass
- `docs/logging/ILM.md` — Elasticsearch index lifecycle management
- `docs/DISASTER_RECOVERY.md` — backup restore and disaster recovery procedures
- `SECURITY_REPORT.md` (this document) — consolidated overview
- Working `RateLimiterService` (NestJS, reused across login, forum, and the Admin Public API)
- `backend_migrate` and `backend_seed` services (automated, ordered database setup)
- `elasticsearch_ilm_init` and `kibana_user_init` services (automated, idempotent ELK configuration)
- Hardened Vault deployment (real init/unseal, TLS, persisted AppRole credentials)
- Aggregated health check (`/health`, `/health/status`) and standalone status page
- Corrected `Makefile` (decoupled routine builds from full cache resets)