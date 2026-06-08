import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server/app";

describe("API", () => {
  const app = createServer();

  afterEach(() => {
    delete process.env.IDENTITY_VERIFICATION_SERVICE_URL;
    delete process.env.IDENTITY_VERIFICATION_SERVICE_SECRET;
    delete process.env.AUDIT_LOG_WEBHOOK_URL;
    delete process.env.AUDIT_LOG_WEBHOOK_SECRET;
    delete process.env.SIMULATION_GOOGLE_SHEETS_ACCESS_TOKEN;
    vi.unstubAllGlobals();
  });

  it("returns 503 when n8n is unavailable for identity verification", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("service down")));
    const response = await request(app)
      .post("/api/identity-verification/analyze")
      .send({
        requestId: "req_local_1",
        imageBase64: "data:image/png;base64,abc123",
        selectedDocumentType: "permanent-resident-card",
        documentSide: "front",
        documentDetectedInFrame: true,
        profile: {
          legalFirstName: "Jane",
          legalMiddleName: "",
          legalLastName: "Smith",
          suffix: "",
          dateOfBirth: "1990-03-22",
          ssn: "123-45-6789",
          addressLine1: "100 Main St",
          addressLine2: "",
          city: "New York",
          state: "NY",
          zip: "10001",
          email: "jane@example.com",
          phone: "+1 555 100 2000"
        }
      })
      .expect(503);

    expect(response.body.error).toContain("unavailable");
  }, 15000);

  it("forwards captured identity images to the Python verifier when configured", async () => {
    process.env.IDENTITY_VERIFICATION_SERVICE_URL = "http://127.0.0.1:8001/verify";
    process.env.IDENTITY_VERIFICATION_SERVICE_SECRET = "secret-for-test";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        source: "python",
        userMessage: "This ID matches your profile.",
        s3FileKey: "identity/req_python_1/license_front.jpg",
        s3FileUrl: "https://bucket.s3.us-west-2.amazonaws.com/identity/req_python_1/license_front.jpg",
        analysis: {
          documentDetected: true,
          userSelectedType: "drivers-license",
          userSelectedTypeLabel: "US Driver’s License",
          detectedDocumentType: "drivers-license",
          detectedDocumentTypeLabel: "US Driver’s License",
          documentTypeMatch: true,
          detectedSide: "front",
          extractedFields: { first_name: "Lakshya", last_name: "Bhambhani" },
          validationResults: {
            nameMatch: { status: "MATCH" },
            dobMatch: { status: "MATCH" },
            addressMatch: { status: "MATCH" },
            expirationStatus: "VALID",
            photoIntegrity: "CLEAR"
          },
          flags: [],
          complianceEligibility: true,
          nextAction: "CONTINUE",
          humanReviewRequired: false
        }
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(app)
      .post("/api/identity-verification/analyze")
      .send({
        requestId: "req_python_1",
        imageBase64: "data:image/png;base64,abc123",
        selectedDocumentType: "drivers-license",
        documentSide: "front",
        documentDetectedInFrame: true,
        profile: {
          legalFirstName: "Lakshya",
          legalMiddleName: "",
          legalLastName: "Bhambhani",
          suffix: "",
          dateOfBirth: "2003-09-15",
          ssn: "123-45-6789",
          addressLine1: "895 Main St",
          addressLine2: "",
          city: "San Francisco",
          state: "CA",
          zip: "94105",
          email: "lakshya@example.com",
          phone: "+1 555 010 9999"
        }
      })
      .expect(200);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8001/verify",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-instawork-identity-secret": "secret-for-test"
        })
      })
    );
    expect(response.body.source).toBe("n8n-gemini-vision");
    expect(response.body.analysis.complianceEligibility).toBe(true);
    // S3 file location must be passed through to the client (no invalid Google Drive links).
    expect(response.body.s3FileKey).toBe("identity/req_python_1/license_front.jpg");
    expect(response.body.s3FileUrl).toBe(
      "https://bucket.s3.us-west-2.amazonaws.com/identity/req_python_1/license_front.jpg"
    );
    expect(response.body.googleDriveFileUrl).toBeUndefined();
  });

  it("forwards completed simulation summaries to the audit webhook", async () => {
    process.env.AUDIT_LOG_WEBHOOK_URL = "https://example.test/webhook/audit-log";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ logged: true })
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(app)
      .post("/api/audit-log")
      .send({
        recordKind: "summary",
        sessionId: "session-1",
        timestamp: "2026-05-07T00:00:00.000Z",
        profile: {
          legalFirstName: "Lakshya",
          legalLastName: "Bhambhani",
          dateOfBirth: "2003-09-17",
          email: "lakshya@example.com",
          phone: "+1 555 010 9999"
        },
        identity: {
          finalStatus: "pass",
          attemptCount: 2,
          fileLinks: ["license_front.jpg — https://bucket.s3.amazonaws.com/docs/session-1/license_front.jpg"]
        },
        i9: {
          finalStatus: "pass",
          attemptCount: 4,
          fileLinks: ["ssn_card.jpg — https://bucket.s3.amazonaws.com/docs/session-1/ssn_card.jpg"],
          citizenshipStatus: "us_citizen",
          documentPath: "list_bc",
          selectedDocuments: ["List B: Driver's License", "List C: Social Security Card"]
        },
        feedback: { rating: 5, comments: "Clear flow" }
      })
      .expect(200);

    expect(response.body.logged).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/webhook/audit-log",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("Lakshya")
      })
    );
    // PII minimization: only name + email survive; DOB and phone are stripped before forwarding.
    const forwardedSummary = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(forwardedSummary.profile).toEqual({
      legalFirstName: "Lakshya",
      legalLastName: "Bhambhani",
      email: "lakshya@example.com"
    });
    expect(JSON.stringify(forwardedSummary)).not.toContain("2003-09-17");
    expect(JSON.stringify(forwardedSummary)).not.toContain("555");
  });

  it("forwards audit events to the configured n8n webhook", async () => {
    process.env.AUDIT_LOG_WEBHOOK_URL = "https://example.test/webhook/audit-log";
    process.env.AUDIT_LOG_WEBHOOK_SECRET = "audit-secret";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ logged: true })
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(app)
      .post("/api/audit-log")
      .send({
        recordKind: "attempt",
        sessionId: "session-1",
        timestamp: "2026-05-07T00:00:00.000Z",
        flow: "identity",
        attemptNumber: 1,
        side: "front",
        selectedDocumentType: "drivers-license",
        resultStatus: "pass",
        userMessage: "Verified",
        fileName: "license_front.jpg",
        s3FileKey: "identity/session-1/license_front.jpg",
        s3FileUrl: "https://bucket.s3.us-west-2.amazonaws.com/identity/session-1/license_front.jpg"
      })
      .expect(200);

    expect(response.body.logged).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/webhook/audit-log",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-instawork-audit-secret": "audit-secret"
        }),
        body: expect.stringContaining("identity/session-1/license_front.jpg")
      })
    );
    const forwardedBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(forwardedBody.s3FileKey).toBe("identity/session-1/license_front.jpg");
    expect(JSON.stringify(forwardedBody)).not.toContain("drive.google.com");
  });

  it("accepts audit events locally when no audit webhook is configured", async () => {
    const response = await request(app)
      .post("/api/audit-log")
      .send({
        recordKind: "summary",
        sessionId: "session-1",
        timestamp: "2026-05-07T00:00:00.000Z",
        profile: {
          legalFirstName: "Lakshya",
          legalLastName: "Bhambhani",
          dateOfBirth: "1998-04-15",
          email: "lakshya@example.com",
          phone: "+1 555 010 9999"
        },
        identity: {
          finalStatus: "pass",
          attemptCount: 1,
          fileLinks: ["license_front.jpg — https://bucket.s3.amazonaws.com/docs/session-1/license_front.jpg"]
        },
        i9: {
          finalStatus: "pass",
          attemptCount: 2,
          fileLinks: [],
          citizenshipStatus: "us_citizen",
          documentPath: "list_bc",
          selectedDocuments: ["Driver's License", "Social Security Card"]
        },
        feedback: { rating: 5, comments: "Clear flow" }
      })
      .expect(200);

    expect(response.body).toMatchObject({ logged: false, skipped: true });
  });
});
