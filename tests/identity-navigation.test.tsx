import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: {
    forVisionTasks: vi.fn()
  },
  FaceDetector: {
    createFromOptions: vi.fn()
  }
}));

import {
  GovernmentIdUploadVerificationScreen,
  buildSimIdState,
  NAME_MISMATCH_GUIDANCE,
  DOB_MISMATCH_GUIDANCE,
  IMAGE_QUALITY_GUIDANCE,
  DOCUMENT_VALIDATED_SUCCESS
} from "../client/src/App";
import type { ConfirmedW2Profile } from "../shared/types";

const profile: ConfirmedW2Profile = {
  legalFirstName: "Jane",
  legalMiddleName: "",
  legalLastName: "Worker",
  suffix: "",
  dateOfBirth: "1990-01-01",
  ssn: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  zip: "",
  email: "",
  phone: ""
};

describe("document validation navigation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the profile edit destination for name or DOB mismatches", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onSaveProfileCorrection = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          userMessage: "Name mismatch",
          analysis: {
            documentDetected: true,
            documentTypeMatch: true,
            complianceEligibility: false,
            userSelectedTypeLabel: "US Driver's License",
            detectedDocumentTypeLabel: "US Driver's License",
            detectedSide: "front",
            nextAction: "EDIT_PROFILE",
            verificationResults: {
              nameMatch: { status: "MISMATCH", details: "Document name differs from profile." },
              dobMatch: { status: "MATCH" },
              addressMatch: { status: "NOT_CHECKED" },
              expirationStatus: "VALID",
              photoIntegrity: "PASS"
            },
            flags: [{ code: "NAME_MISMATCH", severity: "ERROR", message: "Name mismatch" }],
            extractedFields: {}
          }
        })
      })
    );

    render(
      <GovernmentIdUploadVerificationScreen
        profile={profile}
        onNext={vi.fn()}
        onBack={onBack}
        onSaveProfileCorrection={onSaveProfileCorrection}
      />
    );

    await user.selectOptions(screen.getByLabelText("Government-issued ID type"), "drivers-license");
    await user.upload(
      screen.getByLabelText("Front side image image"),
      new File(["front"], "front.png", { type: "image/png" })
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /review and fix/i })).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: /review and fix/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Resolution Hub" })).toBeVisible();
    });

    const fixBtns = screen.getAllByRole("button", { name: "Fix my profile" });
    expect(fixBtns.length).toBeGreaterThanOrEqual(1);
    await user.click(fixBtns[0]);

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Confirm your legal name and date of birth" })).toBeVisible();
    });
    expect(screen.getByRole("button", { name: "Close profile editor" })).toBeVisible();
    expect(onSaveProfileCorrection).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close profile editor" }));

    expect(screen.queryByRole("dialog", { name: "Confirm your legal name and date of birth" })).not.toBeInTheDocument();
  });

  it("uses neutral DOB mismatch guidance in the simulated identity flow", () => {
    const state = buildSimIdState("dob_mismatch");
    expect(state).not.toBeNull();
    expect(state!.documents.front.message).toBe(DOB_MISMATCH_GUIDANCE);
  });

  it("uses neutral legal name guidance in the simulated identity flow", () => {
    const state = buildSimIdState("name_mismatch");
    expect(state).not.toBeNull();
    expect(state!.documents.front.message).toBe(NAME_MISMATCH_GUIDANCE);
  });

  it("uses complete image quality guidance in the simulated identity flow", () => {
    const state = buildSimIdState("quality_fail");
    expect(state).not.toBeNull();
    expect(state!.documents.front.message).toBe(IMAGE_QUALITY_GUIDANCE);
  });

  it("uses document validation success wording in the simulated identity flow", () => {
    const state = buildSimIdState("pass");
    expect(state).not.toBeNull();
    expect(state!.documents.front.message).toBe(DOCUMENT_VALIDATED_SUCCESS);
  });
});
