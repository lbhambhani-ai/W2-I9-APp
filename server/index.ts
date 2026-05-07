import { createServer } from "./app";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.PORT || 3001);

// ── Python OCR sidecar ────────────────────────────────────────────────────────
// Start the FastAPI identity service on port 8001 as a background process.
// Only starts if Python is available and identity_service exists.
// If it fails to start, the server still runs — n8n is the primary path.
function startPythonOcrSidecar() {
  const svcDir = join(process.cwd(), "identity_service");
  if (!existsSync(svcDir)) {
    console.log("[python-ocr] identity_service/ not found — skipping sidecar");
    return;
  }

  const pythonBin = existsSync("/usr/bin/python3") ? "python3"
    : existsSync("/home/runner/.venv/bin/python") ? "/home/runner/.venv/bin/python"
    : "python3";

  const ocrPort = process.env.PYTHON_OCR_PORT || "8001";

  console.log(`[python-ocr] Starting sidecar on port ${ocrPort} using ${pythonBin}...`);

  const proc = spawn(
    pythonBin,
    ["-m", "uvicorn", "identity_service.app:app", "--host", "0.0.0.0", "--port", ocrPort, "--workers", "1"],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: { ...process.env, PYTHONUNBUFFERED: "1" }
    }
  );

  proc.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[python-ocr] ${line}`);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    // uvicorn startup info goes to stderr — log but don't treat as fatal
    if (line) console.log(`[python-ocr] ${line}`);
  });

  proc.on("error", (err) => {
    console.warn(`[python-ocr] Failed to start sidecar: ${err.message}`);
    console.warn("[python-ocr] Identity verification will use n8n only.");
  });

  proc.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.warn(`[python-ocr] Sidecar exited with code ${code} — n8n remains the primary path.`);
    }
  });

  // Give uvicorn a moment to boot, then confirm it's reachable
  setTimeout(async () => {
    try {
      const res = await fetch("http://localhost:8001/health");
      if (res.ok) {
        console.log("[python-ocr] Sidecar is healthy ✓");
      }
    } catch {
      console.warn("[python-ocr] Sidecar health check failed — will retry on first request.");
    }
  }, 5000);
}

if (process.env.ENABLE_PYTHON_OCR !== "false") {
  startPythonOcrSidecar();
}

// ── Express server ────────────────────────────────────────────────────────────
const server = createServer().listen(port, "0.0.0.0", () => {
  console.log(`Instawork W-2 simulation API listening on ${port}`);
});

server.setTimeout(0);
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
