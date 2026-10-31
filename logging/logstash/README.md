# Logstash Pipeline (`logging/logstash/pipeline/`)

## What it does

Receives logs from Filebeat, turns the **ModSecurity (WAF) audit log** into
structured, searchable fields, and routes everything to Elasticsearch in two
families of daily indices:

- `waf-audit-YYYY.MM.dd`: the parsed ModSecurity audit events.
- `transcendence-logs-YYYY.MM.dd`: all the other logs (everything that is not
  tagged as a WAF audit event). These are forwarded unchanged.

## Why it was needed

The ModSecurity audit log is a large JSON document per blocked or flagged
request, and in raw form it is nearly impossible to query: the useful details
(who, what, which rule, how severe) are buried several levels deep. The goal of
the pipeline is to answer questions in Kibana such as "which IPs are being
blocked most often", "which rules trigger most", or "what was the anomaly score
of this request" without having to open each raw event. It is also the piece
that makes the "Logstash to collect and transform logs" requirement of the ELK
module real, since the *transform* part happens here.

## Data flow

```
nginx + ModSecurity ─▶ audit.log (shared volume) ─▶ Filebeat ─▶ Logstash :5044 ─▶ Elasticsearch ─▶ Kibana
container logs (Docker) ──────────────────────────▶ Filebeat ─┘
```

## How it runs

Defined by the `logstash` service in `docker-compose.yml`:

- The pipeline directory is mounted read-only at
  `/usr/share/logstash/pipeline`.
- Starts only after `elasticsearch` is healthy.
- JVM heap limited to 256 MB inside a 512 MB container limit.
- `ELASTIC_PASSWORD` is provided as an environment variable and referenced in
  the output as `${ELASTIC_PASSWORD}`, so no password is written in the
  pipeline file.
- The Beats port (5044) is not published to the host. Only Filebeat, on the same
  Docker network, can reach it. Plain, unencrypted traffic is acceptable for
  this internal hop.

## Pipeline stages

### Input

A single `beats` input on port 5044. Filebeat is the only shipper.

### Filter

Everything below only runs for events whose `log_type` field equals
`modsec_audit`. That field is **set by Filebeat**, not by Logstash, so the
pipeline depends on the Filebeat configuration tagging the audit log
correctly. All other events skip the filter block entirely.

1. **Parse the JSON.** The raw line (`message`) is parsed into a nested object
   called `modsec`. This requires the audit log to be written in JSON format;
   the compose file does not override the audit log format, so this relies on the
   image's default.
2. **Flatten the key fields.** Copies four values out of the nested structure
   to top-level fields (`source_ip`, `http_method`, `uri`, `http_code`). The
   reason is practical: in Kibana, filtering and aggregating on a short
   top-level field is far easier than on a deep path. The full nested object is
   kept as well.
3. **Convert `http_code` to an integer** so it can be used in ranges and
   numeric aggregations (for example "all 4xx responses").
4. **Extract rule information.** A Ruby block walks through the list of rules
   that matched the request and produces:
   - `rule_ids`: the de-duplicated list of every rule ID that matched.
   - `anomaly_score` and `anomaly_direction`: when the matched rule is the
     OWASP CRS "anomaly score exceeded" rule (949110 for inbound, 959100 for
     outbound), the numeric score is read out of its message text.
   - `rule_id`, `rule_message`, `rule_severity`: the **first matched rule that
     is not** one of the two score rules.

   The split is deliberate. With the CRS in anomaly-scoring mode, the rule that
   actually blocks the request is always the generic "score exceeded" rule. If
   it were treated like any other rule, it would hide what really triggered the
   block (for example a SQL injection rule). Keeping the score and the
   triggering rule in separate fields gives both pieces of information.
5. **Set the event timestamp.** Reads the transaction time from the audit
   record and uses it as `@timestamp`, so events appear in Kibana at the moment
   the request happened rather than when Logstash processed it. If parsing
   fails, Logstash keeps the ingestion time and tags the event.
