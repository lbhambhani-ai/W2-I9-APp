export type DocumentType =
  | "drivers_license"
  | "state_id"
  | "passport"
  | "passport_card"
  | "permanent_resident_card"
  | "social_security_card"
  | "work_authorization"
  | "military_id"
  | "unknown";

export type ImageQuality = "clear" | "unclear" | "glare" | "blur" | "cropped" | "dark";

export type NextAction = "continue" | "retry_document_upload" | "edit_profile" | "contact_support";

export type ValidationStatus = "pass" | "warning" | "blocked";

export type ValidationError = {
  code: string;
  message: string;
};

export type InitialIdentity = {
  accountId: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  dateOfBirth?: string;
  email: string;
  phone: string;
};

export type IdentityOcrResult = {
  documentDetected: boolean;
  documentType: DocumentType;
  selectedDocumentType: DocumentType;
  isSelectedDocumentType: boolean;
  isOriginalPhysicalDocument: boolean;
  imageQuality: ImageQuality;
  imageQualityIssue?: string | null;
  orientation?: "horizontal" | "vertical";
  firstName?: string;
  middleName?: string;
  lastName?: string;
  suffix?: string;
  dateOfBirth?: string;
  ssnLast4?: string | null;
  fullSsnVisible?: boolean;
  confidence: number;
  warnings: ValidationError[];
  blockingErrors: ValidationError[];
};

export type ConfirmedW2Profile = {
  legalFirstName: string;
  legalMiddleName?: string;
  legalLastName: string;
  suffix?: string;
  dateOfBirth: string;
  ssn: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zip: string;
  email: string;
  phone: string;
};

export type ValidationResult = {
  status: ValidationStatus;
  canProceedToWorkBright: boolean;
  warnings: ValidationError[];
  blockingErrors: ValidationError[];
  nextAction: NextAction;
  extractedDocument?: IdentityOcrResult;
};

export type WorkBrightSubmissionInput = {
  w2Validation: ValidationResult;
  signature: string;
  documentValidation: ValidationResult;
};

export type GovernmentIdType =
  | "drivers-license"
  | "state-id"
  | "passport"
  | "passport-card"
  | "permanent-resident-card"
  | "employment-authorization-card"
  | "military-id"
  | "unknown";

export type DocumentSide = "front" | "back";

export type IdentityFlagSeverity = "INFO" | "WARNING" | "CRITICAL";

export type IdentityFlag = {
  severity: IdentityFlagSeverity;
  code: string;
  message: string;
};

export type IdentityFieldMatchStatus =
  | "MATCH"
  | "MISMATCH"
  | "PARTIAL_MATCH"
  | "AMBIGUOUS"
  | "NOT_CHECKED";

export type IdentityFieldComparison = {
  status: IdentityFieldMatchStatus;
  details?: string;
  userProvided?: string;
  documentExtracted?: string;
};

export type IdentityExpirationStatus =
  | "VALID"
  | "EXPIRED"
  | "EXPIRES_SOON"
  | "NOT_APPLICABLE"
  | "UNKNOWN";

export type IdentityPhotoIntegrity =
  | "CLEAR"
  | "BLURRED"
  | "ABSENT"
  | "ANOMALY"
  | "GLARE";

export type IdentityNextAction =
  | "CONTINUE"
  | "HALT_VERIFICATION"
  | "REQUEST_BACK_IMAGE"
  | "REQUEST_FRONT_IMAGE"
  | "RETAKE_PHOTO";

export type DocumentAddress = {
  line1: string;
  city: string;
  state: string;
  zip: string;
};

export type IdentityVerificationAnalysis = {
  userSelectedType: GovernmentIdType;
  userSelectedTypeLabel: string;
  detectedDocumentType: GovernmentIdType;
  detectedDocumentTypeLabel: string;
  documentTypeMatch: boolean;
  documentDetected: boolean;
  detectedSide: DocumentSide;
  extractedFields: Record<string, string | null>;
  validationResults: {
    nameMatch: IdentityFieldComparison;
    dobMatch: IdentityFieldComparison;
    addressMatch: IdentityFieldComparison;
    expirationStatus: IdentityExpirationStatus;
    photoIntegrity: IdentityPhotoIntegrity;
  };
  flags: IdentityFlag[];
  complianceEligibility: boolean;
  nextAction: IdentityNextAction;
  humanReviewRequired: boolean;
  reviewReason?: string;
};

export type IdentityVerificationAnalyzeRequest = {
  requestId: string;
  imageBase64: string;
  selectedDocumentType: GovernmentIdType;
  documentSide: DocumentSide;
  documentDetectedInFrame?: boolean;
  profile: ConfirmedW2Profile;
};

export type IdentityVerificationAnalyzeResponse = {
  requestId: string;
  source: "python" | "mock" | "n8n-gemini-vision" | "local-fallback";
  googleDriveFolderId?: string;
  googleDriveFileId?: string;
  userMessage: string;
  analysis: IdentityVerificationAnalysis;
};
