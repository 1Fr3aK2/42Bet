#!/usr/bin/env bash

# ============================================================
# 42Bet Public Admin API - Test & Demonstration Script
# ============================================================
#
# This script demonstrates and tests the Public Admin API.
#
# It:
#   - asks the user for an API key;
#   - explains each curl command and its flags;
#   - displays readable JSON when possible;
#   - checks returned HTTP status codes;
#   - classifies each test as PASS, FAIL or SKIP;
#   - tests both Nginx and backend Redis rate limiting;
#   - finishes with a summary table.
#
# JSON formatting/parsing:
#   1. jq, if installed
#   2. python3, if installed
#   3. raw JSON if neither is available
#
# ============================================================


BASE_URL="${BASE_URL:-https://localhost}"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

TEST_NAMES=()
TEST_EXPECTED=()
TEST_ACTUAL=()
TEST_RESULTS=()

TEMP_DIR=$(mktemp -d)

cleanup() {
  rm -rf "$TEMP_DIR"
}

trap cleanup EXIT


# ------------------------------------------------------------
# Output helpers
# ------------------------------------------------------------

separator() {
  printf '\n============================================================\n'
}

test_header() {
  separator
  printf '%s\n' "$1"
  separator
}

add_result() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  local result="$4"

  TEST_NAMES+=("$name")
  TEST_EXPECTED+=("$expected")
  TEST_ACTUAL+=("$actual")
  TEST_RESULTS+=("$result")

  case "$result" in
    PASS)
      PASS_COUNT=$((PASS_COUNT + 1))
      ;;
    FAIL)
      FAIL_COUNT=$((FAIL_COUNT + 1))
      ;;
    SKIP)
      SKIP_COUNT=$((SKIP_COUNT + 1))
      ;;
  esac
}

print_result() {
  local result="$1"
  local message="$2"

  printf '\nResult: %s — %s\n' "$result" "$message"
}


# ------------------------------------------------------------
# JSON helpers
# ------------------------------------------------------------

if command -v jq >/dev/null 2>&1; then
  JSON_TOOL="jq"
elif command -v python3 >/dev/null 2>&1; then
  JSON_TOOL="python3"
else
  JSON_TOOL="none"
fi

pretty_json_file() {
  local file="$1"

  if [ ! -s "$file" ]; then
    printf '(empty response body)\n'
    return
  fi

  case "$JSON_TOOL" in
    jq)
      jq . "$file" 2>/dev/null || cat "$file"
      ;;
    python3)
      python3 -m json.tool "$file" 2>/dev/null || cat "$file"
      ;;
    *)
      cat "$file"
      printf '\n'
      ;;
  esac
}

get_json_value() {
  local file="$1"
  local jq_expression="$2"
  local python_expression="$3"

  case "$JSON_TOOL" in
    jq)
      jq -r "$jq_expression" "$file" 2>/dev/null
      ;;
    python3)
      python3 - "$file" "$python_expression" <<'PY'
import json
import sys

filename = sys.argv[1]
expression = sys.argv[2]

try:
    with open(filename, "r", encoding="utf-8") as f:
        data = json.load(f)

    print(eval(expression, {"__builtins__": {}}, {"data": data}))
except Exception:
    pass
PY
      ;;
    *)
      return 1
      ;;
  esac
}


# ------------------------------------------------------------
# curl explanation helpers
# ------------------------------------------------------------

explain_get() {
  cat <<'EOF'

Flags:
  -k        Accept the local/self-signed HTTPS certificate.
  -s        Silent mode: hide curl progress information.
  -o FILE   Save the response body in FILE.
  -w        Print selected information after the request.
  -H        Add an HTTP header.

The API key is used internally but is never printed by this script.
EOF
}

explain_body_request() {
  local method="$1"

  cat <<EOF

Flags:
  -k          Accept the local/self-signed HTTPS certificate.
  -s          Silent mode: hide curl progress information.
  -X $method   Use the HTTP $method method.
  -H          Add an HTTP header.
  -d          Send a request body.
  -o FILE     Save the response body in FILE.
  -w          Print selected information after the request.

The API key is used internally but is never printed by this script.
EOF
}

explain_delete_request() {
  cat <<'EOF'

Flags:
  -k          Accept the local/self-signed HTTPS certificate.
  -s          Silent mode: hide curl progress information.
  -X DELETE   Use the HTTP DELETE method.
  -H          Add an HTTP header.
  -o FILE     Save the response body in FILE.
  -w          Print selected information after the request.

The API key is used internally but is never printed by this script.
EOF
}


# ------------------------------------------------------------
# Startup
# ------------------------------------------------------------

clear 2>/dev/null || true

separator
printf ' 42Bet Public Admin API\n'
printf ' Test & Demonstration Script\n'
separator

printf '\nTarget API: %s\n' "$BASE_URL"

case "$JSON_TOOL" in
  jq)
    printf 'JSON tool: jq\n'
    ;;
  python3)
    printf 'JSON tool: python3\n'
    ;;
  none)
    printf 'JSON tool: none\n'
    printf 'JSON will be displayed raw.\n'
    printf 'Tests requiring JSON parsing may be skipped.\n'
    ;;
esac

printf '\nEnter the API key to use for the tests.\n'
printf 'The key will not be displayed on screen.\n\n'

read -rsp "API key: " API_KEY
printf '\n'

if [ -z "$API_KEY" ]; then
  printf '\nNo API key was provided. Exiting.\n'
  exit 1
fi


# ============================================================
# TEST 1 - API key authentication
# ============================================================

test_header "TEST 1 — API key authentication"

cat <<EOF
Purpose:
Verify that the Public Admin API is protected by an API key.

Request:
GET /api/admin/users

Command:

curl -k -s \\
  "$BASE_URL/api/admin/users" \\
  -H "X-API-Key: ***" \\
  -o RESPONSE_FILE \\
  -w "%{http_code}"
EOF

explain_get

AUTH_RESPONSE="$TEMP_DIR/auth.json"

AUTH_STATUS=$(curl -k -s \
  "$BASE_URL/api/admin/users" \
  -H "X-API-Key: $API_KEY" \
  -o "$AUTH_RESPONSE" \
  -w "%{http_code}")

printf '\nResponse (HTTP %s):\n' "$AUTH_STATUS"
pretty_json_file "$AUTH_RESPONSE"

if [ "$AUTH_STATUS" = "200" ]; then
  add_result \
    "API key authentication" \
    "200" \
    "$AUTH_STATUS" \
    "PASS"

  print_result \
    "PASS" \
    "API key accepted. Functional tests will continue."

elif [ "$AUTH_STATUS" = "401" ]; then
  add_result \
    "API key protection" \
    "401" \
    "$AUTH_STATUS" \
    "PASS"

  print_result \
    "PASS" \
    "invalid API key was correctly rejected."

  separator
  printf 'SUMMARY\n'
  separator

  printf '\n%-32s %-10s %-10s %-8s\n' \
    "Test" "Expected" "Actual" "Result"

  printf '%-32s %-10s %-10s %-8s\n' \
    "--------------------------------" \
    "----------" \
    "----------" \
    "--------"

  printf '%-32s %-10s %-10s %-8s\n' \
    "API key protection" \
    "401" \
    "$AUTH_STATUS" \
    "PASS"

  printf '\nThe supplied API key was rejected.\n'
  printf 'Protected API access is working correctly.\n'
  printf 'Functional tests were not executed.\n\n'

  exit 0

else
  add_result \
    "API key authentication" \
    "200/401" \
    "$AUTH_STATUS" \
    "FAIL"

  print_result \
    "FAIL" \
    "unexpected HTTP status. Cannot safely continue."

  exit 1
fi


# ============================================================
# TEST 2 - GET users
# ============================================================

test_header "TEST 2 — GET users"