6. **Drop the raw `message`**, which is redundant once it has been parsed, to
   save storage.

### Output

Two Elasticsearch outputs chosen by a conditional: WAF audit events go to
`waf-audit-%{+YYYY.MM.dd}`, everything else to
`transcendence-logs-%{+YYYY.MM.dd}`. 
Both authenticate using the dedicated least-privilege user `logstash_writer` 
(provisioned by `elasticsearch_ilm_init`) with `manage_template => false` so 
that index lifecycle management (ILM) and templates are managed exclusively 
by cluster policies. The date in the index name creates **one index per day**.
## Fields reference

| Field               | Type    | Meaning                                                        |
|---------------------|---------|----------------------------------------------------------------|
| `source_ip`         | string  | Client IP address                                              |
| `http_method`       | string  | HTTP method of the request                                     |
| `uri`               | string  | Requested URI                                                  |
| `http_code`         | integer | HTTP status code returned                                      |
| `anomaly_score`     | integer | CRS total anomaly score (only on events that exceeded the threshold) |
| `anomaly_direction` | string  | `inbound` or `outbound`                                        |
| `rule_id`           | string  | First matched rule that is not a score rule                    |
| `rule_message`      | string  | Message of that rule                                           |
| `rule_severity`     | string  | Severity of that rule                                          |
| `rule_ids`          | array   | Every distinct rule ID that matched                            |
| `modsec`            | object  | The full parsed audit transaction                              |

## Relationship with the ILM policy

The index names above are what the index templates created by `ilm-init.sh`
match (`waf-audit-*` and `transcendence-logs-*`). That is how new daily indices
receive the retention policy automatically.

However, these are plain daily indices: the output sets no rollover alias and
does not use data streams. The ILM policy currently includes a rollover action,
and that action needs an alias or a data stream to work. If it does not, the
index ends up in an error state and the delete phase never runs. Because each
index is already created per day, the rollover is redundant here, and the
simplest consistent setup is a policy with only a delete phase. See the
limitations in the `ilm-init.sh` documentation.

## How to verify it works

- Trigger the WAF on purpose (for example with an obviously malicious query
  string against the site) and look for the event in the `waf-audit-*` index in
  Kibana's Discover.
- Check that the flat fields have real values. A field that contains a literal
  `%{[modsec]...` text means the corresponding value was missing in the audit
  record, because Logstash leaves unresolved references as plain text.
- Look for events tagged with a parse failure, either for the JSON (a broken
  audit format) or for the date.
- Check that blocked requests have `anomaly_score` and a `rule_id` that points
  to the real cause, not just the score rule.

## Design Notes & Caveats

These are important operational details to be aware of:

- **Request and response bodies may be indexed.** The audit log parts
  configured on the WAF include the (reduced) request body and the response
  body. In a web app, that can include whatever the user submitted, such as
  credentials on a login form. All of it ends up in `modsec`. Check what a
  blocked login request looks like in Elasticsearch, and if it holds sensitive
  data, either sanitise it at ModSecurity level, remove those audit parts, or
  strip the fields in this pipeline. This is also relevant to the Privacy
  Policy, since the app would be storing personal data in the logs.
- **Only WAF events are parsed.** Everything else is forwarded as received, so
  the other logs are searchable as text but have no extracted fields.
- **The Ruby block assumes well-formed messages.** If a matched-rule entry has
  no message text, the code would raise an error, and the event would be
  tagged with a Ruby exception instead of being enriched. It is unlikely with
  CRS rules but possible.
- **`rule_id` is the first matched rule, not the most severe.** For requests
  that trigger several rules, the one reported depends on the order the WAF
  evaluated them. The full list stays available in `rule_ids`.
- **Timezone.** The audit timestamp has no timezone, so Logstash interprets it
  in its own (container) timezone. This is consistent as long as all the
  containers run in UTC, which is the default.
- **Superuser credentials.** The output authenticates as `elastic`. A dedicated
  user limited to writing to these indices would follow least privilege more
  closely.