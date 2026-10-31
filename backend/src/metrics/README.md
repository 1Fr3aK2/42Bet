# Metrics Module (`backend/src/metrics`)

## What it does

Exposes a `/metrics` endpoint on the backend, in the format Prometheus expects,
so it can be scraped by the existing Prometheus service defined in
`docker-compose.yml`. Beyond default Node.js process metrics, it also tracks
per-route request counts and latency for the application itself.

## Why it was needed

Prometheus was already configured to scrape `backend:8000` (via the `backend`
job in `prometheus.yml`), but the backend had no `/metrics` endpoint — the
scrape returned `404 Not Found`. As a result, the `up{job="backend"}` metric
was always `0`, and the `BackendDown` alerting rule was permanently firing,
even though the backend was healthy and responding normally on its other
routes.

Once the endpoint existed, the only metrics available were process-level
(CPU, memory) — nothing about the application's actual behavior. A second
pass added application-level metrics (request counts and latency per route),
so the Grafana dashboard can show whether the API itself is healthy, not just
whether the process is running.

## Implementation

`metrics.module.ts` registers the base Prometheus integration plus a custom
counter, a custom histogram, and a global interceptor that populates them:

```typescript
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  PrometheusModule,
  makeCounterProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { MetricsInterceptor } from './metrics.interceptor';

@Module({
  imports: [PrometheusModule.register()],
  providers: [
    makeCounterProvider({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
    }),
    makeHistogramProvider({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
    }),
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },
  ],
})
export class MetricsModule {}
```

`metrics.interceptor.ts` wraps every request, records the duration, and
increments the counter with the resolved status code — for both successful
and failed requests:

```typescript
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(
    @InjectMetric('http_requests_total')
    private readonly requestCounter: Counter<string>,
    @InjectMetric('http_request_duration_seconds')
    private readonly requestDuration: Histogram<string>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    // Matched route pattern (e.g. "/users/:id"), not the raw URL —
    // avoids one metric series per unique resource ID.
    const route = request.route?.path ?? request.url;
    const method = request.method;

    const endTimer = this.requestDuration.startTimer({ method, route });

    return next.handle().pipe(
      tap({
        next: () => {
          const statusCode = response.statusCode;
          this.requestCounter.inc({ method, route, status_code: statusCode });
          endTimer({ status_code: statusCode });
        },
        error: (err) => {
          const statusCode = err?.status ?? 500;
          this.requestCounter.inc({ method, route, status_code: statusCode });
          endTimer({ status_code: statusCode });
        },
      }),
    );
  }
}
```

- Uses [`@willsoto/nestjs-prometheus`](https://www.npmjs.com/package/@willsoto/nestjs-prometheus)
  (backed by [`prom-client`](https://www.npmjs.com/package/prom-client)) — a
  NestJS wrapper around the standard Prometheus Node.js client.
- `PrometheusModule.register()` automatically registers `GET /metrics` with
  Node.js default metrics enabled (CPU usage, memory, event loop lag, GC
  stats, etc.) — no manual route or controller needed for those.
- `APP_INTERCEPTOR` applies `MetricsInterceptor` globally, so every route
  (present and future) is measured automatically without per-route code.
- Registered in `app.module.ts` alongside the other feature modules
  (`AuthModule`, `ForumModule`, `HealthModule`, etc.), following the same
  pattern already used in the project.

## Metrics exposed

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `http_requests_total` | Counter | `method`, `route`, `status_code` | Request counts per route/status |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | Request latency distribution (enables p95/p99 via `histogram_quantile`) |
| `process_cpu_seconds_total` | Gauge/Counter (default) | — | Process CPU time |
| `process_resident_memory_bytes` | Gauge (default) | — | Process memory (RSS) |

## Dependencies added

```json
"@willsoto/nestjs-prometheus": "^6.1.0",
"prom-client": "^15.1.3"
```

## Verification

```bash
docker exec -it prometheus wget -O- http://backend:8000/metrics
```

Returns Prometheus-format metrics (previously returned `404`). Confirmed in
the Prometheus UI (`https://localhost/prometheus/alerts`) that `BackendDown`
transitioned from `FIRING` to `INACTIVE` once the endpoint became available.

After adding the custom metrics, confirmed with real traffic
(`https://localhost/prometheus/graph`, query `http_requests_total`) that
request counts increment per route as expected, and that
`sum(rate(http_requests_total[1m])) by (route)` and
`histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))`
produce sensible values on the Grafana "Infra Status" dashboard.

## Issue found and fixed

Adding `metrics.interceptor.ts` initially broke the backend build:

```
error TS2306: File '.../metrics.interceptor.ts' is not a module.
```

This surfaced at runtime as a `502 Bad Gateway` through Nginx, since the
backend container failed to start. Diagnosed via `docker compose logs
backend`, which pointed directly at the TypeScript compile error rather than
the symptom (the 502).

## Relation to `health/`

This module remains intentionally separate from `health/` — the two answer
different questions:

- **`metrics/`** (this module) answers "what are this service's detailed
  numbers over time?" — scraped periodically by Prometheus, used for
  dashboards, rates, percentiles, and alerting thresholds. Not meant to be
  consumed directly by a human or read in real time.
- **`health/`** answers "is this service alive, right now?" — a point-in-time
  check, read synchronously by whoever needs an immediate yes/no (or
  component-by-component) answer. That module has since grown two distinct
  endpoints of its own, which mirror this same kind of internal/external
  split: `GET /health` (minimal, used by the Docker Compose `healthcheck:`
  for the `backend` service itself) and `GET /health/status` (richer, checks
  one more component, and is the one proxied publicly through nginx at
  `/health` for the standalone status page at `/status` to poll). See
  `SECURITY_REPORT.md` §7 for the full reasoning behind keeping those two
  endpoints separate.

Metrics and health checks could in principle overlap (e.g. Prometheus could
scrape a `/health`-style endpoint instead), but are kept as separate modules
and separate concerns here: Prometheus/Grafana are for trends an operator
watches over time, while `/health` is for an immediate status a script,
load balancer, or human visiting `/status` can act on right now.