cat <<EOF
Purpose:
Verify that GET /api/admin/users retrieves users from the database.

Command:

curl -k -s \\
  "$BASE_URL/api/admin/users" \\
  -H "X-API-Key: ***" \\
  -o RESPONSE_FILE \\
  -w "%{http_code}"
EOF

explain_get

USERS_RESPONSE="$TEMP_DIR/users.json"

USERS_STATUS=$(curl -k -s \
  "$BASE_URL/api/admin/users" \
  -H "X-API-Key: $API_KEY" \
  -o "$USERS_RESPONSE" \
  -w "%{http_code}")

printf '\nResponse (HTTP %s):\n' "$USERS_STATUS"
pretty_json_file "$USERS_RESPONSE"

if [ "$USERS_STATUS" = "200" ]; then
  add_result "GET users" "200" "$USERS_STATUS" "PASS"
  print_result "PASS" "users retrieved successfully."
else
  add_result "GET users" "200" "$USERS_STATUS" "FAIL"
  print_result "FAIL" "expected HTTP 200."
fi


# ============================================================
# TEST 3 - GET reports
# ============================================================

test_header "TEST 3 — GET moderation reports"

cat <<EOF
Purpose:
Verify that GET /api/admin/reports retrieves moderation reports
from the database.

Command:

curl -k -s \\
  "$BASE_URL/api/admin/reports" \\
  -H "X-API-Key: ***" \\
  -o RESPONSE_FILE \\
  -w "%{http_code}"
EOF

explain_get

REPORTS_RESPONSE="$TEMP_DIR/reports.json"

REPORTS_STATUS=$(curl -k -s \
  "$BASE_URL/api/admin/reports" \
  -H "X-API-Key: $API_KEY" \
  -o "$REPORTS_RESPONSE" \
  -w "%{http_code}")

printf '\nResponse (HTTP %s):\n' "$REPORTS_STATUS"
pretty_json_file "$REPORTS_RESPONSE"

if [ "$REPORTS_STATUS" = "200" ]; then
  add_result "GET reports" "200" "$REPORTS_STATUS" "PASS"
  print_result "PASS" "moderation reports retrieved successfully."
else
  add_result "GET reports" "200" "$REPORTS_STATUS" "FAIL"
  print_result "FAIL" "expected HTTP 200."
fi


# ============================================================
# TEST 4 - GET pending moderation
# ============================================================

test_header "TEST 4 — GET pending moderation content"

cat <<EOF
Purpose:
Verify that the API can retrieve content waiting for manual
moderation review.

Command:

curl -k -s \\
  "$BASE_URL/api/admin/moderation/pending" \\
  -H "X-API-Key: ***" \\
  -o RESPONSE_FILE \\
  -w "%{http_code}"
EOF

explain_get

PENDING_CONTENT_RESPONSE="$TEMP_DIR/pending-content.json"

PENDING_CONTENT_STATUS=$(curl -k -s \
  "$BASE_URL/api/admin/moderation/pending" \
  -H "X-API-Key: $API_KEY" \
  -o "$PENDING_CONTENT_RESPONSE" \
  -w "%{http_code}")

printf '\nResponse (HTTP %s):\n' "$PENDING_CONTENT_STATUS"
pretty_json_file "$PENDING_CONTENT_RESPONSE"

if [ "$PENDING_CONTENT_STATUS" = "200" ]; then
  add_result \
    "GET pending moderation" \
    "200" \
    "$PENDING_CONTENT_STATUS" \
    "PASS"

  print_result "PASS" "pending moderation content retrieved."
else
  add_result \
    "GET pending moderation" \
    "200" \
    "$PENDING_CONTENT_STATUS" \
    "FAIL"

  print_result "FAIL" "expected HTTP 200."
fi


# ============================================================
# TEST 5 - GET moderation logs
# ============================================================

test_header "TEST 5 — GET moderation logs"

cat <<EOF
Purpose:
Verify that the API can retrieve the moderation audit history.

