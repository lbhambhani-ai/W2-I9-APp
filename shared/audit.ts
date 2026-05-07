import type { AuditAttemptEvent } from "./types";

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
