#!/bin/sh
set -e

echo "Waiting for Elasticsearch to be ready..."
until curl -sf -u "elastic:$ELASTIC_PASSWORD" "http://elasticsearch:9200/_cluster/health" > /dev/null; do
  sleep 2
done

# Generate a random password for the temporary ilm_admin user
ILM_PASS=$(head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)

echo "Creating ILM/SLM admin role..."
curl -sf -u "elastic:$ELASTIC_PASSWORD" -X POST "http://elasticsearch:9200/_security/role/ilm_admin_role" \
  -H "Content-Type: application/json" \
  -d '{
    "cluster": ["manage", "manage_ilm", "manage_slm", "manage_index_templates"],
    "indices": [
      {
        "names": ["*"],
        "privileges": ["manage", "read"]
      }
    ]
  }'

echo "Creating ilm_admin user..."
curl -sf -u "elastic:$ELASTIC_PASSWORD" -X POST "http://elasticsearch:9200/_security/user/ilm_admin" \
  -H "Content-Type: application/json" \
  -d '{
    "password": "'"$ILM_PASS"'",
    "roles": ["ilm_admin_role"]
  }'

# From now on, use the ilm_admin user for all operations
AUTH="ilm_admin:$ILM_PASS"

echo "Registering snapshot repository..."
curl -sf -u "$AUTH" -X PUT "http://elasticsearch:9200/_snapshot/local_backup" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "fs",
    "settings": {
      "location": "/usr/share/elasticsearch/backups"
    }
  }'

echo "Creating SLM policy..."
curl -sf -u "$AUTH" -X PUT "http://elasticsearch:9200/_slm/policy/daily-snapshots" \
  -H "Content-Type: application/json" \
  -d '{
    "schedule": "0 0 0 * * ?",
    "name": "<daily-snap-{now/d}>",
    "repository": "local_backup",
    "config": {
      "indices": ["*"],
      "ignore_unavailable": true,
      "include_global_state": true
    },
    "retention": {
      "expire_after": "30d",
      "min_count": 5,
      "max_count": 30
    }
  }'

echo "Creating ILM policy..."
curl -sf -u "$AUTH" -X PUT "http://elasticsearch:9200/_ilm/policy/transcendence-logs-policy" \
  -H "Content-Type: application/json" \
  -d '{
    "policy": {
      "phases": {
        "delete": {
          "min_age": "14d",
          "actions": {
            "delete": {}
          }
        }
      }
    }
  }'

echo "Creating index template for transcendence-logs-*..."
curl -sf -u "$AUTH" -X PUT "http://elasticsearch:9200/_index_template/transcendence-logs-template" \
  -H "Content-Type: application/json" \
  -d '{
    "index_patterns": ["transcendence-logs-*"],
    "template": {
      "settings": {
        "index.lifecycle.name": "transcendence-logs-policy",
        "index.number_of_replicas": "0"
      }
    }
  }'

echo "Creating index template for waf-audit-*..."
curl -sf -u "$AUTH" -X PUT "http://elasticsearch:9200/_index_template/waf-audit-template" \
  -H "Content-Type: application/json" \
  -d '{
    "index_patterns": ["waf-audit-*"],
    "template": {
      "settings": {
        "index.lifecycle.name": "transcendence-logs-policy",
        "index.number_of_replicas": "0"
      }
    }
  }'

echo "Applying policy to existing transcendence-logs-* indices..."
curl -sf -u "$AUTH" -X PUT "http://elasticsearch:9200/transcendence-logs-*/_settings?ignore_unavailable=true" \
  -H "Content-Type: application/json" \
  -d '{"index.lifecycle.name": "transcendence-logs-policy"}' || true

echo "Applying policy to existing waf-audit-* indices..."
curl -sf -u "$AUTH" -X PUT "http://elasticsearch:9200/waf-audit-*/_settings?ignore_unavailable=true" \
  -H "Content-Type: application/json" \
  -d '{"index.lifecycle.name": "transcendence-logs-policy"}' || true

# Criar papel restrito permanente para o Logstash
echo "Creating permanent logstash_writer role..."
curl -sf -u "elastic:$ELASTIC_PASSWORD" -X POST "http://elasticsearch:9200/_security/role/logstash_writer_role" \
  -H "Content-Type: application/json" \
  -d '{
    "cluster": ["monitor", "manage_index_templates"],
    "indices": [
      {
        "names": ["transcendence-logs-*", "waf-audit-*"],
        "privileges": ["create_index", "create", "write", "auto_configure", "view_index_metadata"]
      }
    ]
  }'

# Criar utilizador restrito permanente para o Logstash
echo "Creating logstash_writer user..."
curl -sf -u "elastic:$ELASTIC_PASSWORD" -X POST "http://elasticsearch:9200/_security/user/logstash_writer" \
  -H "Content-Type: application/json" \
  -d '{
    "password": "'"$ELASTIC_PASSWORD"'",
    "roles": ["logstash_writer_role"]
  }'

echo "Cleaning up ilm_admin user..."
curl -sf -u "elastic:$ELASTIC_PASSWORD" -X DELETE "http://elasticsearch:9200/_security/user/ilm_admin"

echo "ILM, SLM and Logstash least-privilege setup complete."
