# Test Payloads

Each JSON file in this folder is a ready-to-use request body for the n8n document validation webhook.

## How to use

**curl:**
```bash
N8N_URL="https://your-n8n-instance.example.com/webhook/identity/verify-document"

curl -s -X POST "$N8N_URL" \
  -H "Content-Type: application/json" \
  -d @drivers-license-front.json | python3 -m json.tool
```

**Postman:**
1. POST to your webhook URL
2. Body → raw → JSON
3. Paste file contents

## imageBase64 field

The `imageBase64` field in each file contains a tiny placeholder 1×1 white PNG.
Replace the value with a real base64-encoded image before sending.

To encode a real image:
```bash
base64 -i /path/to/id-photo.png | tr -d '\n'
# or with data URL prefix:
echo "data:image/png;base64,$(base64 -i /path/to/id-photo.png | tr -d '\n')"
```
