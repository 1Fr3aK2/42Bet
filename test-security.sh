#!/usr/bin/env bash
# ============================================================
# 42Bet - testes de seguranca (ver SECURITY_HARDENING.md)
# ============================================================
#
# Cada teste PASSA ("OK") quando a defesa existe e FALHA ("VULNERAVEL")
# quando falta. Sai com codigo 1 se houver algum VULNERAVEL (serve na CI).
#
# Usage:  bash scripts/test-security.sh        (stack iniciada com make, na raiz do repo)
#         BASE_URL=https://localhost:8443 bash scripts/test-security.sh
#         LOGIN_GAP=10 bash scripts/test-security.sh   (mais lento, se o nginx ainda der 429)
# Needs:  curl, python3, base64 (GNU, -w0), grep.
#
# Duracao: cerca de 1 minuto. O nginx permite 10 logins por minuto por IP, por isso
# o S1 espaca os logins (LOGIN_GAP segundos) e repete uma vez se receber 429/503.
# Espera 1 minuto depois de qualquer outro script que faca login (test-users.sh, ...).
#
# ============================================================

BASE_URL="${BASE_URL:-https://localhost}"
PASSWORD='Password123!'
LOGIN_GAP="${LOGIN_GAP:-8}"
OK=0
VULN=0

ok()   { OK=$((OK + 1)); printf '  OK          %s\n' "$1"; }
vuln() { VULN=$((VULN + 1)); printf '  VULNERAVEL  %-55s %s\n' "$1" "$2"; }
note() { printf '  AVISO       %s\n' "$1"; }

expect() { # NAME EXPECTED ACTUAL
  if [ "$2" = "$3" ]; then ok "$1"; else vuln "$1" "esperado [$2], obtido [$3]"; fi
}

# call METHOD PATH [TOKEN] [JSON] -> sets CODE (HTTP status) and BODY
call() {
  local args=(-sk -w '\n%{http_code}' -X "$1" "$BASE_URL$2")
  [ -n "$3" ] && args+=(-H "Authorization: Bearer $3")
  [ -n "$4" ] && args+=(-H 'Content-Type: application/json' --data "$4")
  local response
  response=$(curl "${args[@]}")
  CODE=${response##*$'\n'}
  BODY=${response%$'\n'*}
}

# login IDENTIFIER PASSWORD -> como call, mas se o nginx limitar (429/503)
# espera 20 s e repete uma vez. Um 429 do nginx nao chega ao backend, por isso
# nao conta como tentativa falhada.
login() {
  local payload="{\"username\":\"$1\",\"password\":\"$2\"}"
  call POST /auth/login "" "$payload"
  if [ "$CODE" = 429 ] || [ "$CODE" = 503 ]; then
    note "nginx limitou os logins ($CODE), a esperar 20 s e a repetir"
    sleep 20
    call POST /auth/login "" "$payload"
  fi
}

# field PATH -> valor no JSON de BODY (vazio se nao existir)
field() {
  printf '%s' "$BODY" | python3 -I -c '
import json, sys
try:
    value = json.load(sys.stdin)
    for key in sys.argv[1].split("."):
        value = value[key]
    print(value)
except Exception:
    print("")' "$1"
}

# ------------------------------------------------------------
echo "== Preparacao: conta principal (com campos extra, ver S5)"
USER="sec$RANDOM$RANDOM"
EMAIL="$USER@example.com"
call POST /users "" "{\"username\":\"$USER\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"role\":\"ADMIN\",\"wallet\":999999}"
if [ "$CODE" = 400 ]; then
  ok "S5 registo com campos extra recusado (400, forbidNonWhitelisted)"
  call POST /users "" "{\"username\":\"$USER\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
fi
login "$USER" "$PASSWORD"
TOKEN=$(field access_token)
[ -z "$TOKEN" ] && { echo "Nao consegui fazer login (codigo $CODE). Espera 1 minuto ou verifica a stack."; exit 2; }

# ------------------------------------------------------------
echo "== S5 Mass assignment"
call GET /users/me "$TOKEN"
ROLE=$(field role | tr '[:upper:]' '[:lower:]')
case "$ROLE" in
  *admin*|*moder*) vuln "S5 role enviada no registo foi aceite" "role=$ROLE" ;;
  *) ok "S5 role enviada no registo foi ignorada (role='${ROLE:-n/d}')" ;;
esac

# ------------------------------------------------------------
echo "== S1 Brute-force: bloqueio por username vs email (demora cerca de 1 minuto)"
LUSER="lock$RANDOM$RANDOM"
LEMAIL="$LUSER@example.com"
call POST /users "" "{\"username\":\"$LUSER\",\"email\":\"$LEMAIL\",\"password\":\"$PASSWORD\"}"
if [ "$CODE" != 201 ]; then
  note "S1 nao consegui criar a conta de teste (codigo $CODE), teste saltado"
