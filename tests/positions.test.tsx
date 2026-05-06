import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../client/src/App";

async function reachEntryPositions() {
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
}

describe("position selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("allows any entry-level position chip to be selected and unselected", async () => {
    await reachEntryPositions();

    expect(screen.getByRole("heading", { name: "You will have access to these entry-level positions" }).closest("section")).toHaveClass(
      "entry-positions-screen"
    );
    const cashier = screen.getByRole("button", { name: "Counter Staff / Cashier" });
    await userEvent.click(cashier);
    expect(cashier).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(cashier);
    expect(cashier).toHaveAttribute("aria-pressed", "false");
  });

  it("allows advanced position chips to be selected", async () => {
    await reachEntryPositions();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    const security = screen.getByRole("button", { name: "Security" });
    await userEvent.click(security);
    expect(security).toHaveAttribute("aria-pressed", "true");
  });

  it("shows selectable cleaning and maintenance options", async () => {
    await reachEntryPositions();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("Cleaning and maintenance")).toBeVisible();
    const eventCleaner = screen.getByRole("button", { name: "Event Cleaner" });
    await userEvent.click(eventCleaner);
    expect(eventCleaner).toHaveAttribute("aria-pressed", "true");
  });
});
