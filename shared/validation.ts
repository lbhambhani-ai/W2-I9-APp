import type {
  ConfirmedW2Profile,
  DocumentAddress,
  DocumentSide,
  GovernmentIdType,
  IdentityFieldComparison,
  IdentityFlag,
  IdentityOcrResult,
  IdentityVerificationAnalysis,
  ValidationError,
  ValidationResult,
  WorkBrightSubmissionInput
} from "./types";

type W2ProfileValidationInput = {
  ocr: IdentityOcrResult;
  profile: ConfirmedW2Profile;
  duplicateSsns: Set<string>;
};

const messages = {
  wrongDocumentType: "The uploaded document does not match the selected document type.",
  imageUnclear: "We could not read this image clearly. Please retake the photo.",
  notOriginal: "Please upload a photo of the original physical document.",
  nameMismatch: "Your legal name does not match the uploaded identity document.",
  dobMismatch: "Your date of birth does not match your identity document.",
  ssnMismatch: "The SSN entered does not match the uploaded Social Security document.",
  duplicateSsn: "This SSN is already associated with another Instawork account.",
  invalidSsn: "SSN must contain exactly 9 digits.",
  under18: "You must be at least 18 to continue W-2 onboarding."
};

export function normalizeNamePart(value = ""): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.'-]/g, "")
    .replace(/\s+/g, " ");
}

export function normalizeSsn(value: string): string {
  return value.replace(/\D/g, "");
}

export function maskSsn(value: string): string {
  const digits = normalizeSsn(value);
  return `XXX-XX-${digits.slice(-4)}`;
}

export function validateDocumentUpload(ocr: IdentityOcrResult): ValidationResult {
  const blockingErrors: ValidationError[] = [...ocr.blockingErrors];
  const warnings: ValidationError[] = [...ocr.warnings];

  if (!ocr.documentDetected) {
    blockingErrors.push({ code: "NO_DOCUMENT_DETECTED", message: "No supported identity document was detected." });
  }

  if (!ocr.isSelectedDocumentType || ocr.documentType !== ocr.selectedDocumentType) {
    blockingErrors.push({ code: "WRONG_DOCUMENT_TYPE", message: messages.wrongDocumentType });
  }

  if (ocr.imageQuality !== "clear" || ocr.confidence < 0.7) {
    blockingErrors.push({ code: "IMAGE_UNCLEAR", message: messages.imageUnclear });
  }

  if (!ocr.isOriginalPhysicalDocument) {
    blockingErrors.push({ code: "NOT_ORIGINAL_PHYSICAL_DOCUMENT", message: messages.notOriginal });
  }

  const status = blockingErrors.length ? "blocked" : warnings.length ? "warning" : "pass";
  return {
    status,
    canProceedToWorkBright: status !== "blocked",
    warnings,
    blockingErrors,
    nextAction: status === "blocked" ? "retry_document_upload" : "continue",
    extractedDocument: ocr
  };
}

export function validateW2Profile({ ocr, profile, duplicateSsns }: W2ProfileValidationInput): ValidationResult {
  const documentValidation = validateDocumentUpload(ocr);
  const blockingErrors: ValidationError[] = [...documentValidation.blockingErrors];
  const warnings: ValidationError[] = [...documentValidation.warnings];
  const ssn = normalizeSsn(profile.ssn);

  if (normalizeNamePart(profile.legalFirstName) !== normalizeNamePart(ocr.firstName)) {
    blockingErrors.push({ code: "LEGAL_NAME_MISMATCH", message: messages.nameMismatch });
  }

  if (normalizeNamePart(profile.legalLastName) !== normalizeNamePart(ocr.lastName)) {
    blockingErrors.push({ code: "LEGAL_NAME_MISMATCH", message: messages.nameMismatch });
  }

  if (ocr.suffix && normalizeNamePart(profile.suffix) !== normalizeNamePart(ocr.suffix)) {
    warnings.push({ code: "SUFFIX_MISMATCH", message: "The suffix on the profile differs from the identity document." });
  }

  if (profile.dateOfBirth !== ocr.dateOfBirth) {
    blockingErrors.push({ code: "DOB_MISMATCH", message: messages.dobMismatch });
  }

  if (!isValidAdultDate(profile.dateOfBirth)) {
    blockingErrors.push({ code: "DOB_UNDER_18_OR_INVALID", message: messages.under18 });
  }

  if (ssn.length !== 9) {
    blockingErrors.push({ code: "INVALID_SSN_FORMAT", message: messages.invalidSsn });
  }

  if (duplicateSsns.has(ssn)) {
    blockingErrors.push({ code: "DUPLICATE_SSN", message: messages.duplicateSsn });
  }

  if (ocr.documentType === "social_security_card" && ocr.ssnLast4 && ssn.slice(-4) !== ocr.ssnLast4) {
    blockingErrors.push({ code: "SSN_MISMATCH", message: messages.ssnMismatch });
  }

  const hasDuplicate = blockingErrors.some((error) => error.code === "DUPLICATE_SSN");
  const status = blockingErrors.length ? "blocked" : warnings.length ? "warning" : "pass";

  return {
    status,
    canProceedToWorkBright: status !== "blocked",
    warnings: dedupeErrors(warnings),
    blockingErrors: dedupeErrors(blockingErrors),
    nextAction: status === "blocked" ? (hasDuplicate ? "contact_support" : "edit_profile") : "continue",
    extractedDocument: ocr
  };
}