Command:

curl -k -s \\
  "$BASE_URL/api/admin/moderation/logs" \\
  -H "X-API-Key: ***" \\
  -o RESPONSE_FILE \\
  -w "%{http_code}"
EOF

explain_get

LOGS_RESPONSE="$TEMP_DIR/logs.json"

LOGS_STATUS=$(curl -k -s \
  "$BASE_URL/api/admin/moderation/logs" \
  -H "X-API-Key: $API_KEY" \
  -o "$LOGS_RESPONSE" \
  -w "%{http_code}")

printf '\nResponse (HTTP %s):\n' "$LOGS_STATUS"
pretty_json_file "$LOGS_RESPONSE"

if [ "$LOGS_STATUS" = "200" ]; then
  add_result "GET moderation logs" "200" "$LOGS_STATUS" "PASS"
  print_result "PASS" "moderation logs retrieved successfully."
else
  add_result "GET moderation logs" "200" "$LOGS_STATUS" "FAIL"
  print_result "FAIL" "expected HTTP 200."
fi


# ============================================================
# TEST 6 - PUT user role
# ============================================================

test_header "TEST 6 — PUT user role"

cat <<'EOF'
Purpose:
Verify the PUT endpoint by temporarily changing the role of the
first non-ADMIN user found.

The script will restore the original role after the test.
EOF

if [ "$JSON_TOOL" = "none" ]; then

  add_result "PUT user role" "-" "-" "SKIP"
  print_result \
    "SKIP" \
    "jq or python3 is required to safely select a user."

else

  USER_ID=$(get_json_value \
    "$USERS_RESPONSE" \
    '[.[] | select(.role != "ADMIN")][0].id // empty' \
    'next((u["id"] for u in data if u.get("role") != "ADMIN"), "")')

  USER_ROLE=$(get_json_value \
    "$USERS_RESPONSE" \
    '[.[] | select(.role != "ADMIN")][0].role // empty' \
    'next((u["role"] for u in data if u.get("role") != "ADMIN"), "")')

  if [ -z "$USER_ID" ] || [ -z "$USER_ROLE" ]; then

    add_result "PUT user role" "-" "-" "SKIP"
    print_result \
      "SKIP" \
      "no non-ADMIN user is available for this test."

  else

    if [ "$USER_ROLE" = "USER" ]; then
      NEW_ROLE="MODERATOR"
    else
      NEW_ROLE="USER"
    fi

    printf '\nSelected user ID: %s\n' "$USER_ID"
    printf 'Current role:      %s\n' "$USER_ROLE"
    printf 'Temporary role:    %s\n' "$NEW_ROLE"

    cat <<EOF

Command:

curl -k -s -X PUT \\
  "$BASE_URL/api/admin/users/$USER_ID/role" \\
  -H "X-API-Key: ***" \\
  -H "Content-Type: application/json" \\
  -d '{"role":"$NEW_ROLE"}' \\
  -o RESPONSE_FILE \\
  -w "%{http_code}"
EOF

    explain_body_request "PUT"

    PUT_RESPONSE="$TEMP_DIR/put-role.json"

    PUT_STATUS=$(curl -k -s -X PUT \
      "$BASE_URL/api/admin/users/$USER_ID/role" \
      -H "X-API-Key: $API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"role\":\"$NEW_ROLE\"}" \
      -o "$PUT_RESPONSE" \
      -w "%{http_code}")

    printf '\nResponse (HTTP %s):\n' "$PUT_STATUS"
    pretty_json_file "$PUT_RESPONSE"

    if [ "$PUT_STATUS" = "200" ]; then
      add_result "PUT user role" "200" "$PUT_STATUS" "PASS"
      print_result "PASS" "user role updated successfully."
    else
      add_result "PUT user role" "200" "$PUT_STATUS" "FAIL"
      print_result "FAIL" "expected HTTP 200."
    fi

    printf '\nRestoring original role (%s)...\n' "$USER_ROLE"

    RESTORE_RESPONSE="$TEMP_DIR/restore-role.json"

    RESTORE_STATUS=$(curl -k -s -X PUT \
      "$BASE_URL/api/admin/users/$USER_ID/role" \
      -H "X-API-Key: $API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"role\":\"$USER_ROLE\"}" \
      -o "$RESTORE_RESPONSE" \
      -w "%{http_code}")

    if [ "$RESTORE_STATUS" = "200" ]; then
      printf 'Original role restored successfully.\n'
    else
      printf 'WARNING: original role could not be restored (HTTP %s).\n' \
        "$RESTORE_STATUS"
    fi

  fi
