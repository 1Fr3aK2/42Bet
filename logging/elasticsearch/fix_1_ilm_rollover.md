# Fix: Elasticsearch ILM Rollover Error

## The Original Problem

The initialization script (`ilm-init.sh`) defined an Index Lifecycle Management (ILM) policy with a `hot` phase that triggered a `rollover` action when an index reached 1 day of age or 5GB in size. 

However, the Logstash pipeline in this project is configured to write logs to plain, date-named indices (e.g., `transcendence-logs-YYYY.MM.DD`). A `rollover` action requires a write alias or a data stream to function correctly. Because neither was present, the ILM policy would fail on the `hot` phase, entering an error state. 

When an ILM policy enters an error state, it never progresses to subsequent phases. As a result, the `delete` phase (which was supposed to remove logs after 14 days) was never reached, meaning logs would be retained indefinitely, eventually exhausting disk space.

## The Applied Change

The ILM policy in `logging/elasticsearch/ilm-init.sh` was simplified to remove the incompatible `hot` phase and its `rollover` action, leaving only the `delete` phase:

```diff
     "policy": {
       "phases": {
-        "hot": {
-          "min_age": "0ms",
-          "actions": {
-            "rollover": {
-              "max_age": "1d",
-              "max_size": "5gb"
-            }
-          }
-        },
         "delete": {
           "min_age": "14d",
```

## What this Affects

1. **Functional Log Retention:** The ILM policy will now successfully apply to the daily indices created by Logstash. Since there is no `rollover` action to fail, the indices will smoothly transition to the `delete` phase exactly 14 days after their creation, ensuring disk space is automatically freed.
2. **Cluster Health:** Prevents indices from entering a perpetual ILM error state, keeping the Elasticsearch logs clean and the index management dashboard error-free.
3. **Simplicity:** It aligns the retention policy perfectly with the existing Logstash output configuration without requiring complex alias management or data streams.
