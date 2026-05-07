import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { validateWorkBrightSubmission } from "../shared/validation";
import type {
  AuditLogEvent,
  ConfirmedW2Profile,
  GovernmentIdType,
  IdentityFieldComparison,
  IdentityVerificationAnalyzeRequest,
  IdentityVerificationAnalyzeResponse,
  IdentityVerificationAnalysis,
  WorkBrightSubmissionInput
} from "../shared/types";
import { googleDriveFileUrl } from "../shared/audit";

function normalizeFieldComparison(val: unknown): IdentityFieldComparison {
  const validStatuses = ["MATCH", "MISMATCH", "PARTIAL_MATCH", "AMBIGUOUS", "NOT_CHECKED"] as const;
  type ValidStatus = (typeof validStatuses)[number];

  function toStatus(s: unknown): ValidStatus {
    const str = String(s || "NOT_CHECKED").toUpperCase().replace("NAME_", "").replace("DOB_", "");
    return validStatuses.includes(str as ValidStatus) ? (str as ValidStatus) : "NOT_CHECKED";
  }

  if (typeof val === "string") return { status: toStatus(val) };
  if (val && typeof val === "object") {
    const obj = val as Record<string, unknown>;
    return {
      status: toStatus(obj.status),
      details: obj.details ? String(obj.details) : undefined,
      userProvided: obj.userProvided ? String(obj.userProvided) : undefined,
      documentExtracted: obj.documentExtracted ? String(obj.documentExtracted) : undefined
    };
  }
  return { status: "NOT_CHECKED" };
}

function normalizeN8nAnalysis(raw: Record<string, unknown>, input: IdentityVerificationAnalyzeRequest): IdentityVerificationAnalysis {
  const vr = (raw.validationResults || {}) as Record<string, unknown>;
  const bc = (raw.booleanChecks || {}) as Record<string, unknown>;
  const ef = (raw.extractedFields || {}) as Record<string, string | null>;
  const flags = Array.isArray(raw.flags)
    ? raw.flags.map((f: unknown) => typeof f === "string" ? { severity: "CRITICAL" as const, code: f, message: f } : f as { severity: "CRITICAL" | "WARNING" | "INFO"; code: string; message: string })
    : [];

  const complianceEligibility = typeof raw.complianceEligibility === "boolean"
    ? raw.complianceEligibility
    : typeof raw.complianceEligibility === "object" && raw.complianceEligibility !== null
      ? Boolean((raw.complianceEligibility as Record<string, unknown>).canContinue)
      : Boolean(bc.canContinue);

  const docTypeLabels: Record<string, string> = {
    "drivers-license": "US Driver's License",
    "state-id": "US State ID Card",
    passport: "US Passport",
    "passport-card": "US Passport Card",
    "permanent-resident-card": "US Permanent Resident Card",
    "employment-authorization-card": "US Employment Authorization Card",
    "military-id": "US Military ID",
    unknown: "Unknown Document"
  };

  const detectedType = String(raw.detectedDocumentType || input.selectedDocumentType) as GovernmentIdType;

  return {
    userSelectedType: input.selectedDocumentType,
    userSelectedTypeLabel: docTypeLabels[input.selectedDocumentType] || input.selectedDocumentType,
    detectedDocumentType: detectedType,
    detectedDocumentTypeLabel: docTypeLabels[detectedType] || String(raw.detectedDocumentTypeLabel || detectedType),
    documentTypeMatch: raw.documentTypeMatch !== undefined ? Boolean(raw.documentTypeMatch) : Boolean(bc.documentTypeMatchesSelection),
    documentDetected: Boolean(raw.documentDetected ?? bc.documentDetected ?? true),
    detectedSide: (String(raw.detectedSide || input.documentSide) as "front" | "back"),
    extractedFields: ef,
    validationResults: {
      nameMatch: normalizeFieldComparison(vr.nameMatch),
      dobMatch: normalizeFieldComparison(vr.dobMatch),
      addressMatch: normalizeFieldComparison(vr.addressMatch || "NOT_CHECKED"),
      expirationStatus: String(vr.expirationStatus || "UNKNOWN") as IdentityVerificationAnalysis["validationResults"]["expirationStatus"],
      photoIntegrity: String(vr.photoIntegrity || "CLEAR") as IdentityVerificationAnalysis["validationResults"]["photoIntegrity"]
    },
    flags,
    complianceEligibility,
    nextAction: String(raw.nextAction || (complianceEligibility ? "CONTINUE" : "HALT_VERIFICATION")) as IdentityVerificationAnalysis["nextAction"],
    humanReviewRequired: Boolean(raw.humanReviewRequired ?? !complianceEligibility),
    reviewReason: raw.reviewReason ? String(raw.reviewReason) : undefined
  };
}

function isAnalyzeRequest(value: Partial<IdentityVerificationAnalyzeRequest>): value is IdentityVerificationAnalyzeRequest {
  return Boolean(
    value.requestId &&
      value.imageBase64 &&
      value.selectedDocumentType &&
      value.documentSide &&
      value.profile?.legalFirstName &&
      value.profile?.legalLastName &&
      value.profile?.dateOfBirth
  );
}

