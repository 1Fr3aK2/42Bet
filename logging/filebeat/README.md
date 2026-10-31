# Filebeat (`logging/filebeat/`)

## What it does

Filebeat is the log shipper of the ELK stack. It collects logs from two sources:

* Docker container logs.
* The ModSecurity (WAF) audit log.

It forwards all collected events to Logstash on port `5044`, where they are either parsed and enriched or forwarded unchanged to Elasticsearch.

For ModSecurity audit events, Filebeat adds the field:

```text
log_type: modsec_audit
```

This tag is important because Logstash uses it to distinguish WAF audit events from all other logs.

---

## Why it was needed

The application runs several Docker containers, and their logs need to be collected centrally instead of being inspected individually with commands such as `docker logs`.

Filebeat provides the collection layer between the containers/WAF and Logstash:

```text
Docker containers ────────┐
                          ├──▶ Filebeat ─▶ Logstash ─▶ Elasticsearch ─▶ Kibana
ModSecurity audit.log ────┘
```

This makes Filebeat responsible for **collecting and shipping** logs, while Logstash is responsible for the **transformation and routing** of the logs.

The distinction is important for the ELK module requirement: Filebeat handles log collection, while the Logstash pipeline performs the processing of the ModSecurity events.

---

## Data flow

```text
Docker container logs
        │
        ▼
/var/lib/docker/containers/*/*.log
        │
        ▼
     Filebeat
        │
        │
        ├──────────────────────────────┐
        │                              │
        ▼                              ▼
ModSecurity audit log              Other logs
/var/log/modsecurity/audit.log     Docker container logs
        │                              │
        │                              │
        └──────────────┬───────────────┘
                       ▼
                 Logstash :5044
                       │
                       ▼
                 Elasticsearch
                       │
                       ▼
                    Kibana
```

---

## How it runs

The Filebeat image is defined by the accompanying `Dockerfile`:

```dockerfile
FROM docker.elastic.co/beats/filebeat:8.19.18
COPY --chown=root:root filebeat.yml /usr/share/filebeat/filebeat.yml
# Filebeat refuses a config file writable by group/others. The copied file
# keeps the host's mode (664 with umask 002), so fix it in the image.
USER root
RUN chmod go-w /usr/share/filebeat/filebeat.yml
```

The image uses **Filebeat 8.19.18**, matching the Elastic stack version used by the project.

The custom configuration is copied into Filebeat's standard configuration location:

```text
/usr/share/filebeat/filebeat.yml
```

Ownership by `root` is not enough on its own. Filebeat also checks the file
mode and refuses to start if the configuration file is writable by group or
others. `COPY` preserves the mode of the file on the host (`664` with
`umask 002`), so the `chmod go-w` step normalizes it to `644` inside the
image.

This makes the build independent of the host's `umask` and of the file mode
stored in the repository: the same image is produced on any machine.

The `USER root` instruction is explicit because the `chmod` step needs it, and
the container reads Docker's log files under `/var/lib/docker/containers`,
which are not readable by unprivileged users.

---

## Configuration

The complete configuration is contained in:

```text
logging/filebeat/filebeat.yml
```

It contains three main parts:

1. Docker log collection.
2. ModSecurity audit log collection.
3. Logstash output.

---

## Docker logs

### Autodiscover

Docker container logs are collected using Filebeat's Docker autodiscover provider:

```yaml
filebeat.autodiscover:
  providers:
    - type: docker
      hints.enabled: true
      hints.default_config:
        type: container
        paths:
          - /var/lib/docker/containers/${data.container.id}/*.log
```

The `docker` provider allows Filebeat to automatically discover containers and start log inputs for them.

The `${data.container.id}` variable is replaced with the ID of each discovered container.

The resulting path points to Docker's standard JSON log files:

```text
/var/lib/docker/containers/<container-id>/*.log
```

This means the configuration does not need to manually list every application container.

---

## Docker hints

Docker hints are enabled:

```yaml
hints.enabled: true
```

Hints allow container metadata to influence how Filebeat collects logs.

A default configuration is provided:

```yaml
hints.default_config:
  type: container
  paths:
    - /var/lib/docker/containers/${data.container.id}/*.log
```

This acts as the fallback configuration for containers that do not provide more specific Filebeat hints.

As a result, normal Docker container logs are collected without requiring a separate input for every service.

---

## ModSecurity audit log

The ModSecurity audit log is collected using a separate Filebeat input:

```yaml
filebeat.inputs:
  - type: log
    enabled: true
    paths:
      - /var/log/modsecurity/audit.log
```

