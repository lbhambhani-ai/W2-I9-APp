# How to Deploy on Replit

## Step 1 — Push to GitHub

If you haven't already pushed this project to GitHub, do it now from your terminal:

```bash
cd "/Users/instawork/Desktop/untitled folder 3"

git init
git add .
git commit -m "Initial commit"
```

Then create a new repository on [github.com](https://github.com/new) (make it **private**) and push:

```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git branch -M main
git push -u origin main
```

---

## Step 2 — Import into Replit

1. Go to [replit.com](https://replit.com) and sign in.
2. Click **+ Create Repl**.
3. Select **Import from GitHub**.
4. Paste your GitHub repository URL, e.g.:
   ```
   https://github.com/YOUR_USERNAME/YOUR_REPO_NAME
   ```
5. Click **Import from GitHub**.
6. Replit will detect it as a Node.js project automatically.

---

## Step 3 — Add Environment Variables (Secrets)

In your Repl, click the **Secrets** tab in the left sidebar (the lock icon 🔒) and add the
keys below. The app will *run* with no secrets at all (it falls back to the Instawork
production n8n webhooks), but set the **Recommended** ones for a clean, fully-working deploy.

### Recommended

| Key | Value | Why |
|-----|-------|-----|
| `ENABLE_PYTHON_OCR` | `false` | n8n is the primary verification path; skips the heavy Python build on Replit. |
| `AUDIT_LOG_WEBHOOK_URL` | `https://instawork.app.n8n.cloud/webhook/audit-log` | Turns on audit logging to Google Sheets (off if unset). |
| `AUDIT_LOG_WEBHOOK_SECRET` | _your shared secret_ | **Required if** you imported the audit workflow with the "Check Secret" node. Set the **same** value as an n8n Variable named `AUDIT_LOG_WEBHOOK_SECRET`, or the workflow returns 401. |

### Optional (set only to override defaults / enable extras)

| Key | Value | Why |
|-----|-------|-----|
| `DOCUMENT_VALIDATION_SERVICE_URL` | `https://instawork.app.n8n.cloud/webhook/identity/verify-document` | Identity-doc verification webhook. Defaults to this if unset. |
| `I9_VERIFICATION_URL` | `https://instawork.app.n8n.cloud/webhook/i9/verify-document` | I-9 verification webhook. Defaults to this if unset. |
| `DOCUMENT_VALIDATION_SERVICE_SECRET` | _your shared secret_ | Only if your identity/I-9 n8n webhooks require the `x-instawork-identity-secret` header. |
| `I9_VERIFICATION_SECRET` | _your shared secret_ | Only if the I-9 webhook needs a different secret than above (falls back to `DOCUMENT_VALIDATION_SERVICE_SECRET`). |
| `INTERCOM_API_KEY` | _your Intercom key_ | Enriches audit rows with the contact's name + email (looked up by `?uid=` / `?email=` on the sim link). |

### Do NOT set

| Key | Why |
|-----|-----|
| `PORT` | Replit injects this automatically. Hard-coding it can break the public URL. |

For audit logging, import `n8n/audit-log-google-sheets.workflow.json` into n8n, then replace:
- `REPLACE_WITH_GOOGLE_SHEET_ID` with the Google Sheet ID that should receive rows.
- `REPLACE_WITH_GOOGLE_SHEETS_CREDENTIAL_ID` with your Google Sheets credential in n8n.

Create a sheet tab named `audit_log`. The workflow auto-maps incoming row fields, so the first successful run can create or populate columns based on the normalized audit payload.

---

## Step 4 — Run the App

1. Click the green **Run** button at the top.
2. The `.replit` `run` command does everything automatically:
   `npm install && npm run build && npm start`
   - `npm install` — installs all dependencies
   - `npm run build` — builds the React frontend into `dist/client/`
   - `npm start` — starts the Express server, which serves both the API and the built frontend on `$PORT`
3. A browser preview will open inside Replit showing the app.
4. You can also open it in a full browser tab using the URL shown at the top of the preview panel.

> **Published deployments** use the `[deployment]` config in `.replit`, which builds with
> `npm install && npm run build` and serves with `npm start` — so the published site always
> ships a freshly built frontend.

---

## Step 5 — Share the App

Once running, your app is publicly accessible at:

```
https://YOUR_REPL_NAME.YOUR_USERNAME.repl.co
```

Share this URL with anyone who needs to test the simulation.

---

## Troubleshooting

### App shows a blank white page
- Make sure the build completed successfully. Check the console for any build errors.
- In the Replit shell, run manually:
  ```bash
  npm run build
  npm start
  ```

### "Cannot find module" errors on startup
- Run `npm install` in the Replit shell to reinstall dependencies.

### Document analysis returns errors / "Analysis failed"
- Double-check that both Secrets (`DOCUMENT_VALIDATION_SERVICE_URL` and `I9_VERIFICATION_URL`) are set correctly in the Secrets panel.
- Make sure the n8n workflows are **active** (not in test/paused mode) in your n8n dashboard.

### App works locally but not on Replit
- Verify the `.replit` file is present in the root of the repo (it should be committed to GitHub).
- Check that `PORT` is not hardcoded anywhere — the server reads `process.env.PORT` automatically.

---

## Updating the App After Code Changes

When you push new code to GitHub:

1. In Replit, open the **Shell** tab and run:
   ```bash
   git pull
   npm install
   npm run build
   ```
2. Click **Stop** then **Run** to restart the server, or run:
   ```bash
   npm start
   ```

---

## Local Development (reminder)

For local development, use two terminals:

```bash
# Terminal 1 — Express API (port 3001)
npm run dev:server

# Terminal 2 — Vite dev server (port 5173)
npm run dev:local
```

Open **http://localhost:5173** in your browser.
