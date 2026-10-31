# Backend Health Check

## Objetivo

O backend NestJS expõe dois endpoints de health check, com propósitos
diferentes — não um só como numa versão anterior deste documento.

---

# Endpoints

## GET `/health`

### Descrição

Endpoint simples, pensado para uso **interno**: é o que o `healthcheck:` do
serviço `backend` no `docker-compose.yml` consulta para decidir se o backend
está `healthy`, e é também o que outros serviços esperam
(`condition: service_healthy`) antes de arrancarem.

Verifica:

- Ligação ao PostgreSQL (via Prisma, `SELECT 1`)
- Ligação ao Redis (`PING`)
- Ligação ao Vault (`GET /v1/sys/health` via HTTPS, com o CA correto)

Devolve `503` (via `ServiceUnavailableException`) se algum destes três
estiver em baixo.

**Decisão deliberada: o Elasticsearch não entra neste endpoint.** O
Elasticsearch pode legitimamente demorar mais tempo a ficar pronto do que os
outros três (por exemplo, depois de um `make re`), e incluí-lo aqui faria o
backend ficar `unhealthy` nesses momentos, atrasando sem necessidade
qualquer serviço que dependa de `backend: condition: service_healthy` —
mesmo o backend em si estando perfeitamente funcional. Ver
`SECURITY_REPORT.md` §7.

### Resposta — 200 OK

```json
{
  "status": "ok",
  "database": "up",
  "redis": "up",
  "vault": "up"
}
```

### Resposta — 503 Service Unavailable

Mesmo formato, com `"status": "error"` e o(s) componente(s) em baixo
marcados como `"down"`.

---

## GET `/health/status`

### Descrição

Endpoint mais rico, pensado para consumo **externo** — é o que está exposto
publicamente através do nginx em `/health` (ver `NGINX_CONFIG.md`), e o que
a status page pública (`/status`) consulta a cada 10 segundos para mostrar o
estado do sistema.

Verifica os mesmos três componentes do `/health`, **mais o Elasticsearch**
(via `_cluster/health`, autenticado com as credenciais do utilizador
`elastic`).

Ao contrário do `/health`, **devolve sempre `200`** — mesmo com componentes
em baixo — porque o próprio propósito deste endpoint é reportar o estado,
não falhar quando algo está mal. Um `503` aqui esconderia exatamente a
informação que a status page precisa de mostrar.

### Resposta

```json
{
  "status": "up",
  "timestamp": "2026-09-30T15:12:03.569Z",
  "components": {
    "database": "up",
    "redis": "up",
    "vault": "up",
    "elasticsearch": "up"
  }
}
```

`status` pode ser:

- `"up"` — todos os componentes operacionais
- `"degraded"` — pelo menos um componente em baixo, mas não todos
- `"down"` — todos os componentes em baixo

---

# Porque dois endpoints em vez de um

Cada um responde a uma pergunta diferente:

- **`/health`** — "o backend está pronto para o Docker o considerar
  saudável?" — usado por máquinas, internamente, com consequências diretas
  na ordem de arranque do stack.
- **`/health/status`** — "qual é o estado atual do sistema, para quem está a
  olhar de fora?" — usado por humanos (via `/status`) ou por scripts
  externos que só querem saber o estado, sem afetar o arranque de mais
  nada.

Detalhe de implementação, bugs encontrados, e a exposição pública completa
(nginx + status page + rate limiting dedicado) estão documentados em
`SECURITY_REPORT.md` §7 e `NGINX_CONFIG.md` — não duplicados aqui.