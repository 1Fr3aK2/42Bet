#!/usr/bin/env bash
# Popula o fórum através da API REST, sem acesso direto à base de dados.
# Uso: ./scripts/populate-forum.sh pt|en
set -u

usage() {
  cat <<'EOF'
Uso: ./scripts/populate-forum.sh <pt|en>

Exemplos:
  ./scripts/populate-forum.sh pt    # Conversas em português
  ./scripts/populate-forum.sh en    # Conversas em inglês

Variáveis opcionais:
  API_BASE_URL=https://localhost  # Endereço público da API (sem barra final)
  DEMO_PASSWORD=...               # Password comum às contas de demonstração
  SKIP_TLS_VERIFY=1               # 1: aceita certificado local; 0: verifica TLS
EOF
}

if [[ $# -ne 1 || ( "${1:-}" != "pt" && "${1:-}" != "en" ) ]]; then
  usage
  exit 2
fi
LANGUAGE="$1"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DATA_FILE="$SCRIPT_DIR/forum-data/$LANGUAGE.json"

for command in curl jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Erro: é necessário instalar %s.\n' "$command" >&2
    exit 2
  fi
done
if [[ ! -r "$DATA_FILE" ]]; then
  printf 'Erro: não foi encontrado %s\n' "$DATA_FILE" >&2
  exit 2
fi
if ! jq -e '(.users | length) == 5 and (.posts | length) == 20 and all(.posts[]; (.comments | length) == 3)' "$DATA_FILE" >/dev/null 2>&1; then
  printf 'Erro: dados inválidos ou incompletos em %s\n' "$DATA_FILE" >&2
  exit 2
fi

API_BASE_URL="${API_BASE_URL:-https://localhost}"
API_BASE_URL="${API_BASE_URL%/}"
DEMO_PASSWORD="${DEMO_PASSWORD:-ForumDemo2026!}"
SKIP_TLS_VERIFY="${SKIP_TLS_VERIFY:-1}"
CURL_ARGS=(-sS --connect-timeout 5 --max-time 30)
if [[ "$SKIP_TLS_VERIFY" == "1" ]]; then CURL_ARGS+=(-k); fi

# Um log por execução; os segredos nunca são escritos nele.
LOG_DIR="${LOG_DIR:-$SCRIPT_DIR/logs}"
if ! mkdir -p "$LOG_DIR"; then
  printf 'Erro: não foi possível criar a pasta de logs: %s\n' "$LOG_DIR" >&2
  exit 2
fi
LOG_FILE="$LOG_DIR/populate-forum-${LANGUAGE}-$(date +%Y%m%d-%H%M%S)-$$.log"
if ! : > "$LOG_FILE"; then
  printf 'Erro: não foi possível escrever o log em %s\n' "$LOG_FILE" >&2
  exit 2
fi

log() { printf '%s\n' "$*" | tee -a "$LOG_FILE"; }
response_file="$(mktemp)" || exit 2
trap 'rm -f "$response_file"' EXIT
HTTP_STATUS=""
HTTP_BODY=""
CURL_ERROR=""

# request MÉTODO CAMINHO TOKEN [JSON]
# Os payloads, passwords e JWT nunca são incluídos nas mensagens de progresso.
request() {
  local method="$1" path="$2" token="$3" payload="${4:-}" output
  local args=("${CURL_ARGS[@]}" -X "$method" -o "$response_file" -w '%{http_code}' -H 'Accept: application/json')
  [[ -n "$token" ]] && args+=(-H "Authorization: Bearer $token")
  CURL_ERROR=""
  if [[ "$method" == "GET" ]]; then
    if ! output=$(curl "${args[@]}" "$API_BASE_URL$path" 2>&1); then
      CURL_ERROR="$output"
      HTTP_STATUS="000"
      HTTP_BODY=""
      return 1
    fi
  else
    args+=(-H 'Content-Type: application/json' --data-binary @-)
    if ! output=$(printf '%s' "$payload" | curl "${args[@]}" "$API_BASE_URL$path" 2>&1); then
      CURL_ERROR="$output"
      HTTP_STATUS="000"
      HTTP_BODY=""
      return 1
    fi
  fi
  HTTP_STATUS="$output"
  HTTP_BODY="$(cat "$response_file")"
  return 0
}

response_detail() {
  local detail
  detail=$(printf '%s' "$HTTP_BODY" | jq -r 'if (.message? | type) == "array" then .message | join("; ") else .message // .error // empty end' 2>/dev/null || true)
  if [[ -z "$detail" ]]; then detail="${CURL_ERROR:-${HTTP_BODY:-sem detalhes}}"; fi
  detail="${detail//$'\n'/ }"
  printf '%s' "${detail:0:170}"
}

errors=()
add_error() {
  local label="$1" description="$2"
  errors+=("$label — $description")
  log "  ✗ $label — $description"
}

# Confirma que o endereço aponta para a API e não para a página do frontend.
request GET '/forum/posts' '' || true
if [[ "$HTTP_STATUS" != "401" ]]; then
  log "Erro: resposta inesperada ao verificar /forum/posts (HTTP $HTTP_STATUS)."
  log "Verifica API_BASE_URL e se o backend está disponível. $(response_detail)"
  exit 2
fi

users_new=0; users_existing=0; users_failed=0
logins_ok=0; logins_failed=0
posts_new=0; posts_existing=0; posts_pending=0; posts_failed=0
comments_new=0; comments_existing=0; comments_pending=0; comments_failed=0
comments_skipped=0

declare -a USERNAMES USER_IDS USER_TOKENS
for ((i=0; i<5; i++)); do
  USERNAMES[i]="$(jq -r ".users[$i].username" "$DATA_FILE")"
  USER_IDS[i]=""
  USER_TOKENS[i]=""
done

log '=== 42Bet — Popular fórum via API REST ==='
log "Idioma: $LANGUAGE | API: $API_BASE_URL"
log "Log: $LOG_FILE"
log ''
log '[1/4] Criar ou reutilizar as cinco contas de demonstração'
for ((i=0; i<5; i++)); do
  username="${USERNAMES[i]}"
  email="$(jq -r ".users[$i].email" "$DATA_FILE")"
  payload="$(jq -nc --arg username "$username" --arg email "$email" --arg password "$DEMO_PASSWORD" '{username:$username,email:$email,password:$password,wallet:1000}')"
  request POST '/users' '' "$payload" || true
  case "$HTTP_STATUS" in
    201)
      ((users_new+=1))
      log "  ✓ [$((i+1))/5] $username — conta criada"
      ;;
    409)
      ((users_existing+=1))
      log "  ↷ [$((i+1))/5] $username — conta já existente"
      ;;
    *)
      ((users_failed+=1))
      add_error "Conta $username" "HTTP $HTTP_STATUS: $(response_detail)"
      ;;
  esac
