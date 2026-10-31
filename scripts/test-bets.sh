#!/usr/bin/env bash
# ============================================================
# Transcendence betting engine - end-to-end test
# ============================================================
#
# Creates two users and checks the betting engine (backend/src/bets)
# through nginx, the same way the browser uses it:
#   - new accounts start with 1000 T$, set by the server
#   - betting needs a valid login token
#   - invalid bets are refused: the amount must be a positive whole number
#   - the balance never goes below zero, even with simultaneous bets
#   - bet history and its filters
#   - a bet settled too late is refunded (needs docker)
#   - every bet is settled after 60 s with the right payout
#
# Usage:  bash scripts/test-bets.sh            (with the stack started by make)
#         BASE_URL=https://localhost:8443 bash scripts/test-bets.sh
# Needs:  curl and python3; docker for the "settled too late" check.
# Takes about 75 seconds, because it waits for the bets to be settled.
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

# field PATH -> value at PATH in BODY, e.g. "balance", "bet.status", "0.status", "length"
field() {
  printf '%s' "$BODY" | python3 -I -c '
import json, sys
value = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    if key == "length":
        value = len(value)
    elif isinstance(value, list):
        value = value[int(key)]
    else:
        value = value[key]
print(value)' "$1"
}

# check_settled TOKEN BALANCE_AFTER_BETTING [BET_ID_ALREADY_SETTLED]
# Every settled bet must follow the payout rules, and the balance must be
# what was left after betting plus the payouts.
check_settled() {
  call GET "/users/me/bets?status=settled" "$1"
  local lines verdict rest payouts=0
  lines=$(printf '%s' "$BODY" | python3 -I -c '
import json, math, sys
skip, payouts = sys.argv[1], 0
for b in json.load(sys.stdin):
    e, x, up = b["entryPrice"], b["exitPrice"], b["direction"] == "up"
    if b["status"] == "won":
        ok = b["payout"] == math.floor(b["amount"] * 1.85) and (x > e) == up
    elif b["status"] == "lost":
        ok = b["payout"] == 0 and x != e and (x > e) != up
    else:
        ok = b["status"] == "refunded" and b["payout"] == b["amount"]
    print("%s bet %s: %s %s %s T$ -> %s, %s -> %s, payout %s" % (
        "PASS" if ok else "FAIL", b["id"], b["coin"], b["direction"],
        b["amount"], b["status"], e, x, b["payout"]))
    if str(b["id"]) != skip:
        payouts += b["payout"]
print("PAYOUTS %d" % payouts)' "${3:-none}")
  while read -r verdict rest; do
    case "$verdict" in
      PASS) PASS=$((PASS + 1)); echo "  PASS  $rest" ;;
      FAIL) FAIL=$((FAIL + 1)); echo "  FAIL  $rest" ;;
      PAYOUTS) payouts=$rest ;;
    esac
  done <<< "$lines"
  call GET /users/me/balance "$1"
  check "  balance = $2 + payouts" "$(($2 + payouts))" "$(field balance)"
}

U1="bettest$RANDOM$RANDOM"
U2="bettest$RANDOM$RANDOM"

echo "== New accounts start with 1000 T\$, set by the server"
call POST /users "" "{\"username\":\"$U1\",\"email\":\"$U1@example.com\",\"password\":\"$PASSWORD\",\"wallet\":0}"
check "register sending wallet: 0 -> 201" 201 "$CODE"
check "  balance stored" 1000 "$(field wallet)"
call POST /users "" "{\"username\":\"$U2\",\"email\":\"$U2@example.com\",\"password\":\"$PASSWORD\"}"
check "register without wallet -> 201" 201 "$CODE"
check "  balance stored" 1000 "$(field wallet)"

call POST /auth/login "" "{\"username\":\"$U1\",\"password\":\"$PASSWORD\"}"
T1=$(field access_token)
call POST /auth/login "" "{\"username\":\"$U2\",\"password\":\"$PASSWORD\"}"
T2=$(field access_token)

echo "== Balance"
call GET /users/me/balance "$T1"
check "GET /users/me/balance -> 200" 200 "$CODE"
check "  balance" 1000 "$(field balance)"
call GET /users/me/balance
check "without a token -> 401" 401 "$CODE"
call POST /users/me/bets "" '{"coin":"BTC","direction":"up","amount":100}'
check "betting without a token -> 401" 401 "$CODE"
call POST /users/me/bets "not-a-real-token" '{"coin":"BTC","direction":"up","amount":100}'
check "betting with a fake token -> 401" 401 "$CODE"

