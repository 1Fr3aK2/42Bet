# WAF/ModSecurity Hardening (`nginx/modsecurity/`)

This document describes hardening the WAF for the "WAF/ModSecurity (hardened)
+ HashiCorp Vault for secrets" module (the WAF half — see `VAULT_PRODUCTION.md`
for the Vault half).

## Overview

The project uses the `owasp/modsecurity-crs:4-nginx` image, which bundles
Nginx, ModSecurity, and the OWASP Core Rule Set (CRS). Out of the box it runs
with `PARANOIA=1`, the CRS's most permissive detection level — enough to be
"a WAF exists", but not enough to be considered hardened.

## What changed

```yaml
environment:
  PARANOIA: "2"
  BLOCKING_PARANOIA: "2"
volumes:
  - ./nginx/modsecurity/before-crs.conf:/etc/modsecurity.d/owasp-crs/rules/REQUEST-900-EXCLUSION-RULES-BEFORE-CRS.conf
```

- **`PARANOIA` / `BLOCKING_PARANOIA` raised to 2** — the CRS distinguishes
  detection level (what's evaluated/logged) from blocking level (what's
  actually rejected); both were set to 2. Level 3 was considered but
  rejected as likely overkill for this project's scope, generating
  significantly more false positives for marginal extra protection.
- **`REQUEST-900-EXCLUSION-RULES-BEFORE-CRS.conf`** and
  **`RESPONSE-999-EXCLUSION-RULES-AFTER-CRS.conf`** are placeholder files the
  CRS itself expects to be overridden for local exclusions — one for rules
  that must run *before* the CRS loads (e.g. setting `tx.allowed_methods`),
  one for rules that run *after* (e.g. `SecRuleRemoveById`). Using these,
  rather than editing the CRS's own rule files, keeps customizations isolated
  and upgrade-safe. **This project only overrides the first one**
  (`before-crs.conf`); the `RESPONSE-999-...` placeholder keeps the image's
  default content because every exclusion in use is a runtime exclusion (see
  the next section).

### Which file does an exclusion go in?

There are two kinds of exclusion, and the kind decides the file:

| Kind | Examples | File | Why |
|------|----------|------|-----|
| **Runtime** (a `SecRule` with a `ctl:` action) | `ctl:ruleRemoveTargetById`, `ctl:ruleRemoveTargetByTag` | `before-crs.conf` | Runs during the request (phase 1) and must fire *before* the CRS rule it targets is evaluated (phase 2). It can be conditioned on the request (URI, method), so the exclusion can be limited to one route. |
| **Configuration-time** (a directive) | `SecRuleUpdateTargetById`, `SecRuleRemoveById` | `RESPONSE-999-EXCLUSION-RULES-AFTER-CRS.conf` (**not used by this project at the moment**) | Edits a rule that is **already loaded**, so it must come after the CRS. Placed before the CRS, the target rule does not exist yet, so the directive errors out or has no effect. It cannot be conditioned on the request: it applies to every route. |

The Kibana `sid` cookie exclusion is a runtime rule precisely because of the
last point: a configuration-time directive cannot be limited to `/kibana`, the
`ctl:` action can (see the Kibana section below). If a future exclusion must be
a configuration-time directive, mount a file on
`RESPONSE-999-EXCLUSION-RULES-AFTER-CRS.conf`.

### Local rule IDs in use

| ID        | Purpose                                              |
|-----------|------------------------------------------------------|
| `900200`  | Allowed HTTP methods (REST)                          |
| `1000001` | Base64 avatar exclusion (`PATCH /users/me`)          |
| `1000002` | PromQL exclusion for Grafana (`POST /grafana/api/ds/query`, `queries.array_0` and `array_1`) |
| `1000003` | *(Removed)* Former PromQL exclusion for `/prometheus/api/v1/` (endpoint now returns 404) |
| `1000004` | Forum text fields exclusion (`/forum/`)              |
| `1000005` | Kibana session cookie exclusion (`/kibana`, rule `942440`, `REQUEST_COOKIES:sid`) |
| `1000006` | Grafana userstorage `history` field exclusion (`/grafana/apis/userstorage.grafana.app/`, `ARGS:json.spec.data.history`) |
| `1000007` | Extra allowed Content-Type `application/merge-patch+json` (same path only, rule `920420`) |
| `1000008` | Grafana `Referer` header: SQL-injection and command-injection groups excluded on `/grafana/` requests only (page state in the URL) |
| `1000009` | Grafana Explore `panes` argument: SQL-injection and command-injection groups excluded on `/grafana/explore` only (reload with F5) |
| `1000010` | Grafana Explore query history: PromQL field of `POST /grafana/api/query-history` (`queries.array_0.expr`) |
| `1000011` | Kibana login `currentURL` field: rule `920230` only, on `/kibana/internal/security/login` (`ARGS:json.currentURL`) |
| `1000012` | Kibana internal API and query exclusions: rules `932236`, `932240`, `942220`, `942340`, `934190` on `/kibana/` |
| `1000013` | Socket.IO WebSocket/polling exclusion: rule `920420` on `/socket.io/` |

### Configuration-time exclusions in use

None. Every exclusion in use is a runtime rule in `before-crs.conf`.

## `before-crs.conf` — allowing REST methods

```apache
SecAction \
  "id:900200,\
  phase:1,\
  nolog,\
  pass,\
  t:none,\
  setvar:'tx.allowed_methods=GET HEAD POST OPTIONS PATCH PUT DELETE'"
```

The CRS's method-enforcement rule (`911100`) only allows
`GET HEAD POST OPTIONS` by default. This project's REST API relies on
`PATCH` (e.g. `PATCH /forum/posts/:id`, `PATCH /forum/reports/:id/resolve`)
and would need `DELETE`/`PUT` too, so without this exclusion every
partial-update endpoint was rejected by the WAF before it ever reached the
backend. `id:900200` is a locally-chosen ID inside the CRS's reserved range
for custom rules (900000–900999), avoiding collisions with CRS rule IDs.

This is a WAF-level allowance only — it does not grant any application
permission. Whether a specific user is allowed to edit or delete a specific
post is authorization logic that belongs to (and is enforced by) the
backend, not the WAF. The WAF only decides whether the HTTP method is
permitted to exist for this API at all.

## `before-crs.conf` — Base64 Avatar Upload Exclusion

```apache
SecRule REQUEST_METHOD "@streq PATCH" \
  "id:1000001,\
  phase:1,\
  nolog,\
  pass,\
  t:none,\
  chain"
  SecRule REQUEST_URI "@rx ^/users/me(/|\?|$)" \
    "t:none,\
    ctl:ruleRemoveTargetById=934170;ARGS:json.avatar,\
    ctl:ruleRemoveTargetById=941130;ARGS:json.avatar,\
    ctl:ruleRemoveTargetById=941170;ARGS:json.avatar,\
    ctl:ruleRemoveTargetById=932235;ARGS:json.avatar,\
    ctl:ruleRemoveTargetById=932236;ARGS:json.avatar,\
    ctl:ruleRemoveTargetById=932260;ARGS:json.avatar,\
    ctl:ruleRemoveTargetByTag=attack-sqli;ARGS:json.avatar,\
    ctl:ruleRemoveTargetByTag=attack-xss;ARGS:json.avatar,\
    ctl:ruleRemoveTargetByTag=attack-rce;ARGS:json.avatar"
```

A base64 data URL (`data:image/...;base64,...`) sent during profile updates
trips several CRS rules detecting PHP injection (`934170`), XSS data
attributes (`941130`, `941170`), and Unix command injection (`932235`,
`932236`, `932260`).

