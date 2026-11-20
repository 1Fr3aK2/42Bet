TOKEN=$(curl -sk -X POST https://localhost/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"pedro1","password":"12345678"}' \
  | jq -r '.access_token')

export TOKEN
print "TOKEN=" $TOKEN

