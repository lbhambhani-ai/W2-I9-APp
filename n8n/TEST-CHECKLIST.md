# N8N Identity Verification — Test Setup & Run Checklist

## Prerequisites

- [ ] n8n instance running (cloud or self-hosted)
- [ ] OpenAI API key with access to `gpt-4.1-mini` (or your chosen model)
- [ ] Google account with access to the **Testing W2** Drive folder
- [ ] Python 3.9+ (only needed for the automated test runner)

---

## Step 1 — Import The Workflow

1. Open your n8n instance.
2. Go to **Workflows → Import from file**.
3. Select `n8n/identity-verification-n8n-workflow.json`.
4. The workflow will appear as **Identity Verification - ChatGPT Vision**.

---

## Step 2 — Set Up Google Drive Credential

1. In n8n go to **Credentials → New → Google Drive OAuth2 API**.
2. Follow the OAuth flow and authorize the account that owns the **Testing W2** folder.
3. Open the imported workflow.
4. Click the **Upload ID Image To Google Drive** node.
5. Under **Credential**, select the Google Drive account you just created.
6. Save the node.

The folder ID `1vn1OXPH2al136Us9th9LHR96nwIqHLQd` (Testing W2) is already hardcoded.

---

## Step 3 — Set OPENAI_API_KEY Environment Variable

### Option A — n8n Cloud
In n8n go to **Settings → Environment Variables** and add:

```
OPENAI_API_KEY = sk-...your-key...
```

### Option B — Self-hosted (Docker)
Add to your `docker-compose.yml` or `.env` file:

```env
OPENAI_API_KEY=sk-...your-key...
```

Restart n8n after adding.

### Option C — Override the model (optional)
```env
OPENAI_IDENTITY_MODEL=gpt-4.1
```
If not set, the workflow defaults to `gpt-4.1-mini`.

---

## Step 4 — Activate The Workflow

1. Open the workflow in n8n.
2. Toggle **Active** to ON (top-right switch).
3. Copy the **Production Webhook URL** shown — it will look like:
   ```
   https://your-n8n.example.com/webhook/identity/verify-document
   ```

---

## Step 5 — Quick Smoke Test (curl)

Replace `N8N_URL` with your actual webhook URL.

### Valid request (placeholder image — expect `documentDetected: false`):
```bash
N8N_URL="https://your-n8n.example.com/webhook/identity/verify-document"

curl -s -X POST "$N8N_URL" \
  -H "Content-Type: application/json" \
  -d @n8n/test-payloads/drivers-license-front.json | python3 -m json.tool
```

Expected: HTTP 200, `success: true`, `nextAction` set, `userMessage` set.

### Invalid request (missing imageBase64 — expect HTTP 400):
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$N8N_URL" \
  -H "Content-Type: application/json" \
  -d @n8n/test-payloads/invalid-missing-fields.json
# Expected: 400
```

---

## Step 6 — Real-Image Automated Test Runner

This uses the 9 real document images from the assets folder and sends them
to the live webhook, checking every field, flag, and nextAction.

```bash
# Set your webhook URL:
export N8N_WEBHOOK_URL="https://your-n8n.example.com/webhook/identity/verify-document"

# Optional overrides:
export N8N_TEST_TIMEOUT=120
export N8N_ASSETS_DIR="/Users/instawork/.cursor/projects/Users-instawork-Desktop-untitled-folder-3/assets"