done

log ''
log '[2/4] Autenticar e identificar os utilizadores'
for ((i=0; i<5; i++)); do
  username="${USERNAMES[i]}"
  payload="$(jq -nc --arg username "$username" --arg password "$DEMO_PASSWORD" '{username:$username,password:$password}')"
  request POST '/auth/login' '' "$payload" || true
  if [[ "$HTTP_STATUS" != "200" ]]; then
    ((logins_failed+=1))
    add_error "Login $username" "HTTP $HTTP_STATUS: $(response_detail)"
    continue
  fi
  token="$(printf '%s' "$HTTP_BODY" | jq -r '.access_token // empty' 2>/dev/null)"
  if [[ -z "$token" ]]; then
    ((logins_failed+=1))
    add_error "Login $username" 'a resposta não contém access_token'
    continue
  fi
  # O /users/me devolve o ID real, inclusive quando a conta já existia.
  request GET '/users/me' "$token" || true
  if [[ "$HTTP_STATUS" != "200" ]]; then
    ((logins_failed+=1))
    add_error "Perfil $username" "HTTP $HTTP_STATUS: $(response_detail)"
    continue
  fi
  user_id="$(printf '%s' "$HTTP_BODY" | jq -r '.id // empty' 2>/dev/null)"
  if [[ ! "$user_id" =~ ^[0-9]+$ ]]; then
    ((logins_failed+=1))
    add_error "Perfil $username" 'a resposta não contém um ID numérico'
    continue
  fi
  USER_TOKENS[i]="$token"
  USER_IDS[i]="$user_id"
  ((logins_ok+=1))
  log "  ✓ [$((i+1))/5] $username — autenticado (ID $user_id)"
done

log ''
log '[3/4] Criar ou reutilizar 20 publicações'
declare -a POST_IDS
for ((i=0; i<20; i++)); do
  author_slot=$((i % 5))
  username="${USERNAMES[author_slot]}"
  token="${USER_TOKENS[author_slot]}"
  title="$(jq -r ".posts[$i].title" "$DATA_FILE")"
  content="$(jq -r ".posts[$i].content" "$DATA_FILE")"
  POST_IDS[i]=""
  if [[ -z "$token" ]]; then
    ((posts_failed+=1))
    add_error "Post [$((i+1))/20] $title" "autor $username não autenticado"
    continue
  fi
  encoded_title="$(jq -nr --arg v "$title" '$v|@uri')"
  request GET "/forum/posts?search=$encoded_title&authorId=${USER_IDS[author_slot]}&limit=100" "$token" || true
  if [[ "$HTTP_STATUS" != "200" ]]; then
    ((posts_failed+=1))
    add_error "Pesquisa [$((i+1))/20] $title" "HTTP $HTTP_STATUS: $(response_detail)"
    continue
  fi
  if ! printf '%s' "$HTTP_BODY" | jq -e 'type == "object" and (.data | type) == "array"' >/dev/null 2>&1; then
    ((posts_failed+=1))
    add_error "Pesquisa [$((i+1))/20] $title" 'resposta sem a lista data[] esperada'
    continue
  fi
  post_id="$(printf '%s' "$HTTP_BODY" | jq -r --arg title "$title" --argjson author "${USER_IDS[author_slot]}" '[.data[]? | select(.title == $title and .authorId == $author) | .id] | first // empty' 2>/dev/null)"
  if [[ "$post_id" =~ ^[0-9]+$ ]]; then
    POST_IDS[i]="$post_id"
    ((posts_existing+=1))
    log "  ↷ [$((i+1))/20] $title — já existe (ID $post_id)"
    continue
  fi
  payload="$(jq -nc --arg title "$title" --arg content "$content" '{title:$title,content:$content}')"
  request POST '/forum/posts' "$token" "$payload" || true
  if [[ "$HTTP_STATUS" != "201" ]]; then
    ((posts_failed+=1))
    add_error "Post [$((i+1))/20] $title" "HTTP $HTTP_STATUS: $(response_detail)"
    continue
  fi
  post_id="$(printf '%s' "$HTTP_BODY" | jq -r '.id // empty' 2>/dev/null)"
  status="$(printf '%s' "$HTTP_BODY" | jq -r '.status // empty' 2>/dev/null)"
  if [[ ! "$post_id" =~ ^[0-9]+$ ]]; then
    ((posts_failed+=1))
    add_error "Post [$((i+1))/20] $title" 'resposta sem ID numérico'
    continue
  fi
  if [[ "$status" == "visible" ]]; then
    POST_IDS[i]="$post_id"
    ((posts_new+=1))
    log "  ✓ [$((i+1))/20] $title — criado (ID $post_id)"
  else
    ((posts_pending+=1))
    log "  ! [$((i+1))/20] $title — criado, mas status=$status (não comentável)"
  fi
done

