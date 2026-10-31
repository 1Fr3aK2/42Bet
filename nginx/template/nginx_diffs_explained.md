# Correção: Stale DNS Caching no NGINX
## O Problema
O NGINX, por defeito, resolve os nomes dos serviços Docker (como `backend`, `grafana`, `kibana`) para endereços IP **uma única vez — no momento em que arranca** — e guarda esse IP em memória para sempre. Nunca mais volta a perguntar ao DNS qual é o IP atual.
Num ambiente Docker, os contentores podem ser recriados a qualquer momento (crash, atualização, restart manual), e quando isso acontece, o Docker atribui-lhes **um IP diferente**. O NGINX não sabe disto e continua a enviar tráfego para o IP antigo — que já não pertence a ninguém ou pertence a outro contentor.
### O que acontecia sem esta correção
```
                    NGINX                         Docker Network
                    ┌─────────┐
  Pedido ──────────►│ Cache:  │──── http://172.19.0.7:8000 ────► ❌ Nada (IP antigo)
  curl /health      │ backend │
                    │ =       │                                    ✅ Backend real
                    │ 172.19. │                                    (agora em 172.19.0.12)
                    │ 0.7     │
                    └─────────┘
```
**Resultado visível para o utilizador:**
- `502 Bad Gateway` — o NGINX não consegue ligar-se ao IP antigo
- `403 Forbidden` — o ModSecurity (WAF) interceta o erro 502 e devolve 403
**Nos logs do NGINX aparecia:**
```
connect() failed (111: Connection refused) while connecting to upstream,
upstream: "http://172.19.0.7:8000/health/status"
```
> [!WARNING]
> Este problema significava que **não era possível reiniciar o backend sem reiniciar também o NGINX**. Qualquer manutenção ao backend (ou a qualquer outro serviço proxied) obrigava a um restart em cadeia de toda a infraestrutura.
---
## Como reproduzir o problema (antes da correção)
Para provar que o problema existia, seguimos estes passos:
```bash
# 1. Confirmar que o sistema está funcional
curl -k https://localhost/health
# ✅ {"status":"up","timestamp":"...","components":{"database":"up","redis":"up",...}}
# 2. Anotar o IP atual do backend
docker inspect backend --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
# Exemplo: 172.19.0.7
# 3. Parar e remover o backend
docker compose stop backend
docker compose rm -f backend
# 4. "Roubar" o IP antigo com um contentor dummy para forçar um IP diferente
docker run -d --name ladrao_de_ip --network transcendence_transcendence alpine sleep 3600
# 5. Recriar o backend (vai receber um IP diferente)
docker compose up -d --no-deps backend
# 6. Verificar que o IP mudou
docker inspect backend --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
# Exemplo: 172.19.0.12 (DIFERENTE do original!)
# 7. Tentar aceder — FALHA!
curl -k https://localhost/health
# ❌ 502 Bad Gateway ou 403 Forbidden
# 8. Confirmar nos logs
docker logs nginx 2>&1 | tail -5
# "connect() failed (111: Connection refused) ... upstream: http://172.19.0.7:8000"
#                                                            ^^^^^^^^^^^^^^^^^^^
#                                                            IP ANTIGO! Já não existe!
```
---
## As Alterações Realizadas
### Ficheiro 1: [default.conf.template](file:///wsl.localhost/Ubuntu-22.04/home/rafael/git/42/Transcendence/nginx/template/default.conf.template)
#### Alteração A — Resolver DNS do Docker
Adicionámos o resolver do Docker no bloco `server {}` de HTTPS:
```diff
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
+ resolver 127.0.0.11 valid=10s;
+ set $upstream_frontend http://frontend:5173;
+ set $upstream_backend http://backend:8000;
+ set $upstream_grafana http://grafana:3000;
+ set $upstream_prometheus http://prometheus:9090;
+ set $upstream_kibana http://kibana:5601;
+
  location / {
```
**O que faz cada parte:**
|
 Diretiva 
|
 Explicação 
|
|
----------
|
------------
|
|
`resolver 127.0.0.11`
|
 Aponta para o DNS interno do Docker. Todos os contentores na mesma rede Docker podem resolver nomes de serviço (como 
`backend`
) através deste endereço. 
|
|
`valid=10s`
|
 O NGINX só guarda a resposta do DNS durante 10 segundos. Passados 10s, volta a perguntar ao DNS qual é o IP atual. 
|
|
`set $upstream_*`
|
 Cria variáveis NGINX com os endereços dos serviços. Isto é 
**
essencial
**
 porque... 
|
> [!IMPORTANT]
> Quando o `proxy_pass` usa uma **string estática** (ex: `proxy_pass http://backend:8000;`), o NGINX resolve o hostname no arranque e **ignora completamente** o `resolver`. Só quando o `proxy_pass` usa uma **variável** (ex: `proxy_pass $upstream_backend;`) é que o NGINX é forçado a resolver o hostname **a cada pedido** usando o resolver configurado.
#### Alteração B — Todos os `proxy_pass` passaram a usar variáveis
**Antes (estático — resolve uma vez, fixa para sempre):**
```nginx
location /auth/ {
    proxy_pass http://backend:8000;    # ← hostname resolvido no arranque, NUNCA mais atualizado
}
location /grafana/ {
    proxy_pass http://grafana:3000;    # ← mesmo problema
}
```
**Depois (variável — resolve a cada pedido via DNS do Docker):**
```nginx
location /auth/ {
    proxy_pass $upstream_backend;      # ← re-resolvido a cada pedido (max a cada 10s)
}
location /grafana/ {
    proxy_pass $upstream_grafana;      # ← mesmo mecanismo
}
```
Esta alteração foi aplicada a **todos os 11 `location` blocks**:
|
 Location 