export function validateWorkBrightSubmission(input: WorkBrightSubmissionInput): ValidationResult {
  const blockingErrors: ValidationError[] = [];

  if (!input.w2Validation.canProceedToWorkBright) {
    blockingErrors.push({
      code: "WORKBRIGHT_LOCKED",
      message: "WorkBright cannot open until W-2 Steps 1 and 2 are valid."
    });
  }

  if (!input.documentValidation.canProceedToWorkBright) {
    blockingErrors.push(...input.documentValidation.blockingErrors);
  }

  if (!input.signature.trim()) {
    blockingErrors.push({ code: "SIGNATURE_REQUIRED", message: "Signature is required before final submission." });
  }

  return {
    status: blockingErrors.length ? "blocked" : "pass",
    canProceedToWorkBright: blockingErrors.length === 0,
    warnings: [],
    blockingErrors: dedupeErrors(blockingErrors),
    nextAction: blockingErrors.length ? "edit_profile" : "continue"
  };
}

function isValidAdultDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  const eighteenthBirthday = new Date(parsed);
  eighteenthBirthday.setUTCFullYear(parsed.getUTCFullYear() + 18);
  return eighteenthBirthday <= new Date();
}

function dedupeErrors(errors: ValidationError[]): ValidationError[] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    const key = `${error.code}:${error.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

const GOVERNMENT_ID_TYPE_LABELS: Record<GovernmentIdType, string> = {
  "drivers-license": "US Driver’s License",
  "state-id": "US State ID Card",
  passport: "US Passport",
  "passport-card": "US Passport Card",
  "permanent-resident-card": "US Permanent Resident Card",
  "employment-authorization-card": "US Employment Authorization Card",
  "foreign-passport-i94": "Foreign Passport with Form I-94",
  "military-id": "US Military ID",
  "school-id": "School ID with Photograph",
  unknown: "Unsupported document"
};

const DOCUMENT_TYPES_WITH_ADDRESS = new Set<GovernmentIdType>([
  "drivers-license",
  "state-id"
]);

const DOCUMENT_TYPES_WITH_EXPIRATION = new Set<GovernmentIdType>([
  "drivers-license",
  "state-id",
  "passport",
  "passport-card",
  "permanent-resident-card",
  "foreign-passport-i94",
  "employment-authorization-card"
]);

const VENEZUELAN_PASSPORT_TYPES = new Set<GovernmentIdType>([
  "passport",
  "foreign-passport-i94"
]);

function isVenezuelanPassport(
  detectedType: GovernmentIdType,
  nationality?: string,
  countryOfIssuance?: string
): boolean {
  if (!VENEZUELAN_PASSPORT_TYPES.has(detectedType)) return false;
  const indicators = [nationality, countryOfIssuance].filter(Boolean).map(v => v!.toUpperCase().trim());
  return indicators.some(v =>
    v === "VEN" || v === "VENEZUELA" || v === "VENEZUELAN" ||
    v.includes("VENEZUELA") || v.includes("BOLIVARIAN REPUBLIC OF VENEZUELA")
  );
}

export const VENEZUELAN_PASSPORT_EXPIRY_BYPASS_MESSAGE =
  "Since this is a Venezuelan passport, the expiry date will not be checked. Make sure your name and date of birth match those on your identity document to proceed.";

export const I9_EXPIRY_EXCEPTION_MESSAGES = {
  EAD_AUTO_EXTENSION:
    "This Employment Authorization Document (Form I-766) has been auto-extended with a valid Form I-797C receipt notice. The printed expiry date on the card is not enforced.",
  I551_EXTENSION_NOTICE:
    "This Permanent Resident Card has been extended with a valid Form I-797 Notice of Action. The card's printed expiry date is not enforced.",
  ADIT_STAMP_ACCEPTED:
    "This foreign passport contains a valid temporary I-551/ADIT stamp confirming permanent resident status. The passport's own expiry date is not enforced for I-9 purposes.",
  VENEZUELAN_PASSPORT_EXPIRY_BYPASS:
    VENEZUELAN_PASSPORT_EXPIRY_BYPASS_MESSAGE,
  RECEIPT_DOCUMENT_ACCEPTED:
    "A valid receipt for a lost, stolen, or damaged document has been accepted. The actual replacement document must be presented within 90 days of the hire date."
} as const;

export type I9ExpiryExceptionCode =
  | "EAD_AUTO_EXTENSION"
  | "I551_EXTENSION_NOTICE"
  | "ADIT_STAMP_ACCEPTED"
  | "VENEZUELAN_PASSPORT_EXPIRY_BYPASS"
  | "RECEIPT_DOCUMENT_ACCEPTED";

const DOCUMENT_TYPES_REQUIRING_BACK = new Set<GovernmentIdType>([
  "drivers-license",
  "state-id",
  "passport-card"
]);

export function governmentIdTypeLabel(value: string): string {
  if ((Object.keys(GOVERNMENT_ID_TYPE_LABELS) as GovernmentIdType[]).includes(value as GovernmentIdType)) {
    return GOVERNMENT_ID_TYPE_LABELS[value as GovernmentIdType];
  }
  return GOVERNMENT_ID_TYPE_LABELS.unknown;
}

function formatUserFacingDocumentLabel(label: string): string {
  return label.replace(/^US\b/, "U.S.");
}

export function documentTypeMismatchMessage(selectedDocumentLabel: string): string {
  const label = formatUserFacingDocumentLabel(selectedDocumentLabel || "document");
  return `The uploaded document does not match the selected document type. You can change your selection to match what you uploaded, or upload a valid ${label}.`;
}

function ocrToGovernmentIdType(ocr: IdentityOcrResult): GovernmentIdType {
  switch (ocr.documentType) {
    case "drivers_license":
      return "drivers-license";
    case "state_id":
      return "state-id";
    case "passport":
      return "passport";
    case "passport_card":
      return "passport-card";
    case "permanent_resident_card":
      return "permanent-resident-card";
    case "work_authorization":
      return "employment-authorization-card";
    case "military_id":
      return "military-id";
    default:
      return "unknown";
  }
}

function maskDocumentNumber(prefix: string, digits = 8): string {
  return `${prefix}${"*".repeat(Math.max(digits - 4, 0))}1234`;
}

function buildExtractedFields(
  detectedType: GovernmentIdType,
  side: DocumentSide,
  ocr: IdentityOcrResult,
  documentAddress: DocumentAddress | undefined,
  expirationDate: string | undefined,
  issueDate: string | undefined
): Record<string, string | null> {
  const fullName = [ocr.firstName, ocr.middleName, ocr.lastName].filter(Boolean).join(" ").trim();
  const baseFront = {
    full_name_raw: fullName || null,
    last_name: ocr.lastName ?? null,
    first_name: ocr.firstName ?? null,
    middle_name: ocr.middleName?.trim() ? ocr.middleName : null,
    name_suffix: ocr.suffix?.trim() ? ocr.suffix : null,
    date_of_birth: ocr.dateOfBirth ?? null
  };

  switch (detectedType) {
    case "drivers-license":
    case "state-id": {
      if (side === "back") {
        return {
          pdf417_data: "DECODED",
          magnetic_stripe_data: "PRESENT",
          duplicate_indicator: "NONE"
        };
      }
      return {
        ...baseFront,
        document_type: detectedType === "state-id" ? "IDENTIFICATION CARD" : "DRIVER LICENSE",
        address: documentAddress
          ? `${documentAddress.line1}, ${documentAddress.city}, ${documentAddress.state} ${documentAddress.zip}`
          : null,
        license_number: maskDocumentNumber("DL"),
        class: detectedType === "state-id" ? "ID ONLY" : "C",
        sex: "M",
        height: "5'-09\"",
        eye_color: "BRN",
        donor: "NO",
        issue_date: issueDate ?? null,
        expiration_date: expirationDate ?? null
      };
    }
    case "passport": {
      if (side === "back") {
        return {
          chip_present: "YES",
          observations: "NONE"
        };
      }
      return {
        ...baseFront,
        passport_type: "P",
        country_code: "USA",
        passport_number: maskDocumentNumber("P", 9),
        nationality: "UNITED STATES OF AMERICA",
        sex: "M",
        place_of_birth: documentAddress ? `${documentAddress.city}, ${documentAddress.state}` : null,
        date_of_issue: issueDate ?? null,
        date_of_expiration: expirationDate ?? null,
        authority: "U.S. Department of State",
        signature: "YES",
        mrz_line_1: "P<USAB<<HAMBHANI<<LAKSHYA<<<<<<<<<<<<<<<<<<<<<<<",
        mrz_line_2: "X1234567US9001151M3001151<<<<<<<<<<<<<<00"
      };
    }
    case "passport-card": {
      if (side === "back") {
        return {
          mrz_line_1: "I<USAC1234567<<<<<<<<<<<<<<<<<",
          mrz_line_2: "9001151M3001151USA<<<<<<<<<<<6",
          mrz_line_3: "BHAMBHANI<<LAKSHYA<<<<<<<<<<<<",
          rfid_indicator: "YES"
        };
      }
      return {
        ...baseFront,
        card_number: maskDocumentNumber("C"),
        sex: "M",
        place_of_birth: documentAddress ? `${documentAddress.city}, ${documentAddress.state}` : null,
        date_of_issue: issueDate ?? null,
        date_of_expiration: expirationDate ?? null,
        authority: "U.S. Department of State"
      };
    }
    case "permanent-resident-card": {
      if (side === "back") {
        return {
          address_sticker: "NONE",
          security_features: "HOLOGRAM, LASER ENGRAVING"
        };
      }
      return {
        ...baseFront,
        card_number: "MSC1234567890",
        a_number: "A123456789",
        category: "IR1",
        sex: "M",
        resident_since: issueDate ?? null,
        card_expires: expirationDate ?? null,
        signature: "YES"
      };
    }
    case "employment-authorization-card": {
      if (side === "back") {
        return {
          usually_blank: "YES",
          security_features: "HOLOGRAM"
        };
      }
      return {
        ...baseFront,
        card_number: "SRC1234567890",
        a_number: "A987654321",
        category: "C09",
        sex: "M",
        valid_from: issueDate ?? null,
        card_expires: expirationDate ?? null,
        fingerprint: "DETECTED"
      };
    }
    case "military-id": {
      if (side === "back") {
        return {
          barcodes: "PDF417, CODE39",
          magnetic_stripe: "YES",
          official_use_text: "INFORMATION ON BACK IS FOR OFFICIAL USE ONLY"
        };
      }
      return {
        ...baseFront,
        edipi: "1234567890",
        rank: "E-4",
        branch_of_service: "ARMY",
        geneva_convention_category: "II",
        blood_type: "O POS",
        pay_grade: "E-4",
        chip_present: "YES"
      };
    }
    default:
      return baseFront;
  }
}

function compareNames(profile: ConfirmedW2Profile, ocr: IdentityOcrResult): IdentityFieldComparison {
  const profileName = `${profile.legalFirstName} ${profile.legalLastName}`.trim();
  const documentName = `${ocr.firstName ?? ""} ${ocr.lastName ?? ""}`.trim();

  if (!ocr.firstName && !ocr.lastName) {
    return {
      status: "NOT_CHECKED",
      details: "Document name was not extracted.",
      userProvided: profileName,
      documentExtracted: ""
    };
  }

  const lastMatch =
    normalizeNamePart(profile.legalLastName) === normalizeNamePart(ocr.lastName);
  const firstMatch =
    normalizeNamePart(profile.legalFirstName) === normalizeNamePart(ocr.firstName);

  if (lastMatch && firstMatch) {
    if (
      profile.legalMiddleName &&
      ocr.middleName &&
      normalizeNamePart(profile.legalMiddleName) !== normalizeNamePart(ocr.middleName)
    ) {
      return {
        status: "PARTIAL_MATCH",
        details: "Middle name differs between profile and ID.",
        userProvided: profileName,
        documentExtracted: documentName
      };
    }
    return {
      status: "MATCH",
      userProvided: profileName,
      documentExtracted: documentName
    };
  }

  return {
    status: "MISMATCH",
    details: `Name mismatch: ID shows ${documentName}; profile says ${profileName}. Go back and correct your legal name.`,
    userProvided: profileName,
    documentExtracted: documentName
  };
}

function compareDob(profile: ConfirmedW2Profile, ocr: IdentityOcrResult): IdentityFieldComparison {
  if (!ocr.dateOfBirth) {
    return {
      status: "NOT_CHECKED",
      details: "Date of birth was not extracted.",
      userProvided: profile.dateOfBirth,
      documentExtracted: ""
    };
  }

  if (profile.dateOfBirth === ocr.dateOfBirth) {
    return {
      status: "MATCH",
      userProvided: profile.dateOfBirth,
      documentExtracted: ocr.dateOfBirth
    };
  }

  return {
    status: "MISMATCH",
    details: `Date of birth mismatch: ID shows ${ocr.dateOfBirth}; profile says ${profile.dateOfBirth}. Go back and correct your date of birth.`,
    userProvided: profile.dateOfBirth,
    documentExtracted: ocr.dateOfBirth
  };
}

function compareAddress(
  detectedType: GovernmentIdType,
  profile: ConfirmedW2Profile,
  documentAddress: DocumentAddress | undefined
): IdentityFieldComparison {
  if (!DOCUMENT_TYPES_WITH_ADDRESS.has(detectedType) || !documentAddress) {
    return {
      status: "NOT_CHECKED",
      details: "Address is not printed on this document type."
    };
  }

  const profileAddress = `${profile.addressLine1}, ${profile.city}, ${profile.state} ${profile.zip}`;
  const documentAddressString = `${documentAddress.line1}, ${documentAddress.city}, ${documentAddress.state} ${documentAddress.zip}`;

  const componentsMatch =
    normalizeNamePart(profile.addressLine1) === normalizeNamePart(documentAddress.line1) &&
    normalizeNamePart(profile.city) === normalizeNamePart(documentAddress.city) &&
    normalizeNamePart(profile.state) === normalizeNamePart(documentAddress.state) &&
    profile.zip.replace(/\D/g, "").slice(0, 5) === documentAddress.zip.replace(/\D/g, "").slice(0, 5);

  if (componentsMatch) {
    return {
      status: "MATCH",
      userProvided: profileAddress,
      documentExtracted: documentAddressString
    };
  }

  return {
    status: "MISMATCH",
    details: `Address mismatch: ID shows ${documentAddressString}; profile says ${profileAddress}. Go back and correct your address.`,
    userProvided: profileAddress,
    documentExtracted: documentAddressString
  };
}

function expirationStatus(
  detectedType: GovernmentIdType,
  expirationDate: string | undefined,
  today: Date
): { status: "VALID" | "EXPIRED" | "EXPIRES_SOON" | "NOT_APPLICABLE" | "UNKNOWN"; date?: string } {
  if (!DOCUMENT_TYPES_WITH_EXPIRATION.has(detectedType)) {
    return { status: "NOT_APPLICABLE" };
  }
  if (!expirationDate) {
    return { status: "UNKNOWN" };
  }
  const parsed = new Date(`${expirationDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return { status: "UNKNOWN", date: expirationDate };
  }
  const diffMs = parsed.getTime() - today.getTime();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  if (diffMs < 0) {
    return { status: "EXPIRED", date: expirationDate };
  }
  if (diffMs < ninetyDaysMs) {
    return { status: "EXPIRES_SOON", date: expirationDate };
  }
  return { status: "VALID", date: expirationDate };
}

