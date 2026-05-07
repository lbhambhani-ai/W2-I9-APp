import { expect, test } from "@playwright/test";

test("completes the W-2 and WorkBright happy path", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Hey Lakshya, let’s add your profile photo" })).toBeVisible();
  await page.getByRole("button", { name: "Upload profile photo" }).click();
  await page.getByRole("button", { name: "Capture selfie" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Import your resume" }).click();
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Continue to W-2" }).click();

  await expect(page.getByText("Initial app name: Lakshya Bhambhani")).toBeVisible();
  await page.getByRole("button", { name: "Save SSN" }).click();
  await page.getByRole("button", { name: "Validate W-2 profile" }).click();
  await expect(page.getByText("W-2 validation passed")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect(page.getByRole("heading", { name: "WorkBright Dashboard" })).toBeVisible();

  await page.getByRole("button", { name: "Start Form I-9" }).click();
  await expect(page.getByText("Lakshya Bhambhani")).toBeVisible();
  await page.getByRole("button", { name: "Continue to citizenship" }).click();
  await page.getByRole("button", { name: "Select documents" }).click();
  await page.getByRole("button", { name: "Upload passport fixture" }).click();
  await page.getByRole("button", { name: "Review OCR" }).click();
  await page.getByRole("button", { name: "Sign and submit" }).click();

  await expect(page.getByText("Pending admin review")).toBeVisible();
});

test("shows duplicate SSN support block", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Upload profile photo" }).click();
  await page.getByRole("button", { name: "Capture selfie" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Import your resume" }).click();
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Continue to W-2" }).click();
  await page.getByLabel("SSN").fill("987-65-4321");
  await page.getByRole("button", { name: "Save SSN" }).click();
  await page.getByRole("button", { name: "Validate W-2 profile" }).click();

  await expect(page.getByText("W-2 onboarding is blocked until support reviews the duplicate account issue.")).toBeVisible();
});