**v3 (final version):** the SQL-injection rules (tag `attack-sqli`, `942xxx`)
are also removed for `ARGS:json.avatar`. Random base64 text keeps matching
them: the `==` padding is read as an SQL operator (`942120`), and `+` (a space
once decoded) next to `OR` looks like an authentication bypass (`942340`,
`942200`, `942450`, `942210`, `942390`). Out of 200 random pictures sent before
this change, 40 were refused with `403`; after it, none. A later run of 30
showed that the XSS rules can match random base64 too (`941150` read `SRC`
followed by a `+` as an HTML attribute), so the XSS and command-injection groups
(tags `attack-xss`, `attack-rce`) are removed for this field as well: 300
random pictures then all passed. Removing whole groups instead of one id at a
time stops the whack-a-mole, as for the PromQL fields (see the next section).
It is safe because the backend accepts in this field only a PNG, JPEG, GIF or
WebP data URL made of base64 characters, at most 100 000 long
(`backend/src/users/user-rules.ts`), never builds SQL or runs anything from it,
and React only shows it in an `<img>`. A script or HTML payload in this field is
now refused by the backend (`400`) instead of the WAF. This exclusion touches no
other field or route.

**v2:** the original version of this exclusion used
`ctl:ruleRemoveById`, which disables the listed rules for the *entire*
request, not just the `avatar` field. Since `PATCH /users/me` also accepts
other fields (`username`, `email`), those rules were silently disabled for
them too. This was confirmed exploitable during a pentest pass: a `data:`
scheme + base64 payload (e.g. `data:text/html;base64,PHNjcmlwdD4=`) sent in
`username` or `email` was accepted (`200`) instead of blocked, before this
fix.

Fixed by scoping the exclusion to the specific field with
`ctl:ruleRemoveTargetById=<id>;ARGS:json.avatar` instead of
`ctl:ruleRemoveById=<id>`. Two things worth knowing if this is touched
again:

- The `json.` prefix matters: for JSON request bodies, ModSecurity names
  the variable `ARGS:json.<field>`, not `ARGS:<field>`. Using the latter
  silently has no effect — it was tried first and caused the *legitimate*
  avatar upload to be falsely blocked, because the target rules were never
  actually being excluded from anything.
- The `@rx ^/users/me(/|\?|$)` regex scoping to the one endpoint (handling
  trailing slash / query string) was correct from the start and needed no
  change — the gap was scoping *within* the request to the one field that
  needed it, not the endpoint matching itself.

