import { describe, expect, it } from "vitest";
import {
  documentAddressFixture,
  documentExpirationFixture,
  documentIssueDateFixture,
  identityFixtures,
  ocrFixtures
} from "../shared/fixtures";
import {
  analyzeIdentityDocument,
  documentTypeMismatchMessage,
  governmentIdTypeLabel,
  VENEZUELAN_PASSPORT_EXPIRY_BYPASS_MESSAGE
} from "../shared/validation";
import type {
  ConfirmedW2Profile,
  GovernmentIdType,
  IdentityOcrResult
} from "../shared/types";

const today = new Date("2026-04-26T00:00:00Z");

describe("governmentIdTypeLabel", () => {
  it("labels School ID as an accepted I-9 identity document type", () => {
    expect(governmentIdTypeLabel("school-id")).toBe("School ID with Photograph");
  });

  it.each([
    [
      "US Driver’s License",
      "The uploaded document does not match the selected document type. Please upload a valid U.S. Driver’s License or choose a different document type."
    ],
    [
      "US State ID Card",
      "The uploaded document does not match the selected document type. Please upload a valid U.S. State ID Card or choose a different document type."
    ],
    [
      "US Passport",
      "The uploaded document does not match the selected document type. Please upload a valid U.S. Passport or choose a different document type."
    ],
    [
      "US Passport Card",
      "The uploaded document does not match the selected document type. Please upload a valid U.S. Passport Card or choose a different document type."
    ],
    [
      "US Permanent Resident Card",
      "The uploaded document does not match the selected document type. Please upload a valid U.S. Permanent Resident Card or choose a different document type."
    ],
    [
      "US Employment Authorization Card",
      "The uploaded document does not match the selected document type. Please upload a valid U.S. Employment Authorization Card or choose a different document type."
    ],
    [
      "Foreign Passport with Form I-94",
      "The uploaded document does not match the selected document type. Please upload a valid Foreign Passport with Form I-94 or choose a different document type."
    ]
  ])("formats document mismatch guidance for %s", (label, expected) => {
    expect(documentTypeMismatchMessage(label)).toBe(expected);
  });
});

function makeInput(overrides: {
  selectedType?: GovernmentIdType;
  side?: "front" | "back";
  profile?: Partial<ConfirmedW2Profile>;
  ocr?: Partial<IdentityOcrResult>;
  documentDetectedInFrame?: boolean;
  expirationDate?: string | undefined;
  issueDate?: string;
  nationality?: string;
  countryOfIssuance?: string;
} = {}) {
  return {
    userSelectedType: overrides.selectedType ?? ("drivers-license" as GovernmentIdType),
    side: overrides.side ?? ("front" as const),
    profile: {
      ...identityFixtures.confirmedProfile,
      addressLine1: documentAddressFixture.line1,
      city: documentAddressFixture.city,
      state: documentAddressFixture.state,
      zip: documentAddressFixture.zip,
      ...overrides.profile
    },
    ocr: { ...ocrFixtures.driversLicenseClear, ...overrides.ocr },
    documentDetectedInFrame: overrides.documentDetectedInFrame ?? true,
    documentAddress: documentAddressFixture,
    expirationDate: "expirationDate" in overrides ? overrides.expirationDate : documentExpirationFixture,
    issueDate: overrides.issueDate ?? documentIssueDateFixture,
    today,
    nationality: overrides.nationality,
    countryOfIssuance: overrides.countryOfIssuance
  };
}

