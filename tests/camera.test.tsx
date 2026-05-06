import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mediaPipeMock = vi.hoisted(() => ({
  detections: [] as Array<{ boundingBox: { originX: number; originY: number; width: number; height: number } }>,
  forVisionTasks: vi.fn().mockResolvedValue({}),
  createFromOptions: vi.fn()
}));

vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: {
    forVisionTasks: mediaPipeMock.forVisionTasks
  },
  FaceDetector: {
    createFromOptions: mediaPipeMock.createFromOptions
  }
}));

import { App } from "../client/src/App";

describe("real camera onboarding step", () => {
  beforeEach(() => {
    mediaPipeMock.detections = [];
    mediaPipeMock.createFromOptions.mockReset();
    mediaPipeMock.createFromOptions.mockResolvedValue({
      detectForVideo: () => ({ detections: mediaPipeMock.detections })
    });
    mediaPipeMock.forVisionTasks.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks for browser camera permission before showing the face oval", async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia }
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Upload profile photo" }));
    expect(screen.getByRole("heading", { name: "Use your camera to take your profile selfie" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Allow camera access" }));

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 }
        }
      });
    });
    await waitFor(() => {
      expect(screen.getByText("No face detected. Move into the oval")).toBeVisible();
    });
    expect(screen.getByRole("button", { name: "Capture selfie" })).toBeDisabled();
  });

  it("blocks capture until face detection says the face is inside the oval", async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) }
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
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

    let aligned = false;
    class MockFaceDetector {
      async detect() {
        return [
          {
            boundingBox: aligned
              ? { x: 135, y: 170, width: 130, height: 170 }
              : { x: 5, y: 5, width: 80, height: 80 }
          }
        ];
      }
    }
    vi.stubGlobal("FaceDetector", MockFaceDetector);

    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Upload profile photo" }));
    await userEvent.click(screen.getByRole("button", { name: "Allow camera access" }));

    await waitFor(() => {
      expect(screen.getByText("Move your face into the oval")).toBeVisible();
    });
    expect(screen.getByRole("button", { name: "Capture selfie" })).toBeDisabled();

    aligned = true;

    await waitFor(
      () => {
        expect(screen.getByRole("button", { name: "Capture selfie" })).toBeEnabled();
      },
      { timeout: 4000 }
    );
  });

  it("uses MediaPipe fallback when the browser has no native FaceDetector", async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) }
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    mediaPipeMock.detections = [{ boundingBox: { originX: 135, originY: 170, width: 130, height: 170 } }];
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

    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Upload profile photo" }));
    await userEvent.click(screen.getByRole("button", { name: "Allow camera access" }));

    await waitFor(() => {
      expect(mediaPipeMock.forVisionTasks).toHaveBeenCalled();
      expect(mediaPipeMock.createFromOptions).toHaveBeenCalled();
      expect(screen.getByText("Face aligned. Hold still and capture.")).toBeVisible();
    });
    expect(screen.getByRole("button", { name: "Capture selfie" })).toBeEnabled();
  });

  it("uses the captured selfie on the date-of-birth profile circle", async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) }
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,captured-selfie");
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

    expect(screen.getByRole("heading", { name: "Confirm your legal name and date of birth" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Legal first name" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Legal last name" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Open date of birth calendar" })).toHaveTextContent("MM/DD/YYYY");
    expect(screen.getByAltText("Captured profile selfie")).toHaveAttribute("src", "data:image/png;base64,captured-selfie");
    expect(screen.getByRole("button", { name: "Open date of birth calendar" })).toBeVisible();
  });

  it("does not offer under-18 years in the custom date picker", async () => {
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

    const under18Year = String(new Date().getFullYear() - 17);
    expect(screen.getByRole("combobox", { name: "Year" })).not.toHaveTextContent(under18Year);
    await userEvent.click(screen.getByRole("button", { name: /September 15,/ }));
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("uses a custom date picker instead of the browser default calendar", async () => {
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

    await userEvent.click(screen.getByRole("button", { name: "Open date of birth calendar" }));

    expect(screen.getByRole("dialog", { name: "Choose date of birth" })).toBeVisible();
    expect(screen.getByRole("button", { name: "September 15, 2003" })).toHaveClass("selected");
  });
});
