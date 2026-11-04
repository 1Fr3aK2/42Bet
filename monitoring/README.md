# Monitoring Stack (Prometheus + Grafana)

This document describes the observability setup implemented for the Devops module
("Monitoring system with Prometheus and Grafana") of `ft_transcendence`.

## Overview

The stack collects metrics from all core services and exposes them through a
provisioned Grafana dashboard, with alerting rules evaluated by Prometheus.

**Services monitored:**

| Service    | Exporter                                  | Scrape target             |
|------------|--------------------------------------------|----------------------------|
| Backend    | built-in (`@willsoto/nestjs-prometheus`)    | `backend:8000`             |
| Nginx      | `nginx-prometheus-exporter`                 | `nginx_exporter:9113`      |
| PostgreSQL | `postgres_exporter`                         | `postgres_exporter:9187`   |
| Redis      | `redis_exporter`                            | `redis_exporter:9121`      |
| Prometheus | self-scrape                                 | `prometheus:9090`          |

## Architecture decisions

- **Internal-only access**: Prometheus is not exposed on host ports and is not
  accessible via public Nginx reverse proxy (returns 404). Grafana reaches Prometheus
  exclusively over the internal Docker network (`http://prometheus:9090/prometheus/`).
  Grafana itself is reached through Nginx under `/grafana/` and requires authentication.
- **Route prefixes**: Prometheus runs with `--web.route-prefix=/prometheus/` and
  `--web.external-url=https://localhost/prometheus/`; Grafana runs with
  `GF_SERVER_SERVE_FROM_SUB_PATH=true` and a matching `GF_SERVER_ROOT_URL`. This
  keeps both UIs working correctly behind the reverse proxy subpath.
- **Storage permissions**: a `prometheus-init` one-shot container `chown`s the
  `prometheus-data` volume to UID `65534` (the `nobody` user Prometheus runs as)
  before the main Prometheus container starts, avoiding permission errors on the
  TSDB volume.
- **Provisioning as code**: both the Grafana datasource and dashboards are
  provisioned from files mounted into the container, not created manually through
  the UI. This keeps the whole monitoring setup reproducible with a single
  `docker compose up`, per the project's containerization requirement.

## Directory structure

```
monitoring/
├── grafana/
│   └── provisioning/
│       ├── datasources/
│       │   └── datasource.yml
│       └── dashboards/
│           ├── dashboard.yml
│           └── infra-status.json
└── prometheus/
    ├── prometheus.yml
    └── alert.rules.yml
```

## Docker Compose wiring

The `grafana` service mounts the provisioning folder into the path Grafana scans
by default:

```yaml
grafana:
  volumes:
    - grafana-db:/var/lib/grafana/
    - ./monitoring/grafana/provisioning:/etc/grafana/provisioning
```

## Datasource provisioning

`monitoring/grafana/provisioning/datasources/datasource.yml` points Grafana to
Prometheus over the internal Docker network, including the route prefix
Prometheus was started with:

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090/prometheus/
    isDefault: true
    editable: false
```

- `access: proxy` — Grafana's backend calls Prometheus server-side.
- `editable: false` — prevents UI edits from drifting away from the provisioned
  config in the repo.

## Dashboard provisioning

`monitoring/grafana/provisioning/dashboards/dashboard.yml` tells Grafana where to
read dashboard JSON files from, and which folder to display them under in the UI:

```yaml
apiVersion: 1

providers:
  - name: "default"
    orgId: 1
    folder: "Infra"
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    options:
      path: /etc/grafana/provisioning/dashboards