log ''
log '[4/4] Criar ou reutilizar 60 comentários (três por publicação)'
for ((i=0; i<20; i++)); do
  post_id="${POST_IDS[i]}"
  post_title="$(jq -r ".posts[$i].title" "$DATA_FILE")"
  if [[ -z "$post_id" ]]; then
    ((comments_skipped+=3))
    log "  ↷ Post $((i+1))/20 — três comentários ignorados (post indisponível)"
    continue
  fi
  # Uma leitura por post permite evitar duplicações em execuções posteriores.
  owner_slot=$((i % 5))
  request GET "/forum/posts/$post_id/comments" "${USER_TOKENS[owner_slot]}" || true
  if [[ "$HTTP_STATUS" != "200" ]]; then
    ((comments_skipped+=3))
    add_error "Comentários do post $post_id" "HTTP $HTTP_STATUS: $(response_detail)"
    continue
  fi
  existing_comments="$HTTP_BODY"
  if ! printf '%s' "$existing_comments" | jq -e 'type == "array"' >/dev/null 2>&1; then
    ((comments_skipped+=3))
    add_error "Comentários do post $post_id" 'a resposta não é uma lista JSON'
    continue
  fi
  for ((j=0; j<3; j++)); do
    ordinal=$((i*3+j+1))
    commenter_slot=$(((i+j+1) % 5))
    commenter="${USERNAMES[commenter_slot]}"
    token="${USER_TOKENS[commenter_slot]}"
    content="$(jq -r ".posts[$i].comments[$j]" "$DATA_FILE")"
    if [[ -z "$token" ]]; then
      ((comments_failed+=1))
      add_error "Comentário [$ordinal/60] $commenter → post $post_id" 'utilizador não autenticado'
      continue
    fi
    found="$(printf '%s' "$existing_comments" | jq -r --arg content "$content" --argjson author "${USER_IDS[commenter_slot]}" 'any(.[]; .content == $content and .authorId == $author)' 2>/dev/null)"
    if [[ "$found" == "true" ]]; then
      ((comments_existing+=1))
      log "  ↷ [$ordinal/60] $commenter → post $post_id — já existe"
      continue
    fi
    payload="$(jq -nc --arg content "$content" '{content:$content}')"
    request POST "/forum/posts/$post_id/comments" "$token" "$payload" || true
    if [[ "$HTTP_STATUS" != "201" ]]; then
      ((comments_failed+=1))
      add_error "Comentário [$ordinal/60] $commenter → post $post_id" "HTTP $HTTP_STATUS: $(response_detail)"
      continue
    fi
    comment_id="$(printf '%s' "$HTTP_BODY" | jq -r '.id // empty' 2>/dev/null)"
    status="$(printf '%s' "$HTTP_BODY" | jq -r '.status // empty' 2>/dev/null)"
    if [[ ! "$comment_id" =~ ^[0-9]+$ ]]; then
      ((comments_failed+=1))
      add_error "Comentário [$ordinal/60] $commenter → post $post_id" 'resposta sem ID numérico'
      continue
    fi
    if [[ "$status" == "visible" ]]; then
      ((comments_new+=1))
      existing_comments="$(printf '%s' "$existing_comments" | jq -c --arg content "$content" --argjson author "${USER_IDS[commenter_slot]}" '. + [{content:$content, authorId:$author}]')"
      log "  ✓ [$ordinal/60] $commenter → post $post_id — criado (ID $comment_id)"
    else
      ((comments_pending+=1))
      log "  ! [$ordinal/60] $commenter → post $post_id — criado, mas status=$status"
    fi
  done
done

log ''
log '=== RESUMO ==='
log "Contas:       $users_new criadas | $users_existing existentes | $users_failed falhas"
log "Logins:       $logins_ok com sucesso | $logins_failed falhas"
log "Posts:        $posts_new criados | $posts_existing existentes | $posts_pending pendentes | $posts_failed falhas"
log "Comentários:  $comments_new criados | $comments_existing existentes | $comments_pending pendentes | $comments_failed falhas | $comments_skipped ignorados"
if (( ${#errors[@]} > 0 )); then
  log ''
  log "ERROS (${#errors[@]}):"
  for error in "${errors[@]}"; do log "  - $error"; done
fi
log "Log completo: $LOG_FILE"
if (( users_failed + logins_failed + posts_pending + posts_failed + comments_pending + comments_failed + comments_skipped > 0 )); then
  log 'Resultado: INCOMPLETO — verificar as mensagens acima.'
  exit 1
fi
log 'Resultado: OK — todas as conversas estão disponíveis no fórum.'