|
 Variável 
|
 Serviço alvo 
|
|
----------
|
----------
|
--------------
|
|
`/`
|
`$upstream_frontend`
|
 Frontend React (porta 5173) 
|
|
`/auth/`
|
`$upstream_backend`
|
 Backend NestJS (porta 8000) 
|
|
`/forum`
|
`$upstream_backend`
|
 Backend NestJS (porta 8000) 
|
|
`/api/admin`
|
`$upstream_backend`
|
 Backend NestJS (porta 8000) 
|
|
`/users`
|
`$upstream_backend`
|
 Backend NestJS (porta 8000) 
|
|
`/crypto`
|
`$upstream_backend`
|
 Backend NestJS (porta 8000) 
|
|
`/ws`
|
`$upstream_backend`
|
 Backend NestJS (porta 8000) 
|
|
`/socket.io/`
|
`$upstream_backend`
|
 Backend NestJS (porta 8000) 
|
|
`/grafana/`
|
`$upstream_grafana`
|
 Grafana (porta 3000) 
|
|
`/prometheus/`
|
`$upstream_prometheus`
|
 Prometheus (porta 9090) 
|
|
`/kibana/`
|
`$upstream_kibana`
|
 Kibana (porta 5601) 
|
#### Alteração C — Endpoint `/health` adaptado com `rewrite`
O endpoint `/health` tinha uma particularidade: usava `proxy_pass ${BACKEND}/health/status;` para reescrever o caminho (`/health` → `/health/status`). Com `proxy_pass` por variável, esta reescrita automática não funciona. A solução foi usar a diretiva `rewrite`:
**Antes:**
```nginx
location /health {
    limit_req zone=health burst=20 nodelay;
    proxy_pass ${BACKEND}/health/status;       # ← envsubst substitui ${BACKEND}, mas é estático
}
```
**Depois:**
```nginx
location /health {
    limit_req zone=health burst=20 nodelay;
    rewrite ^ /health/status break;            # ← reescreve o caminho antes de enviar
    proxy_pass $upstream_backend;              # ← envia para o backend com DNS dinâmico
}
```
---
### Ficheiro 2: [README.md](file:///wsl.localhost/Ubuntu-22.04/home/rafael/git/42/Transcendence/nginx/template/README.md)
O README foi atualizado para documentar esta correção:
1. **Nova secção "DNS resolution"** — explica o `resolver` e o porquê das variáveis
2. **Todos os code blocks atualizados** — agora mostram `$upstream_*` em vez de hostnames estáticos
3. **Secção `/health` atualizada** — documenta a abordagem com `rewrite`
4. **"Stale DNS caching" movido** de "Known limitations" para "previously a known limitation — now resolved"
5. **Referência `${BACKEND}` removida** da lista de variáveis envsubst (já não é usada)
---
## O Que Esta Correção Resolve
### Antes da correção
```
docker compose stop backend && docker compose up -d backend
# → NGINX continua a apontar para o IP antigo
# → 502/403 em TODOS os endpoints do backend
# → Solução: reiniciar também o NGINX (docker compose restart nginx)
```
### Depois da correção
```
docker compose stop backend && docker compose up -d backend
# → NGINX re-resolve o hostname "backend" automaticamente (em ≤10 segundos)
# → Todos os endpoints continuam a funcionar sem intervenção
# → NÃO é preciso reiniciar o NGINX
```
> [!TIP]
> Esta correção aplica-se a **todos** os serviços proxied, não apenas ao backend. Se o Grafana, Prometheus, Kibana ou o Frontend forem recriados, o NGINX também se adapta automaticamente.
### Diagrama — Fluxo com a correção
```
                    NGINX                              Docker DNS            Docker Network
                    ┌──────────┐                       ┌──────────┐
  Pedido ──────────►│ Variável │── "backend" IP? ─────►│ 127.0.0. │
  curl /health      │ $upstream│                       │ 11       │
                    │ _backend │◄─ 172.19.0.12 ───────│ (valid   │
                    │          │                       │  =10s)   │
                    │          │── http://172.19.0.12 ─│──────────┘──► ✅ Backend real
                    └──────────┘   :8000/health/status                  (172.19.0.12)
```
O NGINX agora pergunta ao DNS do Docker qual é o IP atual **antes de cada pedido** (com cache de 10 segundos), em vez de usar um valor fixo do arranque.
---
## Como verificar que a correção funciona
```bash
# 1. Reiniciar o NGINX com a nova configuração
docker compose restart nginx
# 2. Confirmar que tudo funciona normalmente
curl -k https://localhost/health
# ✅ {"status":"up",...}
# 3. Forçar mudança de IP do backend (mesmo teste de antes)
docker compose stop backend && docker compose rm -f backend
docker run -d --name ladrao_de_ip --network transcendence_transcendence alpine sleep 3600
docker compose up -d --no-deps backend
# 4. Esperar ~15 segundos para o backend ficar healthy
# 5. Testar — AGORA FUNCIONA!
curl -k https://localhost/health
# ✅ {"status":"up",...}  (antes dava 502/403!)
# 6. Limpar
docker stop ladrao_de_ip && docker rm ladrao_de_ip
```
