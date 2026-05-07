# Instawork W-2 & I-9 Onboarding Simulation

A full-stack TypeScript simulation of the Instawork W-2 and I-9 onboarding flow, including WorkBright Form I-9, identity verification via Google Gemini Vision (through n8n), and a feedback/rating screen.

---

## Deploy on Replit

1. **Import from GitHub** — paste your repo URL into Replit's "Import from GitHub" dialog.
2. Replit auto-detects Node.js and runs `npm install`.
3. Click **Run** — this runs `npm run build && npm start`.
4. Set **Secrets** (Replit's env var panel) — see table below.

| Secret name | Value |
|---|---|
| `IDENTITY_VERIFICATION_SERVICE_URL` | `https://instawork.app.n8n.cloud/webhook/identity/verify-document` |
| `I9_VERIFICATION_URL` | `https://instawork.app.n8n.cloud/webhook/i9/verify-document` |
| `IDENTITY_VERIFICATION_SERVICE_SECRET` | *(optional, shared header sent to n8n)* |

The server listens on `process.env.PORT` (set automatically by Replit) and falls back to `3001` locally.

---

## Run Locally (development)

Run the frontend (Vite dev server with HMR) and the backend (Express API) in two terminals:

```bash
# Terminal 1 — API server (port 3001)
npm install
npm run dev:server

# Terminal 2 — Vite dev server (port 5173, proxies /api → 3001)
npm run dev:local
```

Open **http://localhost:5173**.

---

## Build for Production

```bash
npm run build   # builds Vite frontend → dist/client/
npm start       # Express serves API + static frontend on PORT (default 3001)
```

Open **http://localhost:3001**.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in values:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|---|---|---|
| `PORT` | Port the Express server listens on | `3001` |
| `IDENTITY_VERIFICATION_SERVICE_URL` | n8n webhook for identity document verification | Instawork production n8n |
| `I9_VERIFICATION_URL` | n8n webhook for I-9 document verification | Instawork production n8n |
| `IDENTITY_VERIFICATION_SERVICE_SECRET` | Optional shared secret header for n8n | *(empty)* |

---

## Project Structure

```
.
├── client/          # React + Vite frontend
│   └── src/
│       ├── App.tsx       # Full onboarding flow
│       └── styles.css
├── server/          # Express API
│   ├── index.ts     # Entry point (listens on PORT)
│   └── app.ts       # Routes + static file serving
├── shared/          # Types, validation, fixtures (used by both)
├── n8n/             # Importable n8n workflow JSONs
├── dist/            # Built output (git-ignored)
├── .env.example     # Required environment variables
└── .replit          # Replit deployment config
```

---

## n8n Workflows

Import these into your n8n instance:

| File | Purpose |
|---|---|
| `n8n/identity-verification-v2-workflow.json` | Identity document OCR via Gemini Vision |
| `n8n/i9-document-verification.workflow.json` | I-9 document cross-list validation |
| `n8n/instawork-w2-document-validation.workflow.json` | W-2 document validation |

Google Drive folder for uploaded images: `17N2GfPmuGpZ9OErpOwNHl_xv8L5rB9Sy`

---

## Key Features

- **Identity Verification** — Upload US government ID, Gemini Vision checks name/DOB match
- **W-2 Profile Setup** — SSN validation, duplicate detection, legal name confirmation
- **WorkBright I-9 Simulation** — Citizenship attestation, List A / List B+C document upload with front+back, cross-list mismatch detection, real-time feedback
- **Admin Review → Feedback** — Final rating screen (1–5 stars) after I-9 submission
- **Image cache clearing** — Images are cleared on every back navigation, forcing fresh uploads
