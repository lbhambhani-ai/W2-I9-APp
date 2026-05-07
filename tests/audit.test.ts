import { describe, expect, it } from "vitest";
import { googleDriveFileUrl, summarizeAuditAttempts } from "../shared/audit";
import type { AuditAttemptEvent } from "../shared/types";

describe("audit helpers", () => {
  it("derives a reviewable Google Drive URL from a file id", () => {
    expect(googleDriveFileUrl("drive-file-123")).toBe("https://drive.google.com/file/d/drive-file-123/view");
    expect(googleDriveFileUrl(undefined)).toBeUndefined();
  });

  it("summarizes attempts by final status and drive links", () => {
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
        googleDriveFileId: "first-fail",
        googleDriveFileUrl: googleDriveFileUrl("first-fail")
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
        googleDriveFileId: "second-pass",
        googleDriveFileUrl: googleDriveFileUrl("second-pass")
      }
    ];

    expect(summarizeAuditAttempts(attempts, "identity")).toEqual({
      finalStatus: "pass",
      attemptCount: 2,
      driveLinks: [
        "https://drive.google.com/file/d/first-fail/view",
        "https://drive.google.com/file/d/second-pass/view"
      ]
    });
  });
});
