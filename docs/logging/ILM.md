# Index Lifecycle Management (ILM) — Elasticsearch

## Context

This project's Logs module (ELK — Elasticsearch, Logstash, Kibana, Filebeat) ships
two kinds of daily indices into Elasticsearch:

- `transcendence-logs-YYYY.MM.dd` — general application/container logs collected
  by Filebeat via Docker autodiscover and shipped through Logstash.
- `waf-audit-YYYY.MM.dd` — structured ModSecurity (WAF) audit log entries, parsed
  by a dedicated Logstash pipeline (source IP, HTTP method, URI, status code, rule
  ID/message/severity, anomaly score).

Elasticsearch does not manage the lifecycle of these indices on its own: left
alone, a new index is created every day and none of them is ever rolled over or
deleted. Over time this means unbounded disk growth and slower queries.

The official project subject explicitly requires the Logs module to include a
retention/archiving policy for the indices — this is what ILM (Index Lifecycle
Management) is used for here.

## What ILM does, conceptually

ILM lets you define a policy made of phases (`hot`, `warm`, `cold`, `delete`,
among others) and, for each phase, a minimum age at which the index enters it and
a set of actions to run (e.g. `rollover`, `shrink`, `delete`). Once a policy is
created, it is attached to indices either directly or — more commonly — through
an **index template**, so that any new index whose name matches a given pattern
is automatically placed under that policy without any manual step.

## The policy used in this project: `transcendence-logs-policy`

```json
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_age": "1d",
            "max_size": "5gb"
          }
        }
      },
      "delete": {
        "min_age": "14d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

- **`hot` phase**: the index is active and receiving writes. A `rollover` action
  is configured with `max_age: 1d` and `max_size: 5gb` — in practice this mostly
  formalizes what the pipeline already does on its own (Logstash creates a new
  dated index every day), while also protecting against an unusually large day
  of traffic.
- **`delete` phase**: 14 days after creation, the index is deleted automatically.

### Why 14 days

This is an academic/evaluation project, not a production system with compliance
or long-term audit requirements. A short, clearly justified retention window is
enough to demonstrate that lifecycle management is correctly implemented and
understood, without adding operational complexity (e.g. `warm`/`cold` phases,
shard shrinking, or moving data to cheaper storage tiers) that would not be
justified by this project's actual data volume. Fourteen days also comfortably
covers a full evaluation/defense cycle, so logs relevant to a review remain
queryable in Kibana throughout it.

## Index templates

Two index templates apply `transcendence-logs-policy` automatically to any new
index matching each pattern:

**`transcendence-logs-template`**
```json
{
  "index_patterns": ["transcendence-logs-*"],
  "template": {
    "settings": {
      "index.lifecycle.name": "transcendence-logs-policy"
    }
  }
}
```

**`waf-audit-template`**
```json
{
  "index_patterns": ["waf-audit-*"],
  "template": {
    "settings": {
      "index.lifecycle.name": "transcendence-logs-policy"
    }
  }
}
```

Both indices share the same policy; a single policy was preferred over two
near-identical ones for simplicity, since both log streams have the same
retention requirements in this project. Splitting them into separate policies
(e.g. keeping WAF audit data longer, since it is more security-sensitive) would
be a straightforward extension if ever needed — only the `index.lifecycle.name`
in the WAF template would have to point at a different policy.

## The `elasticsearch_ilm_init` service

Index templates only apply automatically to indices created *after* the template
exists. They do nothing for indices that were already created before the policy
was set up. On top of that, this project's `make re` target performs a full
`docker system prune` and recreates every container and volume from scratch —
including Elasticsearch — which means any configuration applied by hand through
`curl` disappears on the next rebuild.

To make the ILM setup survive a full rebuild without manual intervention, it is
implemented as a dedicated one-shot init service, following the same pattern
already used elsewhere in this project for `kibana_user_init` (setting the
`kibana_system` password) and `vault_init` (bootstrapping Vault secrets):

```yaml
elasticsearch_ilm_init:
  container_name: elasticsearch_ilm_init
  image: docker.elastic.co/elasticsearch/elasticsearch:8.19.18
  networks:
    - transcendence
  environment:
    ELASTIC_PASSWORD: "${ELASTIC_PASSWORD}"
  entrypoint: ["/bin/sh"]
  command: ["/scripts/ilm-init.sh"]
  volumes:
    - ./logging/elasticsearch/ilm-init.sh:/scripts/ilm-init.sh:ro
  depends_on:
    elasticsearch:
      condition: service_healthy
  restart: on-failure
