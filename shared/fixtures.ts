import type {
  ConfirmedW2Profile,
  DocumentAddress,
  IdentityOcrResult,
  InitialIdentity
} from "./types";

export const documentAddressFixture: DocumentAddress = {
  line1: "895 Main St",
  city: "San Francisco",
  state: "CA",
  zip: "94105"
};

export const documentExpirationFixture = "2030-04-15";
export const documentIssueDateFixture = "2022-04-15";

export const initialIdentity: InitialIdentity = {
  accountId: "pro_mock_001",
  firstName: "Lakshya",
  middleName: "",
  lastName: "Bhambhani",
  dateOfBirth: "1998-04-15",
  email: "lakshya@example.com",
  phone: "+1 555 010 9999"
};

const clearDriversLicense: IdentityOcrResult = {
  documentDetected: true,
  documentType: "drivers_license",
  selectedDocumentType: "drivers_license",
  isSelectedDocumentType: true,
  isOriginalPhysicalDocument: true,
  imageQuality: "clear",
  imageQualityIssue: null,
  orientation: "horizontal",
  firstName: "Lakshya",
  middleName: "",
  lastName: "Bhambhani",
  suffix: "",
  dateOfBirth: "1998-04-15",
  ssnLast4: null,
  fullSsnVisible: false,
  confidence: 0.94,
  warnings: [],
  blockingErrors: []
};

export const ocrFixtures = {
  driversLicenseClear: clearDriversLicense,
  verticalDriversLicense: {
    ...clearDriversLicense,
    orientation: "vertical",
    confidence: 0.96
  },
  verticalLowConfidence: {
    ...clearDriversLicense,
    orientation: "vertical",
    confidence: 0.62,
    imageQuality: "unclear",
    imageQualityIssue: "low confidence vertical scan"
  },
  passportWhenDriversLicenseSelected: {
    ...clearDriversLicense,
    documentType: "passport",
    selectedDocumentType: "drivers_license",
    isSelectedDocumentType: false
  },
  glareDriversLicense: {
    ...clearDriversLicense,
    imageQuality: "glare",
    imageQualityIssue: "glare"
  },
  screenshotId: {
    ...clearDriversLicense,
    isOriginalPhysicalDocument: false
  },
  socialSecurityCard: {
    ...clearDriversLicense,
    documentType: "social_security_card",
    selectedDocumentType: "social_security_card",
    ssnLast4: "6789",
    fullSsnVisible: true
  },
  workbrightPassport: {
    ...clearDriversLicense,
    documentType: "passport",
    selectedDocumentType: "passport",
    isSelectedDocumentType: true,
    firstName: "Lakshya",
    lastName: "Bhambhani"
  }
} satisfies Record<string, IdentityOcrResult>;

export const identityFixtures = {
  initialIdentity,
  confirmedProfile: {
    legalFirstName: "Lakshya",
    legalMiddleName: "A",
    legalLastName: "Bhambhani",
    suffix: "",
    dateOfBirth: "1998-04-15",
    ssn: "123456789",
    addressLine1: "123 Market St",
    addressLine2: "",
    city: "San Francisco",
    state: "CA",
    zip: "94105",
    email: "lakshya@example.com",
    phone: "+1 555 010 9999"
  } satisfies ConfirmedW2Profile
};

export const duplicateSsns = new Set(["987654321"]);

export type OcrFixtureId = keyof typeof ocrFixtures;
