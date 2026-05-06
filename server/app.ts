import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  documentAddressFixture,
  documentExpirationFixture,
  documentIssueDateFixture,
  duplicateSsns,
  identityFixtures,
  initialIdentity,
  ocrFixtures,
  type OcrFixtureId
} from "../shared/fixtures";
import {
  analyzeIdentityDocument,
  validateDocumentUpload,
  validateW2Profile,
  validateWorkBrightSubmission
} from "../shared/validation";
import type {
  ConfirmedW2Profile,
  DocumentType,
  GovernmentIdType,
  IdentityFieldComparison,
  IdentityOcrResult,
  IdentityVerificationAnalyzeRequest,
  IdentityVerificationAnalyzeResponse,
  IdentityVerificationAnalysis,
  WorkBrightSubmissionInput
} from "../shared/types";

const GOOGLE_DRIVE_IDENTITY_FOLDER_ID = "1vn1OXPH2al136Us9th9LHR96nwIqHLQd";

function getOcrFixture(fixtureId: string | undefined) {
  const key = (fixtureId || "driversLicenseClear") as OcrFixtureId;
  return ocrFixtures[key] ?? ocrFixtures.driversLicenseClear;
}

function selectedTypeToDocumentType(selectedType: GovernmentIdType): DocumentType {
  switch (selectedType) {
    case "drivers-license":
      return "drivers_license";
    case "state-id":
      return "state_id";
    case "passport":
      return "passport";
    case "passport-card":
      return "passport_card";
    case "permanent-resident-card":
      return "permanent_resident_card";
    case "employment-authorization-card":
      return "work_authorization";
    case "military-id":
      return "military_id";
    default:
      return "unknown";
  }
}

function mockOcrForRequest(input: IdentityVerificationAnalyzeRequest): IdentityOcrResult {
  const selectedDocumentType = selectedTypeToDocumentType(input.selectedDocumentType);
  const base = {
    ...ocrFixtures.driversLicenseClear,
    documentDetected: input.documentDetectedInFrame !== false,
    documentType: selectedDocumentType,
    selectedDocumentType,
    isSelectedDocumentType: selectedDocumentType !== "unknown",
    firstName: input.profile.legalFirstName,
    middleName: input.profile.legalMiddleName ?? "",
    lastName: input.profile.legalLastName,
    suffix: input.profile.suffix ?? "",
    dateOfBirth: input.profile.dateOfBirth,
    confidence: 0.86
  } satisfies IdentityOcrResult;

  if (input.selectedDocumentType === "permanent-resident-card") {
    return {
      ...base,
      firstName: "TEST",
      middleName: "V",
      lastName: "SPECIMEN",
      dateOfBirth: "2002-10-20"
    };
  }

  return base;
}

function friendlyMessage(analysis: IdentityVerificationAnalysis): string {
  if (!analysis.documentDetected) {
    return "We could not detect a supported US government ID. Put the document inside the frame and try again.";
  }

  const firstCritical = analysis.flags.find((flag) => flag.severity === "CRITICAL");
  if (!firstCritical) {
    if (analysis.nextAction === "REQUEST_BACK_IMAGE") {
      return `The front of your ${analysis.detectedDocumentTypeLabel} was read. Please capture the back side next.`;
    }
    return "This ID looks good and matches your profile.";
  }

  if (firstCritical.code === "DOCUMENT_TYPE_MISMATCH") {
    return `This looks like ${analysis.detectedDocumentTypeLabel}, but you selected ${analysis.userSelectedTypeLabel}. Choose the correct document type or retake the photo.`;
  }
  if (firstCritical.code === "NAME_MISMATCH") {
    return `This looks like ${analysis.detectedDocumentTypeLabel}, but the name does not match your profile. Go back and correct your legal name or use your own ID.`;
  }
  if (firstCritical.code === "DOB_MISMATCH") {
    return `This looks like ${analysis.detectedDocumentTypeLabel}, but the date of birth does not match your profile. Go back and correct your date of birth or use your own ID.`;
  }
  if (firstCritical.code === "PHOTO_BLURRED") {
    return "We could not read the ID clearly. Retake the photo with sharp text and no glare.";
  }

  return firstCritical.message;
}

function localIdentityAnalysis(input: IdentityVerificationAnalyzeRequest): IdentityVerificationAnalyzeResponse {
  const analysis = analyzeIdentityDocument({
    userSelectedType: input.selectedDocumentType,
    side: input.documentSide,
    profile: input.profile,
    ocr: mockOcrForRequest(input),
    documentDetectedInFrame: input.documentDetectedInFrame ?? true,
    documentAddress: documentAddressFixture,
    expirationDate: documentExpirationFixture,
    issueDate: documentIssueDateFixture
  });

  return {
    requestId: input.requestId,
    source: "mock",
    googleDriveFolderId: GOOGLE_DRIVE_IDENTITY_FOLDER_ID,
    userMessage: friendlyMessage(analysis),
    analysis
  };
}

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

export function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "20mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/initial-identity", (_request, response) => {
    response.json(initialIdentity);
  });

  app.get("/api/fixtures", (_request, response) => {
    response.json({
      initialIdentity,
      confirmedProfile: identityFixtures.confirmedProfile,
      documentFixtures: Object.keys(ocrFixtures)
    });
  });

  app.post("/api/validate-document", (request, response) => {
    const ocr = getOcrFixture(request.body.fixtureId);
    response.json(validateDocumentUpload(ocr));
  });

  app.post("/api/validate-profile", (request, response) => {
    const profile = request.body.profile as ConfirmedW2Profile;
    const ocr = getOcrFixture(request.body.fixtureId);
    response.json(validateW2Profile({ ocr, profile, duplicateSsns }));
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

    console.log(`[n8n] All ${MAX_RETRIES} attempts failed. Falling back to local OCR.`);
    try {
      const localResult = analyzeIdentityDocument({
        userSelectedType: input.selectedDocumentType as GovernmentIdType,
        side: input.documentSide as "front" | "back",
        profile: input.profile as ConfirmedW2Profile,
        ocr: (input as Record<string, unknown>).ocrText
          ? ({ rawText: (input as Record<string, unknown>).ocrText } as unknown as IdentityOcrResult)
          : ({} as IdentityOcrResult),
        documentDetectedInFrame: (input as Record<string, unknown>).documentDetectedInFrame !== false,
        documentAddress: documentAddressFixture,
        expirationDate: documentExpirationFixture,
        issueDate: documentIssueDateFixture
      });

      response.json({
        requestId: input.requestId,
        source: "local-fallback",
        userMessage: `n8n was unavailable after ${MAX_RETRIES} retries. Used local verification.`,
        analysis: localResult
      });
    } catch (fallbackError) {
      response.status(503).json({
        error: `n8n failed (${lastError?.message}), local fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : "Unknown error"}`
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

  app.post("/api/workbright/submit", (request, response) => {
    response.json(validateWorkBrightSubmission(request.body as WorkBrightSubmissionInput));
  });

  // Serve the built Vite frontend in production
  const clientDistPath = join(new URL(".", import.meta.url).pathname, "../dist/client");
  if (existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
    // SPA fallback — serve index.html for any non-API route
    app.get("*", (_request, response) => {
      response.sendFile(join(clientDistPath, "index.html"));
    });
  }

  return app;
}