fi


# ============================================================
# TEST 7 - POST post
# ============================================================

test_header "TEST 7 — POST post"

cat <<EOF
Purpose:
Verify that POST /api/admin/posts creates a new post in the
database.

The created post will later be deleted by TEST 8.

Command:

curl -k -s -X POST \\
  "$BASE_URL/api/admin/posts" \\
  -H "X-API-Key: ***" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Public API test post","content":"Created by the Public API test script."}' \\
  -o RESPONSE_FILE \\
  -w "%{http_code}"
EOF

explain_body_request "POST"

POST_RESPONSE="$TEMP_DIR/create-post.json"

POST_STATUS=$(curl -k -s -X POST \
  "$BASE_URL/api/admin/posts" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Public API test post","content":"Created by the Public API test script."}' \
  -o "$POST_RESPONSE" \
  -w "%{http_code}")

printf '\nResponse (HTTP %s):\n' "$POST_STATUS"
pretty_json_file "$POST_RESPONSE"

if [ "$POST_STATUS" = "201" ]; then
  add_result "POST post" "201" "$POST_STATUS" "PASS"
  print_result "PASS" "post created successfully."
else
  add_result "POST post" "201" "$POST_STATUS" "FAIL"
  print_result "FAIL" "expected HTTP 201."
fi


# ============================================================
# TEST 8 - DELETE created post
# ============================================================

test_header "TEST 8 — DELETE created post"

cat <<'EOF'
Purpose:
Verify the DELETE endpoint by deleting the post created in the
previous test.
EOF

if [ "$POST_STATUS" != "201" ]; then

  add_result "DELETE post" "200" "-" "SKIP"
  print_result \
    "SKIP" \
    "the POST test did not create a post."

elif [ "$JSON_TOOL" = "none" ]; then

  add_result "DELETE post" "200" "-" "SKIP"
  print_result \
    "SKIP" \
    "jq or python3 is required to safely obtain the created post ID."

else

  POST_ID=$(get_json_value \
    "$POST_RESPONSE" \
    '.id // empty' \
    'data.get("id", "")')

  if [ -z "$POST_ID" ]; then

    add_result "DELETE post" "200" "-" "SKIP"
    print_result \
      "SKIP" \
      "could not obtain the ID of the created post."

  else

    printf '\nCreated post ID: %s\n' "$POST_ID"

    cat <<EOF

Command:

curl -k -s -X DELETE \\
  "$BASE_URL/api/admin/posts/$POST_ID" \\
  -H "X-API-Key: ***" \\
  -o RESPONSE_FILE \\
  -w "%{http_code}"
EOF

    explain_delete_request

    DELETE_RESPONSE="$TEMP_DIR/delete-post.json"

    DELETE_STATUS=$(curl -k -s -X DELETE \
      "$BASE_URL/api/admin/posts/$POST_ID" \
      -H "X-API-Key: $API_KEY" \
      -o "$DELETE_RESPONSE" \
      -w "%{http_code}")

    printf '\nResponse (HTTP %s):\n' "$DELETE_STATUS"
    pretty_json_file "$DELETE_RESPONSE"

    if [ "$DELETE_STATUS" = "200" ]; then
      add_result "DELETE post" "200" "$DELETE_STATUS" "PASS"
      print_result "PASS" "created post deleted successfully."
    else
      add_result "DELETE post" "200" "$DELETE_STATUS" "FAIL"
      print_result "FAIL" "expected HTTP 200."
    fi

  fi
fi


# ============================================================
# TEST 9 - Interactive PATCH report resolution
# ============================================================

test_header "TEST 9 — PATCH resolve pending report"

cat <<'EOF'
Purpose:
Test the report resolution endpoint.

The script looks for the first PENDING report.

If one exists, you may choose:
  dismiss  -> resolve the report without removing the content
  remove   -> resolve the report and remove the content
  skip     -> do not modify the report

You may also type another value, such as "banana", to verify that
invalid input is rejected by the API.
EOF

if [ "$JSON_TOOL" = "none" ]; then

  add_result "PATCH resolve report" "-" "-" "SKIP"
  print_result \
    "SKIP" \
    "jq or python3 is required to safely inspect pending reports."

else

  PENDING_REPORT_RESPONSE="$TEMP_DIR/pending-reports.json"

  PENDING_REPORT_STATUS=$(curl -k -s \
    "$BASE_URL/api/admin/reports?status=pending" \
    -H "X-API-Key: $API_KEY" \
    -o "$PENDING_REPORT_RESPONSE" \
    -w "%{http_code}")

  if [ "$PENDING_REPORT_STATUS" != "200" ]; then

    add_result \
      "PATCH resolve report" \
      "200" \
      "$PENDING_REPORT_STATUS" \
      "FAIL"

    print_result \
      "FAIL" \
      "could not retrieve pending reports."

  else

    REPORT_ID=$(get_json_value \
      "$PENDING_REPORT_RESPONSE" \
      '.[0].id // empty' \
      'data[0].get("id", "") if data else ""')

    if [ -z "$REPORT_ID" ]; then

      add_result "PATCH resolve report" "-" "-" "SKIP"
      print_result \
        "SKIP" \
        "no pending report available."

    else

      TARGET_TYPE=$(get_json_value \
        "$PENDING_REPORT_RESPONSE" \
        '.[0].targetType // empty' \
        'data[0].get("targetType", "")')

      TARGET_ID=$(get_json_value \
        "$PENDING_REPORT_RESPONSE" \
        '.[0].targetId // empty' \
        'data[0].get("targetId", "")')

      REASON=$(get_json_value \
        "$PENDING_REPORT_RESPONSE" \
        '.[0].reason // empty' \
        'data[0].get("reason", "")')

      printf '\nFirst pending report:\n'
      printf '  Report ID:   %s\n' "$REPORT_ID"
      printf '  Target type: %s\n' "$TARGET_TYPE"
      printf '  Target ID:   %s\n' "$TARGET_ID"
      printf '  Reason:      %s\n' "$REASON"

      printf '\nAction [dismiss/remove/skip/other]: '
      read -r REPORT_ACTION

      if [ "$REPORT_ACTION" = "skip" ]; then

        add_result "PATCH resolve report" "-" "-" "SKIP"
        print_result \
          "SKIP" \
          "report resolution skipped by user."

      else

        if [ "$REPORT_ACTION" = "dismiss" ] || \
           [ "$REPORT_ACTION" = "remove" ]; then
          EXPECTED_PATCH_STATUS="200"
        else
          EXPECTED_PATCH_STATUS="400"
        fi

        cat <<EOF

Command:

curl -k -s -X PATCH \\
  "$BASE_URL/api/admin/reports/$REPORT_ID/resolve" \\
  -H "X-API-Key: ***" \\
  -H "Content-Type: application/json" \\
  -d '{"action":"$REPORT_ACTION","note":"Public API test script"}' \\
  -o RESPONSE_FILE \\
  -w "%{http_code}"
EOF

        explain_body_request "PATCH"

        PATCH_RESPONSE="$TEMP_DIR/patch-report.json"

        PATCH_STATUS=$(curl -k -s -X PATCH \
          "$BASE_URL/api/admin/reports/$REPORT_ID/resolve" \
          -H "X-API-Key: $API_KEY" \
          -H "Content-Type: application/json" \
          -d "{\"action\":\"$REPORT_ACTION\",\"note\":\"Public API test script\"}" \
          -o "$PATCH_RESPONSE" \
          -w "%{http_code}")

        printf '\nResponse (HTTP %s):\n' "$PATCH_STATUS"
        pretty_json_file "$PATCH_RESPONSE"

        if [ "$PATCH_STATUS" = "$EXPECTED_PATCH_STATUS" ]; then

          add_result \
            "PATCH resolve report" \
            "$EXPECTED_PATCH_STATUS" \
            "$PATCH_STATUS" \
            "PASS"

          if [ "$EXPECTED_PATCH_STATUS" = "200" ]; then
            print_result \
              "PASS" \
              "report resolved successfully."
          else
            print_result \
              "PASS" \
              "invalid action was correctly rejected."
          fi

        else

          add_result \
            "PATCH resolve report" \
            "$EXPECTED_PATCH_STATUS" \
            "$PATCH_STATUS" \
            "FAIL"

          print_result \
            "FAIL" \
            "API behavior did not match the expected result."

        fi

      fi
    fi
  fi
fi


# ============================================================
# TEST 10 - Nginx rate limiting
# ============================================================

test_header "TEST 10 — Nginx rate limiting"

cat <<EOF
Purpose:
Verify the external Nginx rate limiter.

Requests are sent through:

$BASE_URL
        |
        v
      Nginx
        |
        v
     Backend

The Nginx public API limit is configured per client IP.
Repeated requests should eventually receive HTTP 429
Too Many Requests.

This test runs before the backend Redis rate-limit test so that
the Redis counter cannot interfere with the Nginx demonstration.

Command used repeatedly:

curl -k -s \\
  "$BASE_URL/api/admin/users" \\
  -H "X-API-Key: ***" \\
  -o /dev/null \\
  -w "%{http_code}"

Flags:
  -k          Accept the local/self-signed HTTPS certificate.
  -s          Silent mode: hide curl progress information.
  -H          Add the API-key HTTP header.
  -o /dev/null
              Discard the response body for this stress test.
  -w          Print only the HTTP status code.

Sending up to 50 rapid requests...
EOF

NGINX_LIMIT_FOUND=0
NGINX_LIMIT_REQUEST=0
NGINX_LAST_STATUS=""

for i in $(seq 1 50); do

  NGINX_LAST_STATUS=$(curl -k -s \
    "$BASE_URL/api/admin/users" \
    -H "X-API-Key: $API_KEY" \
    -o /dev/null \
    -w "%{http_code}")

  printf 'Request %02d -> HTTP %s\n' "$i" "$NGINX_LAST_STATUS"

  if [ "$NGINX_LAST_STATUS" = "429" ]; then
    NGINX_LIMIT_FOUND=1
    NGINX_LIMIT_REQUEST="$i"
    break
  fi

done

if [ "$NGINX_LIMIT_FOUND" -eq 1 ]; then

  add_result "Nginx rate limiting" "429" "429" "PASS"

  print_result \
    "PASS" \
    "Nginx returned HTTP 429 on request $NGINX_LIMIT_REQUEST."

else

  add_result \
    "Nginx rate limiting" \
    "429" \
    "$NGINX_LAST_STATUS" \
    "FAIL"

  print_result \
    "FAIL" \
    "no HTTP 429 was received within 50 rapid requests."

fi


# ============================================================
# TEST 11 - Backend Redis rate limiting
# ============================================================

test_header "TEST 11 — Backend Redis rate limiting"

cat <<'EOF'
Purpose:
Verify the second rate-limiting layer implemented inside the
NestJS backend using Redis.

Unlike the previous test, these requests do NOT pass through
Nginx.

The script executes curl inside the backend container and calls:

http://localhost:8000/api/admin/users

Therefore the request path is:

Backend container
       |
       v
NestJS Public API
       |
       v
Redis rate limiter

The backend limit is 100 requests per 60-second window.

Conceptual command used repeatedly:

docker compose exec -T backend curl -s \
  "http://localhost:8000/api/admin/users" \
  -H "X-API-Key: ***" \
  -o /dev/null \
  -w "%{http_code}"

Additional flags:
  docker compose exec
              Execute a command inside a running Compose service.
  -T          Disable pseudo-terminal allocation. This is useful
              for non-interactive/scripted execution.

curl flags:
  -s          Silent mode: hide curl progress information.
  -H          Add the API-key HTTP header.
  -o /dev/null
              Discard the response body.
  -w          Print only the HTTP status code.

Sending up to 120 direct backend requests...
EOF

if ! command -v docker >/dev/null 2>&1; then

  add_result \
    "Redis rate limiting" \
    "429" \
    "-" \
    "SKIP"

  print_result \
    "SKIP" \
    "Docker is not available on this machine."

elif ! docker compose ps backend >/dev/null 2>&1; then

  add_result \
    "Redis rate limiting" \
    "429" \
    "-" \
    "SKIP"

  print_result \
    "SKIP" \
    "the backend Compose service is not available."

else

  REDIS_LIMIT_FOUND=0
  REDIS_LIMIT_REQUEST=0
  REDIS_LAST_STATUS=""

  for i in $(seq 1 120); do

    REDIS_LAST_STATUS=$(docker compose exec -T \
      -e PUBLIC_API_TEST_KEY="$API_KEY" \
      backend \
      sh -c '
        curl -s \
          "http://localhost:8000/api/admin/users" \
          -H "X-API-Key: $PUBLIC_API_TEST_KEY" \
          -o /dev/null \
          -w "%{http_code}"
      ' 2>/dev/null)

    printf 'Request %03d -> HTTP %s\n' "$i" "$REDIS_LAST_STATUS"

    if [ "$REDIS_LAST_STATUS" = "429" ]; then
      REDIS_LIMIT_FOUND=1
      REDIS_LIMIT_REQUEST="$i"
      break
    fi

  done

  if [ "$REDIS_LIMIT_FOUND" -eq 1 ]; then

    add_result \
      "Redis rate limiting" \
      "429" \
      "429" \
      "PASS"

    print_result \
      "PASS" \
      "backend Redis limiter returned HTTP 429 on request $REDIS_LIMIT_REQUEST."

  else

    if [ -z "$REDIS_LAST_STATUS" ]; then
      REDIS_LAST_STATUS="no response"
    fi

    add_result \
      "Redis rate limiting" \
      "429" \
      "$REDIS_LAST_STATUS" \
      "FAIL"

    print_result \
      "FAIL" \
      "no HTTP 429 was received within 120 direct backend requests."

  fi

fi


# ============================================================
# FINAL SUMMARY
# ============================================================

separator
printf 'FINAL SUMMARY\n'
separator

printf '\n%-32s %-10s %-10s %-8s\n' \
  "Test" "Expected" "Actual" "Result"

printf '%-32s %-10s %-10s %-8s\n' \
  "--------------------------------" \
  "----------" \
  "----------" \
  "--------"

for i in "${!TEST_NAMES[@]}"; do
  printf '%-32s %-10s %-10s %-8s\n' \
    "${TEST_NAMES[$i]}" \
    "${TEST_EXPECTED[$i]}" \
    "${TEST_ACTUAL[$i]}" \
    "${TEST_RESULTS[$i]}"
done

printf '\nPassed:  %d\n' "$PASS_COUNT"
printf 'Failed:  %d\n' "$FAIL_COUNT"
printf 'Skipped: %d\n' "$SKIP_COUNT"

if [ "$FAIL_COUNT" -eq 0 ]; then
  printf '\nOverall result: PASS\n'
else
  printf '\nOverall result: FAIL\n'
fi

printf '\n'