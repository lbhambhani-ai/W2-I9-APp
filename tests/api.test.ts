import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server/app";

describe("API", () => {
  const app = createServer();

  afterEach(() => {
    delete process.env.IDENTITY_VERIFICATION_SERVICE_URL;
    delete process.env.IDENTITY_VERIFICATION_SERVICE_SECRET;
    delete process.env.SIMULATION_GOOGLE_SHEETS_ACCESS_TOKEN;
    vi.unstubAllGlobals();
  });

  it("returns the initial app identity", async () => {
    const response = await request(app).get("/api/initial-identity").expect(200);

    expect(response.body.firstName).toBe("Lakshya");
    expect(response.body.lastName).toBe("Bhambhani");
  });

  it("validates a fixture document through the deterministic mock path", async () => {
    const response = await request(app)
      .post("/api/validate-document")
      .send({ fixtureId: "verticalDriversLicense" })
      .expect(200);

    expect(response.body.status).toBe("pass");
    expect(response.body.extractedDocument.orientation).toBe("vertical");
  });

  it("blocks profile confirmation with a duplicate SSN", async () => {
    const response = await request(app)
      .post("/api/validate-profile")
      .send({
        fixtureId: "driversLicenseClear",
        profile: {
          legalFirstName: "Lakshya",
          legalMiddleName: "",
          legalLastName: "Bhambhani",
          suffix: "",
          dateOfBirth: "1998-04-15",
          ssn: "987-65-4321",
          addressLine1: "123 Market St",
          addressLine2: "",
          city: "San Francisco",
          state: "CA",
          zip: "94105",
          email: "lakshya@example.com",
          phone: "+1 555 010 9999"
        }
      })
      .expect(200);

    expect(response.body.status).toBe("blocked");
    expect(response.body.nextAction).toBe("contact_support");
  });

  it("requires the real Python OCR service instead of falling back to mock identity success", async () => {
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
      .expect(503);

    expect(response.body.error).toContain("Real-time identity OCR is unavailable");
  });

  it("forwards captured identity images to the Python verifier when configured", async () => {
    process.env.IDENTITY_VERIFICATION_SERVICE_URL = "http://127.0.0.1:8001/verify";
    process.env.IDENTITY_VERIFICATION_SERVICE_SECRET = "secret-for-test";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        source: "python",
        userMessage: "This ID matches your profile.",
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
    expect(response.body.source).toBe("python");
    expect(response.body.analysis.complianceEligibility).toBe(true);
  });

  it("logs completed simulation data to the configured Google Sheet", async () => {
    process.env.SIMULATION_GOOGLE_SHEETS_ACCESS_TOKEN = "test-access-token";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ values: [] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ updatedCells: 28 })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ updates: { updatedRows: 1 } })
      });
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(app)
      .post("/api/simulation/log")
      .send({
        identity: {
          accountId: "acct_123",
          firstName: "Lakshya",
          lastName: "Bhambhani",
          dateOfBirth: "2003-09-17",
          email: "lakshya@example.com",
          phone: "+1 555 010 9999"
        },
        profile: {
          legalFirstName: "Lakshya",
          legalMiddleName: "",
          legalLastName: "Bhambhani",
          suffix: "",
          dateOfBirth: "2003-09-17",
          ssn: "123-45-6789",
          addressLine1: "895 Main St",
          addressLine2: "",
          city: "San Francisco",
          state: "CA",
          zip: "94105",
          email: "lakshya@example.com",
          phone: "+1 555 010 9999"
        },
        i9: {
          citizenshipStatus: "citizen",
          documentPath: "list_bc",
          selectedListB: "drivers_license",
          selectedListC: "ssn_card",
          documentData: {
            drivers_license: { documentNumber: "D1234567", expirationDate: "2028-01-01" }
          },
          docImages: {
            drivers_license: { fileName: "front.png", status: "success" },
            drivers_license_back: { fileName: "back.png", status: "success" }
          }
        },
        finalStatus: "Pending admin review",
        feedback: { rating: 5, comments: "Clear flow" }
      })
      .expect(200);

    expect(response.body.logged).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/v4/spreadsheets/13ykmz2E-3fYnZOmMEDZAbFwuVSrOGSuKZmu1F8M13XQ/values/simulation%21A1%3AZZ1"),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer test-access-token" })
      })
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining(":append"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("Lakshya")
      })
    );
  });
});