```

`infra-status.json` (same folder) defines the "Infra Status" dashboard:
up/down stat panels for each service (`up{job="..."}`), plus timeseries panels
for request rate, active connections, backend process CPU/memory, and custom
backend request metrics (see below).

## Custom backend metrics

Beyond the default process metrics (`process_cpu_seconds_total`,
`process_resident_memory_bytes`), the backend exposes application-level metrics
via a global NestJS interceptor (`metrics.interceptor.ts`), registered through
`APP_INTERCEPTOR` in `metrics.module.ts`:

- **`http_requests_total`** (Counter) — total requests, labeled by `method`,
  `route`, and `status_code`.
- **`http_request_duration_seconds`** (Histogram) — request duration, same
  labels, with buckets from 10ms to 5s.

The interceptor uses the matched route pattern (`request.route.path`, e.g.
`/users/:id`) rather than the raw URL, to avoid one metric series per unique
resource ID. Both `next` and `error` paths are covered, so failed requests are
counted too.

Two dashboard panels consume these metrics:
- **Backend - Requests/sec by route**: `sum(rate(http_requests_total[1m])) by (route)`
- **Backend - p95 Latency by route**:
  `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))`

## Grafana access security

- `GF_AUTH_ANONYMOUS_ENABLED: "false"` is set explicitly in `docker-compose.yml`
  (matches Grafana's default, but made explicit so it can't be silently changed
  by a future edit).
- Grafana is not exposed on a host port — reachable only through the Nginx
  reverse proxy over HTTPS, same as Prometheus.
- Admin credentials (`GF_SECURITY_ADMIN_USER`/`PASSWORD`) are set via `.env`,
  not left as Grafana's defaults.
- Grafana is intentionally kept separate from the application's own user auth
  system — it's an internal ops tool for the team, not user-facing, so a
  single shared admin account is appropriate here rather than per-user
  accounts.
- Validated by loading `/grafana/` in an incognito window: redirects to the
  login page, confirming no anonymous access.

## Alerting

`monitoring/prometheus/alert.rules.yml` defines `up{job=...} == 0` alerts for
backend, postgres, nginx, and redis, with `critical` severity for backend/postgres
and `warning` for nginx/redis.

## Issues found and fixed

Two real bugs were caught by testing this setup end-to-end rather than assuming
the config was correct:

1. **Prometheus self-scrape 404**: the `prometheus` job in `prometheus.yml` was
   using the default `/metrics` path, but `--web.route-prefix=/prometheus/`
   moves *all* of Prometheus's own endpoints — including its own metrics —
   under that prefix. Fixed by adding `metrics_path: /prometheus/metrics`
   explicitly to that one job (the other jobs don't need it, since their
   exporters don't run behind a route prefix).

2. **Empty provisioning directory**: Grafana logs showed
   `open /etc/grafana/provisioning/dashboards: no such file or directory`
   even though the local files existed and looked correct. The volume in
   `docker-compose.yml` was mounting `./grafana/provisioning`, but the actual
   folder lives at `./monitoring/grafana/provisioning`. Since the path didn't
   exist, Docker silently created an empty directory instead of failing loudly.
   Fixed by correcting the volume path. Confirmed via
   `docker compose exec grafana ls -la /etc/grafana/provisioning/dashboards`.

3. **Backend 502 after adding the interceptor**: TypeScript failed to build
   with `TS2306: File '.../metrics.interceptor.ts' is not a module`, which
   left the backend container failing to start (surfaced as a 502 through
   Nginx). Diagnosed via `docker compose logs backend`, which pointed
   directly at the compile error rather than the symptom.

## How to test

1. `docker compose up -d` and confirm `grafana` and `prometheus` are healthy.
2. Confirm Prometheus is not publicly exposed: `curl -sk -o /dev/null -w "%{http_code}" https://localhost/prometheus/` returns `404`.
3. `https://localhost/grafana/` → Connections → Data sources — "Prometheus"
   should already be listed (proves `datasource.yml` was read).
4. Dashboards → folder "Infra" → "Infra Status" should appear automatically
   (proves `dashboard.yml` + `infra-status.json` were read).
5. Open the dashboard: 4 status panels should read UP/green, and the
   timeseries panels below should show data (not "No data").
6. Generate some traffic against the backend (e.g. hit `/forum`), then check
   the "Backend - Requests/sec by route" and "p95 Latency by route" panels
   for data.
7. Load `/grafana/` in an incognito window — should redirect to login, not
   grant access.

## Status

- [x] Prometheus scrape config for all services
- [x] Alerting rules (service-down alerts)
- [x] Grafana provisioning wired into Docker Compose
- [x] Datasource provisioning, validated in the UI
- [x] Dashboard provider + "Infra Status" dashboard, validated with live data
- [x] Custom backend metrics (request counts, p95 latency by route),
      validated with live data
- [x] Grafana access secured (no anonymous access, validated)