echo "== Invalid bets are refused with 400 (the amount must be a positive whole number)"
for body in \
  '{"coin":"BTC","direction":"up","amount":0}' \
  '{"coin":"BTC","direction":"up","amount":-50}' \
  '{"coin":"BTC","direction":"up","amount":1.5}' \
  '{"coin":"BTC","direction":"up","amount":"100"}' \
  '{"coin":"BTC","direction":"up","amount":"abc"}' \
  '{"coin":"BTC","direction":"up","amount":"10abc"}' \
  '{"coin":"BTC","direction":"up","amount":""}' \
  '{"coin":"BTC","direction":"up","amount":null}' \
  '{"coin":"BTC","direction":"up","amount":true}' \
  '{"coin":"BTC","direction":"up","amount":[100]}' \
  '{"coin":"BTC","direction":"up","amount":10000000}' \
  '{"coin":"BTC","direction":"up"}' \
  '{"coin":"BTC","direction":"sideways","amount":100}' \
  '{"coin":"B1","direction":"up","amount":100}' \
  '{"coin":"BTC","direction":"up","amount":100,"price":1}' \
  '{"direction":"up","amount":100}'; do
  call POST /users/me/bets "$T1" "$body"
  check "$body" 400 "$CODE"
done
call POST /users/me/bets "$T1" '{"coin":"DOGE","direction":"up","amount":100}'
check "coin without a live price" "No live price for DOGE" "$(field message)"
call POST /users/me/bets "$T1" '{"coin":"BTC","direction":"up","amount":5000}'
check "stake above the balance" "Insufficient balance" "$(field message)"
call GET /users/me/balance "$T1"
check "  balance unchanged" 1000 "$(field balance)"

echo "== Place a bet"
call POST /users/me/bets "$T1" '{"coin":"btc","direction":"up","amount":100}'
check "POST /users/me/bets -> 201" 201 "$CODE"
check "  new balance in the response" 900 "$(field balance)"
check "  status" active "$(field bet.status)"
check "  coin in upper case" BTC "$(field bet.coin)"

echo "== 8 simultaneous bets of 300 T\$ with 1000 T\$: only 3 fit"
CODES=$(for i in $(seq 8); do
  curl -sk -o /dev/null -w '%{http_code}\n' -X POST "$BASE_URL/users/me/bets" \
    -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' \
    --data '{"coin":"ETH","direction":"down","amount":300}' &
done; wait)
check "accepted (201)" 3 "$(grep -c 201 <<< "$CODES")"
check "refused (400)" 5 "$(grep -c 400 <<< "$CODES")"
call GET /users/me/balance "$T2"
check "  balance never goes below zero" 100 "$(field balance)"

echo "== History"
call GET /users/me/bets "$T2"
check "GET /users/me/bets -> 200" 200 "$CODE"
check "  bets" 3 "$(field length)"
call GET "/users/me/bets?status=active" "$T2"
check "  ?status=active" 3 "$(field length)"
call GET "/users/me/bets?status=settled" "$T2"
check "  ?status=settled" 0 "$(field length)"
call GET "/users/me/bets?limit=1" "$T2"
check "  ?limit=1" 1 "$(field length)"
call GET "/users/me/bets?limit=0" "$T2"
check "  ?limit=0 -> 400" 400 "$CODE"
call GET /users/me/bets "$T1"
check "  user 1 only sees their own bet" 1 "$(field length)"

LATE=""
if command -v docker > /dev/null && docker ps --format '{{.Names}}' | grep -qx postgres; then
  echo "== A bet settled more than 10 s late is refunded"
  call POST /users/me/bets "$T1" '{"coin":"ETH","direction":"down","amount":50}'
  LATE=$(field bet.id)
  # Simulate a backend that was down when the bet ended: move its end 30 s back.
  docker exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qc "$1"' _ \
    "UPDATE \"Bet\" SET \"expiresAt\" = now() - interval '30 seconds' WHERE id = $LATE" > /dev/null
  sleep 3
  call GET "/users/me/bets?limit=1" "$T1"
  check "  status" refunded "$(field 0.status)"
  check "  payout = stake" 50 "$(field 0.payout)"
  call GET /users/me/balance "$T1"
  check "  balance back to 900" 900 "$(field balance)"
else
  echo "== (skipped: the settled-too-late check needs docker and the postgres container)"
fi

echo "== Settlement after 60 s (waiting 62 s...)"
sleep 62
call GET "/users/me/bets?status=active" "$T1"
check "no active bet left (user 1)" 0 "$(field length)"
call GET "/users/me/bets?status=active" "$T2"
check "no active bet left (user 2)" 0 "$(field length)"
check_settled "$T1" 900 "$LATE"
check_settled "$T2" 100

echo
echo "TOTAL: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