else
  for i in 1 2 3 4 5; do
    login "$LUSER" "errada$i"
    sleep "$LOGIN_GAP"
  done
  login "$LUSER" "errada6"
  sleep "$LOGIN_GAP"
  if [[ "$BODY" != *"Too many"* ]]; then
    note "S1 o bloqueio por username nao ativou (codigo $CODE), nao da para concluir. Repete com LOGIN_GAP=10."
  else
    # A conta esta bloqueada pelo username. Agora tenta pelo email, com a password CERTA.
    login "$LEMAIL" "$PASSWORD"
    if [ "$CODE" = 200 ]; then
      vuln "S1 conta bloqueada por username, login por email com a password certa" "200 (bypass total)"
    elif [[ "$BODY" == *"Too many"* ]]; then
      ok "S1 o bloqueio vale para username e email"
    else
      note "S1 resposta inesperada no login por email (codigo $CODE), verifica manualmente"
    fi
  fi
fi

# ------------------------------------------------------------
echo "== S2 Portas acessiveis no host (sem WAF)"
for entry in 8000:backend 5432:postgres 6379:redis 9200:elasticsearch 5601:kibana 3000:grafana 9090:prometheus 8200:vault; do
  port=${entry%%:*}; name=${entry##*:}
  if (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
    vuln "S2 porta $port ($name) aberta no host" "confirma com: docker ps | grep 0.0.0.0"
  else
    ok "S2 porta $port ($name) fechada"
  fi
done

# ------------------------------------------------------------
echo "== S3 Validacao dos parametros do forum"
BIG=$(python3 -c 'print("a" * 3000)')
call GET "/forum/posts?search=$BIG" "$TOKEN"
expect "S3a search de 3000 caracteres recusado" 400 "$CODE"
call GET "/forum/posts?sortBy=naoexiste" "$TOKEN"
expect "S3b sortBy fora da whitelist -> 400 (500 = sem whitelist)" 400 "$CODE"
call GET "/forum/posts?order=sideways" "$TOKEN"
expect "S3b order invalido -> 400" 400 "$CODE"

# ------------------------------------------------------------
echo "== S4 Exclusao do WAF no search: o backend tem de aguentar sozinho"
call GET "/forum/posts?search=%27%20OR%201%3D1%20--" "$TOKEN"
if [ "$CODE" = 403 ]; then
  note "S4a o WAF ainda bloqueia SQLi em search: a regra 1000004 nao esta ativa?"
else
  expect "S4a SQLi em search passa o WAF mas nao devolve nada (total)" 0 "$(field meta.total)"
fi
call GET "/forum/posts?search=%27%20UNION%20SELECT%20password%20FROM%20%22User%22%20--" "$TOKEN"
[ "$CODE" != 403 ] && expect "S4a UNION SELECT em search nao devolve nada" 0 "$(field meta.total)"
call GET "/forum/posts?search=%3Cscript%3Ealert(1)%3C/script%3E" "$TOKEN"
expect "S4a XSS em search continua bloqueado pelo WAF" 403 "$CODE"

if [ -d backend/src ]; then
  FOUND=$(grep -rnE '\$(queryRaw|executeRaw)Unsafe|\$(queryRaw|executeRaw)\(|child_process|\beval\(' backend/src --include=*.ts 2>/dev/null)
  if [ -z "$FOUND" ]; then
    ok "S4b sem SQL cru, child_process nem eval no backend"
  else
    vuln "S4b SQL cru / shell / eval no backend (rever):" ""
    printf '%s\n' "$FOUND"
  fi
else
  note "S4b corre o script na raiz do repo para analisar backend/src"
fi

# ------------------------------------------------------------
echo "== S6 Avatar: tem de ser mesmo uma imagem"
FAKE="data:image/png;base64,$(printf 'isto nao e uma imagem png' | base64 -w0)"
call PATCH /users/me "$TOKEN" "{\"avatar\":\"$FAKE\"}"
# Atencao: 400 e o unico resultado correto. 403 seria o WAF a recusar por acaso
# (falso positivo no base64), nao uma validacao da imagem; 200 = aceite.
expect "S6 base64 de texto com prefixo PNG recusado pelo backend (400)" 400 "$CODE"

# ------------------------------------------------------------
echo "== S8 JWT e headers"
NONE_TOKEN=$(python3 -I -c '
import base64, json
b = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()
print(b({"alg": "none", "typ": "JWT"}) + "." + b({"sub": 1, "username": "admin"}) + ".")')
call GET /users/me "$NONE_TOKEN"
expect "S8a JWT com alg=none rejeitado" 401 "$CODE"

HEADERS=$(curl -skI "$BASE_URL/")
for h in strict-transport-security x-content-type-options content-security-policy; do
  if grep -qi "^$h:" <<< "$HEADERS"; then ok "S8b header $h presente"; else vuln "S8b header $h em falta" ""; fi
done
if grep -qiE '^x-frame-options:|frame-ancestors' <<< "$HEADERS"; then
  ok "S8b protecao contra clickjacking"
else
  vuln "S8b sem X-Frame-Options nem frame-ancestors" ""
fi
if grep -qiE '^server:.*[0-9]' <<< "$HEADERS"; then
  vuln "S8b header Server revela a versao" "$(grep -i '^server:' <<< "$HEADERS" | tr -d '\r')"
else
  ok "S8b header Server sem versao"
fi

# ------------------------------------------------------------
echo
echo "Resultado: $OK OK, $VULN vulneraveis"
[ "$VULN" -eq 0 ]