function isAuditLogEvent(value: unknown): value is AuditLogEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AuditLogEvent>;
  const validStatuses = ["pass", "fail", "not_started"];
  if (!record.sessionId || !record.timestamp || Number.isNaN(Date.parse(record.timestamp)) || !record.recordKind) return false;

  if (record.recordKind === "attempt") {
    return Boolean(
      (record.flow === "identity" || record.flow === "i9") &&
        typeof record.attemptNumber === "number" &&
        record.attemptNumber > 0 &&
        (record.side === "front" || record.side === "back") &&
        typeof record.selectedDocumentType === "string" &&
        (record.resultStatus === "pass" || record.resultStatus === "fail") &&
        record.userMessage !== undefined
    );
  }

  if (record.recordKind === "summary") {
    return Boolean(
      record.profile &&
        record.identity &&
        validStatuses.includes(record.identity.finalStatus) &&
        typeof record.identity.attemptCount === "number" &&
        Array.isArray(record.identity.driveLinks) &&
        record.i9 &&
        validStatuses.includes(record.i9.finalStatus) &&
        typeof record.i9.attemptCount === "number" &&
        Array.isArray(record.i9.driveLinks) &&
        Array.isArray(record.i9.selectedDocuments) &&
        record.feedback &&
        typeof record.feedback.rating === "number" &&
        record.feedback.rating >= 1 &&
        record.feedback.rating <= 5 &&
        typeof record.feedback.comments === "string"
    );
  }

  return false;
}