```

The script it runs, `logging/elasticsearch/ilm-init.sh`, does the following, in
order:

1. Waits for Elasticsearch to respond to an authenticated health check (it may
   still be starting up when this service is scheduled).
2. Creates (or updates) the `transcendence-logs-policy` ILM policy.
3. Creates (or updates) the `transcendence-logs-template` index template.
4. Creates (or updates) the `waf-audit-template` index template.
5. Applies the policy directly to any `transcendence-logs-*` indices that
   already exist, using `ignore_unavailable=true` so the request does not fail
   if no such index exists yet.
6. Does the same for any pre-existing `waf-audit-*` indices.

Steps 5 and 6 are what bring already-existing indices under management — without
them, an index created before the templates existed would remain unmanaged
(`"managed": false"`) forever, even though new indices from that point onward
would be picked up correctly by the templates.

### Design notes / pitfalls found while building this

- **Every `curl` call uses `-f`** (`curl -sf`) combined with `set -e`, so the
  script stops immediately on any HTTP error instead of silently continuing
  with partial state.
- **Steps 5 and 6 are separated into two independent calls**, each scoped to a
  single index pattern with `ignore_unavailable=true`. An earlier version tried
  to apply the settings update to both patterns in a single call
  (`transcendence-logs-*,waf-audit-*`). Elasticsearch requires *every* comma
  separated pattern in such a request to resolve to at least one index by
  default; since `waf-audit-*` did not exist yet at the time (no WAF-triggering
  traffic had occurred since the last rebuild), the entire request — including
  the `transcendence-logs-*` part, which did have a match — was rejected with a
  404, and the existing index was silently left unmanaged. Splitting the calls
  and adding `ignore_unavailable=true` to each makes the script correct whether
  zero, one, or both index families currently exist.
- **The last two calls are followed by `|| true`.** Applying a settings update
  is best-effort "cleanup" for pre-existing indices; a transient failure there
  should not stop the rest of the script or the container from being considered
  successful, since the templates (steps 3–4) already guarantee correct behavior
  going forward regardless.
- **The script is idempotent.** Re-running it (which happens on every container
  restart, and therefore on every `make re`) simply re-applies the same policy
  and templates; Elasticsearch treats this as an update, not an error.

## Verifying the setup

Check whether a given index is under ILM management, which policy it uses, and
which phase/step it is currently in:

```bash
docker compose exec elasticsearch sh -c \
  'curl -s -u "elastic:$ELASTIC_PASSWORD" \
   http://localhost:9200/<index-name>/_ilm/explain?pretty'
```

A managed index returns something like:

```json
{
  "indices": {
    "transcendence-logs-2026.09.29": {
      "index": "transcendence-logs-2026.09.29",
      "managed": true,
      "policy": "transcendence-logs-policy",
      "phase": "hot",
      "action": "rollover",
      "step": "check-rollover-ready"
    }
  }
}
```

`"managed": false` (or a `404 index_not_found_exception` if the index does not
exist at all) means the index is not currently governed by the policy — either
it predates the templates and steps 5/6 of the init script have not run
successfully against it, or it does not exist yet.

To inspect the policy and templates themselves:

```bash
docker compose exec elasticsearch sh -c \
  'curl -s -u "elastic:$ELASTIC_PASSWORD" \
   http://localhost:9200/_ilm/policy/transcendence-logs-policy?pretty'

docker compose exec elasticsearch sh -c \
  'curl -s -u "elastic:$ELASTIC_PASSWORD" \
   http://localhost:9200/_index_template/transcendence-logs-template?pretty'

docker compose exec elasticsearch sh -c \
  'curl -s -u "elastic:$ELASTIC_PASSWORD" \
   http://localhost:9200/_index_template/waf-audit-template?pretty'
```

To manually re-run the init logic without a full rebuild (e.g. after editing the
policy):

```bash
docker compose run --rm elasticsearch_ilm_init
```

## Relationship to the rest of the Logs module

This closes the last remaining gap in the Logs (ELK) module of the project's
Cybersecurity/DevOps/Monitoring area:

- Docker → Filebeat → Logstash → Elasticsearch pipeline: done.
- Kibana behind nginx, with its own location and a WAF exclusion for a search
  false positive: done.
- Structured parsing of the ModSecurity audit log into `waf-audit-*`: done.
- Secure access to all components (`xpack.security` on Elasticsearch, Kibana
  authenticating as `kibana_system` rather than `elastic`): done.
- **Retention/archiving policy (ILM)**: done — this document.