function photoIntegrity(ocr: IdentityOcrResult): {
  status: "CLEAR" | "BLURRED" | "ABSENT" | "ANOMALY" | "GLARE";
  detail?: string;
} {
  switch (ocr.imageQuality) {
    case "clear":
      return { status: "CLEAR" };
    case "blur":
    case "unclear":
      return { status: "BLURRED", detail: ocr.imageQualityIssue ?? undefined };
    case "glare":
      return { status: "GLARE", detail: ocr.imageQualityIssue ?? undefined };
    case "dark":
    case "cropped":
      return { status: "ANOMALY", detail: ocr.imageQualityIssue ?? undefined };
    default:
      return { status: "ANOMALY" };
  }
}

export type IdentityAnalysisInput = {
  userSelectedType: GovernmentIdType;
  side: DocumentSide;
  profile: ConfirmedW2Profile;
  ocr: IdentityOcrResult;
  documentDetectedInFrame: boolean;
  documentAddress?: DocumentAddress;
  expirationDate?: string;
  issueDate?: string;
  today?: Date;
  nationality?: string;
  countryOfIssuance?: string;
};

export function analyzeIdentityDocument(input: IdentityAnalysisInput): IdentityVerificationAnalysis {
  const today = input.today ?? new Date();
  const flags: IdentityFlag[] = [];

  if (!input.documentDetectedInFrame) {
    return {
      userSelectedType: input.userSelectedType,
      userSelectedTypeLabel: governmentIdTypeLabel(input.userSelectedType),
      detectedDocumentType: "unknown",
      detectedDocumentTypeLabel: GOVERNMENT_ID_TYPE_LABELS.unknown,
      documentTypeMatch: false,
      documentDetected: false,
      detectedSide: input.side,
      extractedFields: {},
      validationResults: {
        nameMatch: { status: "NOT_CHECKED" },
        dobMatch: { status: "NOT_CHECKED" },
        addressMatch: { status: "NOT_CHECKED" },
        expirationStatus: "UNKNOWN",
        photoIntegrity: "ABSENT"
      },
      flags: [
        {
          severity: "CRITICAL",
          code: "NO_DOCUMENT_DETECTED",
          message:
            "No supported US government ID detected. Hold the selected document inside the frame and capture the correct side."
        }
      ],
      complianceEligibility: false,
      nextAction: "RETAKE_PHOTO",
      humanReviewRequired: false,
      reviewReason: undefined
    };
  }

  const detectedType: GovernmentIdType =
    input.side === "back" ? input.userSelectedType : ocrToGovernmentIdType(input.ocr);
  const detectedLabel = governmentIdTypeLabel(detectedType);
  const userSelectedLabel = governmentIdTypeLabel(input.userSelectedType);
  const documentTypeMatch = detectedType === input.userSelectedType;

  if (!documentTypeMatch) {
    flags.push({
      severity: "CRITICAL",
      code: "DOCUMENT_TYPE_MISMATCH",
      message: documentTypeMismatchMessage(userSelectedLabel)
    });
  }

  const photo = photoIntegrity(input.ocr);
  if (photo.status === "BLURRED") {
    flags.push({
      severity: "CRITICAL",
      code: "PHOTO_BLURRED",
      message: "Photo is blurry. Retake with all text sharp and readable."
    });
  } else if (photo.status === "GLARE") {
    flags.push({
      severity: "WARNING",
      code: "PHOTO_GLARE",
      message: "Photo has glare. Retake without reflections on the ID surface."
    });
  } else if (photo.status === "ANOMALY") {
    flags.push({
      severity: "WARNING",
      code: "PHOTO_ANOMALY",
      message: "Photo quality looks off. Retake with even lighting and full document in frame."
    });
  } else if (photo.status === "ABSENT") {
    flags.push({
      severity: "CRITICAL",
      code: "PHOTO_NOT_VERIFIABLE",
      message: "Photo of the document was not verifiable."
    });
  }

  if (!input.ocr.isOriginalPhysicalDocument) {
    flags.push({
      severity: "CRITICAL",
      code: "DIGITAL_MANIPULATION_SUSPECTED",
      message: "Image looks like a screenshot of a digital document. Capture the original physical ID."
    });
  }

  const nameMatch = compareNames(input.profile, input.ocr);
  const dobMatch = compareDob(input.profile, input.ocr);
  const addressMatch = compareAddress(detectedType, input.profile, input.documentAddress);
  const venezuelanBypass = isVenezuelanPassport(detectedType, input.nationality, input.countryOfIssuance);
  const expiration = venezuelanBypass
    ? { status: "NOT_APPLICABLE" as const }
    : expirationStatus(detectedType, input.expirationDate, today);

  if (documentTypeMatch) {
    if (nameMatch.status === "MISMATCH") {
      flags.push({
        severity: "CRITICAL",
        code: "NAME_MISMATCH",
        message: nameMatch.details ?? "Name on document does not match the profile."
      });
    } else if (nameMatch.status === "PARTIAL_MATCH") {
      flags.push({
        severity: "WARNING",
        code: "MIDDLE_NAME_MISMATCH",
        message: nameMatch.details ?? "Middle name differs between profile and document."
      });
    }

    if (dobMatch.status === "MISMATCH") {
      flags.push({
        severity: "CRITICAL",
        code: "DOB_MISMATCH",
        message: dobMatch.details ?? "Date of birth on document does not match the profile."
      });
    }

    if (addressMatch.status === "MISMATCH") {
      flags.push({
        severity: "CRITICAL",
        code: "ADDRESS_MISMATCH",
        message: addressMatch.details ?? "Address on document does not match the profile."
      });
    }

    if (venezuelanBypass) {
      flags.push({
        severity: "INFO",
        code: "VENEZUELAN_PASSPORT_EXPIRY_BYPASS",
        message: VENEZUELAN_PASSPORT_EXPIRY_BYPASS_MESSAGE
      });
    } else if (expiration.status === "EXPIRED") {
      flags.push({
        severity: "CRITICAL",
        code: "DOCUMENT_EXPIRED",
        message: `Document expired on ${expiration.date}. Provide a renewed document.`
      });
    } else if (expiration.status === "EXPIRES_SOON") {
      flags.push({
        severity: "WARNING",
        code: "DOCUMENT_EXPIRES_SOON",
        message: `Document expires on ${expiration.date}. Plan to renew before the expiration date.`
      });
    } else if (expiration.status === "UNKNOWN") {
      flags.push({
        severity: "INFO",
        code: "EXPIRATION_DATE_NOT_FOUND",
        message: "Expiration date was not detected on the document."
      });
    }
  }

  const extractedFields = buildExtractedFields(
    detectedType,
    input.side,
    input.ocr,
    input.documentAddress,
    input.expirationDate,
    input.issueDate
  );

  const requiresBackImage =
    input.side === "front" &&
    documentTypeMatch &&
    DOCUMENT_TYPES_REQUIRING_BACK.has(detectedType);

  if (requiresBackImage) {
    flags.push({
      severity: "INFO",
      code: "BACK_IMAGE_REQUIRED",
      message: `Capture the back of the ${detectedLabel} to complete verification.`
    });
  }

  const hasCritical = flags.some((flag) => flag.severity === "CRITICAL");
  const hasWarning = flags.some((flag) => flag.severity === "WARNING");

  let nextAction: IdentityVerificationAnalysis["nextAction"];
  if (hasCritical) {
    if (flags.some((flag) => flag.code === "NO_DOCUMENT_DETECTED" || flag.code === "PHOTO_BLURRED")) {
      nextAction = "RETAKE_PHOTO";
    } else {
      nextAction = "HALT_VERIFICATION";
    }
  } else if (requiresBackImage) {
    nextAction = "REQUEST_BACK_IMAGE";
  } else {
    nextAction = "CONTINUE";
  }

  const reviewReason = flags.find((flag) => flag.severity === "CRITICAL")?.message;

  return {
    userSelectedType: input.userSelectedType,
    userSelectedTypeLabel: userSelectedLabel,
    detectedDocumentType: detectedType,
    detectedDocumentTypeLabel: detectedLabel,
    documentTypeMatch,
    documentDetected: true,
    detectedSide: input.side,
    extractedFields,
    validationResults: {
      nameMatch,
      dobMatch,
      addressMatch,
      expirationStatus: expiration.status,
      photoIntegrity: photo.status
    },
    flags,
    complianceEligibility: !hasCritical,
    nextAction,
    humanReviewRequired: hasCritical || hasWarning,
    reviewReason
  };
}
