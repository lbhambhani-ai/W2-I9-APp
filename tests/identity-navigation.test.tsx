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

import { GovernmentIdUploadVerificationScreen } from "../client/src/App";
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

describe("identity verification navigation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the profile edit destination for name or DOB mismatches", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onEditProfile = vi.fn();

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
        onEditProfile={onEditProfile}
      />
    );

    await user.selectOptions(screen.getByLabelText("US government ID type"), "drivers-license");
    await user.upload(
      screen.getByLabelText("Front side image image"),
      new File(["front"], "front.png", { type: "image/png" })
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Go back to edit profile" })).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: "Go back to edit profile" }));

    expect(onEditProfile).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });
});