This is separate from the Docker autodiscover input because the audit log is exposed as a regular file rather than being collected directly from a Docker container's standard output.

The file is shared from the Nginx/ModSecurity environment into the Filebeat container.

---

## Identifying WAF audit events

The most important part of the ModSecurity input is:

```yaml
fields:
  log_type: modsec_audit
fields_under_root: true
```

This adds the following field to every event read from the ModSecurity audit log:

```text
log_type = modsec_audit
```

Because `fields_under_root` is enabled, the field is placed directly at the root of the event instead of being nested under another field.

For example:

```json
{
  "log_type": "modsec_audit",
  "message": "{ ... ModSecurity JSON ... }"
}
```

This field is later used by Logstash:

```text
if [log_type] == "modsec_audit"
```

Only events carrying this tag enter the ModSecurity parsing and enrichment logic.

This means **Filebeat is responsible for classifying WAF events**, while Logstash is responsible for processing them.

---

## Why the `log_type` field matters

Without the `log_type` field, Logstash would have to determine whether an event came from ModSecurity by inspecting the contents of the log itself.

That would be less reliable and would unnecessarily couple the Logstash pipeline to the exact format of every incoming log.

With the explicit tag:

```text
log_type = modsec_audit
```

the responsibilities are clearly separated:

```text
Filebeat
   │
   ├── Collect log
   └── Identify ModSecurity audit log
             │
             ▼
         Logstash
             │
             ├── Parse ModSecurity JSON
             ├── Extract useful fields
             ├── Extract rule information
             └── Route to the appropriate index
```

---

## Output

All Filebeat events are sent to Logstash:

```yaml
output.logstash:
  hosts: ["logstash:5044"]
```

Filebeat therefore does not send logs directly to Elasticsearch.

The communication path is:

```text
Filebeat ──▶ Logstash:5044 ──▶ Elasticsearch
```

Port `5044` is the Beats input configured on the Logstash container.

Because both services run on the Docker network, Filebeat can resolve:

```text
logstash
```

as the Logstash container hostname.

The port does not need to be exposed to the host machine.

---

## Logging

Filebeat's own logging level is configured as:

```yaml
logging.level: info
```

This provides normal operational information without enabling the much more verbose debug logging.

For troubleshooting, the level can temporarily be increased, but `info` is appropriate for normal operation.

---

## Relationship with Logstash

Filebeat and Logstash have deliberately different responsibilities.

### Filebeat

Filebeat:

* Discovers Docker containers.
* Reads Docker container logs.
* Reads the ModSecurity audit log.
* Tags ModSecurity events with `log_type: modsec_audit`.
* Sends events to Logstash.

### Logstash

Logstash:

* Receives events from Filebeat on port `5044`.
* Detects `modsec_audit` events.
* Parses the ModSecurity JSON.
* Extracts useful WAF fields.
* Extracts matched rule information.
* Extracts the anomaly score.
* Sets the event timestamp.
* Routes WAF and non-WAF events to different Elasticsearch indices.

The separation can therefore be represented as:

```text
                COLLECTION                 PROCESSING
                    │                          │
                    ▼                          ▼
              ┌──────────┐              ┌───────────┐
              │ Filebeat │─────────────▶│ Logstash  │
              └──────────┘              └───────────┘
                    │                          │
          ┌─────────┴─────────┐                │
          │                   │                │
          ▼                   ▼                ▼
     Docker logs       ModSecurity       Parse / enrich /
                          audit.log       route events
```

---

## Files

The Filebeat configuration consists of:

```text
logging/filebeat/
├── Dockerfile
├── filebeat.yml
└── README.md
```

### `Dockerfile`

Builds the Filebeat image using Elastic's official `8.19.18` image, copies the project configuration into the container and removes group/other write permissions from `filebeat.yml` (Filebeat refuses to start otherwise).

### `filebeat.yml`

Defines:

* Docker autodiscovery.
* Docker log paths.
* ModSecurity audit log input.
* The `modsec_audit` event tag.
* Logstash as the output.
* Filebeat logging level.

---

## How to verify it works

### 1. Check that the Filebeat container is running

```bash
docker ps
```

The Filebeat container should be running alongside the other ELK services.

---

### 2. Check Filebeat logs

```bash
docker logs filebeat
```

Look for messages indicating that Filebeat has started successfully and is communicating with Logstash.

If the container has a different name, use:

```bash
docker ps --format '{{.Names}}'
```

to find it.

---

### 3. Check the configuration file permissions

```bash
docker exec filebeat ls -l /usr/share/filebeat/filebeat.yml
```

