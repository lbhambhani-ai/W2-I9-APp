import { describe, expect, it } from "vitest";
import { buildReminderIssues, googleDriveFileUrl, summarizeAuditAttempts } from "../shared/audit";
import type { AuditAttemptEvent } from "../shared/types";

describe("audit helpers", () => {
  it("derives a reviewable Google Drive URL from a file id", () => {
    expect(googleDriveFileUrl("drive-file-123")).toBe("https://drive.google.com/file/d/drive-file-123/view");
    expect(googleDriveFileUrl(undefined)).toBeUndefined();
  });

  it("summarizes attempts by final status and AWS file links (name + location)", () => {
    const attempts: AuditAttemptEvent[] = [
      {
        recordKind: "attempt",
        sessionId: "session-1",
        timestamp: "2026-05-07T00:00:00.000Z",
        flow: "identity",
        attemptNumber: 1,
        side: "front",
        selectedDocumentType: "drivers-license",
        resultStatus: "fail",
        userMessage: "Name mismatch",
        fileName: "license_front_1.jpg",
        s3FileKey: "docs/session-1/license_front_1.jpg",
        s3FileUrl: "https://bucket.s3.amazonaws.com/docs/session-1/license_front_1.jpg"
      },
      {
        recordKind: "attempt",
        sessionId: "session-1",
        timestamp: "2026-05-07T00:01:00.000Z",
        flow: "identity",
        attemptNumber: 2,
        side: "front",
        selectedDocumentType: "drivers-license",
        resultStatus: "pass",
        userMessage: "Verified",
        fileName: "license_front_2.jpg",
        s3FileKey: "docs/session-1/license_front_2.jpg",
        s3FileUrl: "https://bucket.s3.amazonaws.com/docs/session-1/license_front_2.jpg"
      }
    ];

    expect(summarizeAuditAttempts(attempts, "identity")).toEqual({
      finalStatus: "pass",
      attemptCount: 2,
      fileLinks: [
        "license_front_1.jpg — https://bucket.s3.amazonaws.com/docs/session-1/license_front_1.jpg",
        "license_front_2.jpg — https://bucket.s3.amazonaws.com/docs/session-1/license_front_2.jpg"
      ]
    });
  });

  it("builds user-facing reminders from failed verification attempts", () => {
    const attempts: AuditAttemptEvent[] = [
      {
        recordKind: "attempt",
        sessionId: "session-1",
        timestamp: "2026-05-07T00:00:00.000Z",
        flow: "i9",
        attemptNumber: 1,
        side: "back",
        selectedDocumentType: "passport-card",
        selectedDocumentLabel: "U.S. Passport Card",
        resultStatus: "fail",
        userMessage: "This appears to be the front side. Please upload the back side.",
        flags: [{ code: "SIDE_MISMATCH", severity: "CRITICAL", message: "Wrong side uploaded" }]
      },
      {
        recordKind: "attempt",
        sessionId: "session-1",
        timestamp: "2026-05-07T00:01:00.000Z",
        flow: "identity",
        attemptNumber: 1,
        side: "front",
        selectedDocumentType: "drivers-license",
        resultStatus: "fail",
        userMessage: "Name does not match your profile",
        flags: [{ code: "NAME_MISMATCH", severity: "CRITICAL", message: "Name mismatch" }]
      },
      {
        recordKind: "attempt",
        sessionId: "session-1",
        timestamp: "2026-05-07T00:02:00.000Z",
        flow: "i9",
        attemptNumber: 2,
        side: "back",
        selectedDocumentType: "passport-card",
        resultStatus: "pass",
        userMessage: "Verified"
      }
    ];

    expect(buildReminderIssues(attempts)).toEqual([
      {
        label: "Upload the requested side",
        detail: "You previously uploaded the wrong side for U.S. Passport Card.",
        fix: "When the app asks for the back, use the back. Do not reuse the front image."
      },
      {
        label: "Match your profile exactly",
        detail: "A previous attempt had a name or date of birth mismatch.",
        fix: "Use the same legal name and date of birth that appear on your document."
      }
    ]);
  });
});
