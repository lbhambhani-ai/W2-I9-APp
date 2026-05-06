import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../client/src/App";
import type { GovernmentIdType, IdentityFlag, IdentityVerificationAnalyzeResponse } from "../shared/types";

let idFrameMode: "valid" | "no-document" | "busy-scene" | "cropped-green-card" = "valid";

async function reachContractorAgreement() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) }
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    getImageData: (_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4);
      const cardLeft = Math.floor(width * 0.16);
      const cardRight = Math.floor(width * 0.84);
      const cardTop = Math.floor(height * 0.28);
      const cardBottom = Math.floor(height * 0.70);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * 4;
          let value = 120;
          if (idFrameMode === "valid") {
            const insideCard = x >= cardLeft && x <= cardRight && y >= cardTop && y <= cardBottom;
            const cardBorder =
              insideCard &&
              (Math.abs(x - cardLeft) < 5 ||
                Math.abs(x - cardRight) < 5 ||
                Math.abs(y - cardTop) < 5 ||
                Math.abs(y - cardBottom) < 5);
            const textLine =
              insideCard &&
              x > cardLeft + 80 &&
              x < cardRight - 40 &&
              ((y > cardTop + 45 && y < cardTop + 53) ||
                (y > cardTop + 74 && y < cardTop + 82) ||
                (y > cardTop + 104 && y < cardTop + 112) ||
                (y > cardTop + 134 && y < cardTop + 142));
            const photoBox =
              insideCard &&
              x > cardLeft + 25 &&
              x < cardLeft + 70 &&
              y > cardTop + 42 &&
              y < cardTop + 128;
            value = cardBorder || textLine || photoBox ? 20 : insideCard ? 235 : 95;
          } else if (idFrameMode === "cropped-green-card") {
            const insideCard = x >= 0 && x <= width && y >= Math.floor(height * 0.18) && y <= Math.floor(height * 0.78);
            const textLine =
              insideCard &&
              x > Math.floor(width * 0.48) &&
              x < Math.floor(width * 0.82) &&
              ((y > Math.floor(height * 0.31) && y < Math.floor(height * 0.34)) ||
                (y > Math.floor(height * 0.4) && y < Math.floor(height * 0.43)) ||
                (y > Math.floor(height * 0.49) && y < Math.floor(height * 0.52)) ||
                (y > Math.floor(height * 0.58) && y < Math.floor(height * 0.61)));
            const photoBox =
              insideCard &&
              x > Math.floor(width * 0.08) &&
              x < Math.floor(width * 0.35) &&
              y > Math.floor(height * 0.34) &&
              y < Math.floor(height * 0.68);
            value = textLine || photoBox ? 30 : insideCard ? 205 : 40;
          } else if (idFrameMode === "busy-scene") {
            value = (x * 13 + y * 29) % 255;
          }
          data[index] = value;
          data[index + 1] = value;
          data[index + 2] = value;
          data[index + 3] = 255;
        }
      }
      return { data };
    }
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,captured-selfie");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as {
      requestId: string;
      selectedDocumentType: GovernmentIdType;
      documentSide: "front" | "back";
      profile: { legalFirstName: string; legalLastName: string; dateOfBirth: string };
    };
    const labels: Record<GovernmentIdType, string> = {
      "drivers-license": "US Driver’s License",
      "state-id": "US State ID Card",
      passport: "US Passport",
      "passport-card": "US Passport Card",
      "permanent-resident-card": "US Permanent Resident Card",
      "employment-authorization-card": "US Employment Authorization Card",
      "military-id": "US Military ID",
      unknown: "Unsupported document"
    };
    if (idFrameMode === "no-document" || idFrameMode === "busy-scene") {
      const response: IdentityVerificationAnalyzeResponse = {
        requestId: body.requestId,
        source: "python",
        userMessage: "We could not detect a supported US government ID. Put the document inside the frame and try again.",
        analysis: {
          documentDetected: false,
          userSelectedType: body.selectedDocumentType,
          userSelectedTypeLabel: labels[body.selectedDocumentType],
          detectedDocumentType: "unknown",
          detectedDocumentTypeLabel: "Unsupported document",
          documentTypeMatch: false,
          detectedSide: body.documentSide,
          extractedFields: {},
          validationResults: {
            nameMatch: { status: "NOT_CHECKED" },
            dobMatch: { status: "NOT_CHECKED" },
            addressMatch: { status: "NOT_CHECKED" },
            expirationStatus: "UNKNOWN",
            photoIntegrity: "ABSENT"
          },
          flags: [{ severity: "CRITICAL", code: "NO_DOCUMENT_DETECTED", message: "No supported US government ID detected." }],
          complianceEligibility: false,
          nextAction: "RETAKE_PHOTO",
          humanReviewRequired: false
        }
      };
      return { ok: true, json: async () => response } as Response;
    }
    const detectedDocumentType =
      body.selectedDocumentType === "permanent-resident-card"
        ? "permanent-resident-card"
        : "drivers-license";
    const detectedDocumentTypeLabel = labels[detectedDocumentType];
    const documentTypeMatch = body.selectedDocumentType === detectedDocumentType;
    const isPermanentResidentMismatch = body.selectedDocumentType === "permanent-resident-card";
    const flags: IdentityFlag[] = [];
    if (!documentTypeMatch) {
      flags.push({
        severity: "CRITICAL",
        code: "DOCUMENT_TYPE_MISMATCH",
        message: `DOCUMENT_TYPE_MISMATCH: User selected ${labels[body.selectedDocumentType]}, but image detects ${detectedDocumentTypeLabel}. Verification halted.`
      });
    }
    if (isPermanentResidentMismatch) {
      flags.push({
        severity: "CRITICAL",
        code: "NAME_MISMATCH",
        message: `Name mismatch: ID shows TEST SPECIMEN; profile says ${body.profile.legalFirstName} ${body.profile.legalLastName}. Go back and correct your legal name.`
      });
      flags.push({
        severity: "CRITICAL",
        code: "DOB_MISMATCH",
        message: `Date of birth mismatch: ID shows 2002-10-20; profile says ${body.profile.dateOfBirth}. Go back and correct your date of birth.`
      });
    }
    if (documentTypeMatch && detectedDocumentType === "drivers-license" && body.documentSide === "front") {
      flags.push({
        severity: "INFO",
        code: "BACK_IMAGE_REQUIRED",
        message: "Capture the back of the US Driver’s License to complete verification."
      });
    }
    const response: IdentityVerificationAnalyzeResponse = {
      requestId: body.requestId,
      source: "mock",
      googleDriveFolderId: "1vn1OXPH2al136Us9th9LHR96nwIqHLQd",
      userMessage: flags.some((flag) => flag.code === "NAME_MISMATCH")
        ? "This looks like a Permanent Resident Card, but the name does not match your profile. Go back and correct your legal name or use your own ID."
        : flags.some((flag) => flag.code === "DOCUMENT_TYPE_MISMATCH")
          ? `This looks like ${detectedDocumentTypeLabel}, but you selected ${labels[body.selectedDocumentType]}. Choose the correct document type or retake the photo.`
          : "This ID looks good and matches your profile.",
      analysis: {
        documentDetected: true,
        userSelectedType: body.selectedDocumentType,
        userSelectedTypeLabel: labels[body.selectedDocumentType],
        detectedDocumentType,
        detectedDocumentTypeLabel,
        documentTypeMatch,
        detectedSide: body.documentSide,
        extractedFields: isPermanentResidentMismatch
          ? { first_name: "TEST", middle_name: "V", last_name: "SPECIMEN", date_of_birth: "2002-10-20" }
          : { first_name: "Lakshya", last_name: "Bhambhani", date_of_birth: body.profile.dateOfBirth, document_type: "DRIVER LICENSE" },
        validationResults: {
          nameMatch: isPermanentResidentMismatch ? { status: "MISMATCH", details: flags[0]?.message } : { status: "MATCH" },
          dobMatch: isPermanentResidentMismatch ? { status: "MISMATCH", details: flags[1]?.message } : { status: "MATCH" },
          addressMatch: { status: "MATCH" },
          expirationStatus: "VALID",
          photoIntegrity: "CLEAR"
        },
        flags,
        complianceEligibility: !flags.some((flag) => flag.severity === "CRITICAL"),
        nextAction: flags.some((flag) => flag.severity === "CRITICAL") ? "HALT_VERIFICATION" : "CONTINUE",
        humanReviewRequired: flags.some((flag) => flag.severity === "CRITICAL"),
        reviewReason: flags.find((flag) => flag.severity === "CRITICAL")?.message
      }
    };
    return {
      ok: true,
      json: async () => response
    } as Response;
  }));
  class MockFaceDetector {
    async detect() {
      return [{ boundingBox: { x: 135, y: 170, width: 130, height: 170 } }];
    }
  }
  vi.stubGlobal("FaceDetector", MockFaceDetector);

  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Upload profile photo" }));
  await userEvent.click(screen.getByRole("button", { name: "Allow camera access" }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Capture selfie" })).toBeEnabled();
  });
  await userEvent.click(screen.getByRole("button", { name: "Capture selfie" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Legal first name" }), "Lakshya");
  await userEvent.type(screen.getByRole("textbox", { name: "Legal last name" }), "Bhambhani");
  await userEvent.click(screen.getByRole("button", { name: "Open date of birth calendar" }));
  await userEvent.click(screen.getByRole("button", { name: /September 15,/ }));
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.click(screen.getByRole("button", { name: "Don’t have a resume?" }));
  await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
}

async function reachW2Prompt() {
  await reachContractorAgreement();
  const agreementText = screen.getByLabelText("Contractor agreement text");
  Object.defineProperties(agreementText, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, value: 600 }
  });
  fireEvent.scroll(agreementText);
  await userEvent.click(screen.getByRole("button", { name: "I accept" }));
}

