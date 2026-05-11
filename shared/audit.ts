import type { AuditAttemptEvent } from "./types";

export type ReminderIssue = {
  label: string;
  detail: string;
  fix: string;
};

export function googleDriveFileUrl(fileId: string | null | undefined): string | undefined {
  if (!fileId) return undefined;
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

export function summarizeAuditAttempts(attempts: AuditAttemptEvent[], flow: AuditAttemptEvent["flow"]): {
  finalStatus: AuditAttemptEvent["resultStatus"] | "not_started";
  attemptCount: number;
  driveLinks: string[];
} {
  const flowAttempts = attempts.filter((attempt) => attempt.flow === flow);
  const finalAttempt = flowAttempts.at(-1);

  return {
    finalStatus: finalAttempt?.resultStatus ?? "not_started",
    attemptCount: flowAttempts.length,
    driveLinks: flowAttempts
      .map((attempt) => attempt.googleDriveFileUrl)
      .filter((link): link is string => Boolean(link))
  };
}

function attemptHasFlag(attempt: AuditAttemptEvent, codes: string[]) {
  return (attempt.flags ?? []).some((flag) => codes.includes(flag.code));
}

function attemptText(attempt: AuditAttemptEvent) {
  return `${attempt.userMessage} ${(attempt.flags ?? []).map((flag) => `${flag.code} ${flag.message}`).join(" ")}`.toLowerCase();
}

function documentLabel(attempt: AuditAttemptEvent) {
  return attempt.selectedDocumentLabel || attempt.selectedDocumentId || "that document";
}

export function buildReminderIssues(attempts: AuditAttemptEvent[]): ReminderIssue[] {
  const issues: ReminderIssue[] = [];
  const seen = new Set<string>();

  function add(key: string, issue: ReminderIssue) {
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  }

  for (const attempt of attempts) {
    if (attempt.resultStatus !== "fail") continue;

    const text = attemptText(attempt);

    if (attemptHasFlag(attempt, ["SIDE_MISMATCH"]) || /\b(front|back|side)\b/.test(text)) {
      add("side", {
        label: "Upload the requested side",
        detail: `You previously uploaded the wrong side for ${documentLabel(attempt)}.`,
        fix: `When the app asks for the ${attempt.side}, use the ${attempt.side}. Do not reuse the ${attempt.side === "back" ? "front" : "back"} image.`
      });
    }

    if (
      attemptHasFlag(attempt, ["WRONG_LIST", "WRONG_DOCUMENT", "DOCUMENT_TYPE_MISMATCH", "DOCUMENT_TYPE_NOT_ALLOWED"]) ||
      /wrong document|document type|detected document|not a us document|non-us/.test(text)
    ) {
      add("document-type", {
        label: "Choose the exact document type",
        detail: "One attempt did not match the document option you selected.",
        fix: "In the app, select the same document type that is physically in your hand."
      });
    }

    if (
      attemptHasFlag(attempt, ["NAME_MISMATCH", "DOB_MISMATCH"]) ||
      /name|date of birth|\bdob\b|profile/.test(text)
    ) {
      add("profile-match", {
        label: "Match your profile exactly",
        detail: "A previous attempt had a name or date of birth mismatch.",
        fix: "Use the same legal name and date of birth that appear on your document."
      });
    }

    if (
      attemptHasFlag(attempt, ["IMAGE_QUALITY_LOW", "PHOTO_BLURRED", "NO_DOCUMENT_DETECTED", "IMAGE_TAMPERING"]) ||
      /blur|glare|cropped|unclear|quality|tamper|no document/.test(text)
    ) {
      add("image-quality", {
        label: "Take a clean, readable photo",
        detail: "At least one upload may have been hard to read.",
        fix: "Use good lighting, avoid glare, keep the full document visible, and retake blurry photos."
      });
    }

    if (issues.length >= 3) break;
  }

  return issues;
}
