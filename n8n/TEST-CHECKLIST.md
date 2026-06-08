# N8N Document Validation & I-9 — Test Setup & Run Checklist

## Prerequisites

- [ ] n8n instance running (cloud or self-hosted)
- [ ] OpenAI API key with access to `gpt-4.1-mini` (or your chosen model)
- [ ] AWS IAM credentials for the dev S3 bucket (see Step 2)
- [ ] Python 3.9+ (only needed for the automated test runner)

---

## Step 1 — Import The Workflows

1. Open your n8n instance.
2. Go to **Workflows → Import from file**.
3. Import both:
   - `n8n/document-validation-n8n-workflow.json` → **Document Validation - ChatGPT Vision**
   - `n8n/i9-document-verification.workflow.json` → **I-9 Document Verification**

---

## Step 2 — Set Up AWS S3 Credential (Dev)

Both workflows upload documents to the dev bucket `instawork-prod-ops-w2-i9-docs-dev`
in `us-west-2` using an IAM user with **upload-only** permissions
(`s3:PutObject`, `s3:AbortMultipartUpload`; all other operations explicitly denied).

### 2a. Create the credential in n8n

1. In n8n go to **Credentials → New → AWS**.
2. Name it exactly: **AWS S3 W2-I9 Dev**
3. Enter the dev IAM user keys from your password manager / secure handoff:

   | Field                   | Value                                              |
   |-------------------------|----------------------------------------------------|
   | Region                  | `us-west-2`                                        |
   | Access Key ID           | `IV_AWS_ACCESS_KEY_ID` secure value                |
   | Secret Access Key       | `IV_AWS_SECRET_ACCESS_KEY` secure value            |
   | Custom Endpoints        | leave unchecked                                    |
   | Temporary Credentials   | leave unchecked                                    |

4. Click **Save**.

> Production keys (for `instawork-prod-ops-w2-i9-docs`) are kept separately and
> are not required for dev testing. Switch to those only when promoting to prod.

### 2b. Confirm the workflows are wired to the credential

In each imported workflow:

- **Document Validation** → open the **Upload ID Image To S3** node
- **I-9 Document Verification** → open the **Upload I9 Doc To S3** node

Make sure:
- **Bucket** = `instawork-prod-ops-w2-i9-docs-dev`
- **Operation** = `Upload`
- **Credential** = `AWS S3 W2-I9 Dev`

Object keys are auto-generated:
```
identity/<requestId>/<fileName>      (Document Validation)
i9/<requestId>/<fileName>            (I-9 Document Verification)
```

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

## Step 4 — Activate The Workflows

1. Open each workflow in n8n.
2. Toggle **Active** to ON (top-right switch).
3. Copy the **Production Webhook URL** for each:
   ```
   https://your-n8n.example.com/webhook/identity/verify-document   (Document Validation)
   https://your-n8n.example.com/webhook/i9/verify-document         (I-9)
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

Expected: HTTP 200, `success: true`, `s3FileKey` set, `s3FileUrl` set,
`nextAction` set, `userMessage` set.

### Invalid request (missing imageBase64 — expect HTTP 400):
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$N8N_URL" \
  -H "Content-Type: application/json" \
  -d @n8n/test-payloads/invalid-missing-fields.json
# Expected: 400
```

---

## Step 6 — Real-Image Automated Test Runner

This uses the real document images from the assets folder and sends them
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
- `s3FileKey` populated (confirms S3 upload worked)
- `s3FileUrl` populated
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

## Step 8 — Verify Upload in S3

After running a successful test, verify the file landed in the dev bucket.

The IAM user `prod-ops-n8n-w2-i9-automation-dev` is **upload-only**, so use a
separate AWS profile (with read permissions, e.g. your SSO `instawork`
profile from STEP 1 of the bucket setup doc) to list/inspect:

```bash
# List recent uploads under identity/
aws s3 ls "s3://instawork-prod-ops-w2-i9-docs-dev/identity/" \
  --recursive --profile instawork | tail -20

# List recent uploads under i9/
aws s3 ls "s3://instawork-prod-ops-w2-i9-docs-dev/i9/" \
  --recursive --profile instawork | tail -20
```

The webhook response also returns `s3FileKey` and `s3FileUrl`, so you can grab
those straight from the JSON response and confirm against the bucket.

---

## Troubleshooting

### Workflow not triggering
- Confirm the workflow is **Active** (not just saved).
- Use the **Test URL** in n8n for quick manual testing before activating.

### S3 upload fails — `AccessDenied`
- Double-check the credential is using the **dev** access keys, not the production ones.
- Confirm the bucket name is `instawork-prod-ops-w2-i9-docs-dev`.
- Confirm region is `us-west-2`.
- The IAM user is `s3:PutObject` only — any non-upload op will fail by design.

### S3 upload fails — `RequestTimeTooSkewed`
- The host running n8n has clock drift. Sync NTP.

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
  "s3FileKey": "identity/n8n-test-01/state-id-front.png",
  "s3FileUrl": "https://instawork-prod-ops-w2-i9-docs-dev.s3.us-west-2.amazonaws.com/identity/n8n-test-01/state-id-front.png",
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
    "extractedFields": { },
    "fieldConfidence": { },
    "validationResults": {
      "nameMatch": { "status": "MATCH" },
      "dobMatch": { "status": "MATCH" },
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

---

## Promoting Dev → Production

When the dev workflow is verified end-to-end, swap the credential in the S3
upload node from **AWS S3 W2-I9 Dev** to a new credential pointing at the
production IAM user (`prod-ops-n8n-w2-i9-automation`) and change the bucket name from
`instawork-prod-ops-w2-i9-docs-dev` to `instawork-prod-ops-w2-i9-docs`.

No other workflow changes are required.
