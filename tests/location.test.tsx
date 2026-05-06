import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../client/src/App";

describe("location onboarding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("populates address suggestions as the user types and fills the selected address", async () => {
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

    await userEvent.clear(screen.getByLabelText("Address"));
    await userEvent.type(screen.getByLabelText("Address"), "895 main");

    expect(screen.getByRole("listbox", { name: "Address suggestions" })).toBeVisible();
    await userEvent.click(screen.getByRole("option", { name: "895 Main St, San Francisco, CA 94105, USA" }));

    expect(screen.getByLabelText("Address")).toHaveValue("895 Main St, San Francisco, CA 94105, USA");
    expect(screen.getByText("San Francisco")).toBeVisible();
  });

  it("fetches real autocomplete-style suggestions for broader place searches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          {
            properties: {
              name: "University of Texas at Austin",
              street: "University Avenue",
              city: "Austin",
              state: "Texas",
              country: "United States"
            }
          },
          {
            properties: {
              name: "University of Texas at Dallas",
              city: "Richardson",
              state: "Texas",
              country: "United States"
            }
          }
        ]
      })
    });
    vi.stubGlobal("fetch", fetchMock);
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

    await userEvent.clear(screen.getByLabelText("Address"));
    await userEvent.type(screen.getByLabelText("Address"), "University of Texas");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      expect(screen.getByRole("option", { name: "University of Texas at Austin, University Avenue, Austin, Texas, United States" })).toBeVisible();
    });
    await userEvent.click(screen.getByRole("option", { name: "University of Texas at Austin, University Avenue, Austin, Texas, United States" }));

    expect(screen.getByLabelText("Address")).toHaveValue("University of Texas at Austin, University Avenue, Austin, Texas, United States");
    expect(screen.getByText("Austin")).toBeVisible();
  });
});