export function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "20mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.post("/api/identity-verification/analyze", async (request, response) => {
    const input = request.body as Partial<IdentityVerificationAnalyzeRequest>;
    if (!isAnalyzeRequest(input)) {
      response.status(400).json({
        error: "Missing required identity verification fields."
      });
      return;
    }

    const n8nUrl = process.env.IDENTITY_VERIFICATION_SERVICE_URL || "https://instawork.app.n8n.cloud/webhook/identity/verify-document";
    const MAX_RETRIES = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[n8n] Attempt ${attempt}/${MAX_RETRIES} for ${input.requestId}`);
        const verifierResponse = await fetch(n8nUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(process.env.IDENTITY_VERIFICATION_SERVICE_SECRET
              ? { "x-instawork-identity-secret": process.env.IDENTITY_VERIFICATION_SERVICE_SECRET }
              : {})
          },
          body: JSON.stringify(input)
        });

        if (!verifierResponse.ok) {
          throw new Error(`n8n returned ${verifierResponse.status}`);
        }

        const body = (await verifierResponse.json()) as IdentityVerificationAnalyzeResponse;

        if (!body || !body.analysis) {
          throw new Error("n8n returned empty or invalid response");
        }

        console.log(`[n8n] Success on attempt ${attempt} for ${input.requestId}`);
        const normalizedAnalysis = normalizeN8nAnalysis(body.analysis as unknown as Record<string, unknown>, input);
        response.json({
          requestId: input.requestId,
          source: "n8n-gemini-vision" as const,
          googleDriveFileId: (body as Record<string, unknown>).googleDriveFileId as string | undefined,
          googleDriveFileUrl: googleDriveFileUrl((body as Record<string, unknown>).googleDriveFileId as string | undefined),
          userMessage: (body as Record<string, unknown>).userMessage as string || normalizedAnalysis.reviewReason || "Document analysis completed.",
          analysis: normalizedAnalysis
        } satisfies IdentityVerificationAnalyzeResponse);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.log(`[n8n] Attempt ${attempt} failed: ${lastError.message}`);
        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }
    }

    console.log(`[n8n] All ${MAX_RETRIES} attempts failed for ${input.requestId}: ${lastError?.message}`);

    // Fallback: try local Python OCR service (runs as sidecar on port 8001)
    const pythonOcrUrl = process.env.PYTHON_OCR_URL || "http://localhost:8001/verify";
    try {
      console.log(`[python-ocr] n8n unavailable — trying local OCR fallback for ${input.requestId}`);
      const pythonResponse = await fetch(pythonOcrUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(30000)
      });
      if (!pythonResponse.ok) {
        throw new Error(`Python OCR returned ${pythonResponse.status}`);
      }
      const pythonResult = (await pythonResponse.json()) as Record<string, unknown>;
      if (!pythonResult || !pythonResult.analysis) {
        throw new Error("Python OCR returned empty response");
      }
      console.log(`[python-ocr] Fallback succeeded for ${input.requestId}`);
      const normalizedAnalysis = normalizeN8nAnalysis(pythonResult.analysis as Record<string, unknown>, input);
      const pythonOcrResponse: IdentityVerificationAnalyzeResponse = {
        requestId: input.requestId,
        source: "python-ocr-fallback",
        googleDriveFileId: undefined,
        googleDriveFileUrl: undefined,
        userMessage: pythonResult.userMessage as string || normalizedAnalysis.reviewReason || "Document analysis completed.",
        analysis: normalizedAnalysis
      };
      response.json(pythonOcrResponse);
    } catch (pythonError) {
      const msg = pythonError instanceof Error ? pythonError.message : String(pythonError);
      console.log(`[python-ocr] Fallback also failed for ${input.requestId}: ${msg}`);
      response.status(503).json({
        error: "Identity verification is temporarily unavailable. Please try again in a moment."
      });
    }
  });

  app.post("/api/i9/verify-document", async (request, response) => {
    const body = request.body as Record<string, unknown>;
    const profile = body.profile as ConfirmedW2Profile | undefined;
    const i9Context = body.i9Context as Record<string, unknown> | undefined;

    if (!body.requestId || !body.imageBase64 || !body.selectedDocumentType || !body.documentSide || !profile?.legalFirstName || !profile?.legalLastName || !profile?.dateOfBirth) {
      response.status(400).json({ error: "Missing required I-9 verification fields." });
      return;
    }

    const n8nUrl = process.env.I9_VERIFICATION_URL || "https://instawork.app.n8n.cloud/webhook/i9/verify-document";
    const MAX_RETRIES = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[i9-n8n] Attempt ${attempt}/${MAX_RETRIES} for ${body.requestId}`);
        console.log(`[i9-n8n] expectedList=${(i9Context as Record<string, unknown>)?.expectedList} expectedDoc=${(i9Context as Record<string, unknown>)?.expectedDocLabel} status=${(i9Context as Record<string, unknown>)?.citizenshipStatus}`);
        const n8nResponse = await fetch(n8nUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: body.requestId,
            imageBase64: body.imageBase64,
            selectedDocumentType: body.selectedDocumentType,
            documentSide: body.documentSide,
            documentDetectedInFrame: body.documentDetectedInFrame ?? true,
            profile,
            i9Context: i9Context || {}
          })
        });

        if (!n8nResponse.ok) {
          throw new Error(`n8n returned ${n8nResponse.status}`);
        }

        const result = (await n8nResponse.json()) as Record<string, unknown>;
        if (!result || !result.analysis) {
          throw new Error("n8n returned empty or invalid response");
        }

        console.log(`[i9-n8n] Success on attempt ${attempt} for ${body.requestId}`);
        const input = { requestId: String(body.requestId), imageBase64: "", selectedDocumentType: String(body.selectedDocumentType) as GovernmentIdType, documentSide: String(body.documentSide) as "front" | "back", profile } as IdentityVerificationAnalyzeRequest;
        const normalizedAnalysis = normalizeN8nAnalysis(result.analysis as Record<string, unknown>, input);

        response.json({
          requestId: body.requestId,
          source: "n8n-i9-gemini",
          googleDriveFileId: result.googleDriveFileId,
          googleDriveFileUrl: googleDriveFileUrl(String(result.googleDriveFileId || "")),
          userMessage: result.userMessage || normalizedAnalysis.reviewReason || "Document analysis completed.",
          analysis: normalizedAnalysis
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.log(`[i9-n8n] Attempt ${attempt} failed: ${lastError.message}`);
        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }
    }

    console.log(`[i9-n8n] All ${MAX_RETRIES} attempts failed for ${body.requestId}`);
    response.status(503).json({
      error: `I-9 document verification unavailable after ${MAX_RETRIES} retries: ${lastError?.message}`
    });
  });

  app.post("/api/audit-log", async (request, response) => {
    const event = request.body as unknown;
    if (!isAuditLogEvent(event)) {
      response.status(400).json({ error: "Missing or invalid audit log event fields." });
      return;
    }

    const auditWebhookUrl = process.env.AUDIT_LOG_WEBHOOK_URL;
    if (!auditWebhookUrl) {
      response.json({ logged: false, skipped: true, reason: "AUDIT_LOG_WEBHOOK_URL is not configured." });
      return;
    }

    try {
      const auditResponse = await fetch(auditWebhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.AUDIT_LOG_WEBHOOK_SECRET
            ? { "x-instawork-audit-secret": process.env.AUDIT_LOG_WEBHOOK_SECRET }
            : {})
        },
        body: JSON.stringify(event)
      });

      if (!auditResponse.ok) {
        throw new Error(`Audit webhook returned ${auditResponse.status}`);
      }

      response.json({ logged: true });
    } catch (error) {
      response.status(502).json({
        logged: false,
        error: error instanceof Error ? error.message : "Audit log forwarding failed."
      });
    }
  });

  app.post("/api/workbright/submit", (request, response) => {
    response.json(validateWorkBrightSubmission(request.body as WorkBrightSubmissionInput));
  });

  // Serve the built Vite frontend in production
  const clientDistPath = join(new URL(".", import.meta.url).pathname, "../dist/client");
  if (existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
    // SPA fallback — serve index.html for any non-API route
    app.get(/\/.*/, (_request, response) => {
      response.sendFile(join(clientDistPath, "index.html"));
    });
  }

  return app;
}
