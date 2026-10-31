#!/usr/bin/env bash
# ============================================================
# Transcendence forum - end-to-end test of the final-version fixes
# ============================================================
#
# Checks, through nginx and the WAF:
#   - ordinary sentences are accepted in posts, comments and the search box
#     (the WAF used to refuse sentences such as "Find the best strategy")
#   - attacks in the same fields are still refused by the WAF (403)
#   - the date filter includes the whole end day (Hugo's fix)
#
# Usage:  bash scripts/test-forum.sh           (with the stack started by make)
#         BASE_URL=https://localhost:8443 bash scripts/test-forum.sh
# Needs:  curl and python3. Creates one user and one post, and deletes the post.
#
# ============================================================

BASE_URL="${BASE_URL:-https://localhost}"
PASSWORD='Password123!'
PASS=0
FAIL=0

check() { # NAME EXPECTED ACTUAL
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); printf '  PASS  %-58s %s\n' "$1" "$3"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL  %-58s expected [%s], got [%s]\n' "$1" "$2" "$3"
  fi
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

# field PATH -> value at PATH in BODY, e.g. "id" or "meta.total"
field() {
  printf '%s' "$BODY" | python3 -I -c '
import json, sys
value = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    value = value[key]
print(value)' "$1"
}

USER="forum$RANDOM$RANDOM"
call POST /users "" "{\"username\":\"$USER\",\"email\":\"$USER@example.com\",\"password\":\"$PASSWORD\"}"
USER_ID=$(field id)
call POST /auth/login "" "{\"username\":\"$USER\",\"password\":\"$PASSWORD\"}"
TOKEN=$(field access_token)

echo "== Ordinary sentences are accepted"
call POST /forum/posts "$TOKEN" '{"title":"Find the best strategy","content":"Watch the 1m candles and wait for a pullback; less risk, more patience."}'
check "post \"Find the best strategy\" -> 201" 201 "$CODE"
check "  visible (not held by the automatic moderation)" visible "$(field status)"
POST_ID=$(field id)
call POST "/forum/posts/$POST_ID/comments" "$TOKEN" '{"content":"Top tip: never bet more than 10% of your balance."}'
check "comment \"Top tip: never bet more...\" -> 201" 201 "$CODE"
call GET "/forum/posts?search=Sort%20of" "$TOKEN"
check "search \"Sort of\" -> 200" 200 "$CODE"

echo "== Attacks are still refused by the WAF (403)"
call POST /forum/posts "$TOKEN" '{"title":"<script>alert(1)</script>","content":"x"}'
check "<script> in a title" 403 "$CODE"
call POST "/forum/posts/$POST_ID/comments" "$TOKEN" '{"content":"<img src=x onerror=alert(1)>"}'
check "onerror= in a comment" 403 "$CODE"
call GET "/forum/posts?page=1%20UNION%20SELECT%20password%20FROM%20users" "$TOKEN"
check "SQL injection in another parameter (page)" 403 "$CODE"

echo "== Date filter (the end day is included)"
TODAY=$(date -u +%F)
YESTERDAY=$(date -u -d yesterday +%F 2>/dev/null || date -u -v-1d +%F)
call GET "/forum/posts?authorId=$USER_ID&dateFrom=$TODAY&dateTo=$TODAY" "$TOKEN"
check "from today to today: the post of today is found" 1 "$(field meta.total)"
call GET "/forum/posts?authorId=$USER_ID&dateTo=$YESTERDAY" "$TOKEN"
check "up to yesterday: it is not" 0 "$(field meta.total)"
call GET "/forum/posts?dateTo=${TODAY}T12:00:00Z" "$TOKEN"
check "date with a time -> 400 (YYYY-MM-DD only)" 400 "$CODE"

call DELETE "/forum/posts/$POST_ID" "$TOKEN"
check "test post deleted (200 or 204)" deleted "$({ [ "$CODE" = 200 ] || [ "$CODE" = 204 ]; } && echo deleted || echo "$CODE")"

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
