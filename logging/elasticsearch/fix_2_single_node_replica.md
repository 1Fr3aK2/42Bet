# Fix: Elasticsearch Single Node Replica (Yellow Status)

## The Original Problem

By default, whenever Elasticsearch creates a new index, it attempts to assign it `1` primary shard and `1` replica shard (for high availability and fault tolerance).

Because this project runs in a constrained local Docker environment with only a single Elasticsearch node, there is nowhere to place the replica shard. Elasticsearch explicitly prevents assigning a primary and a replica of the same shard to the same node. As a result, the replica shard remains in an "unassigned" state permanently, causing the overall cluster health status to degrade from `Green` to `Yellow`.

## The Applied Change

The index templates created by `ilm-init.sh` (both `transcendence-logs-template` and `waf-audit-template`) were updated to explicitly tell Elasticsearch to expect `0` replicas for new log indices.

```diff
     "template": {
       "settings": {
-        "index.lifecycle.name": "transcendence-logs-policy"
+        "index.lifecycle.name": "transcendence-logs-policy",
+        "index.number_of_replicas": "0"
       }
     }
```

## What this Affects

1. **Green Cluster Health:** New log indices created by Logstash or Filebeat will no longer request a replica. This allows Elasticsearch to fully allocate all requested shards on the single available node, returning the cluster status to a healthy `Green`.
2. **Resource Efficiency:** The system no longer wastes overhead attempting to allocate non-existent replica shards.
3. **Cleaner Dashboards:** When accessing Kibana, the cluster will not display persistent warnings about unassigned shards, making it much easier to spot actual, legitimate infrastructure issues if they arise during evaluation.
