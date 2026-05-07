import { describe, expect, it } from "vitest";
import {
  maskSsn,
  validateDocumentUpload,
  validateW2Profile,
  validateWorkBrightSubmission
} from "../shared/validation";
import { duplicateSsns, identityFixtures, ocrFixtures } from "../shared/fixtures";

describe("W-2 validation", () => {
  it("passes when legal name and DOB match OCR while middle name is omitted", () => {
    const result = validateW2Profile({
      ocr: ocrFixtures.driversLicenseClear,
      profile: {
        ...identityFixtures.confirmedProfile,
        legalMiddleName: "",
        dateOfBirth: "1998-04-15",
        ssn: "123-45-6789"
      },
      duplicateSsns
    });

    expect(result.status).toBe("pass");
    expect(result.canProceedToWorkBright).toBe(true);
    expect(result.blockingErrors).toEqual([]);
  });

  it("blocks nicknames instead of treating them as legal-name matches", () => {
    const result = validateW2Profile({
      ocr: { ...ocrFixtures.driversLicenseClear, firstName: "Christopher", lastName: "Smith" },
      profile: { ...identityFixtures.confirmedProfile, legalFirstName: "Chris", legalLastName: "Smith" },
      duplicateSsns
    });

    expect(result.status).toBe("blocked");
    expect(result.nextAction).toBe("edit_profile");
    expect(result.blockingErrors.map((error) => error.code)).toContain("LEGAL_NAME_MISMATCH");
  });

  it("blocks duplicate SSNs and routes to support", () => {
    const result = validateW2Profile({
      ocr: ocrFixtures.driversLicenseClear,
      profile: { ...identityFixtures.confirmedProfile, ssn: "987-65-4321" },
      duplicateSsns
    });

    expect(result.status).toBe("blocked");
    expect(result.nextAction).toBe("contact_support");
    expect(result.blockingErrors.map((error) => error.code)).toContain("DUPLICATE_SSN");
  });

  it("accepts readable vertical IDs", () => {
    const result = validateDocumentUpload(ocrFixtures.verticalDriversLicense);

    expect(result.status).toBe("pass");
    expect(result.canProceedToWorkBright).toBe(true);
  });

  it("blocks wrong document type and unclear images", () => {
    const wrongType = validateDocumentUpload(ocrFixtures.passportWhenDriversLicenseSelected);
    const glare = validateDocumentUpload(ocrFixtures.glareDriversLicense);

    expect(wrongType.blockingErrors.map((error) => error.code)).toContain("WRONG_DOCUMENT_TYPE");
    expect(glare.nextAction).toBe("retry_document_upload");
    expect(glare.blockingErrors.map((error) => error.code)).toContain("IMAGE_UNCLEAR");
  });

  it("masks SSN after save", () => {
    expect(maskSsn("123-45-6789")).toBe("XXX-XX-6789");
  });
});

describe("WorkBright validation", () => {
  it("blocks WorkBright before W-2 validation passes", () => {
    const result = validateWorkBrightSubmission({
      w2Validation: {
        status: "blocked",
        canProceedToWorkBright: false,
        warnings: [],
        blockingErrors: [{ code: "DOB_MISMATCH", message: "DOB mismatch" }],
        nextAction: "edit_profile"
      },
      signature: "Lakshya Bhambhani",
      documentValidation: validateDocumentUpload(ocrFixtures.workbrightPassport)
    });

    expect(result.status).toBe("blocked");
    expect(result.blockingErrors.map((error) => error.code)).toContain("WORKBRIGHT_LOCKED");
  });
});
