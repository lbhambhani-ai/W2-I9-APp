import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { FaceDetector as MediaPipeFaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import type {
  AuditAttemptEvent,
  AuditLogEvent,
  AuditResultStatus,
  AuditSummaryEvent,
  ConfirmedW2Profile,
  DocumentSide,
  GovernmentIdType,
  IdentityVerificationAnalyzeResponse,
  IdentityVerificationAnalysis,
  InitialIdentity,
  ValidationResult
} from "../../shared/types";
import { googleDriveFileUrl, summarizeAuditAttempts } from "../../shared/audit";
import {
  governmentIdTypeLabel,
  normalizeSsn,
  validateW2Profile,
  validateWorkBrightSubmission
} from "../../shared/validation";
import { duplicateSsns } from "../../shared/fixtures";

type DetectedFace = {
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

type FaceDetectorLike = {
  detect: (source: HTMLVideoElement) => Promise<DetectedFace[]>;
  close?: () => void;
};

type FaceDetectorConstructor = new () => FaceDetectorLike;

const MEDIAPIPE_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm";
const MEDIAPIPE_FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite";
const FACE_DETECTION_INTERVAL_MS = 100;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ADDRESS_SUGGESTIONS = [
  {
    address: "895 Main St, San Francisco, CA 94105, USA",
    city: "San Francisco"
  },
  {
    address: "895 Market St, San Francisco, CA 94103, USA",
    city: "San Francisco"
  },
  {
    address: "895 Main St, Redwood City, CA 94063, USA",
    city: "Redwood City"
  },
  {
    address: "123 Market St, San Francisco, CA 94105, USA",
    city: "San Francisco"
  },
  {
    address: "1 Ferry Building, San Francisco, CA 94111, USA",
    city: "San Francisco"
  }
];
type AddressSuggestion = (typeof ADDRESS_SUGGESTIONS)[number];

const onboardingScreens = [
  "Profile Photo",
  "Camera / Selfie",
  "Date of Birth",
  "W-2 Onboarding Prompt",
  "W-2 Intro",
  "Identity Verification",
  "Government ID",
  "Verify Profile Details"
];

const US_GOVERNMENT_ID_TYPES = [
  { value: "drivers-license", label: "US Driver’s License" },
  { value: "state-id", label: "US State ID Card" },
  { value: "passport", label: "US Passport" },
  { value: "passport-card", label: "US Passport Card" },
  { value: "permanent-resident-card", label: "US Permanent Resident Card" },
  { value: "employment-authorization-card", label: "US Employment Authorization Card" },
  { value: "military-id", label: "US Military ID" }
];

type CitizenshipStatus =
  | "us_citizen"
  | "noncitizen_national"
  | "lawful_permanent_resident"
  | "noncitizen_authorized";

type DocumentPath = "list_a" | "list_bc";

type AuthorizedNumberType = "a_number" | "i94" | "foreign_passport";

type DocumentEntry = {
  id: string;
  label: string;
  availableFor: CitizenshipStatus[] | "all";
};

type DocImageState = {
  imageBase64: string;
  fileName: string;
  analysis: IdentityVerificationAnalysis | null;
  status: "idle" | "analyzing" | "error" | "success";
  message: string;
  googleDriveFileId?: string;
  googleDriveFileUrl?: string;
};

type I9State = {
  citizenshipStatus: CitizenshipStatus | null;
  uscisNumber: string;
  i94Number: string;
  foreignPassportNumber: string;
  authorizedNumberType: AuthorizedNumberType | null;
  workAuthExpiration: string;
  documentPath: DocumentPath | null;
  selectedListA: string | null;
  selectedListB: string | null;
  selectedListC: string | null;
  documentData: Record<string, {
    title: string;
    issuingAuthority: string;
    documentNumber: string;
    expirationDate: string;
  }>;
  docImages: Record<string, DocImageState>;
};

const CITIZENSHIP_OPTIONS: { value: CitizenshipStatus; label: string; description: string }[] = [
  { value: "us_citizen", label: "A citizen of the United States", description: "" },
  { value: "noncitizen_national", label: "A noncitizen national of the United States", description: "" },
  { value: "lawful_permanent_resident", label: "A lawful permanent resident", description: "Alien Registration Number / USCIS Number" },
  { value: "noncitizen_authorized", label: "A noncitizen authorized to work", description: "Until expiration date" }
];

const LIST_A_DOCUMENTS: DocumentEntry[] = [
  { id: "us_passport", label: "U.S. Passport", availableFor: ["us_citizen", "noncitizen_national"] },
  { id: "us_passport_card", label: "U.S. Passport Card", availableFor: ["us_citizen", "noncitizen_national"] },
  { id: "permanent_resident_card", label: "Permanent Resident Card (Green Card)", availableFor: ["lawful_permanent_resident"] },
  { id: "employment_auth_doc", label: "Employment Authorization Document (EAD)", availableFor: ["noncitizen_authorized"] },
  { id: "foreign_passport_i551", label: "Foreign Passport with I-551 Stamp", availableFor: ["lawful_permanent_resident"] },
  { id: "foreign_passport_i94", label: "Foreign Passport with I-94", availableFor: ["noncitizen_authorized"] }
];

const LIST_B_DOCUMENTS: DocumentEntry[] = [
  { id: "drivers_license", label: "Driver's License", availableFor: "all" },
  { id: "state_id_card", label: "State ID Card", availableFor: "all" },
  { id: "school_id", label: "School ID with Photograph", availableFor: "all" },
  { id: "voter_registration", label: "Voter Registration Card", availableFor: "all" },
  { id: "military_card", label: "U.S. Military Card", availableFor: "all" },
  { id: "military_dependent", label: "Military Dependent's ID Card", availableFor: "all" }
];

const LIST_C_DOCUMENTS: DocumentEntry[] = [
  { id: "social_security_card", label: "Social Security Card (unrestricted)", availableFor: ["us_citizen", "noncitizen_national", "lawful_permanent_resident"] },
  { id: "birth_certificate", label: "Birth Certificate", availableFor: ["us_citizen", "noncitizen_national"] },
  { id: "us_citizen_id", label: "U.S. Citizen ID Card (Form I-197)", availableFor: ["us_citizen"] },
  { id: "tribal_document", label: "Native American Tribal Document", availableFor: ["us_citizen", "noncitizen_national"] },
  { id: "employment_auth_doc_c", label: "Employment Authorization Document (List C)", availableFor: ["noncitizen_authorized"] }
];

function isDocAvailable(doc: DocumentEntry, status: CitizenshipStatus | null): boolean {
  if (!status) return false;
  if (doc.availableFor === "all") return true;
  return doc.availableFor.includes(status);
}

function sortDocsByAvailability(docs: DocumentEntry[], status: CitizenshipStatus | null): DocumentEntry[] {
  return [...docs].sort((a, b) => {
    const aAvail = isDocAvailable(a, status);
    const bAvail = isDocAvailable(b, status);
    if (aAvail === bAvail) return 0;
    return aAvail ? -1 : 1;
  });
}

const DOC_ID_TO_GOV_TYPE: Record<string, GovernmentIdType> = {
  us_passport: "passport",
  us_passport_card: "passport-card",
  permanent_resident_card: "permanent-resident-card",
  employment_auth_doc: "employment-authorization-card",
  foreign_passport_i551: "passport",
  foreign_passport_i94: "passport",
  receipt_list_a: "unknown",
  drivers_license: "drivers-license",
  state_id_card: "state-id",
  school_id: "unknown",
  voter_registration: "unknown",
  military_card: "military-id",
  military_dependent: "military-id",
  social_security_card: "unknown",
  birth_certificate: "unknown",
  us_citizen_id: "unknown",
  tribal_document: "unknown",
  employment_auth_doc_c: "employment-authorization-card"
};

const EMPTY_DOC_IMAGE: DocImageState = {
  imageBase64: "",
  fileName: "",
  analysis: null,
  status: "idle",
  message: ""
};

const DEFAULT_I9_STATE: I9State = {
  citizenshipStatus: null,
  uscisNumber: "",
  i94Number: "",
  foreignPassportNumber: "",
  authorizedNumberType: null,
  workAuthExpiration: "",
  documentPath: null,
  selectedListA: null,
  selectedListB: null,
  selectedListC: null,
  documentData: {},
  docImages: {}
};

const defaultIdentity: InitialIdentity = {
  accountId: "pro_user_input",
  firstName: "",
  middleName: "",
  lastName: "",
  dateOfBirth: "",
  email: "",
  phone: ""
};

const defaultProfile: ConfirmedW2Profile = {
  legalFirstName: "",
  legalMiddleName: "",
  legalLastName: "",
  suffix: "",
  dateOfBirth: "",
  ssn: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  zip: "",
  email: "",
  phone: ""
};

function createSessionId() {
  return globalThis.crypto?.randomUUID?.() ?? `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function postAuditEvent(event: AuditLogEvent) {
  void fetch("/api/audit-log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event)
  }).catch((error) => {
    console.warn("Audit log failed", error);
  });
}

function auditProfileSnapshot(identity: InitialIdentity, profile: ConfirmedW2Profile) {
  return {
    accountId: identity.accountId,
    firstName: identity.firstName,
    middleName: identity.middleName,
    lastName: identity.lastName,
    legalFirstName: profile.legalFirstName || identity.firstName,
    legalMiddleName: profile.legalMiddleName || identity.middleName,
    legalLastName: profile.legalLastName || identity.lastName,
    dateOfBirth: profile.dateOfBirth || identity.dateOfBirth,
    email: profile.email || identity.email,
    phone: profile.phone || identity.phone
  };
}

function selectedI9DocumentLabels(i9: I9State) {
  const labels: string[] = [];
  if (i9.documentPath === "list_a" && i9.selectedListA) {
    const doc = LIST_A_DOCUMENTS.find((entry) => entry.id === i9.selectedListA);
    if (doc) labels.push(`List A: ${doc.label}`);
    return labels;
  }
  if (i9.selectedListB) {
    const doc = LIST_B_DOCUMENTS.find((entry) => entry.id === i9.selectedListB);
    if (doc) labels.push(`List B: ${doc.label}`);
  }
  if (i9.selectedListC) {
    const doc = LIST_C_DOCUMENTS.find((entry) => entry.id === i9.selectedListC);
    if (doc) labels.push(`List C: ${doc.label}`);
  }
  return labels;
}

export function App() {
  const [step, setStep] = useState(0);
  const [identity, setIdentity] = useState<InitialIdentity>(defaultIdentity);
  const [profile, setProfile] = useState<ConfirmedW2Profile>(defaultProfile);
  const [selfieImage, setSelfieImage] = useState<string | null>(null);
  const [w2Validation, setW2Validation] = useState<ValidationResult | null>(null);
  const [workBrightStep, setWorkBrightStep] = useState(0);
  const [finalStatus, setFinalStatus] = useState("");
  const [sessionId] = useState(createSessionId);
  const [auditAttempts, setAuditAttempts] = useState<AuditAttemptEvent[]>([]);
  const auditAttemptCountsRef = useRef<Record<AuditAttemptEvent["flow"], number>>({ identity: 0, i9: 0 });

  const initialName = `${identity.firstName || "Your first name"} ${identity.lastName || "Your last name"}`;

  function updateIdentity(field: keyof InitialIdentity, value: string) {
    setIdentity((current) => ({ ...current, [field]: value }));
    if (field === "firstName") setProfile((current) => ({ ...current, legalFirstName: value }));
    if (field === "lastName") setProfile((current) => ({ ...current, legalLastName: value }));
    if (field === "dateOfBirth") setProfile((current) => ({ ...current, dateOfBirth: value }));
    if (field === "email") setProfile((current) => ({ ...current, email: value }));
    if (field === "phone") setProfile((current) => ({ ...current, phone: value }));
  }

  function updateProfile(field: keyof ConfirmedW2Profile, value: string) {
    setProfile((current) => ({ ...current, [field]: value }));
    setW2Validation(null);
  }

  function validateProfile() {
    const profileOcr = {
      documentDetected: true,
      documentType: "drivers_license" as const,
      selectedDocumentType: "drivers_license" as const,
      isSelectedDocumentType: true,
      isOriginalPhysicalDocument: true,
      imageQuality: "clear" as const,
      imageQualityIssue: null,
      orientation: "horizontal" as const,
      firstName: profile.legalFirstName,
      middleName: profile.legalMiddleName ?? "",
      lastName: profile.legalLastName,
      suffix: profile.suffix ?? "",
      dateOfBirth: profile.dateOfBirth,
      ssnLast4: null,
      fullSsnVisible: false,
      confidence: 1,
      warnings: [],
      blockingErrors: []
    };
    const result = validateW2Profile({ ocr: profileOcr, profile, duplicateSsns });
    setW2Validation(result);
    return result;
  }

  function submitWorkBright() {
    if (!w2Validation) return;
    const result = validateWorkBrightSubmission({
      w2Validation,
      signature: `${profile.legalFirstName} ${profile.legalLastName}`,
      documentValidation: { status: "pass", blockingErrors: [], warnings: [], canProceedToWorkBright: true, nextAction: "continue" }
    });
    setFinalStatus(result.status === "pass" ? "Pending admin review" : result.blockingErrors[0]?.message || "Blocked");
  }

  function recordAuditAttempt(input: Omit<AuditAttemptEvent, "recordKind" | "sessionId" | "timestamp" | "attemptNumber" | "profile">) {
    auditAttemptCountsRef.current[input.flow] += 1;
    const event: AuditAttemptEvent = {
      recordKind: "attempt",
      sessionId,
      timestamp: new Date().toISOString(),
      attemptNumber: auditAttemptCountsRef.current[input.flow],
      profile: auditProfileSnapshot(identity, profile),
      ...input
    };
    setAuditAttempts((current) => [...current, event]);
    postAuditEvent(event);
  }

  function submitFeedbackSummary(i9: I9State, rating: number, comments: string) {
    const identitySummary = summarizeAuditAttempts(auditAttempts, "identity");
    const i9Summary = summarizeAuditAttempts(auditAttempts, "i9");
    const event: AuditSummaryEvent = {
      recordKind: "summary",
      sessionId,
      timestamp: new Date().toISOString(),
      profile: auditProfileSnapshot(identity, profile),
      identity: identitySummary,
      i9: {
        ...i9Summary,
        citizenshipStatus: i9.citizenshipStatus,
        documentPath: i9.documentPath,
        selectedDocuments: selectedI9DocumentLabels(i9)
      },
      feedback: { rating, comments }
    };
    postAuditEvent(event);
  }

  if (step >= onboardingScreens.length + 1) {
    return (
      <OnboardingShell>
        <WorkBright
          profile={profile}
          currentStep={workBrightStep}
          finalStatus={finalStatus}
          onNext={() => setWorkBrightStep((current) => current + 1)}
          onBack={() => setWorkBrightStep((current) => Math.max(current - 1, 0))}
          onSubmit={submitWorkBright}
          onAuditAttempt={recordAuditAttempt}
          onFeedbackSubmit={submitFeedbackSummary}
        />
      </OnboardingShell>
    );
  }

  if (step === onboardingScreens.length - 1) {
    return (
      <OnboardingShell>
        <W2ProfileScreen
          initialName={initialName}
          profile={profile}
          validation={w2Validation}
          onChange={updateProfile}
          onValidate={validateProfile}
          onContinue={() => setStep(onboardingScreens.length)}
          onBack={() => setStep(0)}
        />
      </OnboardingShell>
    );
  }

  if (step === onboardingScreens.length) {
    return (
      <OnboardingShell>
        <I9SimulationIntroScreen onNext={() => setStep(onboardingScreens.length + 1)} />
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell camera={step === 1}>
      <InstaworkOnboardingScreen
        step={step}
        identity={identity}
        profile={profile}
        selfieImage={selfieImage}
        onIdentityChange={updateIdentity}
        onProfileChange={updateProfile}
        onSelfieCapture={setSelfieImage}
        onNext={() => setStep((current) => Math.min(current + 1, onboardingScreens.length - 1))}
        onBack={() => setStep((current) => Math.max(current - 1, 0))}
        onEditIdentityProfile={() => setStep(2)}
        onAuditAttempt={recordAuditAttempt}
        onJumpToW2={() => setStep(onboardingScreens.length - 1)}
      />
    </OnboardingShell>
  );
}

function Shell({ phase, children }: { phase: string; children: React.ReactNode }) {
  return (
    <main className="page">
      <div className="phone">
        <header className="topbar">
          <strong>Instawork</strong>
          <span>{phase}</span>
        </header>
        {children}
        <nav className="bottom-nav" aria-label="Instawork tabs">
          <span>Shifts</span>
          <span>Jobs</span>
          <span>My work</span>
          <span>Messages</span>
          <strong>Profile</strong>
        </nav>
      </div>
    </main>
  );
}

function OnboardingShell({ camera = false, children }: { camera?: boolean; children: React.ReactNode }) {
  return (
    <main className="page instawork-page">
      <div className={`app-phone ${camera ? "camera-mode" : ""}`}>
        {children}
      </div>
    </main>
  );
}

function InstaworkOnboardingScreen({
  step,
  identity,
  profile,
  selfieImage,
  onIdentityChange,
  onProfileChange,
  onSelfieCapture,
  onNext,
  onBack,
  onEditIdentityProfile,
  onAuditAttempt,
  onJumpToW2
}: {
  step: number;
  identity: InitialIdentity;
  profile: ConfirmedW2Profile;
  selfieImage: string | null;
  onIdentityChange: (field: keyof InitialIdentity, value: string) => void;
  onProfileChange: (field: keyof ConfirmedW2Profile, value: string) => void;
  onSelfieCapture: (imageDataUrl: string) => void;
  onNext: () => void;
  onBack: () => void;
  onEditIdentityProfile: () => void;
  onAuditAttempt: (event: Omit<AuditAttemptEvent, "recordKind" | "sessionId" | "timestamp" | "attemptNumber" | "profile">) => void;
  onJumpToW2: () => void;
}) {
  if (step === 0) {
    return <ProfilePhotoScreen firstName={identity.firstName} onNext={onNext} />;
  }
  if (step === 1) {
    return <SelfieCameraScreen onNext={onNext} onBack={onBack} onCapture={onSelfieCapture} />;
  }
  if (step === 2) {
    return (
      <DobScreen
        firstName={identity.firstName}
        lastName={identity.lastName}
        dateOfBirth={identity.dateOfBirth || ""}
        email={identity.email || ""}
        phone={identity.phone || ""}
        onFirstNameChange={(value) => onIdentityChange("firstName", value)}
        onLastNameChange={(value) => onIdentityChange("lastName", value)}
        onEmailChange={(value) => {
          onIdentityChange("email", value);
          onProfileChange("email", value);
        }}
        onPhoneChange={(value) => {
          onIdentityChange("phone", value);
          onProfileChange("phone", value);
        }}
        onChange={(value) => {
          onIdentityChange("dateOfBirth", value);
          onProfileChange("dateOfBirth", value);
        }}
        onNext={onNext}
        onBack={onBack}
        selfieImage={selfieImage}
      />
    );
  }
  if (step === 3) {
    return <W2OnboardingPromptScreen onNext={onNext} />;
  }
  if (step === 4) {
    return <W2DocumentationIntroScreen onNext={onNext} onBack={onBack} />;
  }
  if (step === 5) {
    return <IdentityVerificationConsentScreen onNext={onNext} onBack={onBack} />;
  }
  if (step === 6) {
    return <GovernmentIdUploadVerificationScreen profile={profile} onNext={onNext} onBack={onBack} onEditProfile={onEditIdentityProfile} onAuditAttempt={onAuditAttempt} />;
  }
  return (
    <section className="native-screen dob-screen">
      <BackButton onClick={onBack} />
      <h1>{onboardingScreens[step]}</h1>
      <p className="native-copy">
        This step continues the Instawork onboarding path before W-2 setup opens. Match this screen when you send the next reference image.
      </p>
      <div className="native-footer">
        <button className="blue-cta" onClick={step === 7 ? onJumpToW2 : onNext}>
          {step === 7 ? "Continue to W-2" : "Next"}
        </button>
      </div>
    </section>
  );
}

function IdentityVerificationConsentScreen({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [consent, setConsent] = useState<"yes" | "no" | "">("");

  return (
    <section className="identity-consent-screen">
      <header className="identity-consent-header">
        <button className="identity-close" onClick={onBack} aria-label="Back">×</button>
        <strong>Identity verification</strong>
      </header>
      <div className="identity-consent-content">
        <h1>Verify your identity to start your W-2 process</h1>
        <p className="identity-intro">
          To verify your identity, submit a clear photo of a government ID and a selfie. The process will only take a few
          minutes.
        </p>
        <h2>Biometric Information Notice and Consent</h2>
        <p>
          This Notice and Consent for the Collection of Biometric Information describes how Instawork and its vendor,
          Persona Identities Inc., collect, use, retain, and disclose your biometric information in connection with
          identity verification.
        </p>
        <p>
          <strong>1. What We Collect.</strong> When you create an account, our Services may require you to upload one or
          more images of your government-issued identification documents as well as selfie photographs using your mobile
          or other device.
        </p>
        <p>
          <strong>2. Disclosure, Use, and Retention of Biometric Information.</strong> Instawork and its vendor may
          collect, use, disclose, and otherwise process your biometric information only for identity verification,
          fraud prevention, and platform safety purposes.
        </p>
        <p>
          <strong>3. Refusal to Provide Biometric Information.</strong> You may refuse to consent to biometric
          collection. If you refuse, you may not be able to use or continue to use services that require identity
          verification.
        </p>
        <p>
          <strong>4. Revocation of Consent.</strong> You may revoke your consent at any time by contacting Instawork at
          privacy@instawork.com.
        </p>
        <p>
          <strong>5. Validity of Electronic Acceptance.</strong> Your electronic acceptance has the same force and effect
          as a written ink signature.
        </p>
        <p>
          <strong>6. Consent.</strong> By selecting Yes below and clicking Begin verifying, you acknowledge and agree
          that you have read this notice and consent to the collection, use, retention, and disclosure of biometric
          information as described above.
        </p>
        <fieldset className="consent-options">
          <legend>Do you give consent?</legend>
          <label>
            <input
              type="radio"
              name="identity-consent"
              value="yes"
              checked={consent === "yes"}
              onChange={() => setConsent("yes")}
            />
            Yes
          </label>
          <label>
            <input
              type="radio"
              name="identity-consent"
              value="no"
              checked={consent === "no"}
              onChange={() => setConsent("no")}
            />
            No
          </label>
        </fieldset>
        <button className="blue-cta" onClick={onNext} disabled={consent !== "yes"}>Begin verifying</button>
      </div>
      <footer className="persona-footer">
        <span>◎ English⌄</span>
        <strong>SECURED WITH<br />persona</strong>
      </footer>
    </section>
  );
}

const FIELD_LABELS: Record<string, string> = {
  full_name_raw: "Full name (raw)",
  first_name: "First name",
  middle_name: "Middle name",
  last_name: "Last name",
  name_suffix: "Suffix",
  date_of_birth: "Date of birth",
  document_type: "Document type",
  address: "Address on document",
  license_number: "License number",
  class: "Class",
  sex: "Sex",
  height: "Height",
  eye_color: "Eye color",
  donor: "Donor",
  issue_date: "Issue date",
  expiration_date: "Expiration date",
  passport_type: "Passport type",
  country_code: "Country code",
  passport_number: "Passport number",
  nationality: "Nationality",
  place_of_birth: "Place of birth",
  date_of_issue: "Date of issue",
  date_of_expiration: "Expiration date",
  authority: "Issuing authority",
  signature: "Signature",
  mrz_line_1: "MRZ line 1",
  mrz_line_2: "MRZ line 2",
  mrz_line_3: "MRZ line 3",
  card_number: "Card number",
  rfid_indicator: "RFID indicator",
  a_number: "A-Number",
  category: "Category",
  resident_since: "Resident since",
  card_expires: "Card expires",
  valid_from: "Valid from",
  fingerprint: "Fingerprint",
  edipi: "DoD ID (EDIPI)",
  rank: "Rank",
  branch_of_service: "Branch of service",
  geneva_convention_category: "Geneva Convention category",
  blood_type: "Blood type",
  pay_grade: "Pay grade",
  chip_present: "Chip present",
  pdf417_data: "PDF417 barcode",
  magnetic_stripe_data: "Magnetic stripe",
  duplicate_indicator: "Duplicate indicator",
  observations: "Observations",
  address_sticker: "Address sticker",
  security_features: "Security features",
  usually_blank: "Back blank",
  barcodes: "Barcodes",
  magnetic_stripe: "Magnetic stripe",
  official_use_text: "Back-of-card notice"
};

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/_/g, " ");
}

function comparisonClass(status: string): string {
  switch (status) {
    case "MATCH":
      return "ok";
    case "PARTIAL_MATCH":
      return "warn";
    case "NOT_CHECKED":
      return "info";
    default:
      return "fail";
  }
}

function expirationClass(status: string): string {
  switch (status) {
    case "VALID":
      return "ok";
    case "EXPIRES_SOON":
      return "warn";
    case "EXPIRED":
      return "fail";
    default:
      return "info";
  }
}

function photoClass(status: string): string {
  switch (status) {
    case "CLEAR":
      return "ok";
    case "GLARE":
    case "ANOMALY":
      return "warn";
    default:
      return "fail";
  }
}

class AnalysisPanelBoundary extends Component<{ children: ReactNode }, { hasError: boolean; errorMsg: string }> {
  state = { hasError: false, errorMsg: "" };
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, errorMsg: error.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[AnalysisPanelBoundary]", error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <section className="identity-analysis-panel" aria-label="Identity verification analysis">
          <header className="analysis-header">
            <h2>Document analysis</h2>
            <span className="analysis-status fail">Rendering error</span>
          </header>
          <p style={{ padding: "1rem", color: "#b91c1c" }}>
            Could not display the analysis panel. The verification was processed but the result could not be rendered.
            Please try capturing the document again.
          </p>
          <details style={{ padding: "0 1rem 1rem" }}>
            <summary>Technical details</summary>
            <code>{this.state.errorMsg}</code>
          </details>
        </section>
      );
    }
    return this.props.children;
  }
}

function IdentityAnalysisPanel({ analysis }: { analysis: IdentityVerificationAnalysis }) {
  const fieldEntries = Object.entries(analysis.extractedFields ?? {}).filter(([, value]) => value);
  const vr = analysis.validationResults ?? {} as IdentityVerificationAnalysis["validationResults"];
  const nameMatch = vr.nameMatch ?? { status: "NOT_CHECKED" as const };
  const dobMatch = vr.dobMatch ?? { status: "NOT_CHECKED" as const };
  const addressMatch = vr.addressMatch ?? { status: "NOT_CHECKED" as const };
  const expirationStatus = String(vr.expirationStatus ?? "UNKNOWN");
  const photoIntegrity = String(vr.photoIntegrity ?? "UNKNOWN");

  return (
    <section
      className="identity-analysis-panel"
      aria-label="Identity verification analysis"
    >
      <header className="analysis-header">
        <h2>Document analysis</h2>
        <span
          className={`analysis-status ${
            analysis.complianceEligibility ? "ok" : "fail"
          }`}
        >
          {analysis.complianceEligibility
            ? "Eligible to continue"
            : "Verification halted"}
        </span>
      </header>
      <dl className="analysis-meta">
        <div>
          <dt>You selected</dt>
          <dd>{analysis.userSelectedTypeLabel}</dd>
        </div>
        <div>
          <dt>Detected document</dt>
          <dd>
            {analysis.detectedDocumentTypeLabel}
            {analysis.documentTypeMatch ? "" : " (does not match selection)"}
          </dd>
        </div>
        <div>
          <dt>Detected side</dt>
          <dd>{analysis.detectedSide === "front" ? "Front" : "Back"}</dd>
        </div>
        <div>
          <dt>Next action</dt>
          <dd>{(analysis.nextAction ?? "UNKNOWN").replace(/_/g, " ").toLowerCase()}</dd>
        </div>
      </dl>

      {fieldEntries.length > 0 && (
        <div className="analysis-fields">
          <h3>Extracted fields</h3>
          <ul>
            {fieldEntries.map(([key, value]) => (
              <li key={key}>
                <span>{fieldLabel(key)}</span>
                <strong>{value}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="analysis-checks">
        <h3>Cross-field validation</h3>
        <ul>
          <li className={comparisonClass(nameMatch.status)}>
            <span>Name</span>
            <strong>{String(nameMatch.status ?? "NOT_CHECKED").replace(/_/g, " ")}</strong>
            {nameMatch.details && <em>{nameMatch.details}</em>}
          </li>
          <li className={comparisonClass(dobMatch.status)}>
            <span>Date of birth</span>
            <strong>{String(dobMatch.status ?? "NOT_CHECKED").replace(/_/g, " ")}</strong>
            {dobMatch.details && <em>{dobMatch.details}</em>}
          </li>
          <li className={comparisonClass(addressMatch.status)}>
            <span>Address</span>
            <strong>{String(addressMatch.status ?? "NOT_CHECKED").replace(/_/g, " ")}</strong>
            {addressMatch.details && <em>{addressMatch.details}</em>}
          </li>
          <li className={expirationClass(expirationStatus)}>
            <span>Expiration</span>
            <strong>{expirationStatus.replace(/_/g, " ")}</strong>
          </li>
          <li className={photoClass(photoIntegrity)}>
            <span>Photo integrity</span>
            <strong>{photoIntegrity}</strong>
          </li>
        </ul>
      </div>

      {(analysis.flags ?? []).length > 0 && (
        <div className="analysis-flags">
          <h3>Flags</h3>
          <ul>
            {(analysis.flags ?? []).map((flag) => (
              <li key={flag.code} className={(flag.severity ?? "INFO").toLowerCase()}>
                <span className="severity">{flag.severity ?? "INFO"}</span>
                <strong>{flag.code ?? "UNKNOWN"}</strong>
                <em>{flag.message ?? ""}</em>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!analysis.complianceEligibility && (
        <p className="analysis-review-note" role="status">
          {(() => {
            const issues: string[] = [];
            const flags = analysis.flags ?? [];
            if (flags.some(f => f.code === "WRONG_LIST" || f.code === "WRONG_DOCUMENT" || f.code === "DOCUMENT_TYPE_MISMATCH"))
              issues.push("wrong document type uploaded");
            if (flags.some(f => f.code === "NAME_MISMATCH") || nameMatch.status === "MISMATCH")
              issues.push("name does not match your profile");
            if (flags.some(f => f.code === "DOB_MISMATCH") || dobMatch.status === "MISMATCH")
              issues.push("date of birth does not match your profile");
            if (flags.some(f => f.code === "DOCUMENT_EXPIRED") || expirationStatus === "EXPIRED")
              issues.push("document is expired");
            if (flags.some(f => f.code === "IMAGE_QUALITY_LOW" || f.code === "PHOTO_BLURRED" || f.code === "NO_DOCUMENT_DETECTED"))
              issues.push("image is unclear or no document detected");
            if (flags.some(f => f.code === "STATUS_INELIGIBLE"))
              issues.push("document not valid for your immigration status");
            if (issues.length === 0) issues.push("verification did not pass");
            return `Please fix: ${issues.join(", ")}. Upload the correct document or retake the photo.`;
          })()}
        </p>
      )}
    </section>
  );
}

type IdUploadSideState = {
  imageBase64: string;
  fileName: string;
  analysis: IdentityVerificationAnalysis | null;
  message: string;
  status: "idle" | "analyzing" | "error" | "success";
};

const emptyIdSideState: IdUploadSideState = {
  imageBase64: "",
  fileName: "",
  analysis: null,
  message: "",
  status: "idle"
};

export function GovernmentIdUploadVerificationScreen({
  profile,
  onNext,
  onBack,
  onEditProfile,
  onAuditAttempt
}: {
  profile: ConfirmedW2Profile;
  onNext: () => void;
  onBack: () => void;
  onEditProfile: () => void;
  onAuditAttempt?: (event: Omit<AuditAttemptEvent, "recordKind" | "sessionId" | "timestamp" | "attemptNumber" | "profile">) => void;
}) {
  const frontInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [documentType, setDocumentType] = useState<GovernmentIdType | "">("");
  const [documents, setDocuments] = useState<Record<DocumentSide, IdUploadSideState>>({
    front: { ...emptyIdSideState },
    back: { ...emptyIdSideState }
  });
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraSide, setCameraSide] = useState<DocumentSide>("front");
  // Extracted A-Number from front of Permanent Resident Card — passed to back-side verification
  const [extractedANumber, setExtractedANumber] = useState<string>("");

  const frontReady = isIdSideReady(documents.front);
  const canContinue = Boolean(documentType && frontReady);
  const blockingAnalysis = [documents.front.analysis].find((sideAnalysis) =>
    sideAnalysis?.flags.some((flag) => flag.code === "NAME_MISMATCH" || flag.code === "DOB_MISMATCH")
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !cameraStream) return;
    video.srcObject = cameraStream;
    const playResult = video.play();
    if (playResult) {
      playResult.catch(() => undefined);
    }
  }, [cameraStream]);

  useEffect(() => {
    return () => {
      cameraStream?.getTracks().forEach((track) => track.stop());
    };
  }, [cameraStream]);

  function resetDocuments() {
    setDocuments({
      front: { ...emptyIdSideState },
      back: { ...emptyIdSideState }
    });
    setExtractedANumber("");
  }

  async function analyzeSide(side: DocumentSide, imageBase64: string, fileName: string) {
    if (!documentType) {
      setDocuments((current) => ({
        ...current,
        [side]: {
          ...current[side],
          imageBase64,
          fileName,
          status: "error",
          message: "Choose the US government ID type before uploading."
        }
      }));
      return;
    }

    setDocuments((current) => ({
      ...current,
      [side]: {
        ...current[side],
        imageBase64,
        fileName,
        analysis: null,
        status: "analyzing",
        message: ""
      }
    }));

    try {
      const isPRC = documentType === "permanent-resident-card";
      const profilePayload = {
        ...profile,
        // For PRC back side, include A-Number extracted from front (if any) so n8n can cross-check
        ...(isPRC && side === "back" && extractedANumber ? { aNumber: extractedANumber } : {})
      };

      const response = await fetch("/api/identity-verification/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: `identity_${side}_${Date.now()}`,
          imageBase64,
          selectedDocumentType: documentType,
          documentSide: side,
          documentDetectedInFrame: true,
          profile: profilePayload
        })
      });

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errorBody?.error || "Identity analysis failed.");
      }

      const result = (await response.json()) as IdentityVerificationAnalyzeResponse;

      // Save A-Number extracted from PRC front for use in back-side verification
      if (isPRC && side === "front" && result.analysis?.extractedFields) {
        const aNum = (result.analysis.extractedFields as Record<string, string | null>).a_number;
        if (aNum) setExtractedANumber(aNum);
      }

      const resultStatus: AuditResultStatus = result.analysis.complianceEligibility ? "pass" : "fail";
      onAuditAttempt?.({
        flow: "identity",
        side,
        selectedDocumentType: documentType,
        fileName,
        resultStatus,
        userMessage: result.userMessage,
        googleDriveFileId: result.googleDriveFileId,
        googleDriveFileUrl: result.googleDriveFileUrl ?? googleDriveFileUrl(result.googleDriveFileId),
        flags: result.analysis.flags
      });
      setDocuments((current) => ({
        ...current,
        [side]: {
          imageBase64,
          fileName,
          analysis: result.analysis,
          status: result.analysis.complianceEligibility ? "success" : "error",
          message: result.userMessage,
          googleDriveFileId: result.googleDriveFileId,
          googleDriveFileUrl: result.googleDriveFileUrl ?? googleDriveFileUrl(result.googleDriveFileId)
        }
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Identity OCR failed. Try another image.";
      onAuditAttempt?.({
        flow: "identity",
        side,
        selectedDocumentType: documentType,
        fileName,
        resultStatus: "fail",
        userMessage: message
      });
      setDocuments((current) => ({
        ...current,
        [side]: {
          imageBase64,
          fileName,
          analysis: null,
          status: "error",
          message
        }
      }));
    }
  }

  async function handleFile(side: DocumentSide, file: File | undefined, inputRef?: React.RefObject<HTMLInputElement | null>) {
    if (!file) return;
    if (inputRef?.current) inputRef.current.value = "";
    const imageBase64 = await readImageFile(file);
    await analyzeSide(side, imageBase64, file.name);
  }

  async function openCamera(side: DocumentSide) {
    if (!navigator.mediaDevices?.getUserMedia) {
      setDocuments((current) => ({
        ...current,
        [side]: {
          ...current[side],
          status: "error",
          message: "Camera access is unavailable in this browser. Upload an image instead."
        }
      }));
      return;
    }

    try {
      cameraStream?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
      setCameraSide(side);
      setCameraStream(stream);
    } catch {
      setDocuments((current) => ({
        ...current,
        [side]: {
          ...current[side],
          status: "error",
          message: "Couldn’t access camera. Please allow camera access or upload an image."
        }
      }));
    }
  }

  async function captureCameraImage() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!video || !canvas || !context) return;

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    canvas.width = width;
    canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    const imageBase64 = canvas.toDataURL("image/png");
    cameraStream?.getTracks().forEach((track) => track.stop());
    setCameraStream(null);
    await analyzeSide(cameraSide, imageBase64, `${cameraSide}-camera-capture.png`);
  }

  function renderUploadSide(side: DocumentSide, title: string, inputRef: React.RefObject<HTMLInputElement | null>) {
    const state = documents[side];
    const ready = isIdSideReady(state);
    const isAnalyzing = state.status === "analyzing";
    const hasError = state.status === "error";
    const hasImage = !!state.imageBase64;
    return (
      <section className={`id-upload-card${ready ? " ready" : hasError ? " has-error" : ""}`}>
        <div className="id-upload-card-header">
          <div>
            <span>{side === "front" ? "Step 1" : "Step 2"}</span>
            <h2>{title}</h2>
          </div>
          <strong className={ready ? "id-badge-success" : hasError ? "id-badge-error" : isAnalyzing ? "id-badge-analyzing" : ""}>
            {ready ? "Verified" : isAnalyzing ? "Analyzing..." : hasError ? "Issue found" : "Required"}
          </strong>
        </div>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept="image/*"
          aria-label={`${title} image`}
          onChange={(event) => void handleFile(side, event.target.files?.[0], inputRef)}
        />
        <div className="id-upload-preview">
          {state.imageBase64 ? (
            <img src={state.imageBase64} alt={`${title} preview`} />
          ) : (
            <div className="id-card-icon" aria-hidden="true">
              <span />
              <i />
            </div>
          )}
        </div>
        {isAnalyzing && <div className="id-feedback analyzing">Analyzing image...</div>}
        <div className="id-upload-actions">
          <button disabled={isAnalyzing} onClick={() => {
            if (hasImage) setDocuments(cur => ({ ...cur, [side]: { ...emptyIdSideState } }));
            inputRef.current?.click();
          }}>
            {hasImage ? (hasError ? "Try different image" : "Replace image") : "Upload image"}
          </button>
          <button disabled={isAnalyzing} onClick={() => {
            if (hasImage) setDocuments(cur => ({ ...cur, [side]: { ...emptyIdSideState } }));
            void openCamera(side);
          }}>
            {hasImage && hasError ? "Retake photo" : "Use camera"}
          </button>
        </div>
        {state.message && state.status !== "analyzing" && (
          <div className={`id-feedback ${state.status === "success" ? "success" : state.status === "idle" ? "" : "error"}`}>
            {state.message}
          </div>
        )}
        {state.status !== "analyzing" && state.analysis && <AnalysisPanelBoundary><IdentityAnalysisPanel analysis={state.analysis} /></AnalysisPanelBoundary>}
      </section>
    );
  }

  return (
    <section className="government-id-screen">
      <header className="identity-consent-header">
        <button className="identity-close" onClick={onBack} aria-label="Back">×</button>
        <strong>Identity verification</strong>
      </header>
      <div className="government-id-content">
        <h1>Government ID</h1>
        <p>Upload a clear image of the front of your selected US government ID. We’ll read the document and compare the extracted details to your profile.</p>
        <label className="id-type-field">
          US government ID type
          <select
            value={documentType}
            onChange={(event) => {
              setDocumentType(event.target.value as GovernmentIdType | "");
              resetDocuments();
            }}
          >
            <option value="">Select ID type</option>
            {US_GOVERNMENT_ID_TYPES.map((type) => (
              <option key={type.value} value={type.value}>{type.label}</option>
            ))}
          </select>
        </label>
        <p className="id-side-guidance">Only the front image is required. If the extracted name or date of birth does not match, go back and correct the profile or upload the correct document.</p>
        {cameraStream && (
          <div className="id-camera-sheet">
            <div className="government-id-preview live">
              <video ref={videoRef} className="government-id-video" aria-label={`${cameraSide} ID camera preview`} playsInline muted />
            </div>
            <button className="id-camera-button" onClick={() => void captureCameraImage()}>Capture {cameraSide} image</button>
          </div>
        )}
        {renderUploadSide("front", "Front side image", frontInputRef)}
        {blockingAnalysis && (
          <div className="id-feedback error" role="alert">
            The document details do not match your profile. Go back to update your legal name or date of birth, then upload the front image again.
            <button className="id-inline-action" onClick={onEditProfile}>Go back to edit profile</button>
          </div>
        )}
        {!canContinue && !blockingAnalysis && documents.front.status !== "analyzing" && (
          <div className="id-feedback" role="status">Upload and verify the front image to continue.</div>
        )}
      </div>
      <div className="government-id-footer">
        <button className="blue-cta" onClick={onNext} disabled={!canContinue}>Continue</button>
      </div>
      <canvas ref={canvasRef} className="visually-hidden" aria-hidden="true" />
    </section>
  );
}

function isIdSideReady(state: IdUploadSideState) {
  return Boolean(state.analysis?.documentDetected && state.analysis.documentTypeMatch && state.analysis.complianceEligibility);
}

function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

function W2DocumentationIntroScreen({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const steps = [
    "Complete identity verification",
    "Confirm your profile information",
    "Submit required forms and complete document verification"
  ];

  return (
    <section className="w2-doc-intro-screen">
      <div className="w2-doc-intro-content">
        <BackButton onClick={onBack} />
        <div className="money-badge" aria-hidden="true">💵</div>
        <h1>Complete W-2 documentation to expand your shift access</h1>
        <p className="w2-employer">Become an employee of Advantage Workforce Services (&quot;AWS&quot;).</p>
        <ul className="w2-benefits">
          <li>More shifts from our biggest partners</li>
          <li>Automatic tax withholding on paychecks</li>
        </ul>
        <p className="w2-faq">Questions? <a href="#faq">Browse our FAQ</a></p>
        <h2>Steps for W-2</h2>
        <ol className="w2-steps">
          {steps.map((step, index) => (
            <li key={step}>
              <span>{index + 1}</span>
              {step}
            </li>
          ))}
        </ol>
      </div>
      <div className="w2-doc-intro-footer">
        <button className="blue-cta" onClick={onNext}>Get started</button>
      </div>
    </section>
  );
}

function ContractorAgreementScreen({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [hasReadAgreement, setHasReadAgreement] = useState(false);

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    const isAtBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 8;
    if (isAtBottom) {
      setHasReadAgreement(true);
    }
  }

  return (
    <section className="contractor-agreement-screen">
      <BackButton onClick={onBack} />
      <div className="contractor-agreement-copy" aria-label="Contractor agreement text" onScroll={handleScroll}>
        <h1>Contractor Services Agreement</h1>
        <p>
          This contractor services agreement (&quot;Agreement&quot;) is made and entered into by and between you
          (&quot;You&quot;) and Garuda Labs, Inc. dba Instawork (&quot;Instawork&quot;), referenced each as a
          &quot;Party&quot; or together as the &quot;Parties.&quot; This Agreement is effective the date accepted by You.
        </p>
        <p>
          By accepting this Agreement, You acknowledge that You have taken time and sought any assistance needed to
          comprehend and consider the consequences of this important business decision. You further acknowledge that You
          have read, understood, and voluntarily agreed to all of the terms in this Agreement.
        </p>
        <p className="agreement-important">
          IMPORTANT: THE MUTUAL ARBITRATION PROVISION REQUIRES THE PARTIES TO RESOLVE DISPUTES BETWEEN THEM THROUGH
          FINAL AND BINDING ARBITRATION ON AN INDIVIDUAL BASIS TO THE FULLEST EXTENT PERMITTED BY LAW.
        </p>
        <p>
          In consideration of the mutual promises in this Agreement, and for other good and valuable consideration, You
          and Instawork agree as follows:
        </p>
        <h2>1. Definitions</h2>
        <p>
          <strong>1.1. Account</strong> means a profile created through the Application and used by a Professional to
          access the Platform.
        </p>
        <p>
          <strong>1.2. Application</strong> means the mobile software application through which a Professional accesses
          the Platform.
        </p>
        <p>
          <strong>1.3. Partner</strong> means a company using the Platform to request service providers to fill one-time
          and recurring local work opportunities.
        </p>
        <p>
          <strong>1.4. Partner Request</strong> means a request for Services posted on the Platform by a Partner.
          &quot;Open Partner Request&quot; means a request that has not been accepted by a Professional. &quot;Partner
          Engagement&quot; means a request that a Professional has accepted and agreed to perform.
        </p>
        <p>
          <strong>1.5. Platform</strong> means the online and mobile platform developed and maintained by Instawork on
          which Partners connect with Professionals.
        </p>
        <p>
          <strong>1.6. Professional</strong> means a service provider operating an independent business, including You,
          who uses the Application to receive access to Partner Service Requests.
        </p>
        <p>
          <strong>1.7. Services</strong> means the work product and services provided by a Professional to a Partner
          pursuant to a Partner Engagement.
        </p>
        <h2>2. Purpose</h2>
        <p>
          <strong>2.1.</strong> This Agreement governs the entire relationship between the Parties and establishes their
          respective rights and obligations arising out of this relationship, including Your access to the Platform and
          use of the Instawork Application.
        </p>
        <p>
          <strong>2.2.</strong> The Parties intend this Agreement to create the relationship of independently contracting
          parties and not that of employer and employee, joint venture, partners, or principal and agent.
        </p>
        <p>
          <strong>2.3.</strong> Nothing in this Agreement requires You to accept any Open Partner Request, and nothing in
          this Agreement guarantees any particular volume of Partner Requests for any particular time period.
        </p>
        <p>
          <strong>2.4.</strong> This Agreement supersedes prior agreements with You. Instawork reserves the right to
          amend, modify, or supplement these terms as permitted by law.
        </p>
        <h2>3. The Instawork Platform</h2>
        <p>
          <strong>3.1.</strong> Instawork is in the business of developing technology that helps connect businesses with
          independent professionals. You are responsible for deciding whether to accept any opportunity presented through
          the Platform.
        </p>
      </div>
      <div className="agreement-accept-footer">
        <p>{hasReadAgreement ? "You can now accept the agreement" : "Scroll down to read and accept"}</p>
        <button className="blue-cta" onClick={onNext} disabled={!hasReadAgreement}>I accept</button>
      </div>
    </section>
  );
}

function W2OnboardingPromptScreen({ onNext }: { onNext: () => void }) {
  return (
    <section className="w2-start-screen" aria-label="W-2 onboarding start">
      <div className="w2-start-content no-scroll">
        <h1>W-2 onboarding</h1>
        <div className="w2-document-icon" aria-hidden="true">
          <span className="w2-clip" />
          <span className="w2-line long" />
          <span className="w2-line short" />
          <span className="w2-pencil" />
        </div>
        <p>Unlock more shifts by completing your paperwork for W-2 shifts.</p>
        <button className="w2-start-button" onClick={onNext}>Start onboarding</button>
      </div>
      <InstaworkBottomNav />
    </section>
  );
}

function InstaworkBottomNav() {
  const tabs = [
    { icon: "◷", label: "Shifts" },
    { icon: "▢", label: "Jobs" },
    { icon: "▣", label: "My work" },
    { icon: "▱", label: "Messages" },
    { icon: "◉", label: "Profile", current: true }
  ];

  return (
    <nav className="instawork-bottom-tabs" aria-label="Instawork tabs">
      {tabs.map((tab) => (
        <span key={tab.label} className={tab.current ? "active" : ""} aria-current={tab.current ? "page" : undefined}>
          <span className="tab-icon" aria-hidden="true">{tab.icon}</span>
          {tab.label}
        </span>
      ))}
    </nav>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="back-button" onClick={onClick} aria-label="Back">
      ←
    </button>
  );
}

function I9SimulationIntroScreen({ onNext }: { onNext: () => void }) {
  return (
    <section className="i9-simulation-screen">
      <div className="i9-simulation-content">
        <div className="i9-document-icon" aria-hidden="true">
          <span />
          <i />
        </div>
        <h1>I-9 form simulation</h1>
        <p>
          Next, you’ll continue into a simulated I-9 form flow using the profile details you just confirmed.
        </p>
      </div>
      <div className="i9-simulation-footer">
        <button className="blue-cta" onClick={onNext}>Continue</button>
      </div>
    </section>
  );
}

function ProfilePhotoScreen({ firstName, onNext }: { firstName: string; onNext: () => void }) {
  return (
    <section className="native-screen profile-photo-screen">
      <h1>Hey {firstName || "there"}, let’s add your profile photo</h1>
      <p className="native-copy">A profile picture will help us verify your account.</p>
      <button className="upload-circle" onClick={onNext} aria-label="Upload profile photo">
        <span className="plus">＋</span>
        <span>Upload</span>
        <span className="safe-badge">✓</span>
      </button>
      <p className="safe-copy">Your profile picture is 100% safe with us.</p>
    </section>
  );
}

function SelfieCameraScreen({
  onNext,
  onBack,
  onCapture
}: {
  onNext: () => void;
  onBack: () => void;
  onCapture: (imageDataUrl: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const ovalRef = useRef<HTMLDivElement | null>(null);
  const [cameraStatus, setCameraStatus] = useState<"idle" | "requesting" | "ready" | "denied" | "unsupported">("idle");
  const [faceAlignment, setFaceAlignment] = useState<"checking" | "aligned" | "not_aligned" | "no_face" | "unsupported">("checking");
  const [stream, setStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      const playResult = videoRef.current.play();
      if (playResult) {
        void playResult.catch(() => undefined);
      }
    }
  }, [stream]);

  useEffect(() => {
    return () => {
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current?.srcObject === stream) {
        videoRef.current.srcObject = null;
      }
    };
  }, [stream]);

  useEffect(() => {
    if (cameraStatus !== "ready") {
      return undefined;
    }

    let cancelled = false;
    let animationFrameId: number | undefined;
    let detecting = false;
    let lastDetectionAt = 0;
    let lastAlignment: typeof faceAlignment = "checking";
    let activeDetector: FaceDetectorLike | null = null;

    function updateAlignment(nextAlignment: typeof faceAlignment) {
      if (lastAlignment !== nextAlignment) {
        lastAlignment = nextAlignment;
        setFaceAlignment(nextAlignment);
      }
    }

    async function startDetection() {
      const detector = await createRealFaceDetector();
      if (!detector || cancelled) {
        detector?.close?.();
        setFaceAlignment("unsupported");
        return;
      }

      activeDetector = detector;
      setFaceAlignment("checking");
      runDetectionLoop(detector, performance.now());
    }

    function runDetectionLoop(detector: FaceDetectorLike, now: number) {
      if (cancelled) {
        return;
      }

      if (!detecting && now - lastDetectionAt >= FACE_DETECTION_INTERVAL_MS) {
        detecting = true;
        lastDetectionAt = now;
        void checkAlignment(detector).finally(() => {
          detecting = false;
        });
      }

      animationFrameId = window.requestAnimationFrame((nextTimestamp) => runDetectionLoop(detector, nextTimestamp));
    }

    async function checkAlignment(detector: FaceDetectorLike) {
      const video = videoRef.current;
      const oval = ovalRef.current;
      if (!video || !oval) {
        return;
      }
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        updateAlignment("checking");
        return;
      }

      try {
        const faces = await detector.detect(video);
        if (cancelled) {
          return;
        }
        if (!faces.length) {
          updateAlignment("no_face");
          return;
        }

        updateAlignment(isFaceInsideOval(faces[0].boundingBox, video, oval) ? "aligned" : "not_aligned");
      } catch {
        updateAlignment("no_face");
      }
    }

    void startDetection();

    return () => {
      cancelled = true;
      if (animationFrameId) {
        window.cancelAnimationFrame(animationFrameId);
      }
      activeDetector?.close?.();
    };
  }, [cameraStatus]);

  async function requestCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus("unsupported");
      return;
    }

    setCameraStatus("requesting");
    setFaceAlignment("checking");
    try {
      stream?.getTracks().forEach((track) => track.stop());
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 }
        }
      });
      setStream(nextStream);
      setCameraStatus("ready");
    } catch {
      setCameraStatus("denied");
    }
  }

  function captureSelfie() {
    if (faceAlignment !== "aligned") {
      setFaceAlignment((current) => (current === "unsupported" ? "unsupported" : "not_aligned"));
      return;
    }
    const capturedImage = captureVideoFrame(videoRef.current);
    if (capturedImage) {
      onCapture(capturedImage);
    }
    stream?.getTracks().forEach((track) => track.stop());
    onNext();
  }

  const cameraInstruction = getCameraInstruction(faceAlignment);
  const canCapture = faceAlignment === "aligned";

  if (cameraStatus === "idle" || cameraStatus === "requesting" || cameraStatus === "denied" || cameraStatus === "unsupported") {
    return (
      <section className="native-screen camera-permission-screen">
        <BackButton onClick={onBack} />
        <h1>Use your camera to take your profile selfie</h1>
        <p className="native-copy">
          Instawork needs browser camera permission so you can line up your face in the oval and take a live selfie.
        </p>
        <div className="permission-card">
          <div className="permission-icon">◎</div>
          <h2>Camera access required</h2>
          <p>When your browser asks, choose Allow. If you choose Block, update your browser site settings and try again.</p>
        </div>
        {cameraStatus === "denied" && (
          <div className="alert">Camera permission was blocked. Please allow camera access in your browser settings, then try again.</div>
        )}
        {cameraStatus === "unsupported" && (
          <div className="alert">This browser does not support live camera capture. Please open this flow in a browser with camera support.</div>
        )}
        <FooterButton onClick={requestCamera}>{cameraStatus === "requesting" ? "Waiting for permission..." : "Allow camera access"}</FooterButton>
      </section>
    );
  }

  return (
    <section className="camera-screen">
      <button className="camera-close" onClick={onBack} aria-label="Close camera">×</button>
      <span className="camera-flash">⌁</span>
      <video ref={videoRef} className="camera-video" playsInline muted autoPlay aria-label="Live selfie camera preview" />
      <p className={`camera-instruction ${canCapture ? "aligned" : ""}`}>{cameraInstruction}</p>
      <div ref={ovalRef} className={`face-oval ${canCapture ? "aligned" : ""}`} />
      <div className="neck-guide" />
      <button className="shutter" onClick={captureSelfie} aria-label="Capture selfie" disabled={!canCapture} />
      <span className="flip-camera">↻</span>
    </section>
  );
}

function captureVideoFrame(video: HTMLVideoElement | null): string | null {
  if (!video) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

async function createRealFaceDetector(): Promise<FaceDetectorLike | null> {
  const NativeFaceDetector = (globalThis as typeof globalThis & { FaceDetector?: FaceDetectorConstructor }).FaceDetector;
  if (NativeFaceDetector) {
    return new NativeFaceDetector();
  }

  try {
    const visionFiles = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
    for (const delegate of ["GPU", "CPU"] as const) {
      try {
    const detector = await MediaPipeFaceDetector.createFromOptions(visionFiles, {
      baseOptions: {
        modelAssetPath: MEDIAPIPE_FACE_MODEL_URL,
            delegate
      },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.65
    });

    return {
      async detect(source: HTMLVideoElement) {
        const result = detector.detectForVideo(source, performance.now());
        return result.detections.map((detection) => ({
          boundingBox: {
            x: detection.boundingBox?.originX ?? 0,
            y: detection.boundingBox?.originY ?? 0,
            width: detection.boundingBox?.width ?? 0,
            height: detection.boundingBox?.height ?? 0
          }
        }));
          },
          close() {
            detector.close?.();
      }
    };
      } catch {
        // Mobile browsers can fail to initialize GPU resources after reloads; CPU is slower but reliable.
      }
    }
    return null;
  } catch {
    return null;
  }
}

function getCameraInstruction(faceAlignment: "checking" | "aligned" | "not_aligned" | "no_face" | "unsupported") {
  if (faceAlignment === "aligned") {
    return "Face aligned. Hold still and capture.";
  }
  if (faceAlignment === "not_aligned") {
    return "Move your face into the oval";
  }
  if (faceAlignment === "no_face") {
    return "No face detected. Move into the oval";
  }
  if (faceAlignment === "unsupported") {
    return "Face alignment could not start. Check your connection and try again";
  }
  return "Place your face inside the oval";
}

function isFaceInsideOval(
  faceBox: { x: number; y: number; width: number; height: number },
  video: HTMLVideoElement,
  oval: HTMLDivElement
) {
  const videoRect = video.getBoundingClientRect();
  const ovalRect = oval.getBoundingClientRect();
  const sourceWidth = video.videoWidth || videoRect.width || 1;
  const sourceHeight = video.videoHeight || videoRect.height || 1;
  const scaleX = videoRect.width / sourceWidth;
  const scaleY = videoRect.height / sourceHeight;
  const faceRect = {
    left: videoRect.left + faceBox.x * scaleX,
    top: videoRect.top + faceBox.y * scaleY,
    right: videoRect.left + (faceBox.x + faceBox.width) * scaleX,
    bottom: videoRect.top + (faceBox.y + faceBox.height) * scaleY
  };
  const faceCenterX = (faceRect.left + faceRect.right) / 2;
  const faceCenterY = (faceRect.top + faceRect.bottom) / 2;
  const faceWidth = faceRect.right - faceRect.left;
  const faceHeight = faceRect.bottom - faceRect.top;

  return (
    faceCenterX >= ovalRect.left &&
    faceCenterX <= ovalRect.right &&
    faceCenterY >= ovalRect.top &&
    faceCenterY <= ovalRect.bottom &&
    faceWidth >= ovalRect.width * 0.35 &&
    faceHeight >= ovalRect.height * 0.35 &&
    faceWidth <= ovalRect.width * 1.05 &&
    faceHeight <= ovalRect.height * 1.05
  );
}

function DobScreen({
  firstName,
  lastName,
  dateOfBirth,
  email,
  phone,
  onFirstNameChange,
  onLastNameChange,
  onEmailChange,
  onPhoneChange,
  onChange,
  onNext,
  onBack,
  selfieImage
}: {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  email: string;
  phone: string;
  onFirstNameChange: (value: string) => void;
  onLastNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPhoneChange: (value: string) => void;
  onChange: (value: string) => void;
  onNext: () => void;
  onBack: () => void;
  selfieImage: string | null;
}) {
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [isYearListOpen, setIsYearListOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const calendarRef = useRef<HTMLDivElement | null>(null);
  const selectedDate = parseDateInputValue(dateOfBirth);
  const [calendarYear, setCalendarYear] = useState(selectedDate.getFullYear());
  const [calendarMonth, setCalendarMonth] = useState(selectedDate.getMonth());
  const latestAllowedDob = getLatestAdultDob();
  const hasDob = Boolean(dateOfBirth);
  const isAdult = isAtLeast18(dateOfBirth);
  const hasName = Boolean(firstName.trim() && lastName.trim());
  const hasValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const hasValidPhone = isValidUsPhone(phone);
  const selectedDay = selectedDate.getDate();

  function toggleCalendar() {
    const opening = !isCalendarOpen;
    setIsCalendarOpen(opening);
    if (!opening) setIsYearListOpen(false);
    if (opening) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          calendarRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      });
    }
  }

  function selectDay(day: number) {
    const nextDate = new Date(calendarYear, calendarMonth, day);
    const nextValue = toDateInputValue(nextDate);
    onChange(nextValue);
    setIsCalendarOpen(false);
    setIsYearListOpen(false);
  }

  return (
    <section className="native-screen dob-screen">
      <BackButton onClick={onBack} />
      <h1>Confirm your legal name and date of birth</h1>
      <p className="native-copy">Enter the same legal details shown on your government ID.</p>
      <div className="dob-body">
        <ProfileThumbnail selfieImage={selfieImage} />
        <div className="identity-name-fields">
          <label>
            Legal first name
            <input value={firstName} onChange={(event) => onFirstNameChange(event.target.value)} />
          </label>
          <label>
            Legal last name
            <input value={lastName} onChange={(event) => onLastNameChange(event.target.value)} />
          </label>
        </div>
        <p className="dob-field-label">Date of birth</p>
          <button
          ref={triggerRef}
            className="date-field custom-date-trigger"
            type="button"
            aria-expanded={isCalendarOpen}
            aria-label="Open date of birth calendar"
          onClick={toggleCalendar}
          >
          <span aria-hidden="true" style={{ fontSize: 18 }}>📅</span>
          <strong className={hasDob ? "has-value" : ""}>{hasDob ? formatDisplayDate(dateOfBirth) : "MM / DD / YYYY"}</strong>
            <span className="calendar-glyph" aria-hidden="true">▾</span>
          </button>
          {isCalendarOpen && (
          <div ref={calendarRef} className="custom-calendar" role="dialog" aria-label="Choose date of birth">
              <div className="calendar-header">
                <button aria-label="Previous month" onClick={() => {
                  const next = new Date(calendarYear, calendarMonth - 1, 1);
                  setCalendarYear(next.getFullYear());
                  setCalendarMonth(next.getMonth());
                }}>‹</button>
                <strong>{MONTHS[calendarMonth]} {calendarYear}</strong>
                <button aria-label="Next month" onClick={() => {
                  const next = new Date(calendarYear, calendarMonth + 1, 1);
                  setCalendarYear(next.getFullYear());
                  setCalendarMonth(next.getMonth());
                }}>›</button>
              </div>
              <div className="calendar-selectors">
                <select aria-label="Month" value={calendarMonth} onChange={(event) => setCalendarMonth(Number(event.target.value))}>
                  {MONTHS.map((month, index) => (
                    <option value={index} key={month}>{month}</option>
                  ))}
                </select>
              <div className="calendar-year-picker">
                <button
                  type="button"
                  aria-expanded={isYearListOpen}
                  aria-label="Choose year"
                  onClick={() => setIsYearListOpen((open) => !open)}
                >
                  {calendarYear}
                  <span aria-hidden="true">▾</span>
                </button>
                {isYearListOpen && (
                  <div className="calendar-year-list" role="listbox" aria-label="Year options">
                  {getDobYears().map((year) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={year === calendarYear}
                        className={year === calendarYear ? "selected" : ""}
                        value={year}
                        key={year}
                        onClick={() => {
                          setCalendarYear(year);
                          setIsYearListOpen(false);
                        }}
                      >
                        {year}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              </div>
              <div className="calendar-weekdays">
                {["S", "M", "T", "W", "T", "F", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}
              </div>
              <div className="calendar-days">
                {Array.from({ length: getFirstWeekday(calendarYear, calendarMonth) }, (_, index) => (
                  <span className="calendar-empty" key={`empty-${index}`} />
                ))}
                {Array.from({ length: getDaysInMonth(calendarYear, calendarMonth) }, (_, index) => {
                  const day = index + 1;
                  const value = toDateInputValue(new Date(calendarYear, calendarMonth, day));
                  const isSelected = calendarYear === selectedDate.getFullYear() && calendarMonth === selectedDate.getMonth() && day === selectedDay;
                  const isDisabled = value > latestAllowedDob;
                  return (
                    <button
                      className={isSelected ? "selected" : ""}
                      aria-label={`${getFullMonthName(calendarMonth)} ${day}, ${calendarYear}`}
                      disabled={isDisabled}
                      key={day}
                      onClick={() => selectDay(day)}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        <label className="email-field">
          Email address
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => onEmailChange(event.target.value)}
          />
        </label>
        <label className="email-field">
          Phone number
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="(323) 555-7890"
            value={phone}
            onChange={(event) => onPhoneChange(event.target.value)}
          />
        </label>
        {!hasName && <p className="field-error">Enter your legal first and last name to continue.</p>}
        {!hasDob && <p className="field-error">Select your date of birth to continue.</p>}
        {hasDob && !isAdult && <p className="field-error">You must be at least 18 years old to continue.</p>}
        {email.length > 0 && !hasValidEmail && <p className="field-error">Enter a valid email address.</p>}
        {phone.length > 0 && !hasValidPhone && <p className="field-error">Enter a valid US phone number.</p>}
      </div>
      <FooterButton onClick={onNext} disabled={!hasName || !hasDob || !isAdult || !hasValidEmail || !hasValidPhone}>Next</FooterButton>
    </section>
  );
}

function parseDateInputValue(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) {
    const today = new Date();
    return new Date(today.getFullYear() - 18, today.getMonth(), today.getDate());
  }
  return new Date(year, month - 1, day);
}

function formatDisplayDate(value: string) {
  const date = parseDateInputValue(value);
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${date.getFullYear()}`;
}

function formatLongDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value || "None";
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

function isValidUsPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
}

function maskFirstSixSsnDigits(value: string) {
  const digits = normalizeSsn(value);
  if (!digits) return "None";
  return `${"*".repeat(Math.min(6, digits.length))}${digits.slice(6)}`;
}

function getFullMonthName(monthIndex: number) {
  return new Date(2000, monthIndex, 1).toLocaleString("en-US", { month: "long" });
}

function getFirstWeekday(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getDobYears() {
  const adultYear = new Date().getFullYear() - 18;
  return Array.from({ length: 90 }, (_, index) => adultYear - index);
}

function getLatestAdultDob() {
  const today = new Date();
  const adultDate = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate());
  return toDateInputValue(adultDate);
}

function isAtLeast18(dateOfBirth: string) {
  if (!dateOfBirth) {
    return false;
  }
  return dateOfBirth <= getLatestAdultDob();
}

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function LocationScreen({
  address,
  onChange,
  onNext,
  onBack
}: {
  address: string;
  onChange: (value: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const [selectedCity, setSelectedCity] = useState(getCityFromAddress(address) || "San Francisco");
  const [remoteSuggestions, setRemoteSuggestions] = useState<AddressSuggestion[]>([]);
  const [isAddressLoading, setIsAddressLoading] = useState(false);
  const normalizedQuery = address.trim().toLowerCase();
  const localSuggestions = normalizedQuery.length >= 2 ? filterLocalAddressSuggestions(normalizedQuery) : [];
  const suggestions = mergeAddressSuggestions(remoteSuggestions, localSuggestions).slice(0, 5);

  useEffect(() => {
    if (normalizedQuery.length < 3 || address === ADDRESS_SUGGESTIONS.find((suggestion) => suggestion.address === address)?.address) {
      setRemoteSuggestions([]);
      setIsAddressLoading(false);
      return undefined;
    }

    const abortController = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      setIsAddressLoading(true);
      try {
        const nextSuggestions = await fetchAddressSuggestions(address, abortController.signal);
        setRemoteSuggestions(nextSuggestions);
      } catch {
        setRemoteSuggestions([]);
      } finally {
        setIsAddressLoading(false);
      }
    }, 250);

    return () => {
      abortController.abort();
      window.clearTimeout(timeoutId);
    };
  }, [address, normalizedQuery]);

  function selectAddress(suggestion: AddressSuggestion) {
    onChange(suggestion.address);
    setSelectedCity(suggestion.city);
    setRemoteSuggestions([]);
  }

  return (
    <section className="native-screen">
      <BackButton onClick={onBack} />
      <h1>Where do you live?</h1>
      <p className="native-copy">We’ll find work opportunities near and around you.</p>
      <div className="address-autocomplete">
        <label className="plain-field">
          Address
          <input
            aria-label="Address"
            value={address}
            autoComplete="off"
            onChange={(event) => {
              onChange(event.target.value);
              setSelectedCity(getCityFromAddress(event.target.value) || "San Francisco");
            }}
          />
        </label>
        {(suggestions.length > 0 || isAddressLoading) && (
          <div className="address-suggestions" role="listbox" aria-label="Address suggestions">
            {isAddressLoading && <div className="address-loading">Searching addresses...</div>}
            {suggestions.map((suggestion) => (
              <button
                type="button"
                role="option"
                aria-label={suggestion.address}
                aria-selected={address === suggestion.address}
                key={suggestion.address}
                onClick={() => selectAddress(suggestion)}
              >
                <strong>{suggestion.address.split(",")[0]}</strong>
                <span>{suggestion.address.split(",").slice(1).join(",").trim()}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="map-preview">
        <span className="map-pin">●</span>
        <strong>{selectedCity}</strong>
        <small> Maps&nbsp;&nbsp;Legal</small>
      </div>
      <FooterButton onClick={onNext}>Next</FooterButton>
    </section>
  );
}

function getCityFromAddress(address: string) {
  const matchedSuggestion = ADDRESS_SUGGESTIONS.find((suggestion) => suggestion.address === address);
  return matchedSuggestion?.city;
}

function filterLocalAddressSuggestions(normalizedQuery: string) {
  return ADDRESS_SUGGESTIONS.filter((suggestion) => suggestion.address.toLowerCase().includes(normalizedQuery));
}

function mergeAddressSuggestions(primary: AddressSuggestion[], fallback: AddressSuggestion[]) {
  const seen = new Set<string>();
  return [...primary, ...fallback].filter((suggestion) => {
    if (seen.has(suggestion.address)) {
      return false;
    }
    seen.add(suggestion.address);
    return true;
  });
}

async function fetchAddressSuggestions(query: string, signal: AbortSignal): Promise<AddressSuggestion[]> {
  if (!globalThis.fetch) {
    return [];
  }

  const response = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5`, { signal });
  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as {
    features?: Array<{
      properties?: {
        name?: string;
        street?: string;
        housenumber?: string;
        city?: string;
        state?: string;
        country?: string;
      };
    }>;
  };

  return (data.features || [])
    .map((feature) => formatPhotonSuggestion(feature.properties))
    .filter((suggestion): suggestion is AddressSuggestion => Boolean(suggestion));
}

function formatPhotonSuggestion(properties?: {
  name?: string;
  street?: string;
  housenumber?: string;
  city?: string;
  state?: string;
  country?: string;
}): AddressSuggestion | null {
  if (!properties?.name) {
    return null;
  }

  const street = [properties.housenumber, properties.street].filter(Boolean).join(" ");
  const parts = [properties.name, street, properties.city, properties.state, properties.country].filter(Boolean);
  return {
    address: parts.join(", "),
    city: properties.city || properties.name
  };
}

function EntryPositionsScreen({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [selectedPositions, setSelectedPositions] = useState<Set<string>>(new Set(["Concession / Stand Worker"]));
  const positions = [
    "Concession / Stand Worker",
    "Counter Staff / Cashier",
    "Custodial",
    "Driver",
    "Event Setup and Takedown",
    "General Labor",
    "Warehouse Associate - Entry Level"
  ];
  return (
    <section className="native-screen entry-positions-screen">
      <div className="positions-scroll-content">
        <BackButton onClick={onBack} />
        <h1>You will have access to these entry-level positions</h1>
        <p className="native-copy">Select the ones you are more interested in.</p>
        <ChipGroup items={positions} selectedItems={selectedPositions} onToggle={setSelectedPositions} />
      </div>
      <FooterButton onClick={onNext}>Next</FooterButton>
    </section>
  );
}

function AdvancedPositionsScreen({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [selectedPositions, setSelectedPositions] = useState<Set<string>>(new Set());
  const groups = [
    ["Event management and customer engagement", ["Brand Ambassador", "Security"]],
    ["Retail and merchandising", ["Retail Merchandiser"]],
    ["Cleaning and maintenance", ["Housekeeper", "Event Cleaner", "Janitor", "Porter", "Sanitation Worker"]],
    ["Warehouse and logistics", ["Forklift Driver", "Warehouse Associate - Intermediate"]],
    ["Beverage service", ["Barback", "Barista", "Bartender"]],
    ["Food preparation, cooking, and kitchen support", ["Dishwasher", "Food Service Worker", "Line Cook", "Prep Cook"]],
    ["Dining and customer service", ["Busser", "Event Server", "Runner"]]
  ] as const;
  return (
    <section className="native-screen scroll-screen advanced-positions-screen">
      <div className="advanced-scroll-content">
        <BackButton onClick={onBack} />
        <h1>Select the advanced positions you are interested in</h1>
        <p className="native-copy">Select the ones you are more interested in.</p>
        {groups.map(([title, items]) => (
          <div className="position-group" key={title}>
            <h2>{title}</h2>
            <ChipGroup items={[...items]} selectedItems={selectedPositions} onToggle={setSelectedPositions} />
          </div>
        ))}
      </div>
      <FooterButton onClick={onNext}>Next</FooterButton>
    </section>
  );
}

function ChipGroup({
  items,
  selectedItems,
  onToggle
}: {
  items: string[];
  selectedItems: Set<string>;
  onToggle: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  function toggleItem(item: string) {
    onToggle((current) => {
      const next = new Set(current);
      if (next.has(item)) {
        next.delete(item);
      } else {
        next.add(item);
      }
      return next;
    });
  }

  return (
    <div className="chips">
      {items.map((item) => {
        const selected = selectedItems.has(item);
        return (
          <button
            className={`chip ${selected ? "selected" : ""}`}
            aria-pressed={selected}
            key={item}
            onClick={() => toggleItem(item)}
          >
            {item}
          </button>
        );
      })}
    </div>
  );
}

function ResumeImportScreen({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const resumeInputRef = useRef<HTMLInputElement | null>(null);
  const [resumeFileName, setResumeFileName] = useState("");

  return (
    <section className="native-screen centered-screen">
      <BackButton onClick={onBack} />
      <div className="resume-illo">🤝</div>
      <h1>Create your Instawork profile to get access to shifts</h1>
      <input
        ref={resumeInputRef}
        className="visually-hidden"
        aria-label="Resume file"
        type="file"
        accept=".pdf,.doc,.docx,.txt"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            setResumeFileName(file.name);
          }
        }}
      />
      <button className="blue-cta" onClick={() => resumeInputRef.current?.click()}>Import your resume</button>
      {resumeFileName && (
        <div className="resume-file-card">
          <span>Resume selected</span>
          <strong>{resumeFileName}</strong>
        </div>
      )}
      {resumeFileName && <button className="blue-cta secondary-continue" onClick={onNext}>Continue with imported resume</button>}
      <button className="link-button" onClick={onNext}>Don’t have a resume?</button>
    </section>
  );
}

function ProfileThumbnail({ selfieImage, large = false }: { selfieImage: string | null; large?: boolean }) {
  return (
    <div className={`profile-thumbnail ${large ? "large" : ""} ${selfieImage ? "captured" : ""}`}>
      {selfieImage && <img src={selfieImage} alt="Captured profile selfie" />}
    </div>
  );
}

function ReviewProfileScreen({
  identity,
  selfieImage,
  onNext,
  onBack
}: {
  identity: InitialIdentity;
  selfieImage: string | null;
  onNext: () => void;
  onBack: () => void;
}) {
  const fullName = `${identity.firstName} ${identity.lastName}`.trim();
  const resumeInputRef = useRef<HTMLInputElement | null>(null);
  const [resumeFileName, setResumeFileName] = useState("");

  return (
    <section className="native-screen review-profile-screen">
      <div className="sticky-title">
        <BackButton onClick={onBack} />
        <strong>Review and save profile</strong>
      </div>
      <div className="review-hero">
        <h1>Review and save profile</h1>
        <p>Completing your profile will match you with work that suits you best.</p>
        <ProfileThumbnail selfieImage={selfieImage} large />
        <h2>{fullName || "Your Name"}</h2>
        <p>San Francisco</p>
      </div>
      <input
        ref={resumeInputRef}
        className="visually-hidden"
        aria-label="Review profile resume file"
        type="file"
        accept=".pdf,.doc,.docx,.txt"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            setResumeFileName(file.name);
          }
        }}
      />
      <ProfileSection
        title="Import resume"
        icon="▤"
        action="Upload resume"
        onAction={() => resumeInputRef.current?.click()}
        extraContent={
          resumeFileName ? (
            <div className="resume-file-card profile-resume-file">
              <span>Resume selected</span>
              <strong>{resumeFileName}</strong>
            </div>
          ) : null
        }
      >
        Upload your resume so we can give partners a fuller picture of your capabilities.
      </ProfileSection>
      <ProfileSection title="Professional summary" icon="✎" action="Add summary">
        Add a short summary to help businesses understand your experience.
      </ProfileSection>
      <ProfileSection title="Work experience" icon="▣" action="Add experience">
        Adding work experience increases your chances of getting selected.
      </ProfileSection>
      <ProfileSection title="Education" icon="▥" action="Add education">
        Adding education helps make your profile more complete.
      </ProfileSection>
      <ProfileSection title="Certificates" icon="▧" action="Add certificates">
        Certain certificates such as a Food Handlers Card or Forklift Certification are required to work shifts depending on your position.
      </ProfileSection>
      <FooterButton onClick={onNext}>Save profile</FooterButton>
    </section>
  );
}

function ProfileSection({
  title,
  icon,
  action,
  children,
  onAction,
  extraContent
}: {
  title: string;
  icon: string;
  action: string;
  children: React.ReactNode;
  onAction?: () => void;
  extraContent?: React.ReactNode;
}) {
  return (
    <section className="profile-section">
      <h2>{title}</h2>
      <div className="section-icon">{icon}</div>
      <p>{children}</p>
      {extraContent}
      <button onClick={onAction}>{title === "Import resume" ? action : `+ ${action}`}</button>
    </section>
  );
}

function FooterButton({ onClick, children, disabled = false }: { onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <div className="native-footer">
      <button className="blue-cta" onClick={onClick} disabled={disabled}>{children}</button>
    </div>
  );
}

function W2ProfileScreen({
  initialName,
  profile,
  validation,
  onChange,
  onValidate,
  onContinue,
  onBack
}: {
  initialName: string;
  profile: ConfirmedW2Profile;
  validation: ValidationResult | null;
  onChange: (field: keyof ConfirmedW2Profile, value: string) => void;
  onValidate: () => ValidationResult;
  onContinue: () => void;
  onBack: () => void;
}) {
  const blockedDuplicate = validation?.blockingErrors.some((error) => error.code === "DUPLICATE_SSN");
  const [editingField, setEditingField] = useState<"name" | "dob" | "email" | "phone" | "ssn" | null>(null);
  const [ssnDraft, setSsnDraft] = useState("");
  const fullName = `${profile.legalFirstName} ${profile.legalLastName}`.trim();
  const ssnDigits = normalizeSsn(profile.ssn);
  const ssnDisplay = ssnDigits.length ? maskFirstSixSsnDigits(ssnDigits) : "None";

  function confirm() {
    const result = onValidate();
    if (result.canProceedToWorkBright) {
      onContinue();
    }
  }

  function saveSsnDraft() {
    onChange("ssn", ssnDraft);
    setSsnDraft("");
    setEditingField(null);
  }

  if (editingField) {
    const titleByField = {
      name: "Edit legal name",
      dob: "Edit birthdate",
      email: "Edit email address",
      phone: "Edit phone number",
      ssn: "Re-enter SSN"
    } satisfies Record<NonNullable<typeof editingField>, string>;

  return (
      <section className="w2-profile-edit-screen">
        <button className="identity-close w2-profile-close" onClick={() => setEditingField(null)} aria-label="Back">×</button>
        <div className="w2-profile-edit-content">
          <h1>{titleByField[editingField]}</h1>
          {editingField === "name" && (
            <div className="w2-edit-fields">
      <label>
        Legal first name
                <input value={profile.legalFirstName} onChange={(event) => onChange("legalFirstName", event.target.value)} placeholder="First name" />
      </label>
      <label>
        Legal last name
                <input value={profile.legalLastName} onChange={(event) => onChange("legalLastName", event.target.value)} placeholder="Last name" />
      </label>
            </div>
          )}
          {editingField === "dob" && (
            <div className="w2-edit-fields">
      <label>
                Birthdate
        <input value={profile.dateOfBirth} onChange={(event) => onChange("dateOfBirth", event.target.value)} placeholder="YYYY-MM-DD" />
      </label>
            </div>
          )}
          {editingField === "email" && (
            <div className="w2-edit-fields">
      <label>
                Email address
                <input type="email" value={profile.email} onChange={(event) => onChange("email", event.target.value)} placeholder="you@example.com" />
      </label>
          </div>
          )}
          {editingField === "phone" && (
            <div className="w2-edit-fields">
              <label>
                Phone number
                <input type="tel" inputMode="tel" value={profile.phone} onChange={(event) => onChange("phone", event.target.value)} placeholder="(323) 555-7890" />
              </label>
        </div>
      )}
          {editingField === "ssn" && (
            <div className="w2-edit-fields">
              <p>For security, re-enter your full SSN. The existing SSN is not shown here.</p>
      <label>
                SSN
                <input
                  inputMode="numeric"
                  value={ssnDraft}
                  onChange={(event) => setSsnDraft(event.target.value)}
                  placeholder="XXX-XX-XXXX"
                />
      </label>
            </div>
          )}
        </div>
        <div className="w2-profile-review-footer">
          {editingField === "ssn" ? (
            <button className="blue-cta" onClick={saveSsnDraft} disabled={normalizeSsn(ssnDraft).length !== 9}>Save</button>
          ) : (
            <button className="blue-cta" onClick={() => setEditingField(null)}>Save</button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="w2-profile-review-screen">
      <button className="identity-close w2-profile-close" onClick={onBack} aria-label="Back">×</button>
      <div className="w2-profile-review-content">
        <h1>Verify your profile details</h1>
        <p>This information may be passed to local, state, and federal governments to complete the W-2 process.</p>
        <W2ReviewRow
          label="Name"
          value={fullName || initialName}
          onEdit={() => setEditingField("name")}
        />
        <W2ReviewRow
          label="Birthdate"
          value={profile.dateOfBirth ? formatLongDate(profile.dateOfBirth) : "None"}
          onEdit={() => setEditingField("dob")}
        />
        <W2ReviewRow
          label="Email address"
          value={profile.email || "None"}
          onEdit={() => setEditingField("email")}
        />
        <W2ReviewRow
          label="Phone number"
          value={profile.phone || "None"}
          onEdit={() => setEditingField("phone")}
        />
        <W2ReviewRow
          label="SSN"
          value={ssnDisplay}
          onEdit={() => {
            setSsnDraft("");
            setEditingField("ssn");
          }}
        />
      </div>
      {validation?.status === "pass" && <p className="success">W-2 validation passed. Review before you continue to WorkBright.</p>}
      {validation?.status === "blocked" && (
        <div className="alert">
          {blockedDuplicate
            ? "W-2 onboarding is blocked until support reviews the duplicate account issue."
            : validation.blockingErrors[0]?.message}
        </div>
      )}
      <div className="w2-profile-review-footer">
        <button className="blue-cta" onClick={confirm}>Confirm</button>
      </div>
    </section>
  );
}

function W2ReviewRow({
  label,
  value,
  onEdit
}: {
  label: string;
  value: string;
  onEdit: () => void;
}) {
  return (
    <section className="w2-review-row">
      <div className="w2-review-row-header">
        <strong>{label}</strong>
        <button onClick={onEdit}>Edit</button>
      </div>
      <p>{value}</p>
    </section>
  );
}

function WorkBright({
  profile,
  currentStep,
  finalStatus,
  onNext,
  onBack,
  onSubmit,
  onAuditAttempt,
  onFeedbackSubmit
}: {
  profile: ConfirmedW2Profile;
  currentStep: number;
  finalStatus: string;
  onNext: () => void;
  onBack: () => void;
  onSubmit: () => void;
  onAuditAttempt: (event: Omit<AuditAttemptEvent, "recordKind" | "sessionId" | "timestamp" | "attemptNumber" | "profile">) => void;
  onFeedbackSubmit: (i9: I9State, rating: number, comments: string) => void;
}) {
  const name = `${profile.legalFirstName} ${profile.legalLastName}`.trim();
  const ssnDigits = normalizeSsn(profile.ssn);
  const ssnLast4 = ssnDigits.slice(-4);
  const [i9, setI9] = useState<I9State>(DEFAULT_I9_STATE);
  const [emailExcluded, setEmailExcluded] = useState(false);
  const [phoneExcluded, setPhoneExcluded] = useState(false);

  function updateI9<K extends keyof I9State>(field: K, value: I9State[K]) {
    setI9(prev => ({ ...prev, [field]: value }));
  }

  function updateDocData(docId: string, field: string, value: string) {
    setI9(prev => ({
      ...prev,
      documentData: {
        ...prev.documentData,
        [docId]: { ...(prev.documentData[docId] || { title: "", issuingAuthority: "", documentNumber: "", expirationDate: "" }), [field]: value }
      }
    }));
  }

  const progressPercent = Math.min(Math.round((currentStep / 5) * 100), 100);

  function wbShell(title: string | null, children: ReactNode, footer: ReactNode) {
  return (
      <section className="workbright-browser-screen">
        <div className="workbright-browser-bar">
          <button className="wb-bar-close">Close</button>
          <span className="wb-bar-lock" aria-hidden="true">&#x1F512;</span>
          <strong>instaworktest.workbright.com</strong>
          <span className="wb-bar-refresh" aria-hidden="true">&#x21BB;</span>
        </div>
        <div className="workbright-form-content">
          {title && <h1>{title}</h1>}
          {children}
        </div>
        <div className="workbright-form-footer">
          <div className="i9-progress">
            <span style={{ width: `${progressPercent}%` }} />
            <strong>{progressPercent}% complete</strong>
          </div>
          {footer}
        </div>
        <div className="wb-browser-nav">
          <button onClick={currentStep > 0 ? onBack : undefined} disabled={currentStep === 0} aria-label="Back">&#x2039;</button>
          <button disabled aria-label="Forward">&#x203A;</button>
        </div>
      </section>
    );
  }

  /* ---- Step 0: Personal Info Review (existing) ---- */
  if (currentStep === 0) {
    return wbShell("Form I-9", (
      <>
        <div className="i9-instruction-links">
          <a>Form I-9 Instructions (PDF) ↗</a>
          <a>Form I-9 Instructions in Spanish (PDF) ↗</a>
        </div>
        <h2>Personal Information</h2>
        <p className="i9-copy">
          The following profile information will be entered into your Form I-9 as you have indicated.
          If any of this information is incorrect, please contact your employer to update it.
        </p>
        <div className="i9-info-list">
          <I9InfoItem label="Name:" value={name || "None"} />
          <I9InfoItem label="Birthdate:" value={profile.dateOfBirth ? formatDisplayDate(profile.dateOfBirth) : "None"} />
          <I9InfoItem label="SSN:" value={ssnLast4 ? `XXX-XX-${ssnLast4}` : "None"} />
          <I9InfoItem
            label="Email (optional):"
            value={profile.email || "None"}
            excludable={!!profile.email}
            excluded={emailExcluded}
            onToggleExclude={() => setEmailExcluded(prev => !prev)}
          />
          <I9InfoItem
            label="Phone Number (optional):"
            value={profile.phone || "None"}
            excludable={!!profile.phone}
            excluded={phoneExcluded}
            onToggleExclude={() => setPhoneExcluded(prev => !prev)}
          />
          <label className="i9-other-names">
            Other Last Names Used (if Any):
            <span aria-hidden="true">?</span>
            <input value="N/A" readOnly />
          </label>
        </div>
      </>
    ), <button onClick={onNext}>Next</button>);
  }

  /* ---- Step 1: Citizenship Attestation ---- */
  if (currentStep === 1) {
    const canProceedStep1 = (() => {
      if (!i9.citizenshipStatus) return false;
      if (i9.citizenshipStatus === "lawful_permanent_resident") {
        const digits = i9.uscisNumber.replace(/\D/g, "");
        return digits.length >= 7 && digits.length <= 9;
      }
      if (i9.citizenshipStatus === "noncitizen_authorized") {
        if (!i9.workAuthExpiration) return false;
        if (!i9.authorizedNumberType) return false;
        if (i9.authorizedNumberType === "a_number" && i9.uscisNumber.replace(/\D/g, "").length < 7) return false;
        if (i9.authorizedNumberType === "i94" && !i9.i94Number.trim()) return false;
        if (i9.authorizedNumberType === "foreign_passport" && !i9.foreignPassportNumber.trim()) return false;
        return true;
      }
      return true;
    })();

    return wbShell(null, (
      <>
        <div className="i9-attestation-banner">
          I am aware that federal law provides for imprisonment and/or fines for false statements, or the use
          of false documents, in connection with the completion of this form. I attest, under penalty of perjury,
          that this information, including my selection of the box attesting to my citizenship or immigration
          status, is true and correct.
        </div>

        <p className="i9-field-label"><span className="i9-required">*</span> Choose one of the following options to attest to your citizenship or immigration status:</p>
        <div className="i9-attestation-list">
          {CITIZENSHIP_OPTIONS.map(opt => (
            <label key={opt.value} className="i9-radio-row">
              <input
                type="radio"
                name="citizenshipStatus"
                checked={i9.citizenshipStatus === opt.value}
                onChange={() => {
                  updateI9("citizenshipStatus", opt.value);
                  updateI9("authorizedNumberType", null);
                }}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>

        {i9.citizenshipStatus === "lawful_permanent_resident" && (
          <div className="i9-conditional-field">
            <p className="i9-field-label"><span className="i9-required">*</span> Alien Registration Number / USCIS Number</p>
            <input
              type="text"
              className="i9-text-input"
              inputMode="numeric"
              placeholder=""
              value={i9.uscisNumber}
              onChange={e => updateI9("uscisNumber", e.target.value)}
              maxLength={11}
            />
          </div>
        )}

        {i9.citizenshipStatus === "noncitizen_authorized" && (
          <div className="i9-conditional-field">
            <p className="i9-field-label"><span className="i9-required">*</span> Date your authorization to work expires:</p>
            <div className="i9-date-input-row">
              <span className="i9-date-icon" aria-hidden="true">&#x1F4C5;</span>
              <input
                type="date"
                className="i9-text-input"
                value={i9.workAuthExpiration}
                onChange={e => updateI9("workAuthExpiration", e.target.value)}
              />
            </div>
            <p className="i9-helper-text">
              Refugees, asylees, and certain citizens of the Federated States of Micronesia, the Republic
              of the Marshall Islands, or Palau, and other noncitizens authorized to work whose employment
              authorization does not have an expiration date, should enter N/A in the Expiration Date field.
            </p>

            <p className="i9-helper-text" style={{ marginTop: 20 }}>
              <span className="i9-required">*</span> Noncitizens authorized to work must enter <strong>one</strong> of
              the following to complete Section 1: USCIS Number/A-Number (7 to 9 digits); Form I-94
              Admission Number (11 digits); or Foreign Passport Number and the Country of
              Issuance. Your employer may not ask for documentation to verify the information
              you entered in Section 1.
            </p>

            <div className="i9-option-list">
              <div className="i9-option-block">
                <p className="i9-option-heading">Option 1</p>
                <p className="i9-field-label"><span className="i9-required">*</span> A-Number/USCIS Number</p>
                <input
                  type="text"
                  className="i9-text-input"
                  inputMode="numeric"
                  placeholder=""
                  value={i9.authorizedNumberType === "a_number" ? i9.uscisNumber : ""}
                  onFocus={() => updateI9("authorizedNumberType", "a_number")}
                  onChange={e => { updateI9("authorizedNumberType", "a_number"); updateI9("uscisNumber", e.target.value); }}
                  maxLength={11}
                />
              </div>
              <div className="i9-option-block">
                <p className="i9-option-heading">Option 2</p>
                <p className="i9-field-label"><span className="i9-required">*</span> Form I-94 Admission Number</p>
                <input
                  type="text"
                  className="i9-text-input"
                  placeholder=""
                  value={i9.authorizedNumberType === "i94" ? i9.i94Number : ""}
                  onFocus={() => updateI9("authorizedNumberType", "i94")}
                  onChange={e => { updateI9("authorizedNumberType", "i94"); updateI9("i94Number", e.target.value); }}
                  maxLength={14}
                />
              </div>
              <div className="i9-option-block">
                <p className="i9-option-heading">Option 3</p>
                <p className="i9-field-label"><span className="i9-required">*</span> Foreign Passport Number</p>
                <input
                  type="text"
                  className="i9-text-input"
                  placeholder=""
                  value={i9.authorizedNumberType === "foreign_passport" ? i9.foreignPassportNumber : ""}
                  onFocus={() => updateI9("authorizedNumberType", "foreign_passport")}
                  onChange={e => { updateI9("authorizedNumberType", "foreign_passport"); updateI9("foreignPassportNumber", e.target.value); }}
                />
              </div>
            </div>
          </div>
        )}
      </>
    ), <button disabled={!canProceedStep1} onClick={onNext}>Next</button>);
  }

  /* ---- Step 2: Choose Your Documentation (tabs + document rows) ---- */
  if (currentStep === 2) {
    const activeTab = i9.documentPath || "list_a";

    const isListA = activeTab === "list_a";

    const canProceedStep2 = isListA
      ? !!i9.selectedListA
      : !!(i9.selectedListB && i9.selectedListC);

    const gapMessage = !isListA
      ? (!i9.selectedListB && !i9.selectedListC
          ? null
          : !i9.selectedListB
            ? "You've provided Work Authorization (List C). Now select an Identity document (List B)."
            : !i9.selectedListC
              ? "You've provided Identity (List B). Now select a Work Authorization document (List C)."
              : null)
      : null;

    function renderDocRows(docs: DocumentEntry[], selectedId: string | null, onSelect: (id: string) => void, sectionLabel?: string) {
      const sorted = sortDocsByAvailability(docs, i9.citizenshipStatus);
      return (
        <div className="i9-doc-rows">
          {sectionLabel && <p className="i9-doc-rows-label">{sectionLabel}</p>}
          {sorted.map(doc => {
            const available = isDocAvailable(doc, i9.citizenshipStatus);
            const selected = selectedId === doc.id;
            return (
              <button
                key={doc.id}
                className={`i9-doc-row${selected ? " selected" : ""}${!available ? " unavailable" : ""}`}
                disabled={!available}
                onClick={() => onSelect(doc.id)}
              >
                {!available && <span className="i9-doc-blocked" aria-hidden="true" />}
                <span className="i9-doc-row-label">{doc.label}</span>
              </button>
            );
          })}
        </div>
      );
    }

    return wbShell("Choose Your Documentation", (
      <>
        <p className="i9-copy">
          You will need to provide documentation that verifies your identity and employment eligibility
          to work in the United States. Your employer or an authorized representative will inspect your
          documentation in person in Section 2 and certify that it proves your identity and that you
          have the legal right to work in the United States.
        </p>
        <p className="i9-copy">
          You can provide one document from <strong>List A</strong> OR a combination of one document
          from <strong>List B</strong> and one document from <strong>List C</strong>. Depending on what
          document(s) you wish to provide, you can select the corresponding tab below for "List A"
          or "Lists B &amp; C" and indicate what document(s) you have selected.
        </p>
        <p className="i9-copy i9-copy-light">What if I have a receipt for a document that is in process?</p>

        <div className="i9-tabs">
          <button
            className={`i9-tab${activeTab === "list_a" ? " active" : ""}`}
            onClick={() => updateI9("documentPath", "list_a")}
          >
            List A
          </button>
          <button
            className={`i9-tab${activeTab === "list_bc" ? " active" : ""}`}
            onClick={() => updateI9("documentPath", "list_bc")}
          >
            Lists B &amp; C
          </button>
        </div>

        {isListA ? (
          <>
            <p className="i9-doc-instruction">Select an option from this list, or go to Lists B &amp; C for more choices.</p>
            {renderDocRows(LIST_A_DOCUMENTS, i9.selectedListA, id => updateI9("selectedListA", id))}
          </>
        ) : (
          <>
            {renderDocRows(LIST_B_DOCUMENTS, i9.selectedListB, id => updateI9("selectedListB", id), "List B — Identity")}
            {renderDocRows(LIST_C_DOCUMENTS, i9.selectedListC, id => updateI9("selectedListC", id), "List C — Work Authorization")}
          </>
        )}
        {gapMessage && <div className="i9-gap-alert">{gapMessage}</div>}
      </>
    ), <button disabled={!canProceedStep2} onClick={() => { if (!i9.documentPath) updateI9("documentPath", activeTab as DocumentPath); onNext(); }}>Next</button>);
  }

  /* ---- Step 3: Document Upload & Verification ---- */
  if (currentStep === 3) {
    return <I9DocumentUpload
      profile={profile}
      i9={i9}
      setI9={setI9}
      progressPercent={progressPercent}
      onNext={onNext}
      onBack={onBack}
      onAuditAttempt={onAuditAttempt}
    />;
  }

  /* ---- Step 4: Review and Submit ---- */
  /* ---- Step 5: Feedback & Rating ---- */
  if (currentStep === 5) {
    return (
      <section className="workbright-browser-screen">
        <div className="workbright-browser-bar">
          <button className="wb-bar-close">Close</button>
          <span className="wb-bar-lock" aria-hidden="true">&#x1F512;</span>
          <strong>instaworktest.workbright.com</strong>
          <span className="wb-bar-refresh" aria-hidden="true">&#x21BB;</span>
        </div>
        <div className="workbright-form-content">
          <FeedbackScreen onSubmit={(rating, comments) => onFeedbackSubmit(i9, rating, comments)} />
        </div>
      </section>
    );
  }

  /* ---- Step 4: Review & Sign ---- */
  const citizenLabel = CITIZENSHIP_OPTIONS.find(o => o.value === i9.citizenshipStatus)?.label || "Not set";

  const selectedDocs: { id: string; label: string; list: string }[] = [];
  if (i9.documentPath === "list_a" && i9.selectedListA) {
    const doc = LIST_A_DOCUMENTS.find(d => d.id === i9.selectedListA);
    if (doc) selectedDocs.push({ ...doc, list: "List A" });
  } else {
    if (i9.selectedListB) {
      const doc = LIST_B_DOCUMENTS.find(d => d.id === i9.selectedListB);
      if (doc) selectedDocs.push({ ...doc, list: "List B" });
    }
    if (i9.selectedListC) {
      const doc = LIST_C_DOCUMENTS.find(d => d.id === i9.selectedListC);
      if (doc) selectedDocs.push({ ...doc, list: "List C" });
    }
  }

  return wbShell("Review & Sign", (
    <>
      <div className="i9-review-section">
        <h3>Personal Information</h3>
        <I9InfoItem label="Name:" value={name || "None"} />
        <I9InfoItem label="Birthdate:" value={profile.dateOfBirth ? formatDisplayDate(profile.dateOfBirth) : "None"} />
        <I9InfoItem label="SSN:" value={ssnLast4 ? `XXX-XX-${ssnLast4}` : "None"} />
      </div>

      <div className="i9-review-section">
        <h3>Citizenship Status</h3>
        <p>{citizenLabel}</p>
        {i9.citizenshipStatus === "lawful_permanent_resident" && i9.uscisNumber && (
          <I9InfoItem label="USCIS / A-Number:" value={i9.uscisNumber} />
        )}
        {i9.citizenshipStatus === "noncitizen_authorized" && (
          <>
            {i9.workAuthExpiration && <I9InfoItem label="Work Auth Expires:" value={i9.workAuthExpiration} />}
            {i9.authorizedNumberType === "a_number" && <I9InfoItem label="A-Number:" value={i9.uscisNumber} />}
            {i9.authorizedNumberType === "i94" && <I9InfoItem label="I-94 Number:" value={i9.i94Number} />}
            {i9.authorizedNumberType === "foreign_passport" && <I9InfoItem label="Passport Number:" value={i9.foreignPassportNumber} />}
          </>
        )}
      </div>

      <div className="i9-review-section">
        <h3>Documents</h3>
        {selectedDocs.map(doc => {
          const data = i9.documentData[doc.id];
          return (
            <div key={doc.id} className="i9-review-doc">
              <strong>{doc.list}: {doc.label}</strong>
              {data && (
                <>
                  <I9InfoItem label="Issuing Authority:" value={data.issuingAuthority || "—"} />
                  <I9InfoItem label="Document Number:" value={data.documentNumber || "—"} />
                  <I9InfoItem label="Expiration:" value={data.expirationDate || "—"} />
                </>
              )}
            </div>
          );
        })}
      </div>

      {finalStatus && <p className="success">{finalStatus}</p>}

      <p className="i9-copy" style={{ marginTop: 16 }}>
        By clicking "Sign and Submit", I attest under penalty of perjury that the information I provided is true and correct.
      </p>
    </>
  ), finalStatus
    ? <button onClick={onNext}>Continue</button>
    : <button onClick={onSubmit}>Sign and Submit</button>
  );
}

function FeedbackScreen({ onSubmit }: { onSubmit: (rating: number, comments: string) => void }) {
  const [rating, setRating] = useState(0);
  const [hoveredStar, setHoveredStar] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit() {
    onSubmit(rating, feedback);
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="feedback-screen">
        <div className="feedback-success-icon">&#x2714;</div>
        <h1>Thank you for your feedback!</h1>
        <p className="feedback-thankyou">
          Your response has been recorded. We appreciate you taking the time to complete this simulation.
        </p>
        <div className="feedback-summary-card">
          <div className="feedback-summary-row">
            <span>Your rating</span>
            <span className="feedback-stars-display">
              {"★".repeat(rating)}{"☆".repeat(5 - rating)}
            </span>
          </div>
          {feedback && (
            <div className="feedback-summary-row">
              <span>Your comments</span>
              <p>{feedback}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="feedback-screen">
      <h1>How was your experience?</h1>
      <p className="feedback-subtitle">
        In a real scenario, your Form I-9 would now be sent to an admin for review.
        Before you go, we'd love to hear your thoughts on this W-2 and I-9 onboarding simulation.
      </p>

      <div className="feedback-question">
        <h3>How well did this simulation help you understand the W-2 and I-9 onboarding process?</h3>
        <div
          className="feedback-stars"
          onMouseLeave={() => setHoveredStar(0)}
        >
          {[1, 2, 3, 4, 5].map(star => (
            <button
              key={star}
              className={`feedback-star${star <= (hoveredStar || rating) ? " active" : ""}`}
              onMouseEnter={() => setHoveredStar(star)}
              onClick={() => setRating(star)}
              aria-label={`${star} star${star > 1 ? "s" : ""}`}
            >
              {star <= (hoveredStar || rating) ? "★" : "☆"}
        </button>
          ))}
          {rating > 0 && (
            <span className="feedback-rating-label">
              {rating === 1 ? "Poor" : rating === 2 ? "Fair" : rating === 3 ? "Good" : rating === 4 ? "Very good" : "Excellent"}
            </span>
          )}
        </div>
      </div>

      <div className="feedback-question">
        <h3>Any additional comments? (optional)</h3>
        <textarea
          className="feedback-textarea"
          rows={4}
          placeholder="Tell us what you liked, what could be improved, or any questions you have..."
          value={feedback}
          onChange={e => setFeedback(e.target.value)}
        />
      </div>

      <button
        className="feedback-submit"
        disabled={!rating}
        onClick={handleSubmit}
      >
        Submit feedback
      </button>
    </div>
  );
}

function I9DocumentUpload({
  profile,
  i9,
  setI9,
  progressPercent,
  onNext,
  onBack,
  onAuditAttempt
}: {
  profile: ConfirmedW2Profile;
  i9: I9State;
  setI9: React.Dispatch<React.SetStateAction<I9State>>;
  progressPercent: number;
  onNext: () => void;
  onBack: () => void;
  onAuditAttempt: (event: Omit<AuditAttemptEvent, "recordKind" | "sessionId" | "timestamp" | "attemptNumber" | "profile">) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [uploadSubStep, setUploadSubStep] = useState(0);

  const effectivePath = i9.documentPath || (i9.selectedListA ? "list_a" : "list_bc");
  const docsToUpload: { id: string; label: string; govType: GovernmentIdType; listLabel: string; expectedList: string }[] = [];
  if (effectivePath === "list_a" && i9.selectedListA) {
    const doc = LIST_A_DOCUMENTS.find(d => d.id === i9.selectedListA);
    if (doc) docsToUpload.push({ ...doc, govType: DOC_ID_TO_GOV_TYPE[doc.id] || "unknown", listLabel: "List A", expectedList: "A" });
  } else {
    if (i9.selectedListB) {
      const doc = LIST_B_DOCUMENTS.find(d => d.id === i9.selectedListB);
      if (doc) docsToUpload.push({ ...doc, govType: DOC_ID_TO_GOV_TYPE[doc.id] || "unknown", listLabel: "List B — Identity", expectedList: "B" });
    }
    if (i9.selectedListC) {
      const doc = LIST_C_DOCUMENTS.find(d => d.id === i9.selectedListC);
      if (doc) docsToUpload.push({ ...doc, govType: DOC_ID_TO_GOV_TYPE[doc.id] || "unknown", listLabel: "List C — Work Authorization", expectedList: "C" });
    }
  }

  type UploadSlot = { doc: typeof docsToUpload[0]; side: "front" | "back"; imageKey: string };
  const uploadSlots: UploadSlot[] = [];
  for (const doc of docsToUpload) {
    uploadSlots.push({ doc, side: "front", imageKey: doc.id });
    uploadSlots.push({ doc, side: "back", imageKey: `${doc.id}_back` });
  }

  const currentSlot = uploadSlots[uploadSubStep] || uploadSlots[0];
  const currentDoc = currentSlot?.doc;
  const currentSide = currentSlot?.side || "front";
  const currentImageKey = currentSlot?.imageKey || "";
  const img = currentImageKey ? (i9.docImages[currentImageKey] || EMPTY_DOC_IMAGE) : EMPTY_DOC_IMAGE;
  const currentVerified = img.status === "success";
  const isLastSlot = uploadSubStep >= uploadSlots.length - 1;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !cameraStream) return;
    video.srcObject = cameraStream;
    void video.play().catch(() => undefined);
  }, [cameraStream]);

  useEffect(() => {
    return () => { cameraStream?.getTracks().forEach(t => t.stop()); };
  }, [cameraStream]);

  useEffect(() => {
    if (currentImageKey) {
      setI9(prev => ({
        ...prev,
        docImages: {
          ...prev.docImages,
          [currentImageKey]: { ...EMPTY_DOC_IMAGE }
        }
      }));
    }
  }, [uploadSubStep]);

  function updateDocImage(docId: string, patch: Partial<DocImageState>) {
    setI9(prev => ({
      ...prev,
      docImages: {
        ...prev.docImages,
        [docId]: { ...(prev.docImages[docId] || EMPTY_DOC_IMAGE), ...patch }
      }
    }));
  }

  async function analyzeDocImage(imageKey: string, govType: GovernmentIdType, imageBase64: string, fileName: string, side: "front" | "back", docEntry?: typeof docsToUpload[0]) {
    updateDocImage(imageKey, { imageBase64, fileName, status: "analyzing", message: "", analysis: null });

    try {
      const response = await fetch("/api/i9/verify-document", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: `i9_${imageKey}_${Date.now()}`,
          imageBase64,
          selectedDocumentType: govType,
          documentSide: side,
          documentDetectedInFrame: true,
          profile,
          i9Context: {
            citizenshipStatus: i9.citizenshipStatus,
            documentPath: i9.documentPath,
            expectedList: docEntry?.expectedList || "A",
            expectedDocId: docEntry?.id || imageKey,
            expectedDocLabel: docEntry?.label || ""
          }
        })
      });

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errorBody?.error || "Document analysis failed.");
      }

      const result = (await response.json()) as IdentityVerificationAnalyzeResponse;

      if (side === "back") {
        const detectedSide = result.analysis?.detectedSide || "unknown";
        const backVerified = detectedSide !== "front" && result.analysis.complianceEligibility;
        if (!backVerified) {
          const message = detectedSide === "front"
            ? "This looks like the front side of the document. Please upload the back side."
            : result.userMessage;
          onAuditAttempt({
            flow: "i9",
            side,
            selectedDocumentType: govType,
            fileName,
            selectedList: docEntry?.expectedList,
            selectedDocumentId: docEntry?.id,
            selectedDocumentLabel: docEntry?.label,
            immigrationStatus: i9.citizenshipStatus,
            documentPath: i9.documentPath,
            resultStatus: "fail",
            userMessage: message,
            googleDriveFileId: result.googleDriveFileId,
            googleDriveFileUrl: result.googleDriveFileUrl ?? googleDriveFileUrl(result.googleDriveFileId),
            flags: result.analysis?.flags ?? []
          });
          updateDocImage(imageKey, {
            imageBase64, fileName, analysis: null, status: "error",
            message,
            googleDriveFileId: result.googleDriveFileId,
            googleDriveFileUrl: result.googleDriveFileUrl ?? googleDriveFileUrl(result.googleDriveFileId)
          });
        } else {
          onAuditAttempt({
            flow: "i9",
            side,
            selectedDocumentType: govType,
            fileName,
            selectedList: docEntry?.expectedList,
            selectedDocumentId: docEntry?.id,
            selectedDocumentLabel: docEntry?.label,
            immigrationStatus: i9.citizenshipStatus,
            documentPath: i9.documentPath,
            resultStatus: "pass",
            userMessage: "Back side captured successfully.",
            googleDriveFileId: result.googleDriveFileId,
            googleDriveFileUrl: result.googleDriveFileUrl ?? googleDriveFileUrl(result.googleDriveFileId),
            flags: result.analysis?.flags ?? []
          });
          updateDocImage(imageKey, {
            imageBase64, fileName, analysis: null, status: "success",
            message: "Back side captured successfully.",
            googleDriveFileId: result.googleDriveFileId,
            googleDriveFileUrl: result.googleDriveFileUrl ?? googleDriveFileUrl(result.googleDriveFileId)
          });
        }
        return;
      }

      onAuditAttempt({
        flow: "i9",
        side,
        selectedDocumentType: govType,
        fileName,
        selectedList: docEntry?.expectedList,
        selectedDocumentId: docEntry?.id,
        selectedDocumentLabel: docEntry?.label,
        immigrationStatus: i9.citizenshipStatus,
        documentPath: i9.documentPath,
        resultStatus: result.analysis.complianceEligibility ? "pass" : "fail",
        userMessage: result.userMessage,
        googleDriveFileId: result.googleDriveFileId,
        googleDriveFileUrl: result.googleDriveFileUrl ?? googleDriveFileUrl(result.googleDriveFileId),
        flags: result.analysis.flags
      });
      updateDocImage(imageKey, {
        imageBase64,
        fileName,
        analysis: result.analysis,
        status: result.analysis.complianceEligibility ? "success" : "error",
        message: result.userMessage,
        googleDriveFileId: result.googleDriveFileId,
        googleDriveFileUrl: result.googleDriveFileUrl ?? googleDriveFileUrl(result.googleDriveFileId)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Analysis failed. Try another image.";
      if (side === "back") {
        onAuditAttempt({
          flow: "i9",
          side,
          selectedDocumentType: govType,
          fileName,
          selectedList: docEntry?.expectedList,
          selectedDocumentId: docEntry?.id,
          selectedDocumentLabel: docEntry?.label,
          immigrationStatus: i9.citizenshipStatus,
          documentPath: i9.documentPath,
          resultStatus: "fail",
          userMessage: message
        });
        updateDocImage(imageKey, { imageBase64, fileName, analysis: null, status: "error", message });
        return;
      }
      onAuditAttempt({
        flow: "i9",
        side,
        selectedDocumentType: govType,
        fileName,
        selectedList: docEntry?.expectedList,
        selectedDocumentId: docEntry?.id,
        selectedDocumentLabel: docEntry?.label,
        immigrationStatus: i9.citizenshipStatus,
        documentPath: i9.documentPath,
        resultStatus: "fail",
        userMessage: message
      });
      updateDocImage(imageKey, {
        imageBase64,
        fileName,
        analysis: null,
        status: "error",
        message
      });
    }
  }

  async function handleFileInput(file: File | undefined) {
    if (!file || !currentDoc) return;
    if (fileInputRef.current) fileInputRef.current.value = "";
    const imageBase64 = await readImageFile(file);
    await analyzeDocImage(currentImageKey, currentDoc.govType, imageBase64, file.name, currentSide, currentDoc);
  }

  async function openDocCamera() {
    if (!currentDoc) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      updateDocImage(currentImageKey, { status: "error", message: "Camera not available. Upload an image instead." });
      return;
    }
    try {
      cameraStream?.getTracks().forEach(t => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      setCameraStream(stream);
    } catch {
      updateDocImage(currentImageKey, { status: "error", message: "Camera access denied. Upload an image instead." });
    }
  }

  async function captureCamera() {
    if (!currentDoc) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!video || !canvas || !ctx) return;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageBase64 = canvas.toDataURL("image/png");
    cameraStream?.getTracks().forEach(t => t.stop());
    setCameraStream(null);
    await analyzeDocImage(currentImageKey, currentDoc.govType, imageBase64, "camera-capture.png", currentSide, currentDoc);
  }

  function handleBack() {
    cameraStream?.getTracks().forEach(t => t.stop());
    setCameraStream(null);
    if (uploadSubStep > 0) {
      const prevSlot = uploadSlots[uploadSubStep - 1];
      if (prevSlot) updateDocImage(prevSlot.imageKey, { ...EMPTY_DOC_IMAGE });
      setUploadSubStep(s => s - 1);
    } else {
      setI9(prev => ({ ...prev, docImages: {} }));
      onBack();
    }
  }

  function handleNext() {
    cameraStream?.getTracks().forEach(t => t.stop());
    setCameraStream(null);
    if (isLastSlot) {
      onNext();
    } else {
      setUploadSubStep(s => s + 1);
    }
  }

  if (!currentDoc) return null;

  const docIndex = docsToUpload.indexOf(currentDoc);
  const totalDocs = docsToUpload.length;
  const sideLabel = currentSide === "front" ? "Front Side" : "Back Side";
  const stepLabel = totalDocs > 1
    ? `${currentDoc.label} — ${sideLabel} (${docIndex + 1} of ${totalDocs})`
    : `${currentDoc.label} — ${sideLabel}`;

  return (
    <section className="workbright-browser-screen">
      <div className="workbright-browser-bar">
        <button className="wb-bar-close">Close</button>
        <span className="wb-bar-lock" aria-hidden="true">&#x1F512;</span>
        <strong>instaworktest.workbright.com</strong>
        <span className="wb-bar-refresh" aria-hidden="true">&#x21BB;</span>
      </div>
      <div className="workbright-form-content">
        <h1>{stepLabel}</h1>
        <p className="i9-copy">
          {currentSide === "front"
            ? <>Take a photo or upload a clear image of the <strong>front</strong> of your <strong>{currentDoc.listLabel}</strong> document.</>
            : <>Now capture the <strong>back</strong> of your <strong>{currentDoc.label}</strong>.</>
          }
        </p>

        <div className={`i9-upload-card${currentVerified ? " verified" : img.status === "error" ? " has-error" : ""}`}>
          <div className="i9-upload-card-header">
            <div>
              <p className="i9-upload-list-tag">{currentDoc.listLabel}</p>
              <h3>{currentDoc.label} — {currentSide === "front" ? "Front" : "Back"}</h3>
            </div>
            <span className={`i9-upload-badge ${currentVerified ? "success" : img.status === "error" ? "error" : img.status === "analyzing" ? "analyzing" : ""}`}>
              {currentVerified ? "Verified" : img.status === "analyzing" ? "Analyzing..." : img.status === "error" ? "Issue found" : "Required"}
            </span>
          </div>

          {cameraStream ? (
            <div className="i9-camera-sheet">
              <video ref={videoRef} className="i9-camera-video" playsInline muted />
              <div className="i9-camera-actions">
                <button className="i9-camera-capture" onClick={() => void captureCamera()}>Capture</button>
                <button className="i9-camera-cancel" onClick={() => { cameraStream.getTracks().forEach(t => t.stop()); setCameraStream(null); }}>Cancel</button>
              </div>
            </div>
          ) : img.imageBase64 ? (
            <div className="i9-upload-preview">
              <img src={img.imageBase64} alt={`${currentDoc.label} preview`} />
            </div>
          ) : (
            <div className="i9-upload-placeholder">
              <span aria-hidden="true">&#x1F4F7;</span>
              <p>{currentSide === "front" ? "Front side photo" : "Back side photo"}</p>
            </div>
          )}
          {img.status === "analyzing" && <div className="i9-upload-feedback analyzing">Analyzing image...</div>}

          {!cameraStream && (
            <div className="i9-upload-actions">
              <button disabled={img.status === "analyzing"} onClick={() => {
                if (img.imageBase64) updateDocImage(currentImageKey, { ...EMPTY_DOC_IMAGE });
                fileInputRef.current?.click();
              }}>
                {img.imageBase64 ? (img.status === "error" ? "Try different image" : "Replace image") : "Upload image"}
              </button>
              <button disabled={img.status === "analyzing"} onClick={() => {
                if (img.imageBase64) updateDocImage(currentImageKey, { ...EMPTY_DOC_IMAGE });
                void openDocCamera();
              }}>
                {img.imageBase64 && img.status === "error" ? "Retake photo" : "Use camera"}
              </button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="visually-hidden"
            onChange={e => void handleFileInput(e.target.files?.[0])}
          />

          {img.message && img.status !== "analyzing" && !(currentSide === "back" && img.status === "success") && (
            <div className={`i9-upload-feedback ${img.status === "success" ? "success" : img.status === "error" ? "error" : ""}`}>
              {img.message}
            </div>
          )}

          {img.status !== "analyzing" && currentSide === "front" && img.analysis && (
            <AnalysisPanelBoundary>
              <IdentityAnalysisPanel analysis={img.analysis} />
            </AnalysisPanelBoundary>
          )}
        </div>
      </div>
      <div className="workbright-form-footer">
        <div className="i9-progress">
          <span style={{ width: `${progressPercent}%` }} />
          <strong>{progressPercent}% complete</strong>
        </div>
        <button disabled={!currentVerified} onClick={handleNext}>
          {isLastSlot ? "Next" : currentSide === "front" ? "Continue to back side" : "Continue"}
        </button>
      </div>
      <div className="wb-browser-nav">
        <button onClick={handleBack} aria-label="Back">&#x2039;</button>
        <button disabled aria-label="Forward">&#x203A;</button>
      </div>
      <canvas ref={canvasRef} className="visually-hidden" aria-hidden="true" />
    </section>
  );
}

function I9InfoItem({ label, value, excludable, excluded, onToggleExclude }: {
  label: string;
  value: string;
  excludable?: boolean;
  excluded?: boolean;
  onToggleExclude?: () => void;
}) {
  return (
    <div className={`i9-info-item${excluded ? " excluded" : ""}`}>
      <strong>{label}</strong>
      <p>
        {excluded ? <span className="i9-excluded-value">{value}</span> : value}
        {excludable && onToggleExclude && (
          <button
            className={`i9-exclude-btn${excluded ? " included" : ""}`}
            onClick={onToggleExclude}
          >
            {excluded ? "Include in my I-9" : "Exclude from my I-9"}
          </button>
        )}
      </p>
      {excluded && <span className="i9-excluded-tag">Excluded from I-9</span>}
    </div>
  );
}
