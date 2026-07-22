import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocationScreen } from "../client/src/App";

describe("location screen", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("allows selection of a US address suggestion before continuing", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          features: [
            {
              geometry: { coordinates: [-73.9857, 40.7484] },
              properties: {
                name: "350 5th Avenue",
                city: "New York",
                state: "New York",
                country: "United States",
                countrycode: "US"
              }
            }
          ]
        })
      })
    );

    function Harness() {
      const [address, setAddress] = useState("");
      return (
        <LocationScreen
          address={address}
          onChange={(value) => {
            onChange(value);
            setAddress(value);
          }}
          onNext={vi.fn()}
          onBack={vi.fn()}
        />
      );
    }

    render(<Harness />);

    const nextButton = screen.getByRole("button", { name: "Next" });
    expect(nextButton).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: "Search residential address" }), "350 5th");
    expect(nextButton).toBeDisabled();

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /350 5th avenue/i })).toBeVisible();
    });
    await user.click(screen.getByRole("option", { name: /350 5th avenue/i }));

    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("allows a manually entered apartment address when no exact suggestion exists", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [address, setAddress] = useState("");
      return (
        <LocationScreen
          address={address}
          onChange={setAddress}
          onNext={vi.fn()}
          onBack={vi.fn()}
        />
      );
    }

    render(<Harness />);
    await user.type(
      screen.getByRole("textbox", { name: "Search residential address" }),
      "895 Main St, Apt 12B, San Francisco, CA 94105"
    );

    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("offers a manual-entry option that keeps the typed address and closes the list", async () => {
    const user = userEvent.setup();
    const typed = "742 Evergreen Terrace, Apt 5, Springfield, IL 62704";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ features: [] }) })
    );

    function Harness() {
      const [address, setAddress] = useState("");
      return (
        <LocationScreen address={address} onChange={setAddress} onNext={vi.fn()} onBack={vi.fn()} />
      );
    }

    render(<Harness />);
    await user.type(screen.getByRole("textbox", { name: "Search residential address" }), typed);

    const useTyped = await screen.findByRole("button", { name: /use this address exactly as typed/i });
    await user.click(useTyped);

    expect(screen.getByRole("textbox", { name: "Search residential address" })).toHaveValue(typed);
    expect(screen.queryByRole("listbox", { name: "Address suggestions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("always opens the panel with guidance once typing, even when the geocoder returns nothing", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ features: [] }) })
    );

    function Harness() {
      const [address, setAddress] = useState("");
      return (
        <LocationScreen address={address} onChange={setAddress} onNext={vi.fn()} onBack={vi.fn()} />
      );
    }

    render(<Harness />);
    await user.type(screen.getByRole("textbox", { name: "Search residential address" }), "Hey");

    // The panel must appear (not stay hidden) and give the user a next step.
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Address suggestions" })).toBeVisible();
    });
    expect(await screen.findByText(/keep typing your full street address/i)).toBeVisible();
  });

  it("shows the complete I-9 and W-4 address guidance", () => {
    render(<LocationScreen address="" onChange={vi.fn()} onNext={vi.fn()} onBack={vi.fn()} />);

    expect(screen.getByText("Address consistency")).toBeVisible();
    expect(
      screen.getByText(
        "Enter your current U.S. residential address. It must be identical on your Form I-9 and Form W-4 — exactly the same, down to the apartment, unit, suite, floor, or lane number."
      )
    ).toBeVisible();
  });
});
