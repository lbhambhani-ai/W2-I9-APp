import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateWorkBrightSubmission } from "../shared/validation";
import type {
  AuditAppRedirectEvent,
  AuditFlowCompleteEvent,
  AuditLogEvent,
  AuditSessionStartEvent,
  ConfirmedW2Profile,
  GovernmentIdType,
  IdentityFieldComparison,
  IdentityVerificationAnalyzeRequest,
  IdentityVerificationAnalyzeResponse,
  IdentityVerificationAnalysis,
  WorkBrightSubmissionInput
} from "../shared/types";
import { s3FileUrlFromKey } from "../shared/audit";

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

  const rawCompliance = typeof raw.complianceEligibility === "boolean"
    ? raw.complianceEligibility
    : typeof raw.complianceEligibility === "object" && raw.complianceEligibility !== null
      ? Boolean((raw.complianceEligibility as Record<string, unknown>).canContinue)
      : Boolean(bc.canContinue);

  // Any CRITICAL flag must block continuation regardless of what the model returned for complianceEligibility
  const hasCriticalFlag = Array.isArray(raw.flags) && raw.flags.some(
    (f: unknown) => typeof f === "object" && f !== null && (f as Record<string, unknown>).severity === "CRITICAL"
  );
  const complianceEligibility = rawCompliance && !hasCriticalFlag;

  const docTypeLabels: Record<string, string> = {
    "drivers-license": "US Driver's License",
    "state-id": "US State ID Card",
    passport: "US Passport",
    "passport-card": "US Passport Card",
    "permanent-resident-card": "US Permanent Resident Card",
    "employment-authorization-card": "US Employment Authorization Card",
    "military-id": "US Military ID",
    "school-id": "School ID with Photograph",
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
        Array.isArray(record.identity.fileLinks) &&
        record.i9 &&
        validStatuses.includes(record.i9.finalStatus) &&
        typeof record.i9.attemptCount === "number" &&
        Array.isArray(record.i9.fileLinks) &&
        Array.isArray(record.i9.selectedDocuments) &&
        record.feedback &&
        typeof record.feedback.rating === "number" &&
        record.feedback.rating >= 1 &&
        record.feedback.rating <= 5 &&
        typeof record.feedback.comments === "string"
    );
  }

  if (record.recordKind === "app_redirect_click") {
    const r = record as Partial<AuditAppRedirectEvent>;
    return Boolean(
      r.sessionId &&
        r.timestamp &&
        !Number.isNaN(Date.parse(r.timestamp)) &&
        (r.context === "pre_submit" || r.context === "post_submit") &&
        typeof r.deepLink === "string"
    );
  }

  if (record.recordKind === "session_start") {
    const r = record as Partial<AuditSessionStartEvent>;
    return Boolean(r.sessionId && r.timestamp && !Number.isNaN(Date.parse(r.timestamp)) && typeof r.landingUrl === "string");
  }

  if (record.recordKind === "flow_complete") {
    const r = record as Partial<AuditFlowCompleteEvent>;
    return Boolean(
      r.sessionId &&
        r.timestamp &&
        !Number.isNaN(Date.parse(r.timestamp)) &&
        typeof r.feedbackRating === "number" &&
        r.feedbackRating >= 1 &&
        r.feedbackRating <= 5 &&
        typeof r.feedbackComments === "string"
    );
  }

  return false;
}

// Keep only the name + email fields the audit sheet needs. Drops DOB, phone, SSN, address, etc.
function sanitizeProfile(profile: unknown): Record<string, unknown> | undefined {
  if (!profile || typeof profile !== "object") return undefined;
  const source = profile as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const key of ["legalFirstName", "legalLastName", "firstName", "lastName", "email"]) {
    if (typeof source[key] === "string" && source[key]) clean[key] = source[key];
  }
  return Object.keys(clean).length ? clean : undefined;
}

function sanitizeFlags(flags: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(flags)) return undefined;
  return flags
    .filter((flag) => flag && typeof flag === "object")
    .map((flag) => {
      const f = flag as Record<string, unknown>;
      return { code: f.code, severity: f.severity, message: f.message };
    });
}

