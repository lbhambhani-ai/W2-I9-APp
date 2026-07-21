import { createServer } from "./app";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.PORT || 3001);

// ── Express server ────────────────────────────────────────────────────────────
// Bind the port FIRST. Deployment healthchecks hit "/", so the server must accept
// connections immediately — before any slow/optional startup work (e.g. the Python
// OCR sidecar, which scans the Nix store and can take ~30s on Replit). Doing that
// work before listen() is what made healthchecks fail with 500 during startup.
const server = createServer().listen(port, "0.0.0.0", () => {
  console.log(`Instawork W-2 simulation API listening on ${port}`);
  if (process.env.ENABLE_PYTHON_OCR !== "false") {
    // Defer so the listen callback returns and the event loop stays responsive.
    setImmediate(startPythonOcrSidecar);
  }
});

server.setTimeout(0);
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

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

  const localVenvPython = join(process.cwd(), ".venv", "bin", "python");
  const replitVenvPython = "/home/runner/.venv/bin/python";
  const pythonBin = existsSync(localVenvPython) ? localVenvPython
    : existsSync(replitVenvPython) ? replitVenvPython
    : "python3";

  const ocrPort = process.env.PYTHON_OCR_PORT || "8001";

  // Resolve libstdc++ asynchronously — scanning /nix/store can take many seconds
  // and must never block the event loop or delay request handling.
  const finder = spawn("sh", [
    "-lc",
    "dirname \"$(find /nix/store -name libstdc++.so.6 2>/dev/null | head -n 1)\""
  ]);
  let libDirOut = "";
  finder.stdout?.on("data", (data: Buffer) => { libDirOut += data.toString(); });

  // A failed spawn emits BOTH 'error' and (afterwards) 'close', so guard against
  // launching the sidecar twice on the same port. Launch exactly once, on whichever
  // fires first: 'error' → fall back to no libstdc++ dir, 'close' → use what we found.
  let launched = false;
  const startOnce = (libstdcxxDir: string) => {
    if (launched) return;
    launched = true;
    launchUvicorn(pythonBin, ocrPort, libstdcxxDir);
  };
  finder.on("error", () => startOnce(""));
  finder.on("close", () => startOnce(libDirOut.trim()));
}

function launchUvicorn(pythonBin: string, ocrPort: string, libstdcxxDir: string) {
  const sidecarEnv = {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    ...(libstdcxxDir && libstdcxxDir !== "."
      ? { LD_LIBRARY_PATH: `${libstdcxxDir}:${process.env.LD_LIBRARY_PATH || ""}` }
      : {})
  };

  console.log(`[python-ocr] Starting sidecar on port ${ocrPort} using ${pythonBin}...`);
  if (libstdcxxDir && libstdcxxDir !== ".") {
    console.log(`[python-ocr] Using libstdc++ from ${libstdcxxDir}`);
  }

  const proc = spawn(
    pythonBin,
    ["-m", "uvicorn", "identity_service.app:app", "--host", "0.0.0.0", "--port", ocrPort, "--workers", "1"],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: sidecarEnv
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
    console.warn("[python-ocr] Document validation will use n8n only.");
  });

  proc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.warn(`[python-ocr] Sidecar exited with code ${code} — n8n remains the primary path.`);
    }
  });

  // Give uvicorn a moment to boot, then confirm it's reachable
  setTimeout(async () => {
    try {
      const res = await fetch(`http://localhost:${ocrPort}/health`);
      if (res.ok) {
        console.log("[python-ocr] Sidecar is healthy ✓");
      }
    } catch {
      console.warn("[python-ocr] Sidecar health check failed — will retry on first request.");
    }
  }, 5000);
}
