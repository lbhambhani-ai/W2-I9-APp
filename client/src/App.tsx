import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { FaceDetector as MediaPipeFaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import type {
  AuditAttemptEvent,
  AuditFlowCompleteEvent,
  AuditLogEvent,
  AuditResultStatus,
  AuditSessionStartEvent,
  AuditSummaryEvent,
  AuditUserSnapshot,
  ConfirmedW2Profile,
  DocumentSide,
  GovernmentIdType,
  IdentityVerificationAnalyzeResponse,
  IdentityVerificationAnalysis,
  InitialIdentity,
  ValidationResult
} from "../../shared/types";
import { buildReminderIssues, s3FileUrlFromKey, summarizeAuditAttempts, type ReminderIssue } from "../../shared/audit";
import {
  documentTypeMismatchMessage,
  governmentIdTypeLabel,
  normalizeSsn,
  validateW2Profile,
  validateWorkBrightSubmission,
  VENEZUELAN_PASSPORT_EXPIRY_BYPASS_MESSAGE,
  I9_EXPIRY_EXCEPTION_MESSAGES
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
type AddressSuggestion = {
  address: string;
  city: string;
  lat?: number;
  lon?: number;
};

const DEFAULT_MAP_CENTER = { lat: 37.7749, lon: -122.4194 };

const ADDRESS_SUGGESTIONS: AddressSuggestion[] = [
  {
    address: "895 Main St, San Francisco, CA 94105, USA",
    city: "San Francisco",
    lat: 37.7897,
    lon: -122.3942
  },
  {
    address: "895 Market St, San Francisco, CA 94103, USA",
    city: "San Francisco",
    lat: 37.7845,
    lon: -122.4072
  },
  {
    address: "895 Main St, Redwood City, CA 94063, USA",
    city: "Redwood City",
    lat: 37.4852,
    lon: -122.2364
  },
  {
    address: "123 Market St, San Francisco, CA 94105, USA",
    city: "San Francisco",
    lat: 37.7936,
    lon: -122.3966
  },
  {
    address: "1 Ferry Building, San Francisco, CA 94111, USA",
    city: "San Francisco",
    lat: 37.7955,
    lon: -122.3937
  }
];

const onboardingScreens = [
  "Profile Photo",
  "Camera / Selfie",
  "Date of Birth",
  "Where do you live?",
  "W-2 Onboarding Prompt",
  "W-2 Intro",
  "Document Validation",
  "Government-Issued ID",
  "Review Profile Details"
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
  s3FileKey?: string;
  s3FileUrl?: string;
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
  {
    value: "us_citizen",
    label: "A citizen of the United States",
    description:
      "Born in the US or naturalized citizen."
  },
  {
    value: "noncitizen_national",
    label: "A noncitizen national of the United States",
    description:
      "Born in American Samoa or Swains Island; owes permanent allegiance to the U.S. but is not a citizen."
  },
  {
    value: "lawful_permanent_resident",
    label: "A lawful permanent resident",
    description:
      "You have a Permanent Resident Card (Form I-551), also known as a \"Green Card.\" You'll need your Alien Registration Number / USCIS Number."
  },
  {
    value: "noncitizen_authorized",
    label: "A noncitizen authorized to work",
    description:
      "You have temporary work authorization (e.g. EAD, H-1B, OPT). You'll enter an expiration date and an A-Number, I-94, or foreign passport number."
  }
];

const LIST_A_DOCUMENTS: DocumentEntry[] = [
  { id: "us_passport", label: "U.S. Passport", availableFor: ["us_citizen", "noncitizen_national"] },
  { id: "us_passport_card", label: "U.S. Passport Card", availableFor: ["us_citizen", "noncitizen_national"] },
  { id: "permanent_resident_card", label: "Permanent Resident Card (I-551)", availableFor: ["lawful_permanent_resident"] },
  { id: "employment_auth_doc", label: "Employment Authorization Document (EAD)", availableFor: ["noncitizen_authorized"] },
  { id: "foreign_passport_i551", label: "Foreign Passport with Temporary I-551 Stamp", availableFor: ["lawful_permanent_resident"] },
  { id: "mriv_foreign_passport", label: "Foreign Passport with Machine-Readable Immigrant Visa (MRIV)", availableFor: ["lawful_permanent_resident"] },
  { id: "expired_green_card_i797", label: "Expired Green Card with Form I-797 (Notice of Action)", availableFor: ["lawful_permanent_resident"] },
  { id: "i94_with_i551_stamp", label: "Form I-94 with I-551 Stamp and Photograph", availableFor: ["lawful_permanent_resident"] },
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
  mriv_foreign_passport: "passport",
  expired_green_card_i797: "permanent-resident-card",
  i94_with_i551_stamp: "unknown",
  foreign_passport_i94: "foreign-passport-i94",
  receipt_list_a: "unknown",
  drivers_license: "drivers-license",
  state_id_card: "state-id",
  school_id: "school-id",
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

function readIntercomUrlParams(): { intercomUserId?: string; intercomEmail?: string; intercomConversationId?: string } {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const uid = params.get("uid") || undefined;
  const email = params.get("email") || undefined;
  const cid = params.get("cid") || undefined;
  return { intercomUserId: uid, intercomEmail: email, intercomConversationId: cid };
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

function auditProfileSnapshot(
  identity: InitialIdentity,
  profile: ConfirmedW2Profile,
  residentialAddress = ""
): AuditUserSnapshot {
  // Privacy: only name, email, and residential address are retained in the audit log.
  // DOB / phone are intentionally omitted.
  return {
    firstName: identity.firstName,
    lastName: identity.lastName,
    legalFirstName: profile.legalFirstName || identity.firstName,
    legalLastName: profile.legalLastName || identity.lastName,
    email: profile.email || identity.email,
    residentialAddress: residentialAddress.trim() || undefined
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
  const directScreen = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("screen")
    : null;
  const fullCapture = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("fullcapture") === "1"
    : false;
  if (fullCapture && typeof document !== "undefined") {
    document.documentElement.classList.add("full-capture-mode");
  }
  const directStep = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("step")
    : null;
  const [step, setStep] = useState(() => {
    if (directScreen === "feedback") return onboardingScreens.length + 1;
    if (directStep !== null) return parseInt(directStep, 10);
    return 0;
  });
  // Simulation consent — shown only on a clean first load (not when deep-linking
  // to a specific screen/step or capturing screenshots).
  const [consentOpen, setConsentOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    if (fullCapture) return false;
    if (directScreen || directStep !== null) return false;
    return true;
  });
  const [identity, setIdentity] = useState<InitialIdentity>(defaultIdentity);
  const [profile, setProfile] = useState<ConfirmedW2Profile>(defaultProfile);
  const [residentialAddress, setResidentialAddress] = useState("");
  const [selfieImage, setSelfieImage] = useState<string | null>(null);
  const [w2Validation, setW2Validation] = useState<ValidationResult | null>(null);
  const directWbStep = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("wbstep")
    : null;
  const [workBrightStep, setWorkBrightStep] = useState(() => {
    if (directScreen === "feedback") return 6;
    if (directWbStep !== null) return parseInt(directWbStep, 10);
    return 0;
  });
  const [finalStatus, setFinalStatus] = useState("");
  const [sessionId] = useState(createSessionId);
  const [intercomParams] = useState(readIntercomUrlParams);
  const [auditAttempts, setAuditAttempts] = useState<AuditAttemptEvent[]>([]);
  const auditAttemptCountsRef = useRef<Record<AuditAttemptEvent["flow"], number>>({ identity: 0, i9: 0 });

  // Fire once on first load so we know who opened the app and when
  useEffect(() => {
    const event: AuditSessionStartEvent = {
      recordKind: "session_start",
      sessionId,
      timestamp: new Date().toISOString(),
      landingUrl: window.location.href,
      ...intercomParams
    };
    postAuditEvent(event);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  function saveIdentityProfileCorrection(correction: IdentityProfileCorrection) {
    setIdentity((current) => ({
      ...current,
      firstName: correction.legalFirstName,
      middleName: correction.legalMiddleName,
      lastName: correction.legalLastName,
      dateOfBirth: correction.dateOfBirth
    }));
    setProfile((current) => ({
      ...current,
      legalFirstName: correction.legalFirstName,
      legalMiddleName: correction.legalMiddleName,
      legalLastName: correction.legalLastName,
      suffix: correction.suffix,
      dateOfBirth: correction.dateOfBirth
    }));
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
      profile: auditProfileSnapshot(identity, profile, residentialAddress),
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
      profile: auditProfileSnapshot(identity, profile, residentialAddress),
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

    const flowCompleteEvent: AuditFlowCompleteEvent = {
      recordKind: "flow_complete",
      sessionId,
      timestamp: new Date().toISOString(),
      feedbackRating: rating,
      feedbackComments: comments,
      ...intercomParams
    };
    postAuditEvent(flowCompleteEvent);
  }

  if (step >= onboardingScreens.length + 1) {
    return (
      <OnboardingShell>
        <WorkBright
          profile={profile}
          currentStep={workBrightStep}
          finalStatus={finalStatus}
          auditAttempts={auditAttempts}
          onNext={() => setWorkBrightStep((current) => current + 1)}
          onBack={() => setWorkBrightStep((current) => Math.max(current - 1, 0))}
          onSubmit={submitWorkBright}
          onAuditAttempt={recordAuditAttempt}
          onFeedbackSubmit={submitFeedbackSummary}
          onAppRedirect={(context) => {
            postAuditEvent({
              recordKind: "app_redirect_click",
              sessionId,
              timestamp: new Date().toISOString(),
              context,
              deepLink: "instawork://profile/w2-onboarding",
              ...intercomParams
            });
          }}
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
        residentialAddress={residentialAddress}
        onIdentityChange={updateIdentity}
        onProfileChange={updateProfile}
        onAddressChange={setResidentialAddress}
        onSelfieCapture={setSelfieImage}
        onNext={() => setStep((current) => Math.min(current + 1, onboardingScreens.length - 1))}
        onBack={() => setStep((current) => Math.max(current - 1, 0))}
        onSaveIdentityProfileCorrection={saveIdentityProfileCorrection}
        onAuditAttempt={recordAuditAttempt}
        onJumpToW2={() => setStep(onboardingScreens.length - 1)}
      />
      {consentOpen && (
        <SimulationConsentModal
          onAccept={() => setConsentOpen(false)}
          onDecline={() => {
            window.location.href = "https://www.google.com";
          }}
        />
      )}
    </OnboardingShell>
  );
}

function SimulationConsentModal({ onAccept, onDecline }: { onAccept: () => void; onDecline: () => void }) {
  return (
    <div className="sim-consent-backdrop" role="dialog" aria-modal="true" aria-labelledby="sim-consent-title">
      <div className="sim-consent-card">
        <div className="sim-consent-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3 4 6v6c0 4.4 3.1 7.6 8 9 4.9-1.4 8-4.6 8-9V6l-8-3Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
        </div>
        <h2 id="sim-consent-title" className="sim-consent-title">
          Your real-time W-2 onboarding walkthrough
        </h2>
        <ul className="sim-consent-list">
          <li>
            <span className="sim-consent-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 5a2 2 0 0 1 2-2h9v15H6a2 2 0 0 0-2 2V5Z" />
                <path d="M15 3h3a2 2 0 0 1 2 2v15a2 2 0 0 0-2-2h-3" />
              </svg>
            </span>
            <span>A hands-on walkthrough of Instawork&rsquo;s <strong>W-2 onboarding and I-9 verification</strong>, with real-time feedback to help you complete each step.</span>
          </li>
          <li>
            <span className="sim-consent-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5" />
                <path d="M12 8h.01" />
              </svg>
            </span>
            <span>It&rsquo;s here to <strong>help you learn the process</strong> — it doesn&rsquo;t replace your official onboarding.</span>
          </li>
        </ul>
        <p className="sim-consent-fine">By continuing, you agree to take part in this real-time W-2 onboarding simulation built to help you understand the process. You can stop anytime. If you decline, you&rsquo;ll leave the walkthrough.</p>
        <button type="button" className="sim-consent-primary" onClick={onAccept}>Accept &amp; continue</button>
        <button type="button" className="sim-consent-skip" onClick={onDecline}>Decline</button>
      </div>
    </div>
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

function isFullCaptureMode() {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("fullcapture") === "1";
}

function OnboardingShell({ camera = false, children }: { camera?: boolean; children: React.ReactNode }) {
  const fullCapture = isFullCaptureMode();

  return (
    <main className={`page instawork-page ${fullCapture ? "full-capture-mode" : ""}`}>
      <div className={`app-phone ${camera ? "camera-mode" : ""} ${fullCapture ? "full-capture-phone" : ""}`}>
        <div className="sim-global-banner" role="note" aria-label="Simulation notice">
          <span className="sim-global-dot" aria-hidden="true" />
          Experience the simulation
        </div>
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
  residentialAddress,
  onIdentityChange,
  onProfileChange,
  onAddressChange,
  onSelfieCapture,
  onNext,
  onBack,
  onSaveIdentityProfileCorrection,
  onAuditAttempt,
  onJumpToW2
}: {
  step: number;
  identity: InitialIdentity;
  profile: ConfirmedW2Profile;
  selfieImage: string | null;
  residentialAddress: string;
  onIdentityChange: (field: keyof InitialIdentity, value: string) => void;
  onProfileChange: (field: keyof ConfirmedW2Profile, value: string) => void;
  onAddressChange: (value: string) => void;
  onSelfieCapture: (imageDataUrl: string) => void;
  onNext: () => void;
  onBack: () => void;
  onSaveIdentityProfileCorrection: (correction: IdentityProfileCorrection) => void;
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
    return (
      <LocationScreen
        address={residentialAddress}
        onChange={onAddressChange}
        onNext={onNext}
        onBack={onBack}
      />
    );
  }
  if (step === 4) {
    return <W2OnboardingPromptScreen onNext={onNext} />;
  }
  if (step === 5) {
    return <W2DocumentationIntroScreen onNext={onNext} onBack={onBack} />;
  }
  if (step === 6) {
    return <IdentityVerificationConsentScreen onNext={onNext} onBack={onBack} />;
  }
  if (step === 7) {
    return <GovernmentIdUploadVerificationScreen profile={profile} onNext={onNext} onBack={onBack} onSaveProfileCorrection={onSaveIdentityProfileCorrection} onAuditAttempt={onAuditAttempt} />;
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
        <strong>Document validation</strong>
      </header>
      <div className="identity-consent-content">
        <h1>Verify your Identity</h1>
        <p className="identity-intro">
          To verify your identity, submit a clear photo of a government ID and a selfie. The process will only take a few
          minutes.
        </p>
        <h2>Simulation Consent</h2>
        <p>
          This document validation flow is for simulation only. It is designed to demonstrate how a worker could review
          and confirm identity information during W-2 onboarding.
        </p>
        <p>
          <strong>1. What You May Submit.</strong> You may upload or capture a government ID image and selfie image so the
          demo can simulate document and identity checks.
        </p>
        <p>
          <strong>2. How This Demo Uses Images.</strong> Images are used only to run the simulated verification steps shown
          in this experience. We are not storing sensitive documents anywhere as part of this simulation.
        </p>
        <p>
          <strong>3. Your Consent.</strong> By selecting Yes below and clicking Begin verifying, you agree to continue
          with this simulation.
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

const DATE_FIELD_KEYS = new Set([
  "date_of_birth", "issue_date", "expiration_date", "date_of_issue", "date_of_expiration"
]);

function formatDisplayDateLong(value: string): string {
  if (!value || value === "N/A") return value;
  let y: number, m: number, day: number;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const slashMDY = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const monthNameDY = value.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  const monthNameDY2 = value.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (iso) {
    y = Number(iso[1]); m = Number(iso[2]) - 1; day = Number(iso[3]);
  } else if (slashMDY) {
    m = Number(slashMDY[1]) - 1; day = Number(slashMDY[2]); y = Number(slashMDY[3]);
  } else if (monthNameDY) {
    const parsed = new Date(`${monthNameDY[2]} ${monthNameDY[1]}, ${monthNameDY[3]}`);
    if (isNaN(parsed.getTime())) return value;
    y = parsed.getFullYear(); m = parsed.getMonth(); day = parsed.getDate();
  } else if (monthNameDY2) {
    const parsed = new Date(`${monthNameDY2[1]} ${monthNameDY2[2]}, ${monthNameDY2[3]}`);
    if (isNaN(parsed.getTime())) return value;
    y = parsed.getFullYear(); m = parsed.getMonth(); day = parsed.getDate();
  } else {
    return value;
  }
  const d = new Date(y, m, day);
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
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
    case "NOT_EXPIRED":
    case "NOT_APPLICABLE":
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
        <section className="identity-analysis-panel" aria-label="Document validation analysis">
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

function ProfileDobPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [openMenu, setOpenMenu] = useState<"month" | "day" | "year" | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [openMenu]);

  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const parsed = value ? new Date(value + "T00:00:00") : null;
  const selMonth = parsed ? parsed.getMonth() + 1 : 0;
  const selDay   = parsed ? parsed.getDate()       : 0;
  const selYear  = parsed ? parsed.getFullYear()   : 0;

  const currentYear = new Date().getFullYear();
  const maxYear = currentYear - 18;
  const minYear = currentYear - 80;
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => maxYear - i);

  const daysInMonth = (month: number, year: number) => {
    if (!month) return 31;
    return new Date(year || 2000, month, 0).getDate();
  };
  const maxDay = daysInMonth(selMonth, selYear);
  const days = Array.from({ length: maxDay }, (_, i) => i + 1);

  function emit(month: number, day: number, year: number) {
    const safeDay = Math.min(day, daysInMonth(month, year));
    if (month && safeDay && year) {
      const mm = String(month).padStart(2, "0");
      const dd = String(safeDay).padStart(2, "0");
      onChange(`${year}-${mm}-${dd}`);
    } else {
      onChange("");
    }
  }

  function renderMenu({
    id,
    placeholder,
    value,
    displayValue,
    options,
    onSelect
  }: {
    id: "month" | "day" | "year";
    placeholder: string;
    value: number;
    displayValue: string;
    options: { value: number; label: string }[];
    onSelect: (value: number) => void;
  }) {
    const open = openMenu === id;
    return (
      <div className={`profile-dob-select${open ? " open" : ""}`}>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={placeholder}
          onClick={() => setOpenMenu(open ? null : id)}
        >
          <span className={value ? "" : "placeholder"}>{value ? displayValue : placeholder}</span>
          <span aria-hidden="true">⌄</span>
        </button>
        {open && (
          <div className="profile-dob-menu" role="listbox" aria-label={placeholder}>
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={option.value === value ? "selected" : ""}
                onClick={() => {
                  onSelect(option.value);
                  setOpenMenu(null);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="profile-dob-picker" ref={pickerRef}>
      {renderMenu({
        id: "month",
        placeholder: "Month",
        value: selMonth,
        displayValue: selMonth ? MONTHS[selMonth - 1] : "",
        options: MONTHS.map((label, index) => ({ value: index + 1, label })),
        onSelect: (month) => emit(month, selDay, selYear)
      })}
      {renderMenu({
        id: "day",
        placeholder: "Day",
        value: selDay,
        displayValue: selDay ? String(selDay) : "",
        options: days.map((day) => ({ value: day, label: String(day) })),
        onSelect: (day) => emit(selMonth, day, selYear)
      })}
      {renderMenu({
        id: "year",
        placeholder: "Year",
        value: selYear,
        displayValue: selYear ? String(selYear) : "",
        options: years.map((year) => ({ value: year, label: String(year) })),
        onSelect: (year) => emit(selMonth, selDay, year)
      })}
    </div>
  );
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
      aria-label="Document validation analysis"
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
            : "Verification failed"}
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
      </dl>

      {fieldEntries.length > 0 && (
        <div className="analysis-fields">
          <h3>Extracted fields</h3>
          <ul>
            {fieldEntries.map(([key, value]) => (
              <li key={key}>
                <span>{fieldLabel(key)}</span>
                <strong>{DATE_FIELD_KEYS.has(key) ? formatDisplayDateLong(value ?? "") : value}</strong>
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

          <li className={expirationClass(expirationStatus)}>
            <span>Document expiry</span>
            <strong>{(() => {
              const flagCodes = (analysis.flags ?? []).map(f => f.code);
              if (flagCodes.includes("VENEZUELAN_PASSPORT_EXPIRY_BYPASS")) return "Not checked (Venezuelan passport)";
              if (flagCodes.includes("EAD_AUTO_EXTENSION")) return "Auto-extended (Form I-797C)";
              if (flagCodes.includes("I551_EXTENSION_NOTICE")) return "Extended (Form I-797)";
              if (flagCodes.includes("ADIT_STAMP_ACCEPTED")) return "Accepted (I-551/ADIT stamp)";
              if (flagCodes.includes("RECEIPT_DOCUMENT_ACCEPTED")) return "Receipt accepted (90-day rule)";
              if (expirationStatus === "VALID" || expirationStatus === "NOT_EXPIRED") return "Not expired";
              if (expirationStatus === "EXPIRED") return "Expired";
              if (expirationStatus === "EXPIRES_SOON") return "Expires soon";
              if (expirationStatus === "NOT_APPLICABLE") return "Not applicable";
              if (expirationStatus === "NOT_CHECKED") return "Not checked";
              return "Unknown";
            })()}</strong>
          </li>
          <li className={photoClass(photoIntegrity)}>
            <span>Photo integrity</span>
            <strong>{photoIntegrity}</strong>
          </li>
        </ul>
      </div>


    </section>
  );
}

type HubItemStatus = "failed" | "resolved" | "blocked" | "pending";
type HubItem = {
  id: string;
  title: string;
  detail: string;
  status: HubItemStatus;
  action?: { label: string; handler: () => void };
  secondaryAction?: { label: string; handler: () => void };
  isHardBlock?: boolean;
};

const I9_EXPIRY_EXCEPTION_CODES = new Set([
  "EAD_AUTO_EXTENSION",
  "I551_EXTENSION_NOTICE",
  "ADIT_STAMP_ACCEPTED",
  "VENEZUELAN_PASSPORT_EXPIRY_BYPASS",
  "RECEIPT_DOCUMENT_ACCEPTED",
]);

function formatUserFacingLabel(label: string): string {
  return (label || "document").replace(/^US\b/, "U.S.");
}

function withArticle(label: string): string {
  return `${/^[aeiou]/i.test(label.trim()) ? "an" : "a"} ${label}`;
}

function deriveHubItems(
  analysis: IdentityVerificationAnalysis,
  handlers: {
    onRetake: () => void;
    onChangeSelection: () => void;
    onUseDetectedType: (type: GovernmentIdType) => void;
    onFixProfile: () => void;
  }
): HubItem[] {
  const flags = analysis.flags ?? [];
  const vr = analysis.validationResults ?? {} as IdentityVerificationAnalysis["validationResults"];

  const hasDocTypeMismatch = hasDocumentTypeMismatch(analysis);
  const hasQualityFail = hasImageQualityIssue(analysis);
  const hasExpiryException = flags.some(f => I9_EXPIRY_EXCEPTION_CODES.has(f.code));
  const hasExpired = !hasExpiryException && (flags.some(f => f.code === "DOCUMENT_EXPIRED") || vr.expirationStatus === "EXPIRED");
  const hasNameMismatch = flags.some(f => f.code === "NAME_MISMATCH") || vr.nameMatch?.status === "MISMATCH";
  const hasDobMismatch = flags.some(f => f.code === "DOB_MISMATCH") || vr.dobMatch?.status === "MISMATCH";

  const items: HubItem[] = [];

  if (hasDocTypeMismatch) {
    const detectedType = analysis.detectedDocumentType as GovernmentIdType | undefined;
    const detectedIsSelectable = Boolean(
      detectedType &&
      detectedType !== analysis.userSelectedType &&
      US_GOVERNMENT_ID_TYPES.some((t) => t.value === detectedType),
    );
    const detectedLabel = detectedIsSelectable
      ? (US_GOVERNMENT_ID_TYPES.find((t) => t.value === detectedType)?.label ?? analysis.detectedDocumentTypeLabel ?? "the detected document")
      : "";

    if (detectedIsSelectable && detectedType) {
      items.push({
        id: "doc_type",
        title: "Wrong document type",
        detail: `This looks like ${withArticle(formatUserFacingLabel(detectedLabel))}, not the ${formatUserFacingLabel(analysis.userSelectedTypeLabel || governmentIdTypeLabel(analysis.userSelectedType))} you selected. Use it as ${withArticle(formatUserFacingLabel(detectedLabel))}, or upload a different document.`,
        status: "failed",
        action: { label: `Use this as ${formatUserFacingLabel(detectedLabel)}`, handler: () => handlers.onUseDetectedType(detectedType) },
        secondaryAction: { label: "Upload a different document", handler: handlers.onRetake },
      });
      return items;
    }

    items.push({
      id: "doc_type",
      title: "Wrong document type",
      detail: selectedDocumentTypeMismatchMessage(analysis),
      status: "failed",
      action: { label: "Upload correct document", handler: handlers.onRetake },
      secondaryAction: { label: "Change my selection", handler: handlers.onChangeSelection },
    });
    return items;
  }

  if (hasQualityFail) {
    items.push({
      id: "quality",
      title: "Image is unclear",
      detail: IMAGE_QUALITY_GUIDANCE,
      status: "failed",
      action: { label: "Retake photo", handler: handlers.onRetake },
    });
    return items;
  }

  if (hasExpired) {
    items.push({
      id: "expired",
      title: "Document is expired",
      detail: flags.find(f => f.code === "DOCUMENT_EXPIRED")?.message || "This document has expired. You must provide a valid, non-expired government ID.",
      status: "failed",
      isHardBlock: true,
      action: { label: "Upload a valid document", handler: handlers.onRetake },
    });
  }

  if (hasNameMismatch) {
    items.push({
      id: "name",
      title: "Name does not match",
      detail: NAME_MISMATCH_GUIDANCE,
      status: hasExpired ? "pending" : "failed",
      action: !hasExpired ? { label: "Fix my profile", handler: handlers.onFixProfile } : undefined,
      secondaryAction: !hasExpired ? { label: "Upload a different document", handler: handlers.onRetake } : undefined,
    });
  }

  if (hasDobMismatch) {
    items.push({
      id: "dob",
      title: "Date of birth does not match",
      detail: DOB_MISMATCH_GUIDANCE,
      status: hasExpired ? "pending" : "failed",
      action: !hasExpired ? { label: "Fix my profile", handler: handlers.onFixProfile } : undefined,
      secondaryAction: !hasExpired ? { label: "Upload a different document", handler: handlers.onRetake } : undefined,
    });
  }

  return items;
}

function hasDocumentTypeMismatch(analysis: IdentityVerificationAnalysis): boolean {
  return !analysis.documentTypeMatch || (analysis.flags ?? []).some(flag => flag.code === "DOCUMENT_TYPE_MISMATCH");
}

function selectedDocumentTypeMismatchMessage(analysis: IdentityVerificationAnalysis): string {
  return documentTypeMismatchMessage(analysis.userSelectedTypeLabel || governmentIdTypeLabel(analysis.userSelectedType));
}

function ResolutionHub({
  items,
  onClose,
  onContinue,
}: {
  items: HubItem[];
  onClose: () => void;
  onContinue: () => void;
}) {
  const resolved = items.filter(i => i.status === "resolved").length;
  const total = items.length;
  const allResolved = resolved === total;


  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  const statusIcon = (status: HubItemStatus) => {
    switch (status) {
      case "resolved": return <span className="hub-icon hub-icon-resolved" aria-label="Resolved">&#x2713;</span>;
      case "failed": return <span className="hub-icon hub-icon-failed" aria-label="Issue">&#x2717;</span>;
      case "blocked": return <span className="hub-icon hub-icon-blocked" aria-label="Blocked">&#x26A0;</span>;
      case "pending": return <span className="hub-icon hub-icon-pending" aria-label="Pending">&#x1F512;</span>;
    }
  };

  return (
    <div className="resolution-hub-backdrop" role="presentation" onClick={e => e.target === e.currentTarget && onClose()}>
      <section className="resolution-hub" role="dialog" aria-modal="true" aria-label="Resolution Hub">
        <div className="resolution-hub-grab" aria-hidden="true" />
        <button className="resolution-hub-close" onClick={onClose} aria-label="Close resolution hub">&times;</button>

        <header className="resolution-hub-header">
          <h2>Let's fix this</h2>
          <p className="resolution-hub-progress-text">
            {allResolved ? "All issues resolved" : `${resolved} of ${total} issues resolved`}
          </p>
          <div className="resolution-hub-progress-bar">
            <div className={`resolution-hub-progress-fill${allResolved ? " hub-progress-complete" : ""}`} style={{ width: `${total ? (resolved / total) * 100 : 0}%` }} />
          </div>
        </header>

        <ul className="resolution-hub-list">
          {items.map(item => (
            <li key={item.id} className={`resolution-hub-item hub-item-${item.status}`}>
              {statusIcon(item.status)}
              <div className="hub-item-content">
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
                {item.status === "failed" && (item.action || item.secondaryAction) && (
                  <div className="hub-item-actions">
                    {item.action && (
                      <button className="hub-item-action" onClick={item.action.handler}>{item.action.label}</button>
                    )}
                    {item.secondaryAction && (
                      <button className="hub-item-action hub-item-action-secondary" onClick={item.secondaryAction.handler}>{item.secondaryAction.label}</button>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>

        {allResolved && (
          <div className="resolution-hub-footer">
            <button className="resolution-hub-cta hub-cta-success" onClick={onContinue}>
              Continue
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

type IdUploadSideState = {
  imageBase64: string;
  fileName: string;
  analysis: IdentityVerificationAnalysis | null;
  message: string;
  status: "idle" | "analyzing" | "error" | "success";
};

type IdentityProfileCorrection = Pick<
  ConfirmedW2Profile,
  "legalFirstName" | "legalMiddleName" | "legalLastName" | "suffix" | "dateOfBirth"
>;

const emptyIdSideState: IdUploadSideState = {
  imageBase64: "",
  fileName: "",
  analysis: null,
  message: "",
  status: "idle"
};

export const NAME_MISMATCH_GUIDANCE = "Ensure that you're using your legal name, as it appears on your government-issued ID.";
export const DOB_MISMATCH_GUIDANCE = "Ensure that you're using the correct date of birth, as it appears on your government-issued ID";
export const IMAGE_QUALITY_GUIDANCE = "Please retake the photo. Reduce glare, fit the entire document in the picture, use good lighting, and make sure the image is not blurry.";
export const DOCUMENT_VALIDATED_SUCCESS = "Document validated successfully.";

const MOCK_ID_IMAGE = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjI1MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNDAwIiBoZWlnaHQ9IjI1MCIgZmlsbD0iI2UyZThmMCIgcng9IjEyIi8+PHJlY3QgeD0iMTYiIHk9IjE2IiB3aWR0aD0iMTEwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjY2NkNWUzIiByeD0iOCIvPjx0ZXh0IHg9IjE0MCIgeT0iNDQiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjE0IiBmaWxsPSIjNDQ0Ij5KT1JEQU4gU01JVEg8L3RleHQ+PHRleHQgeD0iMTQwIiB5PSI2NCIgZm9udC1mYW1pbHk9InNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTIiIGZpbGw9IiM2NjYiPkRPQjogMDQvMTUvMTk5MjwvdGV4dD48dGV4dCB4PSIxNDAiIHk9IjgzIiBmb250LWZhbWlseT0ic2Fucy1zZXJpZiIgZm9udC1zaXplPSIxMiIgZmlsbD0iIzY2NiI+RVhQOiAwNC8xNS8yMDI4PC90ZXh0Pjx0ZXh0IHg9IjE2IiB5PSIxNjAiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjExIiBmaWxsPSIjNjY2Ij5EUklWRVJTIExJQ0VOU0UgLSBDQTwvdGV4dD48L3N2Zz4=";

export function buildSimIdState(simId: string | null): { documentType: GovernmentIdType | ""; documents: Record<DocumentSide, IdUploadSideState> } | null {
  if (!simId) return null;

  const passAnalysis: IdentityVerificationAnalysis = {
    userSelectedType: "drivers-license",
    userSelectedTypeLabel: "US Driver's License",
    detectedDocumentType: "drivers-license",
    detectedDocumentTypeLabel: "US Driver's License",
    documentTypeMatch: true,
    documentDetected: true,
    detectedSide: "front",
    extractedFields: { firstName: "Jordan", lastName: "Smith", dateOfBirth: "1992-04-15", expirationDate: "2028-04-15", licenseNumber: "D1234567" },
    validationResults: {
      nameMatch: { status: "MATCH" },
      dobMatch: { status: "MATCH" },
      addressMatch: { status: "NOT_CHECKED" },
      expirationStatus: "VALID",
      photoIntegrity: "CLEAR"
    },
    flags: [],
    complianceEligibility: true,
    nextAction: "CONTINUE",
    humanReviewRequired: false
  };

  const makeFront = (analysis: IdentityVerificationAnalysis, status: IdUploadSideState["status"], message: string): IdUploadSideState => ({
    imageBase64: MOCK_ID_IMAGE,
    fileName: "license_front.jpg",
    analysis,
    status,
    message
  });

  if (simId === "pass") {
    return {
      documentType: "drivers-license",
      documents: { front: makeFront(passAnalysis, "success", DOCUMENT_VALIDATED_SUCCESS), back: { ...emptyIdSideState } }
    };
  }
  if (simId === "name_mismatch") {
    const a: IdentityVerificationAnalysis = {
      ...passAnalysis,
      complianceEligibility: false,
      nextAction: "HALT_VERIFICATION",
      extractedFields: { ...passAnalysis.extractedFields, firstName: "Alex", lastName: "Johnson" },
      validationResults: { ...passAnalysis.validationResults, nameMatch: { status: "MISMATCH", details: "Document: Alex Johnson | Profile: Jordan Smith" } },
      flags: [{ code: "NAME_MISMATCH", severity: "CRITICAL" as const, message: "Name on document does not match your profile." }]
    };
    return { documentType: "drivers-license", documents: { front: makeFront(a, "error", NAME_MISMATCH_GUIDANCE), back: { ...emptyIdSideState } } };
  }
  if (simId === "dob_mismatch") {
    const a: IdentityVerificationAnalysis = {
      ...passAnalysis,
      complianceEligibility: false,
      nextAction: "HALT_VERIFICATION",
      extractedFields: { ...passAnalysis.extractedFields, dateOfBirth: "1985-07-22" },
      validationResults: { ...passAnalysis.validationResults, dobMatch: { status: "MISMATCH", details: "Document: 1985-07-22 | Profile: 1992-04-15" } },
      flags: [{ code: "DOB_MISMATCH", severity: "CRITICAL" as const, message: "Date of birth does not match your profile." }]
    };
    return { documentType: "drivers-license", documents: { front: makeFront(a, "error", DOB_MISMATCH_GUIDANCE), back: { ...emptyIdSideState } } };
  }
  if (simId === "wrong_doc") {
    const a: IdentityVerificationAnalysis = {
      ...passAnalysis,
      complianceEligibility: false,
      nextAction: "RETAKE_PHOTO",
      documentTypeMatch: false,
      detectedDocumentType: "passport",
      detectedDocumentTypeLabel: "U.S. Passport",
      flags: [{ code: "DOCUMENT_TYPE_MISMATCH", severity: "CRITICAL" as const, message: "A passport was uploaded but Driver's License was expected." }]
    };
    return { documentType: "drivers-license", documents: { front: makeFront(a, "error", selectedDocumentTypeMismatchMessage(a)), back: { ...emptyIdSideState } } };
  }
  if (simId === "quality_fail") {
    const a: IdentityVerificationAnalysis = {
      ...passAnalysis,
      complianceEligibility: false,
      nextAction: "RETAKE_PHOTO",
      documentDetected: false,
      extractedFields: {},
      validationResults: { nameMatch: { status: "NOT_CHECKED" }, dobMatch: { status: "NOT_CHECKED" }, addressMatch: { status: "NOT_CHECKED" }, expirationStatus: "UNKNOWN", photoIntegrity: "BLURRED" },
      flags: [{ code: "IMAGE_QUALITY_LOW", severity: "CRITICAL" as const, message: "Image is too blurry. Please retake the photo." }]
    };
    return { documentType: "drivers-license", documents: { front: makeFront(a, "error", IMAGE_QUALITY_GUIDANCE), back: { ...emptyIdSideState } } };
  }
  if (simId === "expired") {
    const a: IdentityVerificationAnalysis = {
      ...passAnalysis,
      complianceEligibility: false,
      nextAction: "HALT_VERIFICATION",
      extractedFields: { ...passAnalysis.extractedFields, expirationDate: "2020-01-15" },
      validationResults: { ...passAnalysis.validationResults, expirationStatus: "EXPIRED" },
      flags: [{ code: "DOCUMENT_EXPIRED", severity: "CRITICAL" as const, message: "Document expired on Jan 15, 2020." }]
    };
    return { documentType: "drivers-license", documents: { front: makeFront(a, "error", "Document is expired. Please provide a valid government ID."), back: { ...emptyIdSideState } } };
  }
  if (simId === "venezuelan_pass") {
    const a: IdentityVerificationAnalysis = {
      ...passAnalysis,
      userSelectedType: "foreign-passport-i94",
      userSelectedTypeLabel: "Foreign Passport with Form I-94",
      detectedDocumentType: "foreign-passport-i94",
      detectedDocumentTypeLabel: "Foreign Passport with Form I-94",
      extractedFields: { ...passAnalysis.extractedFields, nationality: "VENEZUELA", country_code: "VEN", expirationDate: "2019-06-01" },
      validationResults: { ...passAnalysis.validationResults, expirationStatus: "NOT_APPLICABLE" },
      flags: [{ code: "VENEZUELAN_PASSPORT_EXPIRY_BYPASS", severity: "INFO" as const, message: VENEZUELAN_PASSPORT_EXPIRY_BYPASS_MESSAGE }]
    };
    return { documentType: "foreign-passport-i94", documents: { front: makeFront(a, "success", VENEZUELAN_PASSPORT_EXPIRY_BYPASS_MESSAGE), back: { ...emptyIdSideState } } };
  }
  if (simId === "analyzing") {
    return { documentType: "drivers-license", documents: { front: { imageBase64: MOCK_ID_IMAGE, fileName: "license_front.jpg", analysis: null, status: "analyzing", message: "" }, back: { ...emptyIdSideState } } };
  }
  return null;
}

function hasImageQualityIssue(analysis: IdentityVerificationAnalysis): boolean {
  const flags = analysis.flags ?? [];
  return (
    !analysis.documentDetected ||
    flags.some((flag) => ["IMAGE_QUALITY_LOW", "PHOTO_BLURRED", "NO_DOCUMENT_DETECTED"].includes(flag.code)) ||
    ["BLURRED", "POOR", "FAILED"].includes(String(analysis.validationResults?.photoIntegrity ?? "").toUpperCase())
  );
}

function DobCalendarPicker({
  value,
  onChange,
  wrapperClassName = "",
  triggerClassName = "",
  calendarClassName = "",
  triggerIconSize = 18,
  scrollIntoViewOnOpen = false
}: {
  value: string;
  onChange: (value: string) => void;
  wrapperClassName?: string;
  triggerClassName?: string;
  calendarClassName?: string;
  triggerIconSize?: number;
  scrollIntoViewOnOpen?: boolean;
}) {
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [isYearListOpen, setIsYearListOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const calendarRef = useRef<HTMLDivElement | null>(null);
  const selectedDate = parseDateInputValue(value);
  const [calendarYear, setCalendarYear] = useState(selectedDate.getFullYear());
  const [calendarMonth, setCalendarMonth] = useState(selectedDate.getMonth());
  const latestAllowedDob = getLatestAdultDob();
  const hasDob = Boolean(value);
  const selectedDay = selectedDate.getDate();

  useEffect(() => {
    if (!isCalendarOpen) return;
    function handleOutsideClick(e: MouseEvent) {
      if (
        triggerRef.current && !triggerRef.current.contains(e.target as Node) &&
        calendarRef.current && !calendarRef.current.contains(e.target as Node)
      ) {
        setIsCalendarOpen(false);
        setIsYearListOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [isCalendarOpen]);

  function toggleCalendar() {
    const opening = !isCalendarOpen;
    setIsCalendarOpen(opening);
    if (!opening) {
      setIsYearListOpen(false);
      return;
    }
    if (scrollIntoViewOnOpen) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          calendarRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
        });
      });
    }
  }

  function selectDay(day: number) {
    const nextDate = new Date(calendarYear, calendarMonth, day);
    onChange(toDateInputValue(nextDate));
    setIsCalendarOpen(false);
    setIsYearListOpen(false);
  }

  return (
    <div className={wrapperClassName}>
      <button
        ref={triggerRef}
        className={["date-field custom-date-trigger", triggerClassName].filter(Boolean).join(" ")}
        type="button"
        aria-expanded={isCalendarOpen}
        aria-label="Open date of birth calendar"
        onClick={toggleCalendar}
      >
        <span aria-hidden="true" style={{ fontSize: triggerIconSize }}>📅</span>
        <strong className={hasDob ? "has-value" : ""}>{hasDob ? formatDisplayDateLong(value) : "MM / DD / YYYY"}</strong>
        <span className="calendar-glyph" aria-hidden="true">▾</span>
      </button>
      {isCalendarOpen && (
        <div
          ref={calendarRef}
          className={["custom-calendar", calendarClassName].filter(Boolean).join(" ")}
          role="dialog"
          aria-label="Choose date of birth"
        >
          <div className="calendar-header">
            <button aria-label="Previous month" type="button" onClick={() => {
              const prev = new Date(calendarYear, calendarMonth - 1, 1);
              setCalendarYear(prev.getFullYear());
              setCalendarMonth(prev.getMonth());
            }}>‹</button>
            <strong>{MONTHS[calendarMonth]} {calendarYear}</strong>
            <button aria-label="Next month" type="button" onClick={() => {
              const next = new Date(calendarYear, calendarMonth + 1, 1);
              setCalendarYear(next.getFullYear());
              setCalendarMonth(next.getMonth());
            }}>›</button>
          </div>
          <div className="calendar-selectors">
            <select aria-label="Month" value={calendarMonth} onChange={(e) => setCalendarMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option value={i} key={m}>{m}</option>)}
            </select>
            <div className="calendar-year-picker">
              <button
                type="button"
                aria-expanded={isYearListOpen}
                aria-label="Choose year"
                onClick={() => setIsYearListOpen(o => !o)}
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
                      key={year}
                      aria-selected={year === calendarYear}
                      className={year === calendarYear ? "selected" : ""}
                      onClick={() => { setCalendarYear(year); setIsYearListOpen(false); }}
                    >
                      {year}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="calendar-weekdays">
            {["S", "M", "T", "W", "T", "F", "S"].map((day, index) => (
              <span key={`${day}-${index}`}>{day}</span>
            ))}
          </div>
          <div className="calendar-days">
            {Array.from({ length: getFirstWeekday(calendarYear, calendarMonth) }, (_, index) => (
              <span className="calendar-empty" key={`empty-${index}`} />
            ))}
            {Array.from({ length: getDaysInMonth(calendarYear, calendarMonth) }, (_, index) => {
              const day = index + 1;
              const dayValue = toDateInputValue(new Date(calendarYear, calendarMonth, day));
              const isSelected = calendarYear === selectedDate.getFullYear() && calendarMonth === selectedDate.getMonth() && day === selectedDay;
              const isDisabled = dayValue > latestAllowedDob;
              return (
                <button
                  key={day}
                  type="button"
                  aria-label={`${getFullMonthName(calendarMonth)} ${day}, ${calendarYear}`}
                  className={isSelected ? "selected" : ""}
                  disabled={isDisabled}
                  onClick={() => !isDisabled && selectDay(day)}
                >
                  {day}
                  </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function GovernmentIdUploadVerificationScreen({
  profile,
  onNext,
  onBack,
  onSaveProfileCorrection,
  onAuditAttempt
}: {
  profile: ConfirmedW2Profile;
  onNext: () => void;
  onBack: () => void;
  onSaveProfileCorrection: (correction: IdentityProfileCorrection) => void;
  onAuditAttempt?: (event: Omit<AuditAttemptEvent, "recordKind" | "sessionId" | "timestamp" | "attemptNumber" | "profile">) => void;
}) {
  const frontInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("simid") : null;
  const simState = buildSimIdState(simId);
  const [documentType, setDocumentType] = useState<GovernmentIdType | "">(simState?.documentType ?? "");
  const [documents, setDocuments] = useState<Record<DocumentSide, IdUploadSideState>>(
    simState?.documents ?? { front: { ...emptyIdSideState }, back: { ...emptyIdSideState } }
  );
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraSide, setCameraSide] = useState<DocumentSide>("front");
  // Extracted A-Number from front of Permanent Resident Card — passed to back-side verification
  const [extractedANumber, setExtractedANumber] = useState<string>("");
  const [isProfileEditorOpen, setIsProfileEditorOpen] = useState(false);
  const [profileEditorSaving, setProfileEditorSaving] = useState(false);
  const profileEditorFirstInputRef = useRef<HTMLInputElement | null>(null);
  const [profileDraft, setProfileDraft] = useState<IdentityProfileCorrection>({
    legalFirstName: profile.legalFirstName,
    legalMiddleName: profile.legalMiddleName ?? "",
    legalLastName: profile.legalLastName,
    suffix: profile.suffix ?? "",
    dateOfBirth: profile.dateOfBirth
  });
  const [profileUpdateMessage, setProfileUpdateMessage] = useState("");
  const [isHubOpen, setIsHubOpen] = useState(false);
  const [analysisDisclosureOpen, setAnalysisDisclosureOpen] = useState(false);

  const frontReady = isIdSideReady(documents.front);
  const canContinue = Boolean(documentType && frontReady);

  const frontAnalysis = documents.front.analysis;
  const hubItems = useMemo(() => {
    if (!frontAnalysis || frontAnalysis.complianceEligibility) return [];
    return deriveHubItems(frontAnalysis, {
      onRetake: () => {
        setIsHubOpen(false);
        resetDocuments();
        setTimeout(() => frontInputRef.current?.click(), 120);
      },
      onChangeSelection: () => {
        setIsHubOpen(false);
        resetDocuments();
        setTimeout(() => {
          const sel = document.querySelector<HTMLSelectElement>(".id-type-field select");
          if (sel) { sel.scrollIntoView({ behavior: "smooth", block: "center" }); sel.focus(); }
        }, 120);
      },
      onUseDetectedType: (type: GovernmentIdType) => {
        const front = documents.front;
        if (!front.imageBase64) {
          setIsHubOpen(false);
          resetDocuments();
          setTimeout(() => frontInputRef.current?.click(), 120);
          return;
        }
        setDocumentType(type);
        setIsHubOpen(false);
        void analyzeSide("front", front.imageBase64, front.fileName, type);
      },
      onFixProfile: () => {
        setIsHubOpen(false);
        openProfileEditor();
      },
    });
  }, [frontAnalysis]);


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

  function openProfileEditor() {
    setProfileDraft({
      legalFirstName: profile.legalFirstName,
      legalMiddleName: profile.legalMiddleName ?? "",
      legalLastName: profile.legalLastName,
      suffix: profile.suffix ?? "",
      dateOfBirth: profile.dateOfBirth
    });
    setIsProfileEditorOpen(true);
    setTimeout(() => profileEditorFirstInputRef.current?.focus(), 80);
  }

  function closeProfileEditor() {
    if (profileEditorSaving) return;
    setIsProfileEditorOpen(false);
  }

  function updateProfileDraft(field: keyof IdentityProfileCorrection, value: string) {
    setProfileDraft((current) => ({ ...current, [field]: value }));
  }

  function confirmProfileCorrection() {
    if (profileEditorSaving) return;
    setProfileEditorSaving(true);
    setTimeout(() => {
      const correction = {
        legalFirstName: profileDraft.legalFirstName.trim(),
        legalMiddleName: (profileDraft.legalMiddleName ?? "").trim(),
        legalLastName: profileDraft.legalLastName.trim(),
        suffix: (profileDraft.suffix ?? "").trim(),
        dateOfBirth: profileDraft.dateOfBirth
      };
      onSaveProfileCorrection(correction);
      setProfileEditorSaving(false);
      setIsProfileEditorOpen(false);
      resetDocuments();
      setProfileUpdateMessage("Profile updated. Please upload or retake the front image so we can verify it against the corrected details.");
    }, 600);
  }

  function resetDocuments() {
    setDocuments({
      front: { ...emptyIdSideState },
      back: { ...emptyIdSideState }
    });
    setExtractedANumber("");
  }

  async function analyzeSide(side: DocumentSide, imageBase64: string, fileName: string, typeOverride?: GovernmentIdType) {
    setProfileUpdateMessage("");
    const effectiveType = typeOverride ?? documentType;
    if (!effectiveType) {
      setDocuments((current) => ({
        ...current,
        [side]: {
          ...current[side],
          imageBase64,
          fileName,
          status: "error",
          message: "Choose the Government-issued ID type before uploading."
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
      const isPRC = effectiveType === "permanent-resident-card";
      const profilePayload = {
        ...profile,
        // For PRC back side, include A-Number extracted from front (if any) so n8n can cross-check
        ...(isPRC && side === "back" && extractedANumber ? { aNumber: extractedANumber } : {})
      };

      const response = await postAnalyzeRequest("/api/identity-verification/analyze", {
        requestId: `identity_${side}_${Date.now()}`,
        imageBase64,
        selectedDocumentType: effectiveType,
        documentSide: side,
        documentDetectedInFrame: true,
        profile: profilePayload
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
        selectedDocumentType: effectiveType,
        fileName,
        resultStatus,
        userMessage: result.userMessage,
        s3FileKey: result.s3FileKey,
        s3FileUrl: result.s3FileUrl ?? s3FileUrlFromKey(result.s3FileKey),
        flags: result.analysis.flags
      });
      const normalizedMessage = result.analysis.complianceEligibility
        ? DOCUMENT_VALIDATED_SUCCESS
        : hasImageQualityIssue(result.analysis)
          ? IMAGE_QUALITY_GUIDANCE
          : hasDocumentTypeMismatch(result.analysis)
            ? selectedDocumentTypeMismatchMessage(result.analysis)
            : result.userMessage;

      setDocuments((current) => ({
        ...current,
        [side]: {
          imageBase64,
          fileName,
          analysis: result.analysis,
          status: result.analysis.complianceEligibility ? "success" : "error",
          message: normalizedMessage,
          s3FileKey: result.s3FileKey,
          s3FileUrl: result.s3FileUrl ?? s3FileUrlFromKey(result.s3FileKey)
        }
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Identity OCR failed. Try another image.";
      onAuditAttempt?.({
        flow: "identity",
        side,
        selectedDocumentType: effectiveType,
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
            {hasImage ? (hasError ? "Upload image" : "Replace image") : "Upload image"}
          </button>
          <button disabled={isAnalyzing} onClick={() => {
            if (hasImage) setDocuments(cur => ({ ...cur, [side]: { ...emptyIdSideState } }));
            void openCamera(side);
          }}>
            {"Use camera"}
          </button>
        </div>
        {state.message && state.status !== "analyzing" && (
          <div className={`id-feedback ${state.status === "success" ? "success" : state.status === "idle" ? "" : "error"}`}>
            {state.message}
          </div>
        )}
        {state.status !== "analyzing" && state.analysis && (
          <details className="analysis-disclosure" open={analysisDisclosureOpen} onToggle={e => setAnalysisDisclosureOpen((e.target as HTMLDetailsElement).open)}>
            <summary>View technical details</summary>
            <AnalysisPanelBoundary><IdentityAnalysisPanel analysis={state.analysis} /></AnalysisPanelBoundary>
          </details>
        )}
      </section>
    );
  }

  return (
    <section className="government-id-screen">

      <header className="identity-consent-header">
        <button className="identity-close" onClick={onBack} aria-label="Back">×</button>
        <strong>Document validation</strong>
      </header>
      <div className="government-id-content">
        <h1>Government-Issued ID</h1>
        <p>Take a clear image of the front of your selected government-issued ID.</p>
        <label className="id-type-field">
          Government-issued ID type
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
        {profileUpdateMessage && (
          <div className="id-feedback success" role="status">
            {profileUpdateMessage}
          </div>
        )}
        {hubItems.length > 0 && !isHubOpen && (
          <button className="hub-reopen-trigger" onClick={() => setIsHubOpen(true)}>
            Review and fix {hubItems.filter(i => i.status === "failed").length} issue{hubItems.filter(i => i.status === "failed").length !== 1 ? "s" : ""}
          </button>
        )}
        {!canContinue && hubItems.length === 0 && documents.front.status !== "analyzing" && (
          <div className="id-feedback" role="status">Upload and verify the front image to continue.</div>
        )}
      </div>
      {isHubOpen && hubItems.length > 0 && (
        <ResolutionHub
          items={hubItems}
          onClose={() => setIsHubOpen(false)}
          onContinue={onNext}
        />
      )}
      {isProfileEditorOpen && (
        <div
          className="id-profile-editor-backdrop"
          role="presentation"
          onKeyDown={(e) => e.key === "Escape" && closeProfileEditor()}
          onClick={(e) => e.target === e.currentTarget && closeProfileEditor()}
        >
          <section className="id-profile-editor-card" role="dialog" aria-modal="true" aria-labelledby="id-profile-editor-title">
            <div className="id-profile-editor-grab-handle" aria-hidden="true" />
            <button
              className="id-profile-editor-close"
              type="button"
              onClick={closeProfileEditor}
              aria-label="Close profile editor"
            >×</button>

            <div className="id-profile-editor-content">
              <div className="id-profile-editor-security-badge" aria-label="Secure form">
                <span aria-hidden="true">🔒</span> Your details are stored securely and never shared.
              </div>

              <div className="id-profile-editor-avatar" aria-hidden="true">
                {profile.legalFirstName.charAt(0) || "P"}{profile.legalLastName.charAt(0) || ""}
              </div>

              <h2 id="id-profile-editor-title">Confirm your legal name and date of birth</h2>
              <p>Enter the same legal details shown on your government ID.</p>

              <div className="id-profile-editor-grid">
                <label className="id-profile-editor-name-field">
                  Legal first name <span className="id-profile-editor-required" aria-hidden="true">*</span>
                  <input
                    ref={profileEditorFirstInputRef}
                    value={profileDraft.legalFirstName}
                    onChange={(e) => updateProfileDraft("legalFirstName", e.target.value)}
                    autoComplete="given-name"
                  />
                </label>
                <label className="id-profile-editor-name-field">
                  Legal last name <span className="id-profile-editor-required" aria-hidden="true">*</span>
                  <input
                    value={profileDraft.legalLastName}
                    onChange={(e) => updateProfileDraft("legalLastName", e.target.value)}
                    autoComplete="family-name"
                  />
                </label>
                <label className="id-profile-editor-secondary-field">
                  Middle name <span className="id-profile-editor-optional">optional</span>
                  <input
                    value={profileDraft.legalMiddleName ?? ""}
                    onChange={(e) => updateProfileDraft("legalMiddleName", e.target.value)}
                    autoComplete="additional-name"
                  />
                </label>
                <label className="id-profile-editor-secondary-field">
                  Suffix <span className="id-profile-editor-optional">optional</span>
                  <input
                    value={profileDraft.suffix ?? ""}
                    onChange={(e) => updateProfileDraft("suffix", e.target.value)}
                    placeholder="Jr, Sr, III"
                  />
                </label>
                <div className="id-profile-editor-dob-wrap">
                  <span className="id-profile-editor-dob-label">
                    Date of birth <span className="id-profile-editor-required" aria-hidden="true">*</span>
                  </span>
                  <ProfileDobPicker
                    value={profileDraft.dateOfBirth}
                    onChange={(v) => updateProfileDraft("dateOfBirth", v)}
                  />
                </div>
              </div>
            </div>

            <div className="id-profile-editor-actions">
              <button type="button" onClick={closeProfileEditor} disabled={profileEditorSaving}>Cancel</button>
              <button
                type="button"
                className="blue-cta id-profile-editor-save-btn"
                onClick={confirmProfileCorrection}
                disabled={profileEditorSaving || !profileDraft.legalFirstName.trim() || !profileDraft.legalLastName.trim() || !profileDraft.dateOfBirth}
                aria-busy={profileEditorSaving}
              >
                {profileEditorSaving
                  ? <><span className="id-profile-editor-spinner" aria-hidden="true" /> Saving…</>
                  : "Save"}
              </button>
            </div>
          </section>
        </div>
      )}
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

// Upper bound so a stalled request (dead proxy, half-open socket, lost response) can never
// leave the UI stuck on "Analyzing..." forever. Exceeds a normal n8n round trip (~20-40s)
// plus one backend retry.
const ANALYZE_REQUEST_TIMEOUT_MS = 100000;

async function postAnalyzeRequest(url: string, payload: unknown): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ANALYZE_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("Verification is taking longer than usual. Please check your connection and try again.");
    }
    throw error;
  }
}

// Prerequisite onboarding quiz/form link. Replace with the real URL (Google Form, Typeform, etc.).
const PREREQUISITE_QUIZ_URL = "https://forms.gle/REPLACE_WITH_YOUR_QUIZ_LINK";

function W2DocumentationIntroScreen({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const steps = [
    "Complete document validation",
    "Confirm your profile information",
    "Submit required forms and complete document verification"
  ];

  // Prerequisite quiz gate. Because the quiz is hosted externally, the app cannot detect
  // completion, so we require the pro to open it and self-attest before unlocking the CTA.
  const [quizOpened, setQuizOpened] = useState(false);
  const [quizAcknowledged, setQuizAcknowledged] = useState(false);

  return (
    <section className="w2-doc-intro-screen">

      <div className="w2-doc-intro-content">
        <BackButton onClick={onBack} />
        <div className="money-badge" aria-hidden="true">💵</div>
        <h1>Complete W-2 documentation to expand your shift access</h1>
        <p className="w2-employer">Become an employee of Advantage Workforce Services (&quot;AWS&quot;).</p>
        <h2 className="w2-benefits-header">Benefits</h2>
        <ul className="w2-benefits">
          <li>More shifts from our biggest partners</li>
          <li>Automatic tax withholding on paychecks</li>
        </ul>
        <h2>Steps for W-2</h2>
        <ol className="w2-steps">
          {steps.map((step, index) => (
            <li key={step}>
              <span>{index + 1}</span>
              {step}
            </li>
          ))}
        </ol>

        <div className="w2-prereq" aria-label="Required prerequisite quiz">
          <h2>Required before you start</h2>
          <p>Complete the short onboarding quiz. You must finish it to continue.</p>
          <a
            className="w2-prereq-link"
            href={PREREQUISITE_QUIZ_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setQuizOpened(true)}
          >
            Open the required quiz ↗
          </a>
          <label className={`w2-prereq-ack ${quizOpened ? "" : "is-disabled"}`}>
            <input
              type="checkbox"
              checked={quizAcknowledged}
              disabled={!quizOpened}
              onChange={(event) => setQuizAcknowledged(event.target.checked)}
            />
            <span>I have completed the required quiz.</span>
          </label>
          {!quizOpened && <p className="w2-prereq-hint">Open the quiz first to enable this.</p>}
        </div>
      </div>
      <div className="w2-doc-intro-footer">
        <button className="blue-cta" onClick={onNext} disabled={!quizAcknowledged}>Get started</button>
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
        <p>Unlock more shifts by completing your W-2 onboarding.</p>
        <button className="w2-start-button" onClick={onNext}>Start onboarding</button>
      </div>
      <InstaworkBottomNav />
    </section>
  );
}

function InstaworkBottomNav() {
  return (
    <nav className="instawork-bottom-tabs" aria-label="Instawork tabs">
      <span className="active" aria-current="page">
        <span className="tab-icon" aria-hidden="true">◉</span>
        Profile
        </span>
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
          Next, you'll continue into a simulated Form I-9 flow. This process is for educational purposes only.
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
  const hasDob = Boolean(dateOfBirth);
  const isAdult = isAtLeast18(dateOfBirth);
  const hasName = Boolean(firstName.trim() && lastName.trim());
  const hasValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const hasValidPhone = isValidUsPhone(phone);

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
        <DobCalendarPicker value={dateOfBirth} onChange={onChange} scrollIntoViewOnOpen />
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
            onChange={(event) => onPhoneChange(event.target.value.replace(/[a-zA-Z]/g, ""))}
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
  if (/[a-zA-Z]/.test(value)) return false;
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

export function LocationScreen({
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
  const initialSuggestion = getSuggestionForAddress(address);
  const [mapCenter, setMapCenter] = useState<{ lat: number; lon: number }>(
    initialSuggestion?.lat != null && initialSuggestion?.lon != null
      ? { lat: initialSuggestion.lat, lon: initialSuggestion.lon }
      : DEFAULT_MAP_CENTER
  );
  const [selectedCity, setSelectedCity] = useState(initialSuggestion?.city || "San Francisco");
  const [remoteSuggestions, setRemoteSuggestions] = useState<AddressSuggestion[]>([]);
  const [isAddressLoading, setIsAddressLoading] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState(address);
  const normalizedQuery = address.trim().toLowerCase();
  const localSuggestions = normalizedQuery.length >= 2 ? filterLocalAddressSuggestions(normalizedQuery) : [];
  const suggestions = mergeAddressSuggestions(remoteSuggestions, localSuggestions).slice(0, 5);
  const trimmedAddress = address.trim();
  const matchesSuggestion = suggestions.some((suggestion) => suggestion.address === address);
  const canUseTypedAddress = trimmedAddress.length >= 6 && !matchesSuggestion;
  const hasSelectedAddress =
    Boolean(address) && (selectedAddress === address || trimmedAddress.length >= 8);
  const showSuggestions =
    suggestionsOpen && (suggestions.length > 0 || isAddressLoading || canUseTypedAddress);

  useEffect(() => {
    if (normalizedQuery.length < 3) {
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
    setSelectedAddress(suggestion.address);
    setSelectedCity(suggestion.city);
    if (suggestion.lat != null && suggestion.lon != null) {
      setMapCenter({ lat: suggestion.lat, lon: suggestion.lon });
    }
    setRemoteSuggestions([]);
    setSuggestionsOpen(false);
  }

  function clearAddress() {
    onChange("");
    setSelectedAddress("");
    setRemoteSuggestions([]);
    setSuggestionsOpen(false);
  }

  function useTypedAddress() {
    setSelectedAddress(address);
    setSuggestionsOpen(false);
  }

  return (
    <section className="native-screen location-screen">
      <BackButton onClick={onBack} />
      <h1>Where do you live?</h1>
      <p className="native-copy">We’ll use this to find work opportunities near you.</p>
      <div className="address-autocomplete">
        <div className={`address-field${showSuggestions ? " is-open" : ""}`}>
          <span className="address-field-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
              <circle cx="12" cy="10" r="2.5" />
            </svg>
          </span>
          <label className="address-field-label" htmlFor="residential-address">Residential address</label>
          <input
            id="residential-address"
            aria-label="Search residential address"
            placeholder="Start typing your street address"
            value={address}
            autoComplete="off"
            onFocus={() => setSuggestionsOpen(true)}
            onChange={(event) => {
              onChange(event.target.value);
              setSelectedAddress("");
              setSuggestionsOpen(true);
            }}
          />
        </div>
        {showSuggestions && (
          <div className="address-suggestions" role="listbox" aria-label="Address suggestions">
            <div className="address-suggestions-header">
              <span>Suggestions</span>
              <button type="button" className="address-suggestions-close" aria-label="Close suggestions" onClick={clearAddress}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
            {isAddressLoading && suggestions.length === 0 && <div className="address-loading">Searching addresses...</div>}
            {suggestions.map((suggestion) => {
              const [matched, rest] = splitAddressMatch(suggestion.address, normalizedQuery);
              return (
                <button
                  type="button"
                  role="option"
                  aria-label={suggestion.address}
                  aria-selected={address === suggestion.address}
                  className="address-suggestion-row"
                  key={suggestion.address}
                  onClick={() => selectAddress(suggestion)}
                >
                  <strong>{matched}</strong>
                  <span>{rest}</span>
                </button>
              );
            })}
            {!isAddressLoading && suggestions.length === 0 && (
              <p className="address-empty">No exact match — you can enter it manually below.</p>
            )}
            {canUseTypedAddress && (
              <button
                type="button"
                className="address-use-typed"
                onClick={useTypedAddress}
              >
                <span className="address-use-typed-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </span>
                <span className="address-use-typed-text">
                  <strong>Use this address exactly as typed</strong>
                  <span>Keep your apartment, unit, or lane details</span>
                </span>
              </button>
            )}
          </div>
        )}
      </div>
      <aside className="location-address-note" role="note" aria-label="Address consistency reminder">
        <span className="location-note-icon" aria-hidden="true">i</span>
        <p>
          <strong>Address consistency</strong>
          Enter your current U.S. residential address. It must be identical on your Form I-9 and
          Form W-4 — exactly the same, down to the apartment, unit, suite, floor, or lane number.
        </p>
      </aside>
      <div className="map-preview">
        <iframe
          key={`${mapCenter.lat},${mapCenter.lon}`}
          className="map-frame"
          title="Map of your address"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          src={buildMapEmbedUrl(mapCenter.lat, mapCenter.lon)}
        />
        <div className="map-city-badge">{selectedCity}</div>
      </div>
      <FooterButton onClick={onNext} disabled={!hasSelectedAddress}>Next</FooterButton>
    </section>
  );
}

function buildMapEmbedUrl(lat: number, lon: number) {
  const dLat = 0.028;
  const dLon = 0.05;
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat]
    .map((value) => value.toFixed(6))
    .join(",");
  const params = new URLSearchParams({ bbox, layer: "mapnik", marker: `${lat},${lon}` });
  return `https://www.openstreetmap.org/export/embed.html?${params.toString()}`;
}

function getSuggestionForAddress(address: string) {
  return ADDRESS_SUGGESTIONS.find((suggestion) => suggestion.address === address);
}

function splitAddressMatch(address: string, normalizedQuery: string): [string, string] {
  const [head, ...tail] = address.split(",");
  const fallback: [string, string] = [head, tail.length ? `,${tail.join(",")}` : ""];
  if (!normalizedQuery) {
    return fallback;
  }
  const index = address.toLowerCase().indexOf(normalizedQuery);
  if (index === -1) {
    return fallback;
  }
  const matched = address.slice(0, index + normalizedQuery.length);
  const rest = address.slice(index + normalizedQuery.length);
  return [matched, rest];
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

  // Request extra results and a US map bias, then hard-filter to US only below,
  // because I-9 residential addresses must be within the United States.
  const response = await fetch(
    `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=15&lang=en&lat=39.8283&lon=-98.5795`,
    { signal }
  );
  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as {
    features?: Array<{
      geometry?: { coordinates?: [number, number] };
      properties?: {
        name?: string;
        street?: string;
        housenumber?: string;
        city?: string;
        state?: string;
        country?: string;
        countrycode?: string;
      };
    }>;
  };

  return (data.features || [])
    .filter((feature) => isUnitedStatesFeature(feature.properties))
    .map((feature) => formatPhotonSuggestion(feature.properties, feature.geometry?.coordinates))
    .filter((suggestion): suggestion is AddressSuggestion => Boolean(suggestion))
    .slice(0, 5);
}

function isUnitedStatesFeature(properties?: { country?: string; countrycode?: string }) {
  const code = (properties?.countrycode || "").toUpperCase();
  if (code) {
    return code === "US";
  }
  const country = (properties?.country || "").toLowerCase();
  return country === "united states" || country === "united states of america" || country === "usa";
}

function formatPhotonSuggestion(
  properties?: {
    name?: string;
    street?: string;
    housenumber?: string;
    city?: string;
    state?: string;
    country?: string;
  },
  coordinates?: [number, number]
): AddressSuggestion | null {
  if (!properties?.name) {
    return null;
  }

  const street = [properties.housenumber, properties.street].filter(Boolean).join(" ");
  const parts = [properties.name, street, properties.city, properties.state, properties.country].filter(Boolean);
  return {
    address: parts.join(", "),
    city: properties.city || properties.name,
    // Photon returns GeoJSON coordinates as [longitude, latitude]
    lon: coordinates?.[0],
    lat: coordinates?.[1]
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
                <input type="tel" inputMode="tel" value={profile.phone} onChange={(event) => onChange("phone", event.target.value.replace(/[a-zA-Z]/g, ""))} placeholder="(323) 555-7890" />
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

      <button className="identity-close w2-profile-close" onClick={onBack} aria-label="Back">&#x2715;</button>
      <div className="w2-profile-review-content">
        <h1>Review your profile details</h1>
        <W2ReviewRow
          label="Name"
          value={fullName || initialName}
        />
        <W2ReviewRow
          label="Birthdate"
          value={profile.dateOfBirth ? formatLongDate(profile.dateOfBirth) : "None"}
        />
        <W2ReviewRow
          label="Email address"
          value={profile.email || "None"}
        />
        <W2ReviewRow
          label="Phone number"
          value={profile.phone || "None"}
        />
        <W2ReviewRow
          label="SSN"
          value={ssnDisplay}
          onEdit={() => {
            setSsnDraft("");
            setEditingField("ssn");
          }}
        />
        <aside className="w2-address-reminder" role="note" aria-label="Address matching reminder">
          <strong>Address consistency</strong>
          <p>
            Please enter your current residential address. It does not need to match the address on
            your government-issued ID. Ensure the address you provide on Form I-9 and Form W-4 is identical.
          </p>
        </aside>
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
  onEdit?: () => void;
}) {
  return (
    <section className="w2-review-row">
      <div className="w2-review-row-header">
        <strong>{label}</strong>
        {onEdit && <button onClick={onEdit}>Edit</button>}
      </div>
      <p>{value}</p>
    </section>
  );
}

function WorkBright({
  profile,
  currentStep,
  finalStatus,
  auditAttempts,
  onNext,
  onBack,
  onSubmit,
  onAuditAttempt,
  onFeedbackSubmit,
  onAppRedirect
}: {
  profile: ConfirmedW2Profile;
  currentStep: number;
  finalStatus: string;
  auditAttempts: AuditAttemptEvent[];
  onNext: () => void;
  onBack: () => void;
  onSubmit: () => void;
  onAuditAttempt: (event: Omit<AuditAttemptEvent, "recordKind" | "sessionId" | "timestamp" | "attemptNumber" | "profile">) => void;
  onFeedbackSubmit: (i9: I9State, rating: number, comments: string) => void;
  onAppRedirect: (context: "pre_submit" | "post_submit") => void;
}) {
  const name = `${profile.legalFirstName} ${profile.legalLastName}`.trim();
  const ssnDigits = normalizeSsn(profile.ssn);
  const ssnLast4 = ssnDigits.slice(-4);

  const simCitizenship = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("citizenship") as CitizenshipStatus | null : null;
  const simDocPath = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("docpath") as DocumentPath | null : null;
  const simDocA = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("doca") : null;
  const simI9 = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("simi9") : null;

  const buildI9DocImages = (scenario: string | null): Record<string, DocImageState> => {
    if (!scenario) return {};
    const docId = simDocA || "us_passport";
    const passportAnalysis: IdentityVerificationAnalysis = {
      userSelectedType: "passport",
      userSelectedTypeLabel: "U.S. Passport",
      detectedDocumentType: "passport",
      detectedDocumentTypeLabel: "U.S. Passport",
      documentTypeMatch: true,
      documentDetected: true,
      detectedSide: "front",
      extractedFields: { firstName: "Jordan", lastName: "Smith", dateOfBirth: "1992-04-15", expirationDate: "2028-04-15", passportNumber: "A12345678" },
      validationResults: { nameMatch: { status: "MATCH" }, dobMatch: { status: "MATCH" }, addressMatch: { status: "NOT_CHECKED" }, expirationStatus: "VALID", photoIntegrity: "CLEAR" },
      flags: [], complianceEligibility: true, nextAction: "CONTINUE", humanReviewRequired: false
    };
    if (scenario === "pass") {
      return { [docId]: { imageBase64: MOCK_ID_IMAGE, fileName: "passport.jpg", analysis: passportAnalysis, status: "success", message: "Document verified successfully." } };
    }
    if (scenario === "wrong_doc") {
      const analysis: IdentityVerificationAnalysis = { ...passportAnalysis, complianceEligibility: false, nextAction: "RETAKE_PHOTO", documentTypeMatch: false, detectedDocumentType: "drivers-license", detectedDocumentTypeLabel: "Driver's License", flags: [{ code: "DOCUMENT_TYPE_MISMATCH", severity: "CRITICAL" as const, message: selectedDocumentTypeMismatchMessage(passportAnalysis) }] };
      return { [docId]: { imageBase64: MOCK_ID_IMAGE, fileName: "random_card.jpg", analysis, status: "error", message: selectedDocumentTypeMismatchMessage(analysis) } };
    }
    if (scenario === "quality_fail") {
      return { [docId]: { imageBase64: MOCK_ID_IMAGE, fileName: "blurry.jpg", analysis: { ...passportAnalysis, complianceEligibility: false, nextAction: "RETAKE_PHOTO", documentDetected: false, extractedFields: {}, validationResults: { nameMatch: { status: "NOT_CHECKED" }, dobMatch: { status: "NOT_CHECKED" }, addressMatch: { status: "NOT_CHECKED" }, expirationStatus: "UNKNOWN", photoIntegrity: "BLURRED" }, flags: [{ code: "IMAGE_QUALITY_LOW", severity: "CRITICAL" as const, message: "Image too blurry to process." }] }, status: "error", message: "Image is unclear. Please retake in good lighting." } };
    }
    if (scenario === "expired") {
      return { [docId]: { imageBase64: MOCK_ID_IMAGE, fileName: "passport.jpg", analysis: { ...passportAnalysis, complianceEligibility: false, nextAction: "HALT_VERIFICATION", extractedFields: { ...passportAnalysis.extractedFields, expirationDate: "2019-03-10" }, validationResults: { ...passportAnalysis.validationResults, expirationStatus: "EXPIRED" }, flags: [{ code: "DOCUMENT_EXPIRED", severity: "CRITICAL" as const, message: "Passport expired Mar 10, 2019." }] }, status: "error", message: "Document is expired. Please provide a valid passport." } };
    }
    if (scenario === "venezuelan_pass") {
      return { [docId]: { imageBase64: MOCK_ID_IMAGE, fileName: "ven_passport.jpg", analysis: { ...passportAnalysis, detectedDocumentType: "foreign-passport-i94", detectedDocumentTypeLabel: "Foreign Passport with Form I-94", extractedFields: { ...passportAnalysis.extractedFields, nationality: "VENEZUELA", country_code: "VEN", expirationDate: "2019-06-01" }, validationResults: { ...passportAnalysis.validationResults, expirationStatus: "NOT_APPLICABLE" as const }, flags: [{ code: "VENEZUELAN_PASSPORT_EXPIRY_BYPASS", severity: "INFO" as const, message: VENEZUELAN_PASSPORT_EXPIRY_BYPASS_MESSAGE }] }, status: "success", message: VENEZUELAN_PASSPORT_EXPIRY_BYPASS_MESSAGE } };
    }
    if (scenario === "ead_auto_extend") {
      return { [docId]: { imageBase64: MOCK_ID_IMAGE, fileName: "ead_i797c.jpg", analysis: { ...passportAnalysis, userSelectedType: "employment-authorization-card", userSelectedTypeLabel: "Employment Authorization Document (EAD)", detectedDocumentType: "employment-authorization-card", detectedDocumentTypeLabel: "Employment Authorization Document (Form I-766)", extractedFields: { firstName: "Jordan", lastName: "Smith", dateOfBirth: "1992-04-15", expirationDate: "2024-08-15", category: "C09", i797c_receipt_number: "IOE1234567890", auto_extension_date: "2026-08-15" }, validationResults: { ...passportAnalysis.validationResults, expirationStatus: "VALID" }, flags: [{ code: "EAD_AUTO_EXTENSION", severity: "INFO" as const, message: I9_EXPIRY_EXCEPTION_MESSAGES.EAD_AUTO_EXTENSION }] }, status: "success", message: I9_EXPIRY_EXCEPTION_MESSAGES.EAD_AUTO_EXTENSION } };
    }
    if (scenario === "green_card_i797") {
      return { [docId]: { imageBase64: MOCK_ID_IMAGE, fileName: "green_card_i797.jpg", analysis: { ...passportAnalysis, userSelectedType: "permanent-resident-card", userSelectedTypeLabel: "Permanent Resident Card (I-551)", detectedDocumentType: "permanent-resident-card", detectedDocumentTypeLabel: "Expired Permanent Resident Card with Form I-797 Extension Notice", extractedFields: { firstName: "Jordan", lastName: "Smith", dateOfBirth: "1992-04-15", expirationDate: "2023-11-01", a_number: "A123456789", i797_notice_date: "2024-02-15", i797_extension_date: "2026-11-01" }, validationResults: { ...passportAnalysis.validationResults, expirationStatus: "NOT_APPLICABLE" as const }, flags: [{ code: "I551_EXTENSION_NOTICE", severity: "INFO" as const, message: I9_EXPIRY_EXCEPTION_MESSAGES.I551_EXTENSION_NOTICE }] }, status: "success", message: I9_EXPIRY_EXCEPTION_MESSAGES.I551_EXTENSION_NOTICE } };
    }
    if (scenario === "adit_stamp") {
      return { [docId]: { imageBase64: MOCK_ID_IMAGE, fileName: "foreign_passport_adit.jpg", analysis: { ...passportAnalysis, detectedDocumentType: "passport", detectedDocumentTypeLabel: "Foreign Passport with Temporary I-551 Stamp (ADIT)", extractedFields: { firstName: "Jordan", lastName: "Smith", dateOfBirth: "1992-04-15", expirationDate: "2021-03-20", nationality: "COLOMBIA", i551_stamp_date: "2024-06-15" }, validationResults: { ...passportAnalysis.validationResults, expirationStatus: "NOT_APPLICABLE" as const }, flags: [{ code: "ADIT_STAMP_ACCEPTED", severity: "INFO" as const, message: I9_EXPIRY_EXCEPTION_MESSAGES.ADIT_STAMP_ACCEPTED }] }, status: "success", message: I9_EXPIRY_EXCEPTION_MESSAGES.ADIT_STAMP_ACCEPTED } };
    }
    if (scenario === "receipt") {
      return { [docId]: { imageBase64: MOCK_ID_IMAGE, fileName: "receipt_document.jpg", analysis: { ...passportAnalysis, detectedDocumentType: "passport", detectedDocumentTypeLabel: "Receipt for Lost/Stolen/Damaged Document", extractedFields: { firstName: "Jordan", lastName: "Smith", dateOfBirth: "1992-04-15", receipt_date: "2026-05-01", original_document: "US Passport" }, validationResults: { ...passportAnalysis.validationResults, expirationStatus: "NOT_APPLICABLE" as const }, flags: [{ code: "RECEIPT_DOCUMENT_ACCEPTED", severity: "INFO" as const, message: I9_EXPIRY_EXCEPTION_MESSAGES.RECEIPT_DOCUMENT_ACCEPTED }] }, status: "success", message: I9_EXPIRY_EXCEPTION_MESSAGES.RECEIPT_DOCUMENT_ACCEPTED } };
    }
    return {};
  };

  const [i9, setI9] = useState<I9State>(() => ({
    ...DEFAULT_I9_STATE,
    ...(simCitizenship ? { citizenshipStatus: simCitizenship } : {}),
    ...(simDocPath ? { documentPath: simDocPath } : {}),
    ...(simDocA ? { selectedListA: simDocA } : {}),
    docImages: buildI9DocImages(simI9)
  }));
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
        <div className="wb-sim-banner" role="note" aria-label="Simulation notice">
          <span className="wb-sim-dot" aria-hidden="true" />
          Simulation ONLY — Review your I-9 details before official document upload
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
          Review the profile information below. These details will be used to complete your Form I-9.
        </p>
        <div className="i9-info-list">
          <I9InfoItem label="Name:" value={name || "None"} />
          <I9InfoItem label="Birthdate:" value={profile.dateOfBirth ? formatDisplayDateLong(profile.dateOfBirth) : "None"} />
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
        <p className="i9-field-label"><span className="i9-required">*</span> Choose one of the following options to attest to your citizenship or immigration status:</p>
        <p className="i9-scroll-hint">Scroll down to see all 4 options</p>
        <div className="i9-attestation-list">
          {CITIZENSHIP_OPTIONS.map((opt, idx) => (
            <label key={opt.value} className={`i9-radio-card${i9.citizenshipStatus === opt.value ? " selected" : ""}`}>
              <input
                type="radio"
                name="citizenshipStatus"
                checked={i9.citizenshipStatus === opt.value}
                onChange={() => {
                  updateI9("citizenshipStatus", opt.value);
                  updateI9("authorizedNumberType", null);
                }}
              />
              <span className="i9-radio-card-body">
                <strong>{idx + 1}. {opt.label}</strong>
                <small className="i9-status-description">{opt.description}</small>
              </span>
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
                aria-label="Date your authorization to work expires"
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
              <span className="i9-required">*</span> Enter <strong>one</strong> of
              the following to complete Section 1: USCIS Number/A-Number (7 to 9 digits); Form I-94
              Admission Number (11 digits); or Foreign Passport Number and the Country of
              Issuance. Your employer may not ask for documentation to verify the information
              you entered in Section 1.
            </p>

            <div className="i9-ead-caution">
              <span className="i9-ead-caution-icon" aria-hidden="true">⚠️</span>
              <p>
                <strong>Have an expired EAD?</strong> Certain EAD categories may be automatically
                extended by USCIS beyond the card's printed expiration date. Review the latest
                USCIS guidance for more information, then enter the expiration date accordingly.
              </p>
            </div>

            <div className="i9-option-list">
              <div className="i9-option-block">
                <p className="i9-option-heading">Option 1</p>
                <p className="i9-field-label">A-Number/USCIS Number</p>
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
              <div className="i9-option-divider" aria-hidden="true"><span>or</span></div>
              <div className="i9-option-block">
                <p className="i9-option-heading">Option 2</p>
                <p className="i9-field-label">Form I-94 Admission Number</p>
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
              <div className="i9-option-divider" aria-hidden="true"><span>or</span></div>
              <div className="i9-option-block">
                <p className="i9-option-heading">Option 3</p>
                <p className="i9-field-label">Foreign Passport Number</p>
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
        <h2>How to choose documents for Section 2</h2>
        <p className="i9-copy">
          The documents you choose are up to you. This guide is intended to help you understand
          the instructions on Form I-9. You can provide one document from <strong>List A</strong> OR
          a combination of one document from <strong>List B</strong> and one document from <strong>List C</strong>.
          Depending on what document(s) you wish to provide, select the corresponding tab below
          for "List A" or "Lists B &amp; C" and indicate what document(s) you have selected.
        </p>
        <p className="i9-copy">
          You will need to provide documentation that verifies your identity and employment eligibility
          to work in the United States. You will select an authorized representative to inspect
          the original documents in Section 2. The person you select will need to have a smartphone
          and be physically close to you to inspect the documents.
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

  /* ---- Step 5: Personalized pre-app reminders ---- */
  if (currentStep === 5) {
    return wbShell(null, (
      <PreAppReminderScreen issues={buildReminderIssues(auditAttempts)} />
    ), <button onClick={onNext}>I understand, continue</button>);
  }

  /* ---- Step 6: Feedback & Rating ---- */
  if (currentStep === 6) {
    return (
      <section className="workbright-browser-screen">
  
        <div className="workbright-browser-bar">
          <button className="wb-bar-close">Close</button>
          <span className="wb-bar-lock" aria-hidden="true">&#x1F512;</span>
          <strong>instaworktest.workbright.com</strong>
          <span className="wb-bar-refresh" aria-hidden="true">&#x21BB;</span>
        </div>
        <div className="workbright-form-content">
          <FeedbackScreen
            onSubmit={(rating, comments) => onFeedbackSubmit(i9, rating, comments)}
            onAppRedirect={(context) => onAppRedirect(context)}
          />
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
        <I9InfoItem label="Birthdate:" value={profile.dateOfBirth ? formatDisplayDateLong(profile.dateOfBirth) : "None"} />
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
            {i9.workAuthExpiration && <I9InfoItem label="Work Auth Expires:" value={formatDisplayDateLong(i9.workAuthExpiration)} />}
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
                  <I9InfoItem label="Expiration:" value={data.expirationDate ? formatDisplayDateLong(data.expirationDate) : "—"} />
                </>
              )}
            </div>
          );
        })}
      </div>

      {finalStatus && <p className="success">{finalStatus}</p>}

      <p className="i9-copy" style={{ marginTop: 16 }}>
        By clicking "Sign and Submit", you confirm that all the information you have submitted is accurate and complete to the best of your knowledge.
      </p>
    </>
  ), finalStatus
    ? <button onClick={onNext}>Continue</button>
    : <button onClick={onSubmit}>Sign and Submit</button>
  );
}

function PreAppReminderScreen({ issues }: { issues: ReminderIssue[] }) {
  const reminders = issues.length > 0
    ? issues
    : [
        {
          label: "Keep your real submission consistent",
          detail: "No repeated blocking mistakes were found in your simulation logs.",
          fix: "Use your legal profile details, select the exact document type, and upload clear front/back photos when requested."
        }
      ];

  return (
    <div className="preapp-reminder-screen">
      <div className="preapp-success-mark" aria-hidden="true">&#x2713;</div>
      <p className="preapp-eyebrow">Simulation complete</p>
      <h1>Before you continue to the app</h1>
      <p className="preapp-intro">
        Based on your practice attempts, here are the things to avoid when you submit your real W-2 and I-9 onboarding.
      </p>

      <div className="preapp-log-card" aria-label="Personalized reminders from simulation logs">
        <div className="preapp-log-header">
          <span>From your simulation logs</span>
          <strong>{issues.length || 1} reminder{(issues.length || 1) > 1 ? "s" : ""}</strong>
        </div>
        <div className="preapp-issue-list">
          {reminders.map((issue) => (
            <div className="preapp-issue" key={issue.label}>
              <span className="preapp-issue-icon" aria-hidden="true">!</span>
              <div>
                <h2>{issue.label}</h2>
                <p>{issue.detail}</p>
                <strong>{issue.fix}</strong>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FeedbackScreen({ onSubmit, onAppRedirect }: {
  onSubmit: (rating: number, comments: string) => void;
  onAppRedirect: (context: "pre_submit" | "post_submit") => void;
}) {
  const [rating, setRating] = useState(0);
  const [hoveredStar, setHoveredStar] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const instaworkDeepLink = "instawork://profile/w2-onboarding";

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
          Your feedback was submitted for this simulation. Your real W-2 onboarding still needs to be completed in the Instawork app.
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
        <div className="app-deeplink-card submitted">
          <div className="deeplink-badge" aria-hidden="true"></div>
          <div className="deeplink-copy">
            <span>Final step</span>
            <strong>Go back to the Instawork app</strong>
          </div>
          <a href={instaworkDeepLink} onClick={() => onAppRedirect("post_submit")}>Open Instawork <span className="link-arrow">&#x2192;</span></a>
        </div>
      </div>
    );
  }

  return (
    <div className="feedback-screen">
      <h1>How was your experience?</h1>
      <p className="feedback-subtitle">
        Before you return to the Instawork app, we'd love to hear whether this simulation helped you understand the W-2 and I-9 onboarding flow.
      </p>

      <div className="simulation-notice-card">
        <div className="simulation-notice-icon" aria-hidden="true">i</div>
        <div>
          <strong>This was only a simulation</strong>
          <p>
            Your W-2 onboarding is not completed here. Finish it in the Instawork app by submitting the same corrected details and documents you verified in this practice flow.
          </p>
          <a
            className="simulation-notice-cta"
            href={instaworkDeepLink}
            onClick={() => onAppRedirect("pre_submit")}
          >
            Open Instawork app <span className="link-arrow">&#x2192;</span>
          </a>
        </div>
      </div>

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

  const simi9 = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("simi9") : null;
  const prevSubStep = useRef(uploadSubStep);
  useEffect(() => {
    if (simi9) return;
    if (prevSubStep.current === uploadSubStep) { prevSubStep.current = uploadSubStep; return; }
    prevSubStep.current = uploadSubStep;
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
      const response = await postAnalyzeRequest("/api/i9/verify-document", {
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
      });

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errorBody?.error || "Document analysis failed.");
      }

      const result = (await response.json()) as IdentityVerificationAnalyzeResponse;
      const resultMessage = hasDocumentTypeMismatch(result.analysis)
        ? selectedDocumentTypeMismatchMessage(result.analysis)
        : result.userMessage;

      if (side === "back") {
        const detectedSide = result.analysis?.detectedSide || "unknown";
        const backVerified = detectedSide !== "front" && result.analysis.complianceEligibility;
        if (!backVerified) {
          const message = detectedSide === "front"
            ? "This looks like the front side of the document. Please upload the back side."
            : resultMessage;
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
            s3FileKey: result.s3FileKey,
            s3FileUrl: result.s3FileUrl ?? s3FileUrlFromKey(result.s3FileKey),
            flags: result.analysis?.flags ?? []
          });
          updateDocImage(imageKey, {
            imageBase64, fileName, analysis: null, status: "error",
            message,
            s3FileKey: result.s3FileKey,
            s3FileUrl: result.s3FileUrl ?? s3FileUrlFromKey(result.s3FileKey)
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
            s3FileKey: result.s3FileKey,
            s3FileUrl: result.s3FileUrl ?? s3FileUrlFromKey(result.s3FileKey),
            flags: result.analysis?.flags ?? []
          });
          updateDocImage(imageKey, {
            imageBase64, fileName, analysis: null, status: "success",
            message: "Back side captured successfully.",
            s3FileKey: result.s3FileKey,
            s3FileUrl: result.s3FileUrl ?? s3FileUrlFromKey(result.s3FileKey)
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
        userMessage: resultMessage,
        s3FileKey: result.s3FileKey,
        s3FileUrl: result.s3FileUrl ?? s3FileUrlFromKey(result.s3FileKey),
        flags: result.analysis.flags
      });
      updateDocImage(imageKey, {
        imageBase64,
        fileName,
        analysis: result.analysis,
        status: result.analysis.complianceEligibility ? "success" : "error",
        message: resultMessage,
        s3FileKey: result.s3FileKey,
        s3FileUrl: result.s3FileUrl ?? s3FileUrlFromKey(result.s3FileKey)
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
                {img.imageBase64 ? (img.status === "error" ? "Upload image" : "Replace image") : "Upload image"}
        </button>
              <button disabled={img.status === "analyzing"} onClick={() => {
                if (img.imageBase64) updateDocImage(currentImageKey, { ...EMPTY_DOC_IMAGE });
                void openDocCamera();
              }}>
                {"Use camera"}
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
