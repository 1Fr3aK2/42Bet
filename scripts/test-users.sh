#!/usr/bin/env bash
# ============================================================
# Transcendence accounts - end-to-end test
# ============================================================
#
# Checks, through nginx, the account rules added for the final version:
#   - the username must be 3 to 20 letters, digits, "_", "." or "-"
#   - the login accepts the username or the email
#   - the avatar must be a PNG, JPEG, GIF or WebP image
#
# Usage:  bash scripts/test-users.sh           (with the stack started by make)
#         BASE_URL=https://localhost:8443 bash scripts/test-users.sh
# Needs:  curl and python3. Logs in 4 times (nginx allows 10 logins a minute).
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

# refused CODE -> "refused" when the request was refused by the backend (400)
# or, before reaching it, by the WAF (403)
refused() { { [ "$1" = 400 ] || [ "$1" = 403 ]; } && echo refused || echo "$1"; }

# field KEY -> value of KEY in the JSON BODY
field() {
  printf '%s' "$BODY" | python3 -I -c 'import json, sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

USER="acct$RANDOM$RANDOM"
EMAIL="$USER@example.com"
# A 1 x 1 PNG picture.
PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg=='

echo "== Registration refuses bad usernames (400)"
for name in '' 'ab' 'with space' 'bob@home' 'abcdefghijklmnopqrstu' 'josé'; do
  call POST /users "" "{\"username\":\"$name\",\"email\":\"x$RANDOM@example.com\",\"password\":\"$PASSWORD\"}"
  check "username '$name'" 400 "$CODE"
done

echo "== Registration refuses an avatar that is not an image (400)"
call POST /users "" "{\"username\":\"${USER}b\",\"email\":\"b$EMAIL\",\"password\":\"$PASSWORD\",\"avatar\":\"data:text/plain;base64,aGVsbG8=\"}"
check "text file as avatar (400 backend or 403 WAF)" refused "$(refused "$CODE")"

echo "== Registration and login"
call POST /users "" "{\"username\":\"$USER\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
check "valid registration -> 201" 201 "$CODE"
call POST /auth/login "" "{\"username\":\"$USER\",\"password\":\"$PASSWORD\"}"
check "login with the username -> 200" 200 "$CODE"
call POST /auth/login "" "{\"username\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
check "login with the email -> 200" 200 "$CODE"
TOKEN=$(field access_token)
call POST /auth/login "" "{\"username\":\"$EMAIL\",\"password\":\"wrong-password\"}"
check "wrong password -> 401" 401 "$CODE"
call POST /auth/login "" "{\"username\":\"nobody$RANDOM@example.com\",\"password\":\"$PASSWORD\"}"
check "unknown email -> 401" 401 "$CODE"

echo "== Profile update (PATCH /users/me)"
call PATCH /users/me "$TOKEN" '{"username":"me@example.com"}'
check "username with @ -> 400" 400 "$CODE"
call PATCH /users/me "$TOKEN" '{"avatar":"data:text/plain;base64,aGVsbG8="}'
check "text file as avatar -> 400" 400 "$CODE"
call PATCH /users/me "$TOKEN" '{"avatar":"javascript:alert(1)"}'
check "script URL as avatar (400 backend or 403 WAF)" refused "$(refused "$CODE")"
call PATCH /users/me "$TOKEN" "{\"username\":\"${USER}x\",\"avatar\":\"$PNG\"}"
check "new username and PNG avatar -> 200" 200 "$CODE"
check "  username saved" "${USER}x" "$(field username)"
check "  avatar saved" "$PNG" "$(field avatar)"

echo "== 30 random pictures of different sizes are all accepted (none blocked by the WAF)"
CODES=""
for size in $(seq 3000 997 31913); do
  AVATAR="data:image/jpeg;base64,$(head -c "$size" /dev/urandom | base64 -w0)"
  call PATCH /users/me "$TOKEN" "{\"avatar\":\"$AVATAR\"}"
  CODES="$CODES $CODE"
done
check "pictures accepted (200)" 30 "$(grep -o 200 <<< "$CODES" | wc -l)"

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