describe("analyzeIdentityDocument", () => {
  it("returns CONTINUE-ready analysis when document, name, DOB, address, and expiration align", () => {
    const result = analyzeIdentityDocument(makeInput());

    expect(result.documentDetected).toBe(true);
    expect(result.detectedDocumentType).toBe("drivers-license");
    expect(result.documentTypeMatch).toBe(true);
    expect(result.validationResults.nameMatch.status).toBe("MATCH");
    expect(result.validationResults.dobMatch.status).toBe("MATCH");
    expect(result.validationResults.addressMatch.status).toBe("MATCH");
    expect(result.validationResults.expirationStatus).toBe("VALID");
    expect(result.validationResults.photoIntegrity).toBe("CLEAR");
    expect(result.complianceEligibility).toBe(true);
    expect(result.flags.some((flag) => flag.severity === "CRITICAL")).toBe(false);
    expect(result.nextAction === "CONTINUE" || result.nextAction === "REQUEST_BACK_IMAGE").toBe(true);
    expect(result.extractedFields).toMatchObject({
      first_name: "Lakshya",
      last_name: "Bhambhani",
      date_of_birth: "1998-04-15",
      document_type: "DRIVER LICENSE"
    });
  });

  it("flags NO_DOCUMENT_DETECTED and halts when no document is in frame", () => {
    const result = analyzeIdentityDocument(makeInput({ documentDetectedInFrame: false }));

    expect(result.documentDetected).toBe(false);
    expect(result.complianceEligibility).toBe(false);
    expect(result.flags[0]).toMatchObject({
      severity: "CRITICAL",
      code: "NO_DOCUMENT_DETECTED"
    });
    expect(result.nextAction).toBe("RETAKE_PHOTO");
  });

  it("flags DOCUMENT_TYPE_MISMATCH when user selects passport but driver's license is detected", () => {
    const result = analyzeIdentityDocument(makeInput({ selectedType: "passport" }));

    expect(result.documentTypeMatch).toBe(false);
    const flag = result.flags.find((entry) => entry.code === "DOCUMENT_TYPE_MISMATCH");
    expect(flag?.severity).toBe("CRITICAL");
    expect(flag?.message).toBe(
      "The uploaded document does not match the selected document type. Please upload a valid U.S. Passport or choose a different document type."
    );
    expect(result.complianceEligibility).toBe(false);
    expect(result.nextAction).toBe("HALT_VERIFICATION");
  });

  it("flags NAME_MISMATCH when profile last name does not match document", () => {
    const result = analyzeIdentityDocument(
      makeInput({ profile: { legalLastName: "Johnson" } })
    );
    const flag = result.flags.find((entry) => entry.code === "NAME_MISMATCH");
    expect(flag?.severity).toBe("CRITICAL");
    expect(result.validationResults.nameMatch.status).toBe("MISMATCH");
    expect(result.complianceEligibility).toBe(false);
  });

  it("flags DOB_MISMATCH when profile DOB does not match the document", () => {
    const result = analyzeIdentityDocument(
      makeInput({ profile: { dateOfBirth: "1999-01-01" } })
    );
    const flag = result.flags.find((entry) => entry.code === "DOB_MISMATCH");
    expect(flag?.severity).toBe("CRITICAL");
    expect(result.validationResults.dobMatch.status).toBe("MISMATCH");
  });

  it("flags ADDRESS_MISMATCH on driver's license when profile address differs", () => {
    const result = analyzeIdentityDocument(
      makeInput({ profile: { addressLine1: "999 Different Way", city: "Oakland" } })
    );
    const flag = result.flags.find((entry) => entry.code === "ADDRESS_MISMATCH");
    expect(flag?.severity).toBe("CRITICAL");
    expect(result.validationResults.addressMatch.status).toBe("MISMATCH");
  });

  it("does not check address on a passport (no address printed)", () => {
    const result = analyzeIdentityDocument(
      makeInput({
        selectedType: "passport",
        ocr: { documentType: "passport" },
        profile: { addressLine1: "anywhere" }
      })
    );
    expect(result.validationResults.addressMatch.status).toBe("NOT_CHECKED");
    expect(result.flags.find((entry) => entry.code === "ADDRESS_MISMATCH")).toBeUndefined();
  });

  it("flags DOCUMENT_EXPIRED when expiration date is in the past", () => {
    const result = analyzeIdentityDocument(
      makeInput({ expirationDate: "2024-01-01" })
    );
    const flag = result.flags.find((entry) => entry.code === "DOCUMENT_EXPIRED");
    expect(flag?.severity).toBe("CRITICAL");
    expect(result.validationResults.expirationStatus).toBe("EXPIRED");
  });

  it("flags DOCUMENT_EXPIRES_SOON when expiration is within 90 days", () => {
    const result = analyzeIdentityDocument(
      makeInput({ expirationDate: "2026-05-15" })
    );
    expect(result.validationResults.expirationStatus).toBe("EXPIRES_SOON");
    expect(result.flags.find((entry) => entry.code === "DOCUMENT_EXPIRES_SOON")?.severity).toBe(
      "WARNING"
    );
    expect(result.complianceEligibility).toBe(true);
  });

  it("requests the back image when capturing the front of a driver's license", () => {
    const result = analyzeIdentityDocument(makeInput({ side: "front" }));
    expect(result.nextAction).toBe("REQUEST_BACK_IMAGE");
    expect(result.flags.find((entry) => entry.code === "BACK_IMAGE_REQUIRED")).toBeDefined();
  });

  it("returns back-side extracted fields when documenting the back of a driver's license", () => {
    const result = analyzeIdentityDocument(makeInput({ side: "back" }));
    expect(result.detectedSide).toBe("back");
    expect(result.extractedFields).toMatchObject({
      pdf417_data: "DECODED",
      magnetic_stripe_data: "PRESENT"
    });
    expect(result.nextAction).toBe("CONTINUE");
  });

  it("flags PHOTO_BLURRED when OCR reports blur", () => {
    const result = analyzeIdentityDocument(makeInput({ ocr: { imageQuality: "blur" } }));
    expect(result.validationResults.photoIntegrity).toBe("BLURRED");
    expect(result.flags.find((entry) => entry.code === "PHOTO_BLURRED")?.severity).toBe("CRITICAL");
    expect(result.nextAction).toBe("RETAKE_PHOTO");
  });

  it("flags DIGITAL_MANIPULATION_SUSPECTED when OCR reports a screenshot", () => {
    const result = analyzeIdentityDocument(
      makeInput({ ocr: { isOriginalPhysicalDocument: false } })
    );
    expect(result.flags.find((entry) => entry.code === "DIGITAL_MANIPULATION_SUSPECTED")?.severity).toBe(
      "CRITICAL"
    );
  });

  it("bypasses expiry check for Venezuelan passport with nationality=VEN", () => {
    const result = analyzeIdentityDocument(
      makeInput({
        selectedType: "passport",
        ocr: { documentType: "passport" },
        expirationDate: "2020-01-01",
        nationality: "VEN"
      })
    );
    expect(result.validationResults.expirationStatus).toBe("NOT_APPLICABLE");
    expect(result.flags.find((f) => f.code === "DOCUMENT_EXPIRED")).toBeUndefined();
    const bypassFlag = result.flags.find((f) => f.code === "VENEZUELAN_PASSPORT_EXPIRY_BYPASS");
    expect(bypassFlag).toBeDefined();
    expect(bypassFlag?.severity).toBe("INFO");
    expect(bypassFlag?.message).toBe(VENEZUELAN_PASSPORT_EXPIRY_BYPASS_MESSAGE);
    expect(result.complianceEligibility).toBe(true);
  });

  it("bypasses expiry check for Venezuelan passport with countryOfIssuance=VENEZUELA", () => {
    const result = analyzeIdentityDocument(
      makeInput({
        selectedType: "passport",
        ocr: { documentType: "passport" },
        expirationDate: "2019-06-01",
        countryOfIssuance: "VENEZUELA"
      })
    );
    expect(result.validationResults.expirationStatus).toBe("NOT_APPLICABLE");
    expect(result.flags.find((f) => f.code === "DOCUMENT_EXPIRED")).toBeUndefined();
    expect(result.flags.find((f) => f.code === "VENEZUELAN_PASSPORT_EXPIRY_BYPASS")).toBeDefined();
    expect(result.complianceEligibility).toBe(true);
  });

  it("does not bypass expiry for non-Venezuelan passport", () => {
    const result = analyzeIdentityDocument(
      makeInput({
        selectedType: "passport",
        ocr: { documentType: "passport" },
        expirationDate: "2020-01-01",
        nationality: "USA"
      })
    );
    expect(result.validationResults.expirationStatus).toBe("EXPIRED");
    expect(result.flags.find((f) => f.code === "DOCUMENT_EXPIRED")).toBeDefined();
    expect(result.flags.find((f) => f.code === "VENEZUELAN_PASSPORT_EXPIRY_BYPASS")).toBeUndefined();
    expect(result.complianceEligibility).toBe(false);
  });

  it("does not bypass expiry for Venezuelan driver's license (only passports)", () => {
    const result = analyzeIdentityDocument(
      makeInput({
        selectedType: "drivers-license",
        expirationDate: "2020-01-01",
        nationality: "VEN"
      })
    );
    expect(result.validationResults.expirationStatus).toBe("EXPIRED");
    expect(result.flags.find((f) => f.code === "DOCUMENT_EXPIRED")).toBeDefined();
    expect(result.flags.find((f) => f.code === "VENEZUELAN_PASSPORT_EXPIRY_BYPASS")).toBeUndefined();
  });

  it("still flags name mismatch on Venezuelan passport even with expiry bypass", () => {
    const result = analyzeIdentityDocument(
      makeInput({
        selectedType: "passport",
        ocr: { documentType: "passport" },
        expirationDate: "2019-06-01",
        nationality: "VENEZUELA",
        profile: { legalLastName: "DifferentName" }
      })
    );
    expect(result.validationResults.expirationStatus).toBe("NOT_APPLICABLE");
    expect(result.flags.find((f) => f.code === "VENEZUELAN_PASSPORT_EXPIRY_BYPASS")).toBeDefined();
    expect(result.flags.find((f) => f.code === "NAME_MISMATCH")).toBeDefined();
    expect(result.complianceEligibility).toBe(false);
  });
});
