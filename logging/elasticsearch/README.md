# Elasticsearch ILM Init (`logging/elasticsearch/ilm-init.sh`)

## What it does

A one-shot bootstrap script that sets up **log retention** in Elasticsearch.
It creates an Index Lifecycle Management (ILM) policy, attaches that policy to
the indices the project writes logs to, and applies it to any indices that
already exist.

## Why it was needed

The subject's DevOps module for ELK asks for "log retention and archiving
policies". Without ILM, Elasticsearch keeps every log forever: on a
single-node setup with a 1 GB memory limit, the disk and the heap would
eventually fill up. ILM lets Elasticsearch manage the lifecycle of the indices
on its own, so retention is a property of the infrastructure rather than
something someone has to remember to clean up by hand.

## How it runs

The script is executed by the `elasticsearch_ilm_init` service in
`docker-compose.yml`:

- Uses the same Elasticsearch image as the cluster (it already ships `curl`),
  with `/bin/sh` as entrypoint and the script mounted read-only at
  `/scripts/ilm-init.sh`.
- Waits for `elasticsearch` to be healthy (`depends_on: service_healthy`).
- Receives `ELASTIC_PASSWORD` from the environment (from `.env`) and uses it
  for HTTP basic auth against `http://elasticsearch:9200`. Plain HTTP is
  acceptable here: this is internal container-to-container traffic, and the
  subject only requires HTTPS for connections coming from outside the backend.
- `restart: on-failure`: if any critical step fails, the container is
  restarted and tries again; once it exits successfully it stays stopped.

The script is **idempotent**. Every `PUT` replaces the previous definition with
the same content, so running it again (for example on every
`docker compose up`) is safe.

## Step by step

1. **Wait for Elasticsearch.** Polls the cluster health endpoint every 2
   seconds until it answers. This is a second safety net on top of the
   compose-level healthcheck.
2. **Create the ILM policy** `transcendence-logs-policy`.
3. **Create an index template** for `transcendence-logs-*` that points new
   indices at that policy.
4. **Create an index template** for `waf-audit-*` (the ModSecurity audit log,
   read by Filebeat from the shared volume) pointing at the same policy.
5. **Apply the policy retroactively** to any existing `transcendence-logs-*`
   and `waf-audit-*` indices.

### Why step 5 exists

An index template only affects indices created **after** the template exists.
Logstash does not wait for this init job (it only depends on Elasticsearch
being healthy), so it can create its first index before the templates are in
place. That index would then never get the policy and would never be deleted.
Updating the settings of existing indices closes that gap. Those two commands
end with `|| true` because they must not fail the whole script when no index
matches yet, which is the normal case on a first run.

## The policy

| Phase  | Condition                                   | Action                          |
|--------|---------------------------------------------|---------------------------------|
| Delete | 14 days after index creation                | Delete the index                |

Both log families (`transcendence-logs-*` and `waf-audit-*`) share the same
policy, so application logs and WAF audit logs have the same retention.

A detail worth knowing:

- ILM does not act instantly: Elasticsearch evaluates policies on a periodic
  poll (10 minutes by default), so deletions can lag slightly behind the
  configured age.

## How to verify it works

- In Kibana, open **Stack Management → Index Lifecycle Policies** and check
  that `transcendence-logs-policy` exists, and that it lists indices as linked
  to it.
- In **Index Management**, open a log index and check its lifecycle tab.
- In Kibana's Dev Tools, the `_ilm/explain` API on an index shows its current
  phase and, importantly, whether the policy is in an error step.
