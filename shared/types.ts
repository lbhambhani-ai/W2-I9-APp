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
  | "foreign-passport-i94"
  | "employment-authorization-card"
  | "military-id"
  | "school-id"
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
  source: "python" | "mock" | "n8n-gemini-vision" | "n8n-i9-gemini" | "local-fallback" | "python-ocr-fallback";
  googleDriveFolderId?: string;
  googleDriveFileId?: string;
  googleDriveFileUrl?: string;
  s3FileKey?: string;
  s3FileUrl?: string;
  userMessage: string;
  analysis: IdentityVerificationAnalysis;
};

export type AuditResultStatus = "pass" | "fail";

export type AuditUserSnapshot = {
  accountId?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  legalFirstName?: string;
  legalMiddleName?: string;
  legalLastName?: string;
  dateOfBirth?: string;
  email?: string;
  phone?: string;
};

export type AuditAttemptEvent = {
  recordKind: "attempt";
  sessionId: string;
  timestamp: string;
  flow: "identity" | "i9";
  attemptNumber: number;
  side: DocumentSide;
  selectedDocumentType: GovernmentIdType;
  resultStatus: AuditResultStatus;
  userMessage: string;
  profile?: AuditUserSnapshot;
  googleDriveFileId?: string;
  googleDriveFileUrl?: string;
  s3FileKey?: string;
  s3FileUrl?: string;
  fileName?: string;
  selectedList?: string;
  selectedDocumentId?: string;
  selectedDocumentLabel?: string;
  immigrationStatus?: string | null;
  documentPath?: string | null;
  flags?: IdentityFlag[];
};

export type AuditSummaryEvent = {
  recordKind: "summary";
  sessionId: string;
  timestamp: string;
  profile: AuditUserSnapshot;
  identity: {
    finalStatus: AuditResultStatus | "not_started";
    attemptCount: number;
    /** "<file name> — <AWS S3 location>" per captured document */
    fileLinks: string[];
  };
  i9: {
    finalStatus: AuditResultStatus | "not_started";
    attemptCount: number;
    /** "<file name> — <AWS S3 location>" per captured document */
    fileLinks: string[];
    citizenshipStatus: string | null;
    documentPath: string | null;
    selectedDocuments: string[];
  };
  feedback: {
    rating: number;
    comments: string;
  };
};

export type IntercomParams = {
  /** Instawork user ID from Intercom contact (from ?uid= URL param) */
  intercomUserId?: string;
  /** User email from Intercom contact (from ?email= URL param) */
  intercomEmail?: string;
  /** Intercom conversation / ticket ID (from ?cid= URL param) */
  intercomConversationId?: string;
};

export type AuditSessionStartEvent = IntercomParams & {
  recordKind: "session_start";
  sessionId: string;
  timestamp: string;
  /** Full URL the user landed on */
  landingUrl: string;
};

export type AuditFlowCompleteEvent = IntercomParams & {
  recordKind: "flow_complete";
  sessionId: string;
  timestamp: string;
  /** Rating submitted in the feedback screen */
  feedbackRating: number;
  /** Optional comments from the feedback screen */
  feedbackComments: string;
};

export type AuditAppRedirectEvent = IntercomParams & {
  recordKind: "app_redirect_click";
  sessionId: string;
  timestamp: string;
  /** Where in the flow the click happened: "pre_submit" (before feedback submitted) or "post_submit" (after) */
  context: "pre_submit" | "post_submit";
  deepLink: string;
};

export type AuditLogEvent = AuditAttemptEvent | AuditSummaryEvent | AuditSessionStartEvent | AuditFlowCompleteEvent | AuditAppRedirectEvent;
