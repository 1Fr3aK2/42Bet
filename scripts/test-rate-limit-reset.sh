#!/usr/bin/env bash
# ============================================================
# 42Bet rate limiting - Test 12: a successful login clears the counter
# ============================================================
#
# Registers a disposable account, builds up 3 failed attempts (the Redis
# counter login_attempts:user:<id> reads 3), then checks that a correct login
# deletes the key.
#
# Usage:  bash scripts/test-rate-limit-reset.sh      (from the repository root)
# Needs:  curl, python3, docker compose and REDIS_PASSWORD in .env
# Takes about 35 seconds: the logins are 7 seconds apart so that the nginx
# limit on /auth (10 requests a minute) never answers 429 before the account
# limit is involved.
#
# ============================================================

BASE_URL="${BASE_URL:-https://localhost}"
PASSWORD='Password123!'
NAME="rl12_$RANDOM$RANDOM"
EMAIL="$NAME@example.com"
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

# login PASSWORD -> waits 7s, then POST /auth/login for the disposable account
login() {
  sleep 7
  call POST /auth/login "" "{\"username\":\"$NAME\",\"password\":\"$1\"}"
}

REDIS_PASSWORD=$(grep '^REDIS_PASSWORD=' .env | cut -d= -f2- | tr -d '"')
if [ -z "$REDIS_PASSWORD" ]; then
  echo "REDIS_PASSWORD not found in .env (run this from the repository root)"
  exit 1
fi
redis() { docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning "$@" | tr -d '\r'; }

echo "== Setup: disposable account"
call POST /users "" "{\"username\":\"$NAME\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
check "registration -> 201" 201 "$CODE"
login "$PASSWORD"
check "login with the correct password -> 200" 200 "$CODE"
TOKEN=$(printf '%s' "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
ID=$(python3 -c 'import sys,json,base64; p=sys.argv[1].split(".")[1]; p+="="*(-len(p)%4); print(json.loads(base64.urlsafe_b64decode(p))["sub"])' "$TOKEN")
check "user id read from the token" yes "$([ -n "$ID" ] && echo yes || echo no)"
KEY="login_attempts:user:$ID"

echo "== Three failed attempts build up the counter"
for i in 1 2 3; do
  login "wrong-password"
  check "wrong password #$i -> 401" 401 "$CODE"
done
check "counter in Redis is 3" 3 "$(redis GET "$KEY")"

echo "== A correct login clears it"
login "$PASSWORD"
check "correct password -> 200" 200 "$CODE"
check "key deleted from Redis (EXISTS -> 0)" 0 "$(redis EXISTS "$KEY")"

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
