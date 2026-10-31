#!/usr/bin/env bash
# ============================================================
# Transcendence analytics - end-to-end test
# ============================================================
#
# Creates a user, places 4 bets, settles them and checks GET
# /users/me/analytics through nginx: the figures, the filters,
# the validation, and the /bets socket that tells the dashboard
# to reload.
#
# Usage:  bash scripts/test-analytics.sh      (with the stack started by make)
# Needs:  curl, python3 and docker (to settle the bets at once and to open
#         the socket from the backend container).
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

# get PATH -> sets CODE and BODY (with the user's token)
get() {
  local response
  response=$(curl -sk -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL$1")
  CODE=${response##*$'\n'}
  BODY=${response%$'\n'*}
}

# py EXPRESSION -> evaluates EXPRESSION on the JSON BODY, as "d"
py() {
  printf '%s' "$BODY" | python3 -I -c 'import json, sys; d = json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"
}

USERNAME="analytics$RANDOM$RANDOM"
curl -sk -o /dev/null -X POST "$BASE_URL/users" -H 'Content-Type: application/json' \
  --data "{\"username\":\"$USERNAME\",\"email\":\"$USERNAME@example.com\",\"password\":\"$PASSWORD\"}"
TOKEN=$(curl -sk -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
  --data "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" |
  python3 -I -c 'import json, sys; print(json.load(sys.stdin)["access_token"])')

echo "== New account"
get /users/me/analytics
check "GET /users/me/analytics -> 200" 200 "$CODE"
check "  no bets, balance 1000" "0 1000" "$(py 'f"{d["summary"]["bets"]} {d["summary"]["balance"]}"')"
check "  no win rate yet" None "$(py 'd["summary"]["winRate"]')"

echo "== 4 bets, settled at once"
for bet in '{"coin":"BTC","direction":"up","amount":100}' '{"coin":"BTC","direction":"down","amount":50}' \
           '{"coin":"ETH","direction":"up","amount":200}' '{"coin":"ETH","direction":"down","amount":25}'; do
  curl -sk -o /dev/null -X POST "$BASE_URL/users/me/bets" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' --data "$bet"
done
# Move their end to now, so the settlement loop settles them in the next second.
docker exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qc "$1"' _ \
  "UPDATE \"Bet\" SET \"expiresAt\" = now() WHERE \"userId\" = (SELECT id FROM \"User\" WHERE username = '$USERNAME')" > /dev/null
sleep 4
get "/users/me/analytics?tzOffset=$(date +%z | python3 -I -c 'import sys; z = sys.stdin.read().strip(); print(-(int(z[0] + "1") * (int(z[1:3]) * 60 + int(z[3:]))))')"
check "  4 bets, none running" "4 0" "$(py 'f"{d["summary"]["bets"]} {d["summary"]["active"]}"')"
check "  won + lost + refunded = 4" 4 "$(py 'd["summary"]["won"] + d["summary"]["lost"] + d["summary"]["refunded"]')"
check "  wagered = 375" 375 "$(py 'd["summary"]["wagered"]')"
check "  profit = paid out - wagered" True "$(py 'd["summary"]["profit"] == d["summary"]["paidOut"] - d["summary"]["wagered"]')"
check "  balance = 1000 + profit" True "$(py 'd["summary"]["balance"] == 1000 + d["summary"]["profit"]')"
check "  profit line ends at the profit" True "$(py 'd["profitOverTime"][-1]["profit"] == d["summary"]["profit"]')"
check "  profit by day adds up to the profit" True "$(py 'sum(x["profit"] for x in d["profitByDay"]) == d["summary"]["profit"]')"
check "  by coin: BTC 2, ETH 2" "BTC:2 ETH:2" "$(py '" ".join(g["name"] + ":" + str(g["bets"]) for g in sorted(d["byCoin"], key=lambda g: g["name"]))')"
check "  by direction adds up to 4" 4 "$(py 'sum(g["bets"] for g in d["byDirection"])')"
check "  bets listed newest first" True "$(py 'd["bets"][0]["id"] > d["bets"][-1]["id"]')"

echo "== Filters"
get "/users/me/analytics?coin=btc"
check "  ?coin=btc -> 2 bets" 2 "$(py 'd["summary"]["bets"]')"
get "/users/me/analytics?direction=up"
check "  ?direction=up -> 2 bets" 2 "$(py 'd["summary"]["bets"]')"
get "/users/me/analytics?coin=ETH&direction=down"
check "  ?coin=ETH&direction=down -> 1 bet" 1 "$(py 'd["summary"]["bets"]')"
get "/users/me/analytics?from=2099-01-01T00:00:00Z"
check "  period in the future -> 0 bets" 0 "$(py 'd["summary"]["bets"]')"

echo "== Invalid requests"
for query in 'from=yesterday' 'from=2026-10-30T00:00:00Z&to=2026-10-01T00:00:00Z' 'coin=B1' \
             'direction=sideways' 'tzOffset=1000' 'extra=1'; do
  get "/users/me/analytics?$query"
  check "  ?$query -> 400" 400 "$CODE"
done
check "  no token -> 401" 401 "$(curl -sk -o /dev/null -w '%{http_code}' "$BASE_URL/users/me/analytics")"

echo "== Real time: /bets socket"
SOCKET=$(docker exec -e NODE_PATH=/usr/src/app/node_modules -i backend node - "$TOKEN" <<'EOF'
const { io } = require('socket.io-client');
const token = process.argv[2];
const base = 'http://localhost:8000';
const intruder = io(`${base}/bets`, { auth: { token: 'not-a-token' }, transports: ['websocket'], forceNew: true });
intruder.on('disconnect', () => console.log('INTRUDER_DISCONNECTED'));
const socket = io(`${base}/bets`, { auth: { token }, transports: ['websocket'], forceNew: true });
socket.on('connect', async () => {
  socket.on('bets:changed', () => { console.log('EVENT'); setTimeout(() => process.exit(0), 300); });
  await fetch(`${base}/users/me/bets`, { method: 'POST', body: JSON.stringify({ coin: 'BTC', direction: 'up', amount: 10 }),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
});
setTimeout(() => process.exit(1), 8000);
EOF
)
check "  invalid token is disconnected" yes "$(grep -q INTRUDER_DISCONNECTED <<< "$SOCKET" && echo yes || echo no)"
check "  bets:changed arrives after a new bet" yes "$(grep -q EVENT <<< "$SOCKET" && echo yes || echo no)"

echo
echo "TOTAL: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
