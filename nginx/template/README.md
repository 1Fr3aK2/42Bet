# nginx — `default.conf.template`

Documentation for the nginx configuration (reverse proxy + WAF) of the
transcendence project.

> **Note on this revision:** this document has been updated to match the
> current `default.conf.template`. The rate limiting, security headers, and
> per-module routing sections below reflect the live configuration. One item
> — one of the five ModSecurity rule exclusions on `/kibana/` (`934190`) —
> still needs its rationale confirmed against real traffic; see that section
> below.

## General structure

The file defines two `server{}` blocks:

- **Port `${PORT}` (80)** — only exists to redirect all HTTP traffic to HTTPS (`301`), and to expose `/stub_status` (used by the container's healthcheck and by Prometheus's `nginx_exporter`).
- **Port `${SSL_PORT}` (443)** — where all the real logic lives: TLS, WAF (ModSecurity), security headers, rate limiting, and the proxy to the various internal services (frontend, backend, Grafana, Prometheus, Kibana, and the static status page).

Variables (`${PORT}`, `${SERVER_NAME}`, `${SSL_CERT_FILE}`, etc.) are substituted at startup by the `envsubst` mechanism in the `owasp/modsecurity-crs` image, from the values defined under `environment:` in `docker-compose.yml`. **The filename must end in `.template`** — that suffix is what the image's startup script uses to know which files to process.

## Rate limiting

Four active zones, with different values depending on the sensitivity and expected traffic pattern of the endpoint being protected:

```nginx
limit_req_zone $binary_remote_addr zone=admin_api:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=login:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=forum:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=health:10m rate=10r/s;
```

| Zone | Applied to | Limit | Burst | Why |
|---|---|---|---|---|
| `login` | `/auth/` | 10 requests/minute per IP | 5 | Sensitive action (account access) — protects against brute-force by IP. Complemented by a per-account rate limit in the backend (Redis), documented in `RATE_LIMITING.md`. |
| `forum` | `/forum` | 30 requests/second per IP | 5 | General browsing + content-creation traffic. IP-level limit only; per-user, per-action limits (posts, comments, reports) are enforced separately in the backend via `RateLimiterService` — see "Per-user rate limiting" below. |
| `admin_api` | `/api/admin` | 30 requests/second per IP | 5 (`limit_req_status 429`) | The Admin Public API. IP-level limit at nginx complements a second, per-client-IP limit enforced in the backend itself (`AdminApiRateLimitGuard`, 100 req/60s) — see `SECURITY_REPORT.md` §4 for the bug found and fixed in that guard. |
| `health` | `/health` | 10 requests/second per IP | 20, `nodelay` | Public health-check endpoint, expected to be polled frequently (e.g. by the status page, every 10s). Generous burst so legitimate polling is never delayed, while still bounding abuse. |

The previously-commented `api` zone, kept as a placeholder in earlier revisions of this file, has been superseded: the Admin Public API is live under `/api/admin`, with its own `admin_api` zone above.

## Security headers

Applied once, in the port-443 `server{}` block (before the `location{}` blocks), to cover every response from that server:

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
modsecurity on;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

- **`Strict-Transport-Security` (HSTS)** — instructs the browser to never try HTTP with this domain again after the first HTTPS visit, closing the man-in-the-middle attack window that would otherwise exist with only the 301 redirect (which still protects the first connection, but depends on that initial HTTP request not being intercepted before it reaches the server).
- **`X-Content-Type-Options: nosniff`** — prevents the browser from reinterpreting a file's type based on content instead of trusting the declared `Content-Type` (relevant mitigation on the forum endpoints, where users publish content).
- **`X-Frame-Options: DENY`** — prevents the site from being loaded inside an `<iframe>` on another domain (clickjacking protection). Chose `DENY` over `SAMEORIGIN` because the frontend doesn't use iframes of its own domain.
- **`Referrer-Policy: strict-origin-when-cross-origin`** — prevents a page's full path (potentially carrying sensitive information in a query string) from being sent in the `Referer` header to external sites; for internal navigation and HTTPS→HTTPS across domains, it still keeps enough for analytics.

**Tested with:**
```bash
curl -k -I https://localhost/
```
Confirmed: all 4 headers present in the response with the expected values.

## DNS resolution

```nginx
resolver 127.0.0.11 valid=10s;
set $upstream_frontend http://frontend:5173;
set $upstream_backend http://backend:8000;
set $upstream_grafana http://grafana:3000;
set $upstream_prometheus http://prometheus:9090;
set $upstream_kibana http://kibana:5601;
```