The file should be owned by `root` and must not be writable by group or
others (expected mode: `-rw-r--r--`, i.e. `644`).

---

### 4. Check the ModSecurity audit file

Inside the Filebeat container:

```bash
docker exec filebeat ls -l /var/log/modsecurity/audit.log
```

The file should exist and contain the audit events generated by ModSecurity.

---

### 5. Generate a WAF event

Trigger a request that is expected to be detected by the ModSecurity/OWASP CRS configuration.

Then check the audit log:

```bash
docker exec nginx tail -n 1 /var/log/modsecurity/audit.log
```

The exact command may vary depending on how the audit log is mounted and formatted.

---

### 6. Verify the event reaches Logstash

Check the Logstash logs:

```bash
docker logs logstash
```

The event should arrive through:

```text
logstash:5044
```

---

### 7. Verify the `log_type` field

In Kibana, a ModSecurity event should contain:

```text
log_type: modsec_audit
```

This confirms that Filebeat correctly classified the event before sending it to Logstash.

---

### 8. Verify Elasticsearch indices

After Logstash processes the event, WAF events should appear in:

```text
waf-audit-YYYY.MM.dd
```

Other logs should appear in:

```text
transcendence-logs-YYYY.MM.dd
```

The actual parsing and routing of these events is performed by the Logstash pipeline.

---

## Design Notes

### The config file must not be group/other-writable

Filebeat validates the permissions of its configuration file and exits at
startup with a permissions error if the file is writable by group or others.

The file keeps the mode it has on the host when it is copied into the image
(`664` with `umask 002`), and `--chown=root:root` only changes the owner, not
the mode. The Dockerfile therefore runs:

```dockerfile
RUN chmod go-w /usr/share/filebeat/filebeat.yml
```

If Filebeat exits immediately after starting with a message about the config
file permissions, check this step first.

---

### Only the configured audit file is collected

The ModSecurity input specifically watches:

```text
/var/log/modsecurity/audit.log
```

If ModSecurity writes its audit data to a different path, Filebeat will not collect it unless the path is changed accordingly.

---

### The WAF tag depends on this input configuration

Logstash expects:

```text
log_type = modsec_audit
```

If the field is removed, renamed, or moved from the event root, Logstash will no longer identify the event as a ModSecurity audit event.

The relevant configuration is:

```yaml
fields:
  log_type: modsec_audit
fields_under_root: true
```

Therefore, this configuration and the Logstash conditional must remain consistent.

---

### Filebeat does not parse the ModSecurity JSON

Filebeat deliberately does not perform the detailed ModSecurity parsing.

It forwards the raw audit event and adds the identifying field:

```text
log_type: modsec_audit
```

The JSON parsing and extraction of fields such as:

```text
source_ip
http_method
uri
http_code
anomaly_score
rule_id
```

are performed by Logstash.

This keeps the collection layer simple and leaves transformation in the Logstash pipeline.

---

### Docker logs are not enriched by this configuration

Normal Docker logs are collected and forwarded, but this Filebeat configuration does not perform application-specific parsing or transformation on them.

They are subsequently handled by Logstash as non-WAF events.

---

### Logstash is required

Filebeat is configured exclusively with:

```yaml
output.logstash:
  hosts: ["logstash:5044"]
```

Therefore, Filebeat does not have a direct Elasticsearch output configured.

If Logstash is unavailable, Filebeat cannot complete the normal delivery path to Elasticsearch until the connection is restored.

---

## Summary

Filebeat is the **collection and shipping layer** of the logging architecture.

Its main responsibilities are:

```text
1. Discover Docker containers
2. Collect Docker logs
3. Collect ModSecurity audit.log
4. Mark WAF events as modsec_audit
5. Send everything to Logstash
```

The complete ELK flow is:

```text
┌─────────────────────┐
│ Docker containers   │
│                     │
│ application logs    │
└──────────┬──────────┘
           │
           │
           ▼
     ┌───────────┐
     │ Filebeat  │◀──── /var/log/modsecurity/audit.log
     └─────┬─────┘
           │
           │ Beats :5044
           ▼
     ┌───────────┐
     │ Logstash  │
     │           │
     │ Parse WAF │
     │ Enrich    │
     │ Route     │
     └─────┬─────┘
           │
           ▼
     ┌──────────────┐
     │ Elasticsearch│
     └──────┬───────┘
            │
            ▼
        ┌────────┐
        │ Kibana │
        └────────┘
```

The key design decision is that **Filebeat collects and identifies the logs, while Logstash transforms and routes them**.