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
  - ./nginx/modsecurity/exclusions.conf:/etc/modsecurity.d/owasp-crs/rules/RESPONSE-999-EXCLUSION-RULES-AFTER-CRS.conf
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
  and upgrade-safe.

### Local rule IDs in use

| ID        | Purpose                                              |
|-----------|------------------------------------------------------|
| `900200`  | Allowed HTTP methods (REST)                          |
| `1000001` | Base64 avatar exclusion (`PATCH /users/me`)          |
| `1000002` | PromQL exclusion for Grafana (`POST /grafana/api/ds/query`) |
| `1000003` | PromQL exclusion for Prometheus (`/prometheus/api/v1/`) |
| `1000004` | Forum text fields exclusion (`/forum/`)              |

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
    ctl:ruleRemoveTargetById=941380;ARGS:json.queries.array_0.legendFormat"

SecRule REQUEST_URI "@beginsWith /prometheus/api/v1/" \
  "id:1000003,\
  phase:1,\
  nolog,\
  pass,\
  t:none,\
  ctl:ruleRemoveTargetByTag=attack-sqli;ARGS:query,\
  ctl:ruleRemoveTargetByTag=attack-rce;ARGS:query"
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
| `1000002` | `POST /grafana/api/ds/query` | `ARGS:json.queries.array_0.legendFormat`| rule `941380` only          |
| `1000003` | `/prometheus/api/v1/*`       | `ARGS:query`                            | `attack-sqli`, `attack-rce` |

What keeps this safe:

- **Field-scoped, not request-scoped.** Everything uses
  `ctl:ruleRemoveTarget...`, so every other field and route is still fully
  inspected by the whole CRS.
- **XSS and all other rule groups still inspect the PromQL fields.** Only
  `attack-sqli` and `attack-rce` are removed from them (and `941380` from
  `legendFormat`).
- **Grafana's endpoint requires a login**, so it is not reachable by an
  anonymous attacker. The Prometheus endpoint is read-only (query API).

Things worth knowing if this is touched again:

- The `array_0` in `json.queries.array_0.expr` is how ModSecurity names the
  first element of the `queries` JSON array. Each dashboard panel currently
  sends one query, so `array_0` is enough. A panel with several queries per
  request (`array_1`, ...) would have its extra queries still inspected and
  could be blocked again — extend the targets if that happens.
- The `json.` prefix matters here for the same reason as in the avatar
  exclusion (see above).
- Rule `1000003` has no method condition, so it applies to any method on
  `/prometheus/api/v1/`; this is intentional, since the Prometheus query API
  accepts both `GET` and `POST`.

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

## `exclusions.conf` — Vite dev server false positive

```apache
SecRuleRemoveById 930121
```

Rule `930121` (Local File Inclusion detection) flags any request whose
`Referer` header contains the string `node_modules/` — a legitimate
heuristic against LFI attempts, but it also matches the Vite dev server's
own asset requests (`/node_modules/.vite/deps/...`), which are normal in
development.

**This is a dev-mode-specific exclusion.** The frontend currently runs via
the Vite dev server, not a production build. If/when the frontend is served
as a static production build, `node_modules/`-referencing requests should no
longer occur, and this exclusion may no longer be necessary — worth
revisiting at that point rather than assuming it should stay indefinitely.

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

## How to test

1. `docker compose up -d nginx` after any change to these files.
2. Exercise real app flows (forum posts, comments, reports, moderation) and
   confirm nothing legitimate gets an HTML `403 Forbidden` page (a JSON
   error from the app itself, e.g. `400`/`404`, is fine — that means the
   request passed the WAF).
3. If something is blocked, `docker compose logs nginx | grep -i
   modsecurity` shows the matched rule ID and message — identify whether
   it's a genuine false positive (add a scoped exclusion) or a real risk
   (leave it blocking). For the full matched-rule detail (not just the
   summary line), read `/var/log/modsecurity/audit.log` inside the
   container instead of the error log.
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
   ```bash
   # must NOT be 403 — legitimate PromQL on the Prometheus API
   curl -k -G https://localhost/prometheus/api/v1/query \
     --data-urlencode 'query=sum(rate(http_requests_total[1m])) by (route)'

   # must still be 403 — XSS inside the excluded field is still inspected
   curl -k -G https://localhost/prometheus/api/v1/query \
     --data-urlencode 'query=<script>alert(1)</script>'

   # must still be 403 — SQLi in a field that is NOT excluded
   curl -k -G https://localhost/prometheus/api/v1/query \
     --data-urlencode "other=' OR 1=1 --"
   ```
   Then open the Grafana dashboards and confirm all 12 panels load data.
7. If touching the forum exclusion, run `bash scripts/test-forum.sh`:
   ordinary sentences must pass in posts, comments and the search box, while
   `<script>`, `onerror=` and SQL injection in `page` must still return `403`.

## Status

- [x] `PARANOIA`/`BLOCKING_PARANOIA` raised from default (1) to 2
- [x] Method enforcement extended for PATCH/PUT/DELETE (REST API requirement)
- [x] Vite dev-server false positive excluded, with a note to revisit for
      production builds
- [x] Verified against real app traffic (forum flows) with no unresolved
      false positives
- [x] Verified against simulated SQLi/XSS attacks — both blocked
- [x] Avatar exclusion re-scoped to `ARGS:json.avatar` only, after a
      pentest pass confirmed the original `ctl:ruleRemoveById` version was
      exploitable via other fields on the same endpoint (`username`,
      `email`)
- [x] PromQL exclusions added for Grafana (`/grafana/api/ds/query`) and
      Prometheus (`/prometheus/api/v1/`), scoped by tag to the query fields
      only
- [ ] Confirm the negative cases for the PromQL exclusions (XSS in `query`
      still `403`, other fields still inspected) and that all 12 Grafana
      panels load
- [x] Avatar field validated by the backend (PNG, JPEG, GIF or WebP data
      URL, at most 100 000 characters: `backend/src/users/user-rules.ts`)
- [x] Avatar exclusion extended (v3) to the `attack-sqli`, `attack-xss` and
      `attack-rce` groups, for `ARGS:json.avatar` only
- [x] Forum exclusion added (`1000004`), scoped by tag to the forum's text
      fields only