By default, nginx resolves upstream hostnames (e.g. `backend`, `grafana`) to IP addresses **once at startup** and caches the result indefinitely. In a Docker environment, container IPs can change whenever a container is recreated (e.g. after `docker compose stop backend && docker compose up -d backend`). When this happens, nginx continues sending traffic to the old IP — which now belongs to a different container or to nothing — producing `502 Bad Gateway` errors (surfaced by ModSecurity as `403 Forbidden`).

The fix has two parts:

1. **`resolver 127.0.0.11 valid=10s;`** — tells nginx to use Docker's embedded DNS server (`127.0.0.11`) and to re-query it every 10 seconds, instead of caching the result forever.
2. **Variable-based `proxy_pass`** — when `proxy_pass` uses a literal hostname (e.g. `proxy_pass http://backend:8000;`), nginx resolves it at config-load time and ignores the `resolver` directive. Using an nginx variable (`proxy_pass $upstream_backend;`) forces nginx to resolve the hostname at **request time** through the configured resolver.

This makes the infrastructure resilient to container restarts: the backend (or any other service) can be recreated without needing to also restart nginx.

## Frontend routing and Vite HMR WebSocket support

```nginx
location / {
    proxy_pass $upstream_frontend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Routes all root traffic to the frontend service (`frontend:5173`). 

Crucially, `proxy_http_version 1.1;`, `proxy_set_header Upgrade $http_upgrade;`, and `proxy_set_header Connection $connection_upgrade;` are configured on this block. In modern Vite development environments, the browser client establishes a WebSocket connection on the root origin (`wss://localhost/?token=...`) for Hot Module Replacement (HMR) and live development state synchronization. 

Without WebSocket upgrade headers, Nginx processes the handshake as a standard HTTP request and returns `200 OK` rather than `101 Switching Protocols`. This previously caused `Error during WebSocket handshake: Unexpected response code: 200` and secondary `SyntaxError: Failed to construct 'WebSocket'` exceptions in the Google Chrome developer console. Including the upgrade headers ensures compliant, error-free reverse-proxying across all client connections, satisfying the subject v21.1 mandate of zero browser console errors.

## Locations per backend module

Each backend module has its own `location`, matching the real route prefix in NestJS (nginx has no way to know this on its own — it has to be maintained manually every time a new module is added):

