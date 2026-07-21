import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../client/src/App";

async function reachW2Prompt() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) }
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
    configurable: true,
    value: HTMLMediaElement.HAVE_CURRENT_DATA
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function getRect(this: Element) {
    const element = this as Element;
    if (element.classList.contains("camera-video")) {
      return { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600, toJSON: () => ({}) };
    }
    if (element.classList.contains("face-oval")) {
      return { x: 100, y: 120, left: 100, top: 120, right: 300, bottom: 420, width: 200, height: 300, toJSON: () => ({}) };
    }
    return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    getImageData: (_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4).fill(200);
      return { data };
    }
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,captured-selfie");

  class MockFaceDetector {
    async detect() {
      return [{ boundingBox: { x: 135, y: 170, width: 130, height: 170 } }];
    }
  }
  vi.stubGlobal("FaceDetector", MockFaceDetector);

  render(<App />);

  // Step 0: Profile Photo
  await userEvent.click(screen.getByRole("button", { name: "Upload profile photo" }));

  // Step 1: Selfie Camera
  await userEvent.click(screen.getByRole("button", { name: "Allow camera access" }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Capture selfie" })).toBeEnabled();
  });
  await userEvent.click(screen.getByRole("button", { name: "Capture selfie" }));

  // Step 2: DOB / Name / Contact
  await userEvent.type(screen.getByRole("textbox", { name: "Legal first name" }), "Test");
  await userEvent.type(screen.getByRole("textbox", { name: "Legal last name" }), "User");
  await userEvent.click(screen.getByRole("button", { name: "Open date of birth calendar" }));
  const dobOption = document.querySelector(".calendar-days button:not(:disabled)");
  expect(dobOption).toBeInstanceOf(HTMLButtonElement);
  await userEvent.click(dobOption as HTMLButtonElement);
  await userEvent.type(screen.getByRole("textbox", { name: "Email address" }), "test@example.com");
  await userEvent.type(screen.getByRole("textbox", { name: "Phone number" }), "+1 555 100 2000");
  await userEvent.click(screen.getByRole("button", { name: "Next" }));

  // Step 3: Residential address
  await userEvent.type(screen.getByRole("textbox", { name: "Search residential address" }), "895 Main");
  const addressOption = await screen.findByRole("option", {
    name: "895 Main St, San Francisco, CA 94105, USA"
  });
  await userEvent.click(addressOption);
  await userEvent.click(screen.getByRole("button", { name: "Next" }));

  // Step 4: W-2 Onboarding Prompt — we are now here
}

async function reachIdentityVerification() {
  await reachIdentityVerificationConsent();
  // Step 6: Document Validation Consent
  await userEvent.click(screen.getByRole("radio", { name: "Yes" }));
  await userEvent.click(screen.getByRole("button", { name: "Begin verifying" }));
  // Step 6: Government ID Upload
}

async function reachIdentityVerificationConsent() {
  await reachW2Prompt();
  // Step 4: W-2 Onboarding Prompt
  await userEvent.click(screen.getByRole("button", { name: "Start onboarding" }));
  // Step 5: W-2 Documentation Intro
  await userEvent.click(screen.getByRole("button", { name: "Get started" }));
}

describe("W-2 onboarding prompt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("matches the profile-tab W-2 start screen before onboarding", async () => {
    await reachW2Prompt();

    expect(screen.getByRole("heading", { name: "W-2 onboarding" })).toBeVisible();
    expect(screen.getByText(/Unlock more shifts/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Start onboarding" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Instawork tabs" })).toBeVisible();
    expect(screen.getByText("Profile")).toHaveAttribute("aria-current", "page");
    const startScreen = screen.getByLabelText("W-2 onboarding start");
    expect(startScreen.querySelector(".w2-start-content")).toHaveClass("no-scroll");
  });

  it("opens document validation after the W-2 documentation intro and requires yes consent", async () => {
    await reachIdentityVerification();

    expect(screen.getByRole("heading", { name: "Government-Issued ID" })).toBeVisible();
    const select = screen.getByRole("combobox", { name: "Government-issued ID type" });
    expect(select).toBeVisible();
  });

  it("shows simulation-only consent without regulated identity language", async () => {
    await reachIdentityVerificationConsent();

    expect(screen.getByRole("heading", { name: "Simulation Consent" })).toBeVisible();
    expect(screen.getByText(/we are not storing sensitive documents anywhere/i)).toBeVisible();
    expect(screen.queryByText(/English/i)).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp("bio" + "metric", "i"))).not.toBeInTheDocument();
  });
});
