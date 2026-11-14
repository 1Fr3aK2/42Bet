path "secret/data/postgres" {
    capabilities = ["read"]
}

path "secret/data/redis" {
    capabilities = ["read"]
}

path "secret/data/admin-api" {
  capabilities = ["read"]
}

path "secret/data/admin-account" {
  capabilities = ["read"]
}

path "secret/data/jwt" {
  capabilities = ["read"]
}

path "secret/data/elasticsearch-monitor" {
  capabilities = ["read"]
}