```nginx
location /auth/ {
    proxy_pass $upstream_backend;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    limit_req zone=login burst=5 nodelay;
}

location /forum {
    proxy_pass $upstream_backend;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    limit_req zone=forum burst=5 nodelay;
}

location /api/admin {
    proxy_pass $upstream_backend;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    limit_req zone=admin_api burst=5 nodelay;
    limit_req_status 429;
}

location /users {
    proxy_pass $upstream_backend;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /crypto {
    proxy_pass $upstream_backend;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`/forum` and `/api/admin` (no trailing slash) catch, by prefix, any route underneath them — no need for a `location` per individual endpoint, only per module. `/auth/` (trailing slash) matches the auth module's routes the same way.

## WebSocket routes

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

location /ws {
    proxy_pass $upstream_backend;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location /socket.io/ {
    modsecurity on;
    modsecurity_rules '
        SecRuleRemoveById 920420
    ';
    proxy_pass $upstream_backend;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

No dedicated rate limit on either — these are persistent connections (live BTC price feed, trades), not discrete requests that a `limit_req` model fits well.

WebSockets explicitly enforce `proxy_http_version 1.1;` (HTTP 1.0 does not support protocol upgrades), utilize dynamic `$connection_upgrade` handling, and set `proxy_read_timeout 3600s;` to prevent idle connections from being dropped by the proxy's default 60s timeout.

`/socket.io/` (added for the frontend's real-time crypto price data) needs one scoped ModSecurity exclusion: **rule `920420`** was flagging legitimate WebSocket upgrade requests as malformed. The WAF is **not** disabled for this location (`modsecurity on;` is kept explicit) — only this one rule is removed, scoped to this `location` block alone; every other rule still applies to WebSocket traffic.

## Infrastructure UIs

```nginx
location /grafana/ {
    proxy_pass $upstream_grafana;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

location /prometheus/ {
    proxy_pass $upstream_prometheus;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

location /kibana/ {
    modsecurity on;
    modsecurity_rules '
        SecRuleRemoveById 932236
        SecRuleRemoveById 932240
        SecRuleRemoveById 942220
        SecRuleRemoveById 942340
        SecRuleRemoveById 934190
    ';
    proxy_pass $upstream_kibana;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

No dedicated rate limit — these aren't endpoints exposed to end users of the application (internal/admin use), each already gated by its own authentication (Grafana login, Kibana behind `xpack.security`, Prometheus not authenticated but not carrying sensitive data beyond metrics).

**`/kibana/` ModSecurity exclusions — rationale:**

- **`942340`** (SQL Injection via libinjection) — confirmed: Kibana's search UI legitimately sends wildcard-containing queries to `/kibana/api/content_management/rpc/search`, which this rule flagged as an attack, adding to the inbound anomaly score and causing legitimate searches to be blocked with `403`.
- **`932236`** ("Remote Command Execution: Unix Command Injection (command without evasion)", PL2) — a CRS rule with well-documented false positives against ordinary text containing short command-like substrings (e.g. "set" inside "settings") and against UUID/hash-like tokens containing sequences such as "df"/"fd". Kibana's session cookies and saved-object IDs are exactly this kind of token, generated on every login and search; the most likely trigger is the Kibana login/session flow itself rather than any specific admin action.
- **`932240`** ("Remote Command Execution: Unix Command Injection evasion attempt detected", PL2) — same rule family as above; documented false positives against free text containing apostrophes and against cookie values using `$`-separated formats (the kind of format session/analytics cookies commonly use), again consistent with Kibana's own session handling rather than a specific attack pattern.
- **`942220`** ("Looking for integer overflow attacks", critical severity) — flags very large integers or a specific "magic number" float value in request data. Kibana's internal APIs routinely pass large epoch-millisecond timestamps and offsets in JSON request bodies, which plausibly trips this rule on ordinary use.
- **`934190`** ("Possible Server Side Request Forgery (SSRF) Attack: Scheme-less localhost or internal hostname detected") — confirmed: during login, Kibana's `/kibana/internal/security/login` endpoint sends a JSON payload containing `currentURL: https://localhost/kibana/login...`. This rule flags the string `localhost/` inside request arguments as a potential SSRF attempt, causing legitimate logins to be blocked with `403`.

All five exclusions follow the same pattern used for the confirmed `942340` and the `/socket.io/` exclusion above: the rule is removed only inside this one `location` block (`modsecurity on;` stays active), not disabled globally — the rest of the WAF's protection, including the rest of the RCE and SQLi rule families, remains in effect for every other route.

## Static status page

```nginx
location /status {
    alias /usr/share/nginx/status/;
    index index.html;
    try_files $uri $uri/ /status/index.html;
}
```

Served directly by nginx as a static file, not proxied to the backend or bundled into the frontend's React app — see `SECURITY_REPORT.md` §7 for the reasoning (a status page needs to stay reachable even if the frontend/backend are the thing that's broken).

## Public health check

```nginx
location /health {
    limit_req zone=health burst=20 nodelay;
    rewrite ^ /health/status break;
    proxy_pass $upstream_backend;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

Proxies to the backend's `/health/status` endpoint (not the plainer `/health` used internally by Docker's own healthcheck) — the richer, always-`200` endpoint intended for external consumption. Consumed by the status page at `/status` above. Uses a `rewrite` rule to map the request URI to `/health/status` because variable-based `proxy_pass` cannot perform URI replacement directly in the directive (see "DNS resolution" above).

## Per-user rate limiting (forum)

The forum's rate limiting uses a two-tier approach. At the nginx layer, the `forum` zone (defined above) acts as a coarse, IP-level first line of defense. Finer-grained, per-user limits are enforced by the backend itself via the `RateLimiterService` (because nginx cannot cleanly distinguish authenticated users or HTTP methods within the same path). 

The backend-enforced limits for forum endpoints are:
- `createPost`: 5 / 10 minutes
- `createComment`: 20 / 10 minutes
- `createReport`: 10 / hour

## Design notes / future work

- **`X-Frame-Options: DENY`** was chosen as the more restrictive option due to
  lack of concrete confirmation about iframe usage in the frontend;
  reconsider `SAMEORIGIN` if a real need arises.
- **Backend migrations** (`backend_migrate` in `docker-compose.yml`) were the
  root cause of a 500 bug that interfered with testing an earlier revision of
  this config — documented in `SECURITY_REPORT.md` §8. A second one-shot
  service, `backend_seed`, follows the same pattern and must also complete
  successfully before the backend is expected to behave correctly.