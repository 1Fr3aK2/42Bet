# Fix: Archiving via Snapshot Lifecycle Management (SLM)

## The Original Problem

The subject explicitly requests "retention and archiving policies." While the Index Lifecycle Management (ILM) policy successfully fulfilled the "retention" part by deleting logs after 14 days, there was no mechanism in place for "archiving" (i.e., making backup copies of the data to an external location before it is deleted). 

## The Applied Change

To achieve true archiving, we implemented Snapshot Lifecycle Management (SLM) within Elasticsearch:

1. **Volume Mapping:** In `docker-compose.yml`, the Elasticsearch container now maps a local directory (`./backups/elasticsearch`) to `/usr/share/elasticsearch/backups`, and configures `path.repo` to allow snapshots to be stored there.
2. **Initialization Service:** A lightweight Alpine container (`elasticsearch_backups_init`) runs before Elasticsearch to ensure the backup directory is correctly owned by the Elasticsearch user (UID 1000).
3. **SLM Configuration:** The `ilm-init.sh` script now:
   - Registers a `fs` (file system) snapshot repository named `local_backup`.
   - Creates an SLM policy named `daily-snapshots` that runs every day at midnight.
   - The policy takes a snapshot of all indices and retains these backups for 30 days.

## What this Affects

1. **Subject Compliance:** The ELK stack now fully complies with both the "retention" and "archiving" requirements.
2. **Disaster Recovery:** If the active Elasticsearch data volume (`elasticsearch-data`) is corrupted or lost, the logs can be fully restored from the compressed snapshots stored in the host's `./backups/elasticsearch` directory.
3. **Automated Maintenance:** Just like ILM, SLM manages itself. Snapshots older than 30 days are automatically pruned, ensuring the backup drive does not fill up indefinitely.