No MIME-type validation is performed by this exclusion — it only stops the
WAF from flagging base64 noise as an attack. A `data:text/html;...` payload
sent as the `avatar` field itself still passes the WAF unblocked by design
(it's still base64-encoded "noise" to these rules). The application layer
validates that `avatar` is actually image data: since the final version,
`backend/src/users/user-rules.ts` accepts only PNG, JPEG, GIF or WebP data
URLs made of base64 characters, and refuses everything else with `400`.

## `before-crs.conf` — PromQL for the monitoring endpoints

```apache
SecRule REQUEST_METHOD "@streq POST" \
  "id:1000002,\
  phase:1,\
  nolog,\
  pass,\
  t:none,\
  chain"
  SecRule REQUEST_URI "@beginsWith /grafana/api/ds/query" \
    "t:none,\
    ctl:ruleRemoveTargetByTag=attack-sqli;ARGS:json.queries.array_0.expr,\
    ctl:ruleRemoveTargetByTag=attack-rce;ARGS:json.queries.array_0.expr,\
    ctl:ruleRemoveTargetByTag=attack-sqli;ARGS:json.queries.array_1.expr,\
    ctl:ruleRemoveTargetByTag=attack-rce;ARGS:json.queries.array_1.expr,\
    ctl:ruleRemoveTargetById=941380;ARGS:json.queries.array_0.legendFormat"

# Rule 1000003 was removed: /prometheus/ is no longer publicly proxied (returns 404).
# Grafana proxies all PromQL queries server-side via /grafana/api/ds/query (rule 1000002).
```

PromQL is a query language, not SQL or shell, but its operators and brackets
trip many CRS rules:

- `sum(rate(x[1m])) by (route)` matches `942150`, `942410` and `932240`
- `up == 0` matches `942120`
- `... * 100` matches `942370`
- Grafana legend templates such as `{{route}}` match the AngularJS
  template-injection rule `941380`

Without this exclusion, 4 of the 12 Grafana panels showed "No data" (the
WAF returned `403`) and common Prometheus queries were refused.

**Why by tag instead of by ID:** any PromQL operator can trip a different
rule, so listing IDs one by one would be a whack-a-mole. Instead, the
SQL-injection and command-injection groups (tags `attack-sqli` and
`attack-rce`) are removed, but only for the PromQL fields:

| Rule | Endpoint                         | Field excluded                          | What is removed            |
|------|----------------------------------|-----------------------------------------|----------------------------|
| `1000002` | `POST /grafana/api/ds/query` | `ARGS:json.queries.array_0.expr`        | `attack-sqli`, `attack-rce` |
| `1000002` | `POST /grafana/api/ds/query` | `ARGS:json.queries.array_1.expr`        | `attack-sqli`, `attack-rce` |
| `1000002` | `POST /grafana/api/ds/query` | `ARGS:json.queries.array_0.legendFormat`| rule `941380` only          |

*(Note: Rule `1000003` previously excluded `attack-sqli` and `attack-rce` on `/prometheus/api/v1/`. It was removed because `/prometheus/` is no longer publicly proxied by nginx and returns 404. Prometheus queries now only traverse the WAF through the authenticated Grafana proxy endpoint).*

What keeps this safe:

- **Field-scoped, not request-scoped.** Everything uses
  `ctl:ruleRemoveTarget...`, so every other field and route is still fully
  inspected by the whole CRS.
- **XSS and all other rule groups still inspect the PromQL fields.** Only
  `attack-sqli` and `attack-rce` are removed from them (and `941380` from
  `legendFormat`).
- **Grafana's endpoint requires a login**, so it is not reachable by an
  anonymous attacker. Direct Prometheus access from the outside is disabled (404).

Things worth knowing if this is touched again:

- The `array_0` in `json.queries.array_0.expr` is how ModSecurity names the
  first element of the `queries` JSON array. A dashboard panel sends one query
  (`array_0`). Grafana Explore sends the same query twice (range and instant,
  `Type: Both`), so `array_1` is covered too. A request with more queries
  (`array_2`, ... for example Explore with several queries added) would have the
  extra ones still inspected and could be blocked again: read the target in the
  audit log and extend the list, do not add targets that were not seen.
- The `json.` prefix matters here for the same reason as in the avatar
  exclusion (see above).

## `before-crs.conf` — ordinary sentences in the forum

```apache
SecRule REQUEST_URI "@beginsWith /forum/" \
  "id:1000004,\
  phase:1,\
  nolog,\
  pass,\
  t:none,\
  ctl:ruleRemoveTargetByTag=attack-rce;ARGS:json.title,\
  ctl:ruleRemoveTargetByTag=attack-rce;ARGS:json.content,\
  ctl:ruleRemoveTargetByTag=attack-rce;ARGS:json.reason,\
  ctl:ruleRemoveTargetByTag=attack-rce;ARGS:json.note,\
  ctl:ruleRemoveTargetByTag=attack-rce;ARGS:search,\
  ctl:ruleRemoveTargetByTag=attack-sqli;ARGS:json.title,\
  ctl:ruleRemoveTargetByTag=attack-sqli;ARGS:json.content,\
  ctl:ruleRemoveTargetByTag=attack-sqli;ARGS:json.reason,\
  ctl:ruleRemoveTargetByTag=attack-sqli;ARGS:json.note,\
  ctl:ruleRemoveTargetByTag=attack-sqli;ARGS:search"
```

Posts, comments, reports, moderation notes and the search box hold ordinary
sentences, and at paranoia level 2 ordinary sentences keep tripping the
command-injection and SQL-injection rules:

- a sentence that starts with a word that is also a Unix command ("Find the
  best strategy", "Top 3 tips", "Watch the ETH price") matches `932236` or
  `932260`
- a comparison such as "Patience > luck" or "if (price > yesterday)" matches
  SQL-injection rules

Without this exclusion, 40 of 91 ordinary forum texts (posts, comments,
reports and searches) were refused with `403`; with it, none. The fields are
`json.title` and `json.content` (posts and comments), `json.reason` (reports),
`json.note` (moderator notes) and `search` (the search box).

What keeps this safe:

- **Field-scoped, not request-scoped**, as for PromQL: the forum's other
  parameters (`page`, `sortBy`, `authorId`, ...) and every other route keep
  every rule.
- **XSS and all other rule groups still inspect these fields.** `<script>`,
  `onerror=` and `javascript:` payloads are still refused with `403`.
- **These fields are only stored, searched and shown.** The backend runs no
  shell, Prisma sends them to PostgreSQL as query parameters, and React
  escapes them on display.

## `before-crs.conf` — Kibana session cookie

```apache
# Rule 942440 (SQL comment sequence) false positive on Kibana's session cookie.
# The 'sid' value is a random Iron token (base64url), which can contain '--'
# by chance. The cookie is set with Path=/kibana, so the exclusion is limited
# to that route. Only the cookie target is excluded; the rule stays active
# for every other cookie, argument and route.
SecRule REQUEST_URI "@rx ^/kibana(/|\?|$)" \
  "id:1000005,\
  phase:1,\
  nolog,\
  pass,\
  t:none,\
  ctl:ruleRemoveTargetById=942440;REQUEST_COOKIES:sid"
```

**Symptom:** after logging in to Kibana (`/kibana`) and using other services
(e.g. `/grafana`), going back to `/kibana` returned an nginx `403 Forbidden`
page. The login itself (`POST /kibana/internal/security/login`) succeeded;
the block hit the next request, `GET /kibana/spaces/enter`. The error was
intermittent: it depended on the session token Kibana happened to issue.

**Cause:** the block came from the WAF, not from Kibana or authentication.
The audit log (`/var/log/modsecurity/audit.log`, same `unique_id` as the
blocked request) showed a single rule matching, `942440` (*SQL Comment
Sequence Detected*, severity CRITICAL = 5 points), which reached the inbound
anomaly threshold of 5 on its own and triggered `949110`. The matched data was
a `--` inside the value of the `sid` cookie.

Kibana's `sid` is an Iron token (`Fe26.2**...`), made of random base64url
text. The base64url alphabet contains `-`, so any token can contain `--` by
chance, and the rule reads that as the start of an SQL comment. Rule `942440`
already skips values that look like a plain token or JWT, but the Iron format
(with `*` and `.` separators) does not fit that pattern. The rule only runs
at paranoia level 2 (`PARANOIA: "2"`); at level 1 it would not fire.

**Why a runtime rule in `before-crs.conf`:** a configuration-time directive
(`SecRuleUpdateTargetById 942440 "!REQUEST_COOKIES:sid"`) would also remove the
cookie target, but it is path-independent: it would exclude a cookie named
`sid` on *any* route, because a directive cannot be conditioned on the URI.
Rule `1000005` uses `ctl:ruleRemoveTargetById`, which only applies to the
transactions that match the rule's condition. It runs in phase 1 (cookies are
already available) and therefore fires before `942440`, which is evaluated in
phase 2. That is also why it lives in `before-crs.conf`: `ctl` only affects
rules that have not been evaluated yet.

**Why only the cookie:** `SecRuleRemoveById 942440` would disable SQL comment
detection everywhere (every argument, body and header). The
`REQUEST_COOKIES:sid` target only removes that one variable from the list the
rule inspects; the rule stays fully active for every other cookie, parameter
and body field, including inside `/kibana`.

**Why the `@rx` and not `@beginsWith`:** `@rx ^/kibana(/|\?|$)` matches
`/kibana`, `/kibana/...` and `/kibana?...`, but not `/kibana-x/`. A
`@beginsWith /kibana` would also exclude routes that merely start with that
text. It is the same pattern used for `/users/me` in rule `1000001`.

What keeps this safe:

- **Target-scoped, not rule-scoped.** Only `REQUEST_COOKIES:sid` is excluded
  from `942440`; all other CRS rules still inspect the `sid` cookie.
- **Route-scoped.** The exclusion only applies under `/kibana`, where the
  cookie is set (`Path=/kibana`). A `sid` cookie sent to any other route is
  still inspected by `942440`.
- **The value is not attacker-controlled input to a query.** `sid` is an
  encrypted, signed session token. Kibana decrypts and validates it, and
  never uses it to build SQL.

Things worth knowing if this is touched again:

- If another service under `/kibana` (or a change to Kibana's base path)
  starts using different cookie names that trip `942440`, add a separate
  target; do not widen the regex.
- **Near miss (resolved by rule `1000011`, next section):**
  `POST /kibana/internal/security/login` also triggered `920230` (*Multiple
  URL Encoding Detected*, severity WARNING = 3 points) because of the `%2F` in
  `currentURL`. It did not block on its own (3 < 5), but any other rule of 2
  points or more on the same request would have.
- Rules are only read at startup: `docker compose restart nginx` after any
  change to `before-crs.conf`.
- When testing with `curl`, `--` alone does not trigger `942440`. Use `-- `
  (two hyphens followed by a space), e.g. `Cookie: sid=abc-- def`, and confirm
  in the audit log that the rule fired. A `403` from another rule proves
  nothing about this exclusion.

## `before-crs.conf` — Kibana login (`currentURL`)

```apache
# Rule 920230 (multiple URL encoding) false positive on the Kibana login.
# POST /kibana/internal/security/login sends 'currentURL', built by the Kibana
# frontend, e.g. "https://localhost/kibana/login?next=%2Fkibana%2F". The "%2F"
# is a legitimate encoded slash, but 920230 reads it as double encoding (3
# points), leaving the login one small rule away from a 403. Only this rule is
# disabled, ONLY for this field, ONLY on the login path. Every other rule still
# inspects it, and 920230 stays active for every other field and route.
SecRule REQUEST_URI "@beginsWith /kibana/internal/security/login" \
  "id:1000011,\
  phase:1,\
  nolog,\
  pass,\
  t:none,\
  ctl:ruleRemoveTargetById=920230;ARGS:json.currentURL"
```

**Symptom:** none visible. The Kibana login returned `200`, so nothing was
blocked. The problem was a *latent* one, found in the audit log: every login
logged a match of rule `920230` on `ARGS:json.currentURL`.

**Cause:** the login body is JSON and carries `currentURL`, a value built by
the Kibana frontend from the address of the login page, for example
`https://localhost/kibana/login?next=%2Fkibana%2F`. The `next` argument holds
the page to return to after the login, with its slashes encoded as `%2F`. The
WAF decodes the JSON body and the value still contains a `%XX` sequence, which
rule `920230` (*Multiple URL Encoding Detected*, WARNING = 3 points) reads as
double URL encoding. Alone it stays below the blocking threshold of 5, so the
request passes.

**Why it was still worth fixing:** the margin is only 2 points. Any other
rule of 2 points or more matching the same request (for example a NOTICE in a
credential or header field) would push the total to 5 and the login of Kibana
would start returning `403` for no visible reason. The score of a request is
the sum of everything that matched, so a harmless match today is a blocked
login tomorrow.

**Why this is a false positive and not an attack:** the field is generated by
the Kibana frontend, not typed into a form, and the encoded slash is the normal
way to put a path inside a query argument. Rule `920230` is a protocol rule
(encoding anomalies); it is not one of the injection groups, and the backend
does not build SQL or run commands from `currentURL`.

**Fix:** rule `1000011` removes only rule `920230` (`ctl:ruleRemoveTargetById`)
and only the target `ARGS:json.currentURL`, and only when the URI starts with
`/kibana/internal/security/login`. It uses a rule id and not a tag because the
cause is one specific rule on one specific field (a tag would be the right
choice if the content could trip any rule of a group, as with PromQL). It lives
in `before-crs.conf` as a runtime rule for the same reason as `1000005`: `ctl`
must run before `920230` is evaluated.

What keeps this safe:

- **Target-scoped and rule-scoped.** Only `920230` is removed, and only from
  `ARGS:json.currentURL`. Every other CRS rule (SQL injection, XSS, command
  injection, ...) still inspects `currentURL`.
- **Path-scoped.** Only the login endpoint is affected. `920230` stays active
  for every other field of the same request (`providerName`, `providerType`,
  `params`) and for every other route.
- **The value is not used to build SQL or run commands.** It is a redirect
  hint produced by the Kibana frontend, and the endpoint requires valid
  credentials to do anything with it.

Things worth knowing if this is touched again:

- The field is `ARGS:json.currentURL` (`json.` prefix, as in the avatar
  exclusion). Without the prefix the rule does nothing.
- If the audit log shows `920230` on another field of this login request, do
  not extend this rule: that would be a different value and needs its own
  analysis.
- `@beginsWith` is enough here because the endpoint is a fixed path.

## `before-crs.conf` — Kibana internal API traffic (Rule 1000012)

```apache
SecRule REQUEST_URI "@rx ^/+kibana(/|\?|$)" \
  "id:1000012,\
  phase:1,\
  nolog,\
  pass,\
  t:none,\
  ctl:ruleRemoveById=932236,\
  ctl:ruleRemoveById=932240,\
  ctl:ruleRemoveById=942220,\
  ctl:ruleRemoveById=942340,\
  ctl:ruleRemoveById=934190"
```

**Symptom:** When navigating Kibana dashboards, saving objects, or running search filters, requests to internal Kibana APIs produced false positives under Paranoia Level 2.

**Cause:** Kibana's frontend communicates with its Node.js backend using internal query DSLs, Lucene expressions, complex nested JSON states, and URL parameters. Several CRS rules match harmless query fragments:
- `932236`, `932240`: Unix command injection patterns matched in internal query structures, session tokens, and variables.
- `942340`: SQL injection via libinjection matched in search queries and filter DSLs containing wildcards or quotes.
- `942220`: Integer overflow detection triggered by large epoch millisecond timestamps and numeric offsets.
- `934190`: Server-Side Request Forgery (SSRF) detection triggered by scheme-less `localhost/` inside `currentURL` redirection hints.

Previously, these were disabled via inline `modsecurity_rules` inside Nginx's `location /kibana/` block. Migrating them to rule `1000012` in `before-crs.conf` brings all WAF customizations into a single, versioned, runtime exclusion file.

**Fix:** Rule `1000012` disables these five specific rules for requests whose URI path starts with `/kibana` using `@rx ^/+kibana(/|\?|$)` (matching multiple leading slashes to mirror Nginx URI normalization).

What keeps this safe:
- **Scope limited to `/kibana/`.** These five rules remain fully active for all other routes (frontend, backend, forum, auth, admin API).
- **Other CRS rules remain active on Kibana.** XSS rules (941xxx), Local File Inclusion, Remote File Inclusion, and scanner detection continue to inspect all Kibana requests.
- **Kibana is authenticated.** Direct public access without valid Elasticsearch/Kibana credentials cannot reach internal Kibana management functions.
- **Dedicated exclusions remain intact.** Specific targets continue to have surgical overrides (`1000005` for the `sid` cookie, `1000011` for `currentURL`).

## `before-crs.conf` — Socket.IO traffic (Rule 1000013)

```apache
SecRule REQUEST_URI "@rx ^/+socket\.io(/|\?|$)" \
  "id:1000013,\
  phase:1,\
  nolog,\
  pass,\
  t:none,\
  ctl:ruleRemoveById=920420"
```

**Symptom:** Socket.IO connections (used by the frontend for live Kraken price feeds and real-time betting updates) failed during handshake and polling phases with `403 Forbidden`.

**Cause:** Socket.IO clients use a transport fallback sequence starting with HTTP long-polling (`GET`/`POST`) before upgrading to WebSockets. The client sends payload requests with non-standard Content-Type headers or parameter formats that trip CRS rule `920420` (*Request Content-Type is not allowed by policy*).

Previously, this was disabled via an inline `modsecurity_rules` block inside Nginx's `location /socket.io/`. Migrating it to runtime rule `1000013` in `before-crs.conf` brings all ModSecurity exclusions into the central, upgrade-safe exclusion file and eliminates inline Nginx WAF directives entirely.

**Fix:** Rule `1000013` disables only rule `920420` for requests whose URI starts with `/socket.io` using `@rx ^/+socket\.io(/|\?|$)`.

What keeps this safe:
- **Rule-scoped.** Only rule `920420` is bypassed. All other CRS inspection rules (SQLi, XSS, RCE, protocol violations) remain fully active on `/socket.io/` traffic.
- **Path-scoped.** Rule `920420` remains fully enforced on all other routes across the application.
- **WebSocket security preserved.** Inbound frames and payloads continue to be inspected by Phase 1 and Phase 2 rules.

## `before-crs.conf` — Grafana userstorage (page history)

```apache
SecRule REQUEST_URI "@beginsWith /grafana/apis/userstorage.grafana.app/" \
  "id:1000006,\
  phase:1,\
  nolog,\
  pass,\
  t:none,\
  ctl:ruleRemoveTargetByTag=attack-sqli;ARGS:json.spec.data.history,\
  ctl:ruleRemoveTargetByTag=attack-rce;ARGS:json.spec.data.history,\
  ctl:ruleRemoveTargetById=920230;ARGS:json.spec.data.history,\
  ctl:ruleRemoveTargetById=941330;ARGS:json.spec.data.history,\
  ctl:ruleRemoveTargetById=941340;ARGS:json.spec.data.history"
```

**Symptom:** normal Grafana pages produced `403` on
`/grafana/apis/userstorage.grafana.app/v0alpha1/namespaces/default/user-storage/...`
(`POST` and `PATCH`).

**Cause:** Grafana stores the pages the user visited in the `history` field of
that API. It is a list of URLs, so it holds quotes, `%XX` sequences and
characters such as `<` or `{`. The audit log showed SQL-injection and
command-injection rules, `920230` (multiple URL encoding) and two generic XSS
filters (`941330`, `941340`) matching that field.

**Fix:** the SQL-injection and command-injection groups (tags `attack-sqli`,
`attack-rce`) and the three rule ids are removed for
`ARGS:json.spec.data.history` only, and only on this path.

What keeps this safe:

- **Field-scoped and path-scoped.** Every other field of the endpoint, and
  every other route, keeps every rule.
- **The other XSS rules still inspect `history`.** A `<script>` payload in that
  field is still `403`.
- **The endpoint requires a Grafana login.**

Things worth knowing if this is touched again:

- The field is `ARGS:json.spec.data.history` (`json.` prefix, as in the avatar
  exclusion).
- `@beginsWith` is used because the API path is a fixed prefix with the
  namespace and record id after it.

## `before-crs.conf` — Grafana userstorage (Content-Type)

```apache
SecRule REQUEST_URI "@beginsWith /grafana/apis/userstorage.grafana.app/" \
  "id:1000007,\
  phase:1,\
  nolog,\
  pass,\
  t:none,\
  setvar:'tx.allowed_request_content_type=|application/x-www-form-urlencoded| |multipart/form-data| |text/xml| |application/xml| |application/soap+xml| |application/json| |application/merge-patch+json|'"
```

**Symptom:** `PATCH` requests to the userstorage API returned `403`.

**Cause:** Grafana updates the record with `Content-Type:
application/merge-patch+json` (Kubernetes-style API). Rule `920420` blocks any
type that is not in `tx.allowed_request_content_type`.

**Fix:** for this path only, the variable is set to the list above, which is
the default list plus `application/merge-patch+json`. Every other route keeps
the default list.

Things worth knowing if this is touched again:

- The list must contain every type of the image's default plus the new one,
  otherwise this path would refuse types it accepted before. Compare it with the
  default after an image upgrade:
  ```bash
  docker compose exec nginx sh -c 'grep -R "allowed_request_content_type" /etc/modsecurity.d/owasp-crs/crs-setup.conf /etc/modsecurity.d/owasp-crs/rules/REQUEST-901-INITIALIZATION.conf'
  ```
- `/etc/modsecurity.d/owasp-crs` is a symlink: use `grep -R`, not `grep -r`.

## `before-crs.conf` — Grafana Explore (Referer, `panes` and query history)

Grafana's Explore keeps its whole state in the page URL, in the `panes`
argument: `panes={"tea":{"datasource":"...","queries":[{"refId":"A","expr":"sum(rate(x[1m])) by (job)"}]}}`.
That state, and the PromQL in it, reaches the WAF in three places, and the
SQL-injection and command-injection rules read it as an attack each time. Three
rules, one per place.

```apache
SecRule REQUEST_URI "@beginsWith /grafana/" \
  "id:1000008,\
  phase:1,\
  nolog,\
  pass,\
  t:none,\
  ctl:ruleRemoveTargetByTag=attack-sqli;REQUEST_HEADERS:Referer,\
  ctl:ruleRemoveTargetByTag=attack-rce;REQUEST_HEADERS:Referer"

SecRule REQUEST_URI "@rx ^/grafana/explore(/|\?|$)" \
  "id:1000009,\
  phase:1,\
  nolog,\
  pass,\
  t:none,\
  ctl:ruleRemoveTargetByTag=attack-sqli;ARGS:panes,\
  ctl:ruleRemoveTargetByTag=attack-rce;ARGS:panes"

SecRule REQUEST_URI "@beginsWith /grafana/api/query-history" \
  "id:1000010,\
  phase:1,\
  nolog,\
  pass,\
  t:none,\
  ctl:ruleRemoveTargetByTag=attack-sqli;ARGS:json.queries.array_0.expr,\
  ctl:ruleRemoveTargetByTag=attack-rce;ARGS:json.queries.array_0.expr"
```

Together with the `array_1` target of rule `1000002` (previous section), these
make Explore with Prometheus usable.

**Symptoms and causes**

| Rule | Symptom | Rules seen in `audit.log` | Variable |
|---|---|---|---|
| `1000008` | Explore gave `403` on the files the page loads (`react-monaco-editor.*.js`/`.css`, `login/ping`, `datasources/.../resources/...`); the editor showed "React Monaco Editor failed to load" | `942200`, `942370`, `932206`, `932240` | `REQUEST_HEADERS:referer` |
| `1000009` | Reloading Explore (F5) gave `403` | `942200`, `942340`, `942370`, `942430`, `932240` | `ARGS:panes` |
| `1000010` | Running a query gave "Query error 403": Explore also saves it in the history | `932240`, `942150`, `942410`, `942120`, `942131` | `ARGS:json.queries.array_0.expr` |

The browser sends the Explore URL as the `Referer` of every request the page
makes (`1000008`) and sends it again as a query argument on reload (`1000009`).
The query itself is sent to `/grafana/api/ds/query` (rule `1000002`, targets
`array_0` and `array_1`) and to `/grafana/api/query-history` (`1000010`). With
`up` only the SQL rules fired; a real PromQL query such as
`sum(rate(x[1m])) by (job)` also trips command-injection rules (`932240`).

**Fix:** the SQL-injection and command-injection groups (tags `attack-sqli`,
`attack-rce`) are removed for one target each: the `Referer` header on
`/grafana/` requests, the `panes` argument on `/grafana/explore`, and the PromQL
field of the query history. A tag is used instead of ids because any query text
can trip a different rule (same reasoning as for PromQL in `1000002`).

What keeps this safe:

- **Target-scoped and path-scoped.** Every other header, argument, field and
  route keeps every rule. `panes` sent to another path (for example
  `/grafana/api/health`) and command injection in another argument of
  `/grafana/explore` are still blocked.
- **Only those two groups.** XSS, LFI and the rest of the CRS still inspect the
  `Referer`, `panes` and the history field. A `<script>` payload in the `Referer`
  of a `/grafana/` request is still `403`.
- **The values are not used to build SQL or run commands.** `Referer` is a
  browser header, `panes` and the history are Explore's own saved state, and
  Grafana's endpoints require a login. Prometheus is reached only through
  Grafana's server-side proxy.

Trade-off: on `/grafana/` requests the `Referer` is no longer checked for SQL or
command injection; the same is true of `panes` on the Explore page and of the
PromQL field of the history.

Things worth knowing if this is touched again:

- `1000008` uses `@beginsWith /grafana/`, so it does not cover requests outside
  that prefix. After these rules no `403` on `/favicon.ico` was seen with the
  Explore page open.
- Only `array_0` is covered in the query history, and only `array_0` and
  `array_1` in `/grafana/api/ds/query`. Read the target in the audit log before
  adding more (filter `grep -v "api/live/ws"`, that websocket floods the log).

## Known limitation: Grafana Explore Traces

**Explore Traces** (`/grafana/a/grafana-exploretraces-app/explore?...`) keeps its
state in different query arguments (`var-primarySignal=nestedSetParent%3C0`,
`selection={"...`), on a different path. Rules `942131`, `942200`, `942340` and
`942430` match them and reloading that page returns `403`.

**Decision: treated as a known limitation, not fixed.**

- The project does not use Explore Traces, and there is no Tempo/Jaeger backend,
  so the page has nothing to show.
- Fixing it needs more exclusions on arguments of `/grafana/a/...`; each one
  opens a client-controlled field for a page nobody uses.
- The WAF is working as designed: at paranoia level 2, `nestedSetParent<0`
  looks like SQL.

Other Grafana drilldown apps (Metrics, Logs, Pyroscope are installed) also keep
state in the URL and have not been tested. If one is adopted later, repeat the
audit-log analysis for that page. Do not reuse the Explore Traces results.

## Former Vite dev server false positive (Resolved)

Rule `930121` (Local File Inclusion detection) flags any request whose
`Referer` header contains the string `node_modules/` — a legitimate
heuristic against LFI attempts, but it also matched the Vite dev server's
own asset requests (`/node_modules/.vite/deps/...`), which were normal in
development.

**Status: Resolved in production.** With the frontend migrated to a static
multi-stage production build (PR #75), asset requests are compiled into `/assets/`
with content hashes and no longer reference `node_modules/`. The exclusion was
therefore removed and rule `930121` is now fully active. The project currently
has no configuration-time exclusions.

## Verification

All false positives above were found by testing real application flows end
to end, not assumed:

- `/forum` GETs (posts, comments, listing) — clean, no false blocks.
- `/forum/reports`, `/forum/moderation/*` (POST, PATCH) — initially blocked
  by the method-enforcement rule; fixed by `before-crs.conf`; confirmed the
  request now reaches the backend (a `400` from the app's own DTO validation,
  not a `403` from the WAF).
- Attack simulation confirms actual protection, not just that the container
  starts:
  - `POST /forum/posts` with `' OR 1=1 --` in the body → `403` (WAF)
  - `POST /forum/posts` with `<script>alert(1)</script>` in the body →
    `403` (WAF)
- `PATCH /users/me` with a `data:` scheme + base64 payload in `username` or
  `email` (not `avatar`) → `403` (WAF), confirmed after the v2 fix above.
  Before the fix, the same payloads returned `200`.
- Grafana dashboards: before the PromQL exclusion, 4 of the 12 panels
  returned `403` ("No data"); the PromQL exclusion exists to fix exactly
  these.
- Avatar uploads: before v3, 40 of 200 random pictures were refused with
  `403`; after it, 300 random pictures all passed, and a script or HTML
  payload in `avatar` is refused by the backend (`400`).
- Forum texts: before rule `1000004`, 40 of 91 ordinary texts (posts,
  comments, reports and searches) were refused with `403`; after it, none.
  `<script>` and `onerror=` in the same fields, and SQL injection in `page`,
  are still `403`.
- Kibana: before the `942440` exclusion, logging in to Kibana, visiting
  Grafana and returning to Kibana ended in `403` on `GET /kibana/spaces/enter`
  (audit log: only rule `942440` matched, on `REQUEST_COOKIES:sid`).
  After the exclusion, the same flow with repeated reloads gave no `403` on
  any `/kibana` path and no new `942440` entries in `audit.log`; a real
  `'--` in a query argument (`/crypto/BTC/candles?interval=1'--`) is still
  `403` and still logs `942440`.
- Kibana cookie exclusion scope (after moving it to rule `1000005`), using
  `sid=abc-- def` and checking `audit.log` for `942440` and its target:
  - `GET /kibana/` with that `sid` → `302` (not blocked, no `942440` entry)
  - `GET /users/me` with the same `sid` → `403`, `942440` on `REQUEST_COOKIES:sid`
  - `GET /kibana/` with the same value in another cookie (`foo`) → `403`,
    `942440` on `REQUEST_COOKIES:foo`
  - `GET /kibana/?x=abc--%20def` → `403`, `942440` on `ARGS:x`
  - `GET /kibana-x/` with that `sid` → `403`, `942440` on `REQUEST_COOKIES:sid`
    (the `@rx` does not match this route)
  - The same HTTP codes were obtained after recreating the container
    (`docker compose up -d --force-recreate nginx`).
- Kibana login (rule `1000011`), curl without a Kibana session (`401` = the WAF
  let it through) and the matches read from `audit.log`:
  - Before the rule: `currentURL` with `next=%2Fkibana%2F` → `401`, `920230` on
    `ARGS:json.currentURL`; `%2F` in `providerName` → `401`, `920230` on
    `ARGS:json.providerName`.
  - After the rule: `currentURL` with `next=%2Fkibana%2F` → `401`, no `920230`
    entry; `%2F` in `providerName` → `401`, `920230` still on
    `ARGS:json.providerName` (the exclusion covers `currentURL` only).
  - A real login in the browser works.
  - `bash scripts/test-forum.sh` → 11/11 and `bash scripts/test-users.sh` →
    19/19 after the change.
- Grafana userstorage (rules `1000006` and `1000007`), curl without a Grafana
  session (`401` = the WAF let it through, `403` = the WAF blocked it):
  - `PATCH` with `Content-Type: application/merge-patch+json` and `history` → `401`
  - `POST` JSON with `history` → `401`
  - `PATCH` merge-patch with another field → `403`
  - `POST` with `<script>` in `history` → `403`
  - `PATCH /users/me` with `application/merge-patch+json` → `403` (the extra
    type is not open on other routes)

  In the browser, normal Grafana pages give `PATCH 200` and `GET 200` on
  userstorage.
- Grafana Explore (rules `1000008`, `1000009`, `1000010` and `1000002`
  extended to `array_1`): before them, Explore with Prometheus gave `403` on
  `login/ping` and on the `react-monaco-editor` JS/CSS, the editor failed to
  load, reloading with F5 gave `403` (`ARGS:panes`), and running a PromQL query
  gave "Query error 403" (`ARGS:json.queries.array_1.expr` on
  `/grafana/api/ds/query`, `array_0.expr` on `/grafana/api/query-history`). After
  them, the editor loads, `up` returns the five targets, and these queries run
  without `403`:
  - `sum(rate(nginx_http_requests_total[1m])) by (job)`
  - `up == 0`
  - `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))`
  - `rate(nginx_http_requests_total[5m]) * 100 > 0`

  Scope, curl without a Grafana session (`302`/`401` = the WAF let it through):
  - `' OR 1=1 -- ` in the `Referer` of `/grafana/api/health` → `200`
  - PromQL in `panes` on `/grafana/explore` → `302`
  - PromQL in the `Referer` of `/grafana/api/health` → `200`
  - `;cat /etc/passwd` in another argument (`x`) of `/grafana/explore` → `403`
  - `;cat /etc/passwd` in `panes` on `/grafana/api/health` → `403`
  - `<script>` in the `Referer` of `/grafana/api/health` → `403`
  - `;cat /etc/passwd` in the `Referer` of `/users/me` → `403`
  - `POST /grafana/api/ds/query` with PromQL in `array_1` → `401`; with
    `;cat /etc/passwd` in `array_1.legendFormat` → `403`
  - `POST /grafana/api/query-history` with PromQL in `array_0.expr` → `401`; with
    `;cat /etc/passwd` in `comment` → `403`
- Explore Traces is unchanged: its URL still gives `403` on reload (documented
  limitation).
- Existing exclusions after the userstorage change: `bash scripts/test-forum.sh`
  → 11/11 and `bash scripts/test-users.sh` → 19/19.

## How to test

1. `docker compose up -d nginx` after any change to these files
   (`docker compose restart nginx` is enough for edits to `before-crs.conf`).
2. Exercise real app flows (forum posts, comments, reports, moderation) and
   confirm nothing legitimate gets an HTML `403 Forbidden` page (a JSON
   error from the app itself, e.g. `400`/`404`, is fine — that means the
   request passed the WAF).
3. If something is blocked, `docker compose logs nginx | grep -i
   modsecurity` shows the matched rule ID and message — identify whether
   it's a genuine false positive (add a scoped exclusion) or a real risk
   (leave it blocking). For the full matched-rule detail (not just the
   summary line), read `/var/log/modsecurity/audit.log` inside the
   container instead of the error log: take the `unique_id` from the error
   log line and search for it, e.g.
   ```bash
   docker compose exec nginx sh -c 'grep "<unique_id>" /var/log/modsecurity/audit.log'
   ```
   Each entry lists every rule that added points (`ruleId`, `message`, `data`),
   not only the final `949110`. A CRITICAL rule is worth 5 points, ERROR 4,
   WARNING 3, NOTICE 2; the request is blocked when the total reaches the
   threshold (5).
4. Confirm real attacks are still blocked:
   ```bash
   curl -k -X POST https://localhost/forum/posts \
     -H "Content-Type: application/json" \
     -d '{"title":"test","content":"'"'"' OR 1=1 --"}'
   curl -k -X POST https://localhost/forum/posts \
     -H "Content-Type: application/json" \
     -d '{"title":"test","content":"<script>alert(1)</script>"}'
   ```
   Both should return `403`.
5. If touching the avatar exclusion specifically, confirm both sides of the
   scope in the same pass — the legitimate case must still pass, and
   fields outside `avatar` must still be blocked:
   ```bash
   # must stay 200 — legitimate avatar upload
   curl -k -X PATCH https://localhost/users/me \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"avatar":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}'

   # must be 403 — same kind of payload, different field
   curl -k -X PATCH https://localhost/users/me \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"username":"data:text/html;base64,PHNjcmlwdD4="}'
   ```
   `bash scripts/test-users.sh` also sends 30 random pictures of different
   sizes, which must all be accepted.
6. If touching the PromQL exclusions, confirm both sides again — the
   legitimate query must pass, and the same kind of payload outside the
   excluded field (or XSS inside it) must still be blocked:
   Note: Direct queries against `https://localhost/prometheus/` now return `404`
   because unauthenticated public access has been removed at the nginx level.
   All PromQL queries are proxied server-side through Grafana (`/grafana/api/ds/query`)
   which requires a valid Grafana session.
   Then open the Grafana dashboards and confirm all panels load data.
7. If touching the forum exclusion, run `bash scripts/test-forum.sh`:
   ordinary sentences must pass in posts, comments and the search box, while
   `<script>`, `onerror=` and SQL injection in `page` must still return `403`.
8. If touching the Kibana cookie exclusion (rule `1000005`), check both the
   scope and the real flow.

   Scope — run these and confirm in `audit.log` that `942440` appears (with
   the expected target) in every case that returns `403`:
   ```bash
   # must NOT be 403 — sid with "-- " inside /kibana
   curl -sk -o /dev/null -w "%{http_code}\n" -H "Cookie: sid=abc-- def" "https://localhost/kibana/?t=T1"
   # must be 403 — same sid on another route
   curl -sk -o /dev/null -w "%{http_code}\n" -H "Cookie: sid=abc-- def" "https://localhost/users/me?t=T2"
   # must be 403 — another cookie inside /kibana
   curl -sk -o /dev/null -w "%{http_code}\n" -H "Cookie: foo=abc-- def" "https://localhost/kibana/?t=T3"
   # must be 403 — an argument inside /kibana
   curl -sk -o /dev/null -w "%{http_code}\n" "https://localhost/kibana/?t=T4&x=abc--%20def"
   # must be 403 — similar route, the regex must not match
   curl -sk -o /dev/null -w "%{http_code}\n" -H "Cookie: sid=abc-- def" "https://localhost/kibana-x/?t=T5"
   ```
   ```bash
   docker compose exec -T nginx cat /var/log/modsecurity/audit.log \
     | grep -E 't=T[1-5]' \
     | grep -oE '"uri":"[^"]*"|found within MATCHED_VARS:[A-Z_]+:[A-Za-z0-9_]+'
   ```
   Run the commands one at a time, without the `#` comments on the same line
   (zsh treats pasted comments as part of the command).

   Real flow: log in to `https://localhost/kibana/`, open `/grafana`, return
   to `/kibana`, and reload a few times (the failure depended on the session
   token, so one success is not proof). Then check that `942440` no longer
   shows up in `audit.log` for requests carrying the `sid` cookie.
9. If touching the Grafana userstorage exclusions (rules `1000006`, `1000007`),
   check both sides, without a Grafana session. `401` means the WAF let the
   request through; `403` (nginx page, 548 bytes) means the WAF blocked it.
   Any record id works:
   ```bash
   URL="https://localhost/grafana/apis/userstorage.grafana.app/v0alpha1/namespaces/default/user-storage/test"
   ```
   ```bash
   # must be 401: merge-patch on history
   curl -sk -o /dev/null -w "%{http_code}\n" -X PATCH "$URL" \
     -H "Content-Type: application/merge-patch+json" \
     -d '{"spec":{"data":{"history":"[{\"url\":\"/d/x?a=1'"'"'&b=%2F\"}]"}}}'
   ```
   ```bash
   # must be 403: same type, another field
   curl -sk -o /dev/null -w "%{http_code}\n" -X PATCH "$URL" \
     -H "Content-Type: application/merge-patch+json" \
     -d '{"spec":{"data":{"other":"1'"'"' OR 1=1 -- "}}}'
   ```
   ```bash
   # must be 403: XSS still inspected inside history
   curl -sk -o /dev/null -w "%{http_code}\n" -X POST "$URL" \
     -H "Content-Type: application/json" \
     -d '{"spec":{"data":{"history":"<script>alert(1)</script>"}}}'
   ```
   ```bash
   # must be 403: the extra Content-Type is not open on other routes
   curl -sk -o /dev/null -w "%{http_code}\n" -X PATCH https://localhost/users/me \
     -H "Content-Type: application/merge-patch+json" -d '{"username":"x"}'
   ```
   Then open the Grafana home, a dashboard (reload with F5) and Explore with
   Prometheus, and check that no `403` shows up on userstorage:
   ```bash
   docker compose logs nginx --since 5m | grep -v 'ModSecurity' \
     | grep -o '"[A-Z]* [^ ]* HTTP[^"]*" 403' | sed 's/?[^ ]*//; s/page-history:[a-z0-9]*/page-history:ID/' | sort | uniq -c | sort -rn
   ```
   `grep ' 403 '` alone over-counts (response sizes, `Referer` text, and two
   log lines per block).
10. If touching the Grafana Explore exclusions (rules `1000002` `array_1`,
   `1000008`, `1000009`, `1000010`), open Explore, choose Prometheus, switch to
   **Code**, run a real PromQL query and reload with F5:
   `sum(rate(nginx_http_requests_total[1m])) by (job)`, `up == 0` and
   `rate(nginx_http_requests_total[5m]) * 100 > 0` must run without `403`. Then
   check the scope with curl, without a Grafana session (`302`/`401`/`200` = the
   WAF let it through, `403` = blocked). Run them one at a time:
   ```bash
   # must NOT be 403: SQLi in the Referer of a /grafana/ request
   curl -sk -o /dev/null -w "%{http_code}\n" -H "Referer: https://localhost/grafana/explore?q=1' OR 1=1 -- " "https://localhost/grafana/api/health?t=T1"
   ```
   ```bash
   # must NOT be 403: PromQL in panes on /grafana/explore
   curl -sk -o /dev/null -w "%{http_code}\n" -G "https://localhost/grafana/explore" --data-urlencode 'panes={"a":{"queries":[{"expr":"sum(rate(nginx_http_requests_total[1m])) by (job)"}]}}'
   ```
   ```bash
   # must NOT be 403: PromQL in the Referer
   curl -sk -o /dev/null -w "%{http_code}\n" -H 'Referer: https://localhost/grafana/explore?panes={"a":{"queries":[{"expr":"sum(rate(x[1m])) by (job)"}]}}' "https://localhost/grafana/api/health?t=T3"
   ```
   ```bash
   # must be 403: command injection in another argument of the same path
   curl -sk -o /dev/null -w "%{http_code}\n" -G "https://localhost/grafana/explore" --data-urlencode 'x=;cat /etc/passwd'
   ```
   ```bash
   # must be 403: panes on another path
   curl -sk -o /dev/null -w "%{http_code}\n" -G "https://localhost/grafana/api/health" --data-urlencode 'panes=;cat /etc/passwd'
   ```
   ```bash
   # must be 403: XSS in the Referer
   curl -sk -o /dev/null -w "%{http_code}\n" -H "Referer: https://localhost/<script>alert(1)</script>" "https://localhost/grafana/api/health?t=T6"
   ```
   ```bash
   # must be 403: the Referer is still inspected outside /grafana/
   curl -sk -o /dev/null -w "%{http_code}\n" -H "Referer: https://localhost/grafana/explore?q=;cat /etc/passwd" https://localhost/users/me
   ```
   ```bash
   # must be 401: PromQL in array_1 of the query endpoint
   curl -sk -o /dev/null -w "%{http_code}\n" -X POST https://localhost/grafana/api/ds/query -H "Content-Type: application/json" -d '{"queries":[{"expr":"up"},{"expr":"sum(rate(x[1m])) by (job)"}]}'
   ```
   ```bash
   # must be 403: command injection in legendFormat of array_1
   curl -sk -o /dev/null -w "%{http_code}\n" -X POST https://localhost/grafana/api/ds/query -H "Content-Type: application/json" -d '{"queries":[{"expr":"up"},{"expr":"x","legendFormat":";cat /etc/passwd"}]}'
   ```
   ```bash
   # must be 401: PromQL in the query history
   curl -sk -o /dev/null -w "%{http_code}\n" -X POST https://localhost/grafana/api/query-history -H "Content-Type: application/json" -d '{"datasourceUid":"x","queries":[{"expr":"sum(rate(x[1m])) by (job)"}]}'
   ```
   ```bash
   # must be 403: command injection in another field of the history
   curl -sk -o /dev/null -w "%{http_code}\n" -X POST https://localhost/grafana/api/query-history -H "Content-Type: application/json" -d '{"datasourceUid":"x","comment":";cat /etc/passwd","queries":[{"expr":"up"}]}'
   ```
   If a query still gives `403`, read the target in the audit log, ignoring the
   websocket noise:
   ```bash
   docker compose exec nginx sh -c 'grep -v "api/live/ws" /var/log/modsecurity/audit.log | tail -n 6 | grep -oE "\"uri\":\"[^\"]{0,60}|against variable .[A-Za-z_:.0-9-]*|ruleId\":\"[0-9]*"'
   ```
11. If touching the Kibana login exclusion (rule `1000011`), check both sides
   without a Kibana session (`401` = the WAF let the request through, `403` =
   blocked). Run the commands one at a time and use a **new marker** (`T11`,
   `T12`, ...) on every run: the audit log keeps old entries, and `tail -1` on
   a marker from an earlier run would show the old match.
   ```bash
   # must be 401, and no 920230 in the audit log: %2F in currentURL
   curl -sk -o /dev/null -w "%{http_code}\n" -X POST "https://localhost/kibana/internal/security/login?t=T11" -H 'Content-Type: application/json' -H 'kbn-xsrf: true' -d '{"providerType":"basic","providerName":"basic","currentURL":"https://localhost/kibana/login?next=%2Fkibana%2F","params":{"username":"x","password":"x"}}'
   ```
   ```bash
   # must be 401, and 920230 on ARGS:json.providerName: %2F in another field
   curl -sk -o /dev/null -w "%{http_code}\n" -X POST "https://localhost/kibana/internal/security/login?t=T12" -H 'Content-Type: application/json' -H 'kbn-xsrf: true' -d '{"providerType":"basic","providerName":"a%2Fb","currentURL":"https://localhost/kibana/login","params":{"username":"x","password":"x"}}'
   ```
   ```bash
   docker compose exec nginx sh -c 'grep "t=T11" /var/log/modsecurity/audit.log | tail -1 | grep -oE "against variable .[A-Za-z_:.0-9-]*|ruleId\":\"[0-9]*"'
   ```
   ```bash
   docker compose exec nginx sh -c 'grep "t=T12" /var/log/modsecurity/audit.log | tail -1 | grep -oE "against variable .[A-Za-z_:.0-9-]*|ruleId\":\"[0-9]*"'
   ```
   The first one prints nothing (no rule matched); the second prints
   `ARGS:json.providerName` and `920230`, which proves the exclusion covers
   `currentURL` only. Then log in to `https://localhost/kibana/` in the browser
   and confirm it works, and run `bash scripts/test-forum.sh && bash
   scripts/test-users.sh`.

## `before-crs.conf` — Upstream 5xx response masking (Rule 950100)

```apache
SecRuleRemoveById 950100
```

**Symptom:** Upstream server errors (such as unhandled exceptions in `PATCH /users/me` or temporary DNS/connection issues producing 500/502) returned `403 Forbidden` to the client instead of the actual error status.

**Cause:** In Phase 4 (outbound response inspection), CRS rule `950100` matches any `5xx` status code (`RESPONSE_STATUS @rx ^5\d{2}$`) and adds to the outbound anomaly score. Rule `959100` then intercepts the response because the threshold is reached, replacing the upstream 5xx response with a generic WAF `403 Forbidden`.

**Fix:** Rule `950100` is removed via `SecRuleRemoveById 950100`. This allows upstream server errors to be surfaced accurately to client applications and monitoring tools (`500`, `502`, `503`, `504`) instead of masking them behind misleading security blocks.

What keeps this safe:
- **Inbound inspection is unaffected.** All SQLi, XSS, RCE, LFI and anomaly detection rules in Phase 1 and 2 remain active.
- **Data leakage content rules remain active.** Rules that inspect response bodies for sensitive information (`951xxx`–`955xxx`) continue to operate.
- **NestJS sanitizes internal errors.** In production, unhandled exceptions return sanitized JSON (`{"statusCode": 500, "message": "Internal server error"}`) and do not leak stack traces.


## Status

- [x] `PARANOIA`/`BLOCKING_PARANOIA` raised from default (1) to 2
- [x] Method enforcement extended for PATCH/PUT/DELETE (REST API requirement)
- [x] Frontend migrated to static production build (PR #75); Vite dev-server
      exclusion 930121 removed and rule re-enabled
- [x] Verified against real app traffic (forum flows) with no unresolved
      false positives
- [x] Verified against simulated SQLi/XSS attacks — both blocked
- [x] Avatar exclusion re-scoped to `ARGS:json.avatar` only, after a
      pentest pass confirmed the original `ctl:ruleRemoveById` version was
      exploitable via other fields on the same endpoint (`username`,
      `email`)
- [x] PromQL exclusions scoped by tag to the query fields only in Grafana
      (`/grafana/api/ds/query`); public `/prometheus/` endpoint removed (returns 404)
      and unauthenticated access closed
- [x] Confirmed all Grafana panels load data via authenticated server-side proxy
- [x] Avatar field validated by the backend (PNG, JPEG, GIF or WebP data
      URL, at most 100 000 characters: `backend/src/users/user-rules.ts`)
- [x] Avatar exclusion extended (v3) to the `attack-sqli`, `attack-xss` and
      `attack-rce` groups, for `ARGS:json.avatar` only
- [x] Forum exclusion added (`1000004`), scoped by tag to the forum's text
      fields only
- [x] Kibana `sid` cookie exclusion added (`942440`, `REQUEST_COOKIES:sid`
      only)
- [x] Kibana → Grafana → Kibana flow re-tested after the exclusion (step 8
      of *How to test*)
- [x] Kibana `sid` exclusion scoped to `/kibana` with a runtime rule
      (`1000005`) in `before-crs.conf`; scope verified (step 8 of
      *How to test*)
- [x] Kibana login `920230` exclusion added (`1000011`), scoped to
      `ARGS:json.currentURL` on `/kibana/internal/security/login` only; scope
      verified and real login re-tested (step 11 of *How to test*)
- [x] Grafana userstorage `history` exclusion added (`1000006`), scoped by tag
      and rule id to `ARGS:json.spec.data.history` on that path only
- [x] `application/merge-patch+json` allowed for the userstorage path only
      (`1000007`, rule `920420`)
- [x] Grafana Explore with Prometheus: `Referer` (`1000008`), `panes` (`1000009`)
      and query history (`1000010`) exclusions added, SQL-injection and
      command-injection groups only, each for one target on its own path;
      `1000002` extended to `queries.array_1`
- [x] Known limitation documented: Grafana Explore Traces (and untested
      drilldown apps) return `403` on reload; accepted, not fixed
- [x] Upstream 5xx masking rule 950100 removed; real HTTP error semantics preserved for clients and monitoring
- [x] Kibana internal API rules migrated from inline Nginx directives to centralized runtime exclusion `1000012` in `before-crs.conf`
- [x] Socket.IO rule 920420 migrated from inline Nginx directive to centralized runtime exclusion `1000013` in `before-crs.conf`