# Run:
python3 n8n/test-n8n-webhook.py
```

The runner checks each case for:
- HTTP 200
- `success: true`
- `requestId` preserved
- `source: n8n-chatgpt-vision`
- `googleDriveFileId` populated (confirms Drive upload worked)
- `detectedDocumentType` matches expected type
- `detectedSide` matches expected side
- Correct `first_name`, `last_name`, `date_of_birth` extracted
- `nameMatch: MATCH` or `PARTIAL_MATCH`
- `dobMatch: MATCH`
- Expected `expirationStatus`
- `nextAction: CONTINUE`
- `canContinue: true`
- No `IMAGE_QUALITY_LOW` or `SIDE_MISMATCH` flag

---

## Step 7 — Manual Postman Testing

All payloads are in `n8n/test-payloads/`. Replace `imageBase64` in each file
with a real base64-encoded document photo before sending.

To encode a real image:
```bash
echo "data:image/png;base64,$(base64 -i /path/to/photo.png | tr -d '\n')"
```

| File | Doc Type | Side | Expected nextAction |
|------|----------|------|---------------------|
| `drivers-license-front.json` | drivers-license | front | CONTINUE |
| `state-id-front.json` | state-id | front | CONTINUE |
| `passport-front.json` | passport | front | CONTINUE |
| `passport-card-front.json` | passport-card | front | CONTINUE |
| `ead-front.json` | employment-authorization-card | front | CONTINUE |
| `ead-back.json` | employment-authorization-card | back | CONTINUE |
| `permanent-resident-card-front.json` | permanent-resident-card | front | CONTINUE |
| `military-id-front.json` | military-id | front | CONTINUE |
| `invalid-missing-fields.json` | — | — | HTTP 400 |

---

## Step 8 — Check Google Drive

After running a successful test, open the **Testing W2** folder:
https://drive.google.com/drive/folders/1vn1OXPH2al136Us9th9LHR96nwIqHLQd

Verify that uploaded files appear with names like:
```
n8n-test-01-state-id-front.png
n8n-test-03-passport-front.png
```

---

## Troubleshooting

### Workflow not triggering
- Confirm the workflow is **Active** (not just saved).
- Use the **Test URL** in n8n for quick manual testing before activating.

### Google Drive upload fails
- Check the credential is authorized and not expired.
- Confirm the folder ID `1vn1OXPH2al136Us9th9LHR96nwIqHLQd` is accessible by that Google account.

### OpenAI returns 401 Unauthorized
- Confirm `OPENAI_API_KEY` is set in the n8n environment.
- Confirm the key has access to the Responses API (`/v1/responses`).

### OpenAI returns non-JSON or MODEL_RESPONSE_INVALID
- The model produced plain text instead of strict JSON.
- Check the system prompt is loaded correctly in the `Build OpenAI Vision Request` node.
- Try switching to `gpt-4.1` via `OPENAI_IDENTITY_MODEL=gpt-4.1`.

### canContinue is false on a good image
- Inspect `analysis.flags` and `analysis.nextAction` in the response.
- Common causes: `SIDE_MISMATCH`, `IMAGE_QUALITY_LOW`, `DOCUMENT_TYPE_MISMATCH`.
- These are correct workflow behaviors, not bugs.

### Test runner shows "Image not found"
- Confirm `N8N_ASSETS_DIR` points to the folder containing the `file_front_*` and `file_back_*` PNG files.

---

## Expected Final Response Shape

```json
{
  "success": true,
  "requestId": "n8n-test-01",
  "source": "n8n-chatgpt-vision",
  "googleDriveFileId": "1AbCdEfGhIjK...",
  "userMessage": "This ID looks good and matches your profile.",
  "nextAction": "CONTINUE",
  "canContinue": true,
  "humanReviewRequired": false,
  "analysis": {
    "requestId": "n8n-test-01",
    "documentDetected": true,
    "detectedDocumentType": "state-id",
    "detectedSide": "front",
    "documentTypeMatch": true,
    "sideMatchesSelected": true,
    "extractedFields": { ... },
    "fieldConfidence": { ... },
    "validationResults": {
      "nameMatch": { "status": "MATCH", ... },
      "dobMatch": { "status": "MATCH", ... },
      "expirationStatus": "VALID",
      "photoIntegrity": "CLEAR"
    },
    "booleanChecks": {
      "canContinue": true,
      "nameMatchesProfile": true,
      "dobMatchesProfile": true,
      "documentExpired": false
    },
    "flags": [],
    "complianceEligibility": true,
    "nextAction": "CONTINUE",
    "humanReviewRequired": false
  }
}
```
