# N8N Identity Verification Workflow Plan

## Goal

Build an n8n workflow that uses the new ChatGPT vision prompt in `n8n/identity-verification-chatgpt-agent-prompt.txt` to verify uploaded identity documents.

The workflow should replace or supplement the current local OCR flow:

```text
App -> Express backend -> n8n webhook -> Google Drive upload -> ChatGPT vision agent -> normalized JSON -> Express/app
```

The main responsibility of n8n is orchestration. ChatGPT performs the document analysis, and n8n validates inputs, prepares the image, calls the model, normalizes the response, and returns a predictable JSON object to the app.

## Required App Payload

The app or Express backend should send a JSON payload to the n8n webhook with:

```json
{
  "requestId": "string",
  "selectedDocumentType": "drivers-license",
  "documentSide": "front",
  "imageBase64": "base64 image string",
  "profile": {
    "legalFirstName": "string",
    "legalMiddleName": "string optional",
    "legalLastName": "string",
    "dateOfBirth": "YYYY-MM-DD",
    "addressLine1": "string optional",
    "addressLine2": "string optional",
    "city": "string optional",
    "state": "string optional",
    "zip": "string optional"
  }
}
```

Supported `selectedDocumentType` values:

- `drivers-license`
- `state-id`
- `passport`
- `passport-card`
- `permanent-resident-card`
- `employment-authorization-card`
- `military-id`
- `unknown`

Supported `documentSide` values:

- `front`
- `back`

## N8N Workflow Nodes

### 1. Webhook Trigger

Create a `POST` webhook endpoint for identity verification.

Suggested path:

```text
/identity/verify-document
```

The webhook receives the app payload and starts the workflow.

### 2. Validate Required Fields

Add an `IF` node or `Code` node to validate:

- `requestId`
- `selectedDocumentType`
- `documentSide`
- `imageBase64`
- `profile.legalFirstName`
- `profile.legalLastName`
- `profile.dateOfBirth`

If validation fails, return a structured error immediately:

```json
{
  "requestId": null,
  "success": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Missing required identity verification fields."
  },
  "analysis": null
}
```

### 3. Convert Base64 Image To Binary

Add a `Code` node to convert `imageBase64` into binary data.

Implementation notes:

- Strip a leading data URL prefix if present, for example `data:image/png;base64,`.
- Preserve or infer the MIME type.
- Store the binary field as `data` or `image`.
- Use a deterministic file name:

```text
{{ $json.requestId }}-{{ $json.selectedDocumentType }}-{{ $json.documentSide }}.png
```

### 4. Upload Image To Google Drive

Add a Google Drive upload node.

Suggested node name:

```text
Upload ID Image To Google Drive
```

The new prompt already references this node name:

```text
{{ $('Upload ID Image To Google Drive').item.json.id || $('Upload ID Image To Google Drive').item.json.fileId }}
```

Keep that node name unless the prompt template is updated.

Target folder: **Testing W2** (`1vn1OXPH2al136Us9th9LHR96nwIqHLQd`)

Store:

- Google Drive file ID
- file name
- MIME type
- request ID

### 5. Prepare ChatGPT Prompt Input

Add a `Set` or `Code` node that prepares the exact values used by `identity-verification-chatgpt-agent-prompt.txt`.

Pass through:

- `requestId`
- `selectedDocumentType`
- `documentSide`
- `profile`
- Google Drive file ID

The ChatGPT node should use:

- System prompt from the `System Prompt` section of `identity-verification-chatgpt-agent-prompt.txt`
- User prompt from the `User Prompt Template` section
- The uploaded image as the vision input

Important model instruction:

```text
Return strict JSON only. Do not include Markdown, prose, or code fences.
```

### 6. ChatGPT Vision Analysis

Add an OpenAI/ChatGPT node configured for image analysis.

The model must inspect the image and return the schema from the prompt, including:

- `documentDetected`
- `detectedDocumentType`
- `documentTypeMatch`
- `detectedSide`
- `sideMatchesSelected`
- `extractedFields`
- `fieldConfidence`
- `validationResults`
- `booleanChecks`
- `flags`
- `nextAction`
- `humanReviewRequired`
- `userMessage`

The workflow should not rely on free-text reasoning. The app should only use the strict JSON response.

### 7. Parse And Validate ChatGPT JSON

Add a `Code` node after ChatGPT to:

- Parse the model response as JSON.
- Remove accidental code fences if needed.
- Confirm required top-level keys exist.
- Confirm `requestId` matches the original request.
- Default invalid or unparsable responses to a safe failure response.

Safe failure response:

```json
{
  "success": false,
  "requestId": "original request id",
  "source": "n8n-chatgpt-vision",
  "googleDriveFileId": "uploaded file id",
  "analysis": {
    "documentDetected": false,
    "booleanChecks": {
      "canContinue": false,
      "humanReviewRequired": true
    },
    "flags": [
      {
        "severity": "CRITICAL",
        "code": "MODEL_RESPONSE_INVALID",
        "message": "The verifier could not return a valid structured response."
      }
    ],
    "nextAction": "HALT_VERIFICATION",
    "humanReviewRequired": true,
    "reviewReason": "Invalid model response.",
    "userMessage": "We could not verify this image automatically. Please try again or contact support."
  }
}
```

### 8. Normalize Response For App

Return a stable wrapper around the ChatGPT analysis:

```json
{
  "success": true,
  "requestId": "string",
  "source": "n8n-chatgpt-vision",
  "googleDriveFileId": "string",
  "userMessage": "string",
  "nextAction": "CONTINUE",
  "canContinue": true,
  "humanReviewRequired": false,
  "analysis": {}
}
```

The `analysis` object should be the full JSON object returned by ChatGPT.

The app should make decisions from:

- `analysis.booleanChecks.canContinue`
- `analysis.nextAction`
- `analysis.flags`
- `analysis.userMessage`
- `analysis.humanReviewRequired`

## App Decision Rules

Use `nextAction` as the primary workflow decision:

- `CONTINUE`: allow the user to proceed.
- `REQUEST_BACK_IMAGE`: ask the user to upload the back side.
- `REQUEST_FRONT_IMAGE`: ask the user to upload the front side.
- `RETAKE_PHOTO`: ask the user for a clearer image.
- `HALT_VERIFICATION`: block and show the returned `userMessage`.

Use critical flags for support/debugging:

- `SIDE_MISMATCH`: user uploaded front/back into the wrong slot.
- `DOCUMENT_TYPE_MISMATCH`: selected type does not match detected type.
- `NAME_MISMATCH`: readable document name differs from profile.
- `DOB_MISMATCH`: readable document DOB differs from profile.
- `IMAGE_QUALITY_LOW`: key fields cannot be read reliably.
- `DOCUMENT_EXPIRED`: document is expired.

Do not show name or DOB mismatch messages when the model says the side is wrong or the image is unreadable.

## Prompt Integration Checklist

Before enabling the workflow:

- Copy the prompt from `n8n/identity-verification-chatgpt-agent-prompt.txt` into the ChatGPT node.
- Keep the system prompt and user prompt separated if the n8n OpenAI node supports both.
- Confirm the Google Drive node is named `Upload ID Image To Google Drive`.
- Confirm the image is attached to the model request, not only referenced as text.
- Confirm the model response is configured for JSON output if the node supports response format settings.
- Confirm the workflow returns the normalized wrapper to the webhook response.

## Testing Plan

Test each supported document type with front and back images:

- Driver license
- State ID
- Passport book
- Passport card
- Permanent resident card
- Employment authorization card
- Military ID

Required scenario tests:

- Correct document type, correct side, matching name and DOB.
- Correct document type but wrong side uploaded.
- User selected wrong document type.
- Blurry or low-resolution image.
- Cropped image with missing key fields.
- Name mismatch.
- DOB mismatch.
- Expired document.
- Back side required after front side succeeds.
- Unsupported image or no document visible.

For every test, confirm:

- Response is valid JSON.
- `requestId` is preserved.
- `detectedDocumentType` is correct.
- `detectedSide` is correct.
- `nextAction` matches the expected app behavior.
- `userMessage` is clear and user-safe.
- The workflow does not continue when `canContinue` is false.

## Rollout Plan

1. Build the n8n workflow in a test workspace.
2. Use sample app payloads and real document test images.
3. Compare results against the current Python OCR verifier.
4. Add Express backend configuration for the n8n webhook URL.
5. Gate the n8n verifier behind a feature flag.
6. Run side-by-side verification in logs without blocking users.
7. Enable n8n for a small test group.
8. Monitor invalid model responses, human review rates, retake rates, and mismatch rates.
9. Expand rollout once response stability is acceptable.

## Open Implementation Questions

- Should the app send base64 directly to n8n, or should Express upload the image first and send n8n a file reference?
- Should Google Drive files be retained permanently, deleted after verification, or moved to a retention folder?
- Should n8n call the app backend with results asynchronously, or should the webhook response remain synchronous?
- Which model should be used for production latency and accuracy?
- Should the app continue to use Python OCR as a fallback when the model response is invalid?

## Recommended First Version

Start with a synchronous webhook flow:

```text
Express -> n8n webhook -> Google Drive -> ChatGPT vision -> JSON validation -> webhook response -> Express
```

Keep Python OCR available as a fallback until the n8n workflow has been tested across all supported document types and failure scenarios.
