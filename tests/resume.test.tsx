import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../client/src/App";

async function reachResumeImport() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) }
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,captured-selfie");
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
}

async function reachReviewProfile() {
  await reachResumeImport();

  const resume = new File(["resume"], "lakshya-resume.pdf", { type: "application/pdf" });
  await userEvent.upload(screen.getByLabelText("Resume file"), resume);
  await userEvent.click(screen.getByRole("button", { name: "Continue with imported resume" }));
}

describe("resume import", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens a file input and records the selected resume file", async () => {
    await reachResumeImport();

    const resume = new File(["resume"], "lakshya-resume.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Resume file"), resume);

    expect(screen.getByText("lakshya-resume.pdf")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue with imported resume" })).toBeVisible();
  });

  it("keeps save profile after all review sections and supports uploading from review", async () => {
    await reachReviewProfile();

    const saveProfile = screen.getByRole("button", { name: "Save profile" });
    const certificates = screen.getByRole("heading", { name: "Certificates" });
    expect(
      certificates.compareDocumentPosition(saveProfile) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    const inputClick = vi.spyOn(HTMLInputElement.prototype, "click");
    await userEvent.click(screen.getByRole("button", { name: "Upload resume" }));
    expect(inputClick).toHaveBeenCalled();

    const updatedResume = new File(["updated"], "updated-resume.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });
    await userEvent.upload(screen.getByLabelText("Review profile resume file"), updatedResume);
    expect(screen.getByText("updated-resume.docx")).toBeVisible();
  });
});