// Whitelist exactly the fields the audit log uses so no extra PII is ever forwarded to n8n.
function sanitizeAuditEvent(event: AuditLogEvent): Record<string, unknown> {
  const e = event as Record<string, unknown>;
  const base: Record<string, unknown> = {
    recordKind: e.recordKind,
    sessionId: e.sessionId,
    timestamp: e.timestamp
  };
  if (e.intercomUserId) base.intercomUserId = e.intercomUserId;
  if (e.intercomEmail) base.intercomEmail = e.intercomEmail;
  if (e.intercomConversationId) base.intercomConversationId = e.intercomConversationId;

  switch (event.recordKind) {
    case "attempt":
      return {
        ...base,
        flow: e.flow,
        attemptNumber: e.attemptNumber,
        side: e.side,
        resultStatus: e.resultStatus,
        selectedDocumentType: e.selectedDocumentType,
        selectedDocumentLabel: e.selectedDocumentLabel,
        selectedDocumentId: e.selectedDocumentId,
        selectedList: e.selectedList,
        immigrationStatus: e.immigrationStatus,
        documentPath: e.documentPath,
        fileName: e.fileName,
        s3FileKey: e.s3FileKey,
        s3FileUrl: e.s3FileUrl,
        userMessage: e.userMessage,
        flags: sanitizeFlags(e.flags),
        profile: sanitizeProfile(e.profile)
      };
    case "summary": {
      const identity = (e.identity as Record<string, unknown>) || {};
      const i9 = (e.i9 as Record<string, unknown>) || {};
      const feedback = (e.feedback as Record<string, unknown>) || {};
      return {
        ...base,
        profile: sanitizeProfile(e.profile),
        identity: {
          finalStatus: identity.finalStatus,
          attemptCount: identity.attemptCount,
          fileLinks: identity.fileLinks
        },
        i9: {
          finalStatus: i9.finalStatus,
          attemptCount: i9.attemptCount,
          fileLinks: i9.fileLinks,
          citizenshipStatus: i9.citizenshipStatus,
          documentPath: i9.documentPath,
          selectedDocuments: i9.selectedDocuments
        },
        feedback: { rating: feedback.rating, comments: feedback.comments }
      };
    }
    case "session_start":
      return { ...base, landingUrl: e.landingUrl };
    case "flow_complete":
      return { ...base, feedbackRating: e.feedbackRating, feedbackComments: e.feedbackComments };
    case "app_redirect_click":
      return { ...base, context: e.context, deepLink: e.deepLink };
    default:
      return base;
  }
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

    const n8nUrl =
      process.env.DOCUMENT_VALIDATION_SERVICE_URL ||
      process.env.IDENTITY_VERIFICATION_SERVICE_URL ||
      "https://instawork.app.n8n.cloud/webhook/identity/verify-document";
    const identityVerificationSecret =
      process.env.DOCUMENT_VALIDATION_SERVICE_SECRET ||
      process.env.IDENTITY_VERIFICATION_SERVICE_SECRET;
    const MAX_RETRIES = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[n8n] Attempt ${attempt}/${MAX_RETRIES} for ${input.requestId}`);
        const verifierResponse = await fetch(n8nUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(identityVerificationSecret
              ? { "x-instawork-identity-secret": identityVerificationSecret }
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
        const verifierBody = body as Record<string, unknown>;
        const s3FileKey = verifierBody.s3FileKey as string | undefined;
        response.json({
          requestId: input.requestId,
          source: "n8n-gemini-vision" as const,
          s3FileKey,
          s3FileUrl: (verifierBody.s3FileUrl as string | undefined) ?? s3FileUrlFromKey(s3FileKey),
          userMessage: (verifierBody.userMessage as string) || normalizedAnalysis.reviewReason || "Document analysis completed.",
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
      response.json({
        requestId: input.requestId,
        source: "python-ocr-fallback" as const,
        userMessage: pythonResult.userMessage as string || normalizedAnalysis.reviewReason || "Document analysis completed.",
        analysis: normalizedAnalysis
      } satisfies IdentityVerificationAnalyzeResponse);
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
    const i9VerificationSecret =
      process.env.I9_VERIFICATION_SECRET ||
      process.env.DOCUMENT_VALIDATION_SERVICE_SECRET ||
      process.env.IDENTITY_VERIFICATION_SERVICE_SECRET;
    const MAX_RETRIES = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[i9-n8n] Attempt ${attempt}/${MAX_RETRIES} for ${body.requestId}`);
        console.log(`[i9-n8n] expectedList=${(i9Context as Record<string, unknown>)?.expectedList} expectedDoc=${(i9Context as Record<string, unknown>)?.expectedDocLabel} status=${(i9Context as Record<string, unknown>)?.citizenshipStatus}`);
        const n8nResponse = await fetch(n8nUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(i9VerificationSecret
              ? { "x-instawork-identity-secret": i9VerificationSecret }
              : {})
          },
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
        const i9S3FileKey = result.s3FileKey as string | undefined;
        response.json({
          requestId: body.requestId,
          source: "n8n-i9-gemini",
          s3FileKey: i9S3FileKey,
          s3FileUrl: (result.s3FileUrl as string | undefined) ?? s3FileUrlFromKey(i9S3FileKey),
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

  // Look up the Intercom contact's name + email only (no phone / location / custom attributes).
  async function lookupIntercomIdentity(event: AuditLogEvent): Promise<{ intercomName?: string; intercomEmail?: string }> {
    const enrichableKinds: AuditLogEvent["recordKind"][] = ["app_redirect_click", "session_start", "flow_complete"];
    if (!enrichableKinds.includes(event.recordKind)) return {};

    const intercomApiKey = process.env.INTERCOM_API_KEY;
    if (!intercomApiKey) return {};

    const enrichable = event as AuditAppRedirectEvent | AuditSessionStartEvent | AuditFlowCompleteEvent;
    const userId = enrichable.intercomUserId;
    const email = enrichable.intercomEmail;
    if (!userId && !email) return {};

    try {
      // Search Intercom contacts by external user_id first, then fall back to email
      const searchUrl = userId
        ? `https://api.intercom.io/contacts/search`
        : `https://api.intercom.io/contacts/search`;

      const searchBody = userId
        ? { query: { operator: "AND", value: [{ field: "external_id", operator: "=", value: userId }] } }
        : { query: { operator: "AND", value: [{ field: "email", operator: "=", value: email }] } };

      const intercomResponse = await fetch(searchUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "authorization": `Bearer ${intercomApiKey}`,
          "Intercom-Version": "2.11"
        },
        body: JSON.stringify(searchBody),
        signal: AbortSignal.timeout(8000)
      });

      if (!intercomResponse.ok) {
        console.log(`[intercom] Lookup failed: ${intercomResponse.status}`);
        return {};
      }

      const intercomData = await intercomResponse.json() as Record<string, unknown>;
      const contacts = (intercomData.data as unknown[]) ?? [];
      const contact = contacts[0] as Record<string, unknown> | undefined;

      if (!contact) {
        console.log(`[intercom] No contact found for userId=${userId} email=${email}`);
        return {};
      }

      console.log(`[intercom] Resolved contact id=${contact.id} for ${event.recordKind}`);

      return {
        intercomName: typeof contact.name === "string" ? contact.name : undefined,
        intercomEmail: (typeof contact.email === "string" ? contact.email : undefined) || email || undefined
      };
    } catch (err) {
      console.log(`[intercom] Enrichment error: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

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

    // Strip everything except the whitelisted audit fields, then attach Intercom name/email.
    const cleanEvent = sanitizeAuditEvent(event);
    const intercomIdentity = await lookupIntercomIdentity(event);
    const payload = { ...cleanEvent, ...intercomIdentity };

    try {
      const auditResponse = await fetch(auditWebhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.AUDIT_LOG_WEBHOOK_SECRET
            ? { "x-instawork-audit-secret": process.env.AUDIT_LOG_WEBHOOK_SECRET }
            : {})
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000)
      });

      if (!auditResponse.ok) {
        throw new Error(`Audit webhook returned ${auditResponse.status}`);
      }

      response.json({ logged: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Audit log forwarding failed.";
      console.error(`[audit] Failed to forward ${event.recordKind} for session ${event.sessionId}: ${message}`);
      response.status(502).json({ logged: false, error: message });
    }
  });

  app.post("/api/workbright/submit", (request, response) => {
    response.json(validateWorkBrightSubmission(request.body as WorkBrightSubmissionInput));
  });

  // Serve the built Vite frontend in production
  const clientDistPath = join(dirname(fileURLToPath(import.meta.url)), "../dist/client");
  if (existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
    // SPA fallback — serve index.html for any non-API route
    app.get(/\/.*/, (_request, response) => {
      response.sendFile(join(clientDistPath, "index.html"));
    });
  }

  return app;
}