describe("W-2 onboarding prompt", () => {
  afterEach(() => {
    idFrameMode = "valid";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("matches the profile-tab W-2 start screen before onboarding", async () => {
    await reachW2Prompt();

    expect(screen.getByRole("heading", { name: "W-2 onboarding" })).toBeVisible();
    expect(screen.getByText("Unlock more shifts by completing your paperwork for W-2 shifts.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start onboarding" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Instawork tabs" })).toBeVisible();
    expect(screen.getByText("Profile")).toHaveAttribute("aria-current", "page");
    const startScreen = screen.getByLabelText("W-2 onboarding start");
    expect(startScreen.querySelector(".w2-start-content")).toHaveClass("no-scroll");
  });

  it("requires scrolling through the contractor agreement before the W-2 prompt", async () => {
    await reachContractorAgreement();

    expect(screen.getByRole("heading", { name: "Contractor Services Agreement" })).toBeVisible();
    expect(screen.getByText("Scroll down to read and accept")).toBeVisible();
    expect(screen.getByRole("button", { name: "I accept" })).toBeDisabled();

    const agreementText = screen.getByLabelText("Contractor agreement text");
    Object.defineProperties(agreementText, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 600 }
    });
    fireEvent.scroll(agreementText);

    const accept = screen.getByRole("button", { name: "I accept" });
    expect(accept).toBeEnabled();
    await userEvent.click(accept);
    expect(screen.getByRole("heading", { name: "W-2 onboarding" })).toBeVisible();
  });

  it("opens identity verification after the W-2 documentation intro and requires yes consent", async () => {
    await reachW2Prompt();

    await userEvent.click(screen.getByRole("button", { name: "Start onboarding" }));

    expect(screen.getByRole("heading", { name: "Complete W-2 documentation to expand your shift access" })).toBeVisible();
    expect(screen.getByText('Become an employee of Advantage Workforce Services ("AWS").')).toBeVisible();
    expect(screen.getByText("More shifts from our biggest partners")).toBeVisible();
    expect(screen.getByText("Automatic tax withholding on paychecks")).toBeVisible();
    expect(screen.getByText("Steps for W-2")).toBeVisible();
    expect(screen.getByText("Complete identity verification")).toBeVisible();
    expect(screen.getByText("Confirm your profile information")).toBeVisible();
    expect(screen.getByText("Submit required forms and complete document verification")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("heading", { name: "Verify your identity to start your W-2 process" })).toBeVisible();
    expect(screen.getByText("Biometric Information Notice and Consent")).toBeVisible();
    expect(screen.getByText("Do you give consent?")).toBeVisible();
    expect(screen.queryByText("Pass verifications")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Begin verifying" })).toBeDisabled();

    await userEvent.click(screen.getByRole("radio", { name: "Yes" }));
    expect(screen.getByRole("button", { name: "Begin verifying" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Begin verifying" }));
    expect(screen.getByRole("heading", { name: "Government ID" })).toBeVisible();
    expect(screen.queryByText("Pass verifications")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "US government ID type" })).toBeVisible();
    expect(screen.getByText("US Driver’s License")).toBeInTheDocument();
    expect(screen.getByText("US State ID Card")).toBeInTheDocument();
    expect(screen.getByText("US Passport")).toBeInTheDocument();
    expect(screen.getByText("US Passport Card")).toBeInTheDocument();
    expect(screen.getByText("US Permanent Resident Card")).toBeInTheDocument();
    expect(screen.getByText("US Employment Authorization Card")).toBeInTheDocument();
    expect(screen.getByText("US Military ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Front side image image")).toBeInTheDocument();
    expect(screen.getByLabelText("Back side image image")).toBeInTheDocument();
    expect(screen.getByText("Upload and verify both front and back images to continue.")).toBeVisible();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "US government ID type" }), "passport");

    idFrameMode = "no-document";
    await userEvent.upload(screen.getByLabelText("Front side image image"), new File(["front"], "front.png", { type: "image/png" }));
    await waitFor(() => {
      expect(screen.getByText("We could not detect a supported US government ID. Put the document inside the frame and try again.")).toBeVisible();
    });
    expect(screen.queryByText("This ID looks good and matches your profile.")).not.toBeInTheDocument();

    idFrameMode = "valid";
    await userEvent.upload(screen.getByLabelText("Front side image image"), new File(["front"], "front-valid.png", { type: "image/png" }));
    await waitFor(() => {
      expect(screen.getByText("This looks like US Driver’s License, but you selected US Passport. Choose the correct document type or retake the photo.")).toBeVisible();
    });

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "US government ID type" }), "state-id");
    await userEvent.upload(screen.getByLabelText("Front side image image"), new File(["front"], "state-front.png", { type: "image/png" }));
    await waitFor(() => {
      expect(screen.getByText("This looks like US Driver’s License, but you selected US State ID Card. Choose the correct document type or retake the photo.")).toBeVisible();
    });

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "US government ID type" }), "drivers-license");
    await userEvent.upload(screen.getByLabelText("Front side image image"), new File(["front"], "dl-front.png", { type: "image/png" }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/identity-verification/analyze",
        expect.objectContaining({ method: "POST" })
      );
    });
    await userEvent.upload(screen.getByLabelText("Back side image image"), new File(["back"], "dl-back.png", { type: "image/png" }));
    await waitFor(() => {
      expect(screen.getAllByText("This ID looks good and matches your profile.").length).toBeGreaterThan(0);
    });

    const panel = screen.getAllByLabelText("Identity verification analysis")[0];
    expect(panel).toBeVisible();
    expect(panel).toHaveTextContent("Document analysis");
    expect(panel).toHaveTextContent("Eligible to continue");
    expect(panel).toHaveTextContent("Detected document");
    expect(panel).toHaveTextContent("Extracted fields");
    expect(panel).toHaveTextContent("Cross-field validation");
    expect(panel).toHaveTextContent("BACK_IMAGE_REQUIRED");

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Verify Profile Details" })).toBeVisible();
  });

  it("halts verification with structured DOCUMENT_TYPE_MISMATCH flag when selection differs from detected document", async () => {
    await reachW2Prompt();
    await userEvent.click(screen.getByRole("button", { name: "Start onboarding" }));
    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await userEvent.click(screen.getByRole("radio", { name: "Yes" }));
    await userEvent.click(screen.getByRole("button", { name: "Begin verifying" }));

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "US government ID type" }),
      "passport"
    );

    await userEvent.upload(screen.getByLabelText("Front side image image"), new File(["front"], "passport-front.png", { type: "image/png" }));

    const panel = await screen.findByLabelText("Identity verification analysis");
    expect(panel).toHaveTextContent("Verification halted");
    expect(panel).toHaveTextContent("DOCUMENT_TYPE_MISMATCH");
    expect(panel).toHaveTextContent("Human review required");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("rejects a busy camera scene with no ID instead of inventing OCR fields", async () => {
    await reachW2Prompt();
    await userEvent.click(screen.getByRole("button", { name: "Start onboarding" }));
    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await userEvent.click(screen.getByRole("radio", { name: "Yes" }));
    await userEvent.click(screen.getByRole("button", { name: "Begin verifying" }));

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "US government ID type" }),
      "state-id"
    );

    idFrameMode = "busy-scene";
    await userEvent.upload(screen.getByLabelText("Front side image image"), new File(["front"], "busy-front.png", { type: "image/png" }));

    expect(
      await screen.findByText("We could not detect a supported US government ID. Put the document inside the frame and try again.")
    ).toBeVisible();
    expect(screen.getByLabelText("Identity verification analysis")).toHaveTextContent("NO_DOCUMENT_DETECTED");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("accepts a cropped Permanent Resident Card as a document and rejects it for name mismatch", async () => {
    await reachW2Prompt();
    await userEvent.click(screen.getByRole("button", { name: "Start onboarding" }));
    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await userEvent.click(screen.getByRole("radio", { name: "Yes" }));
    await userEvent.click(screen.getByRole("button", { name: "Begin verifying" }));

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "US government ID type" }),
      "permanent-resident-card"
    );

    idFrameMode = "cropped-green-card";
    await userEvent.upload(screen.getByLabelText("Front side image image"), new File(["front"], "green-front.png", { type: "image/png" }));

    expect(screen.queryByText("We could not detect a supported US government ID. Put the document inside the frame and try again.")).not.toBeInTheDocument();
    expect((await screen.findAllByText(/Name mismatch: ID shows TEST SPECIMEN; profile says Lakshya Bhambhani/i))[0]).toBeVisible();

    const panel = screen.getByLabelText("Identity verification analysis");
    expect(panel).toHaveTextContent("US Permanent Resident Card");
    expect(panel).toHaveTextContent("NAME_MISMATCH");
    expect(panel).toHaveTextContent("Verification halted");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
});
