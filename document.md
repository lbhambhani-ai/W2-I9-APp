# Instawork W-2 Onboarding and WorkBright Simulation - Product and Build Documentation

## 1. Product Description

This product is a Replit-hosted simulation of the Instawork Pro onboarding journey from the start of the app through the first two W-2 onboarding steps, followed by a simulated WorkBright upload and I-9 document flow.

The goal is to demonstrate a safer W-2 onboarding experience that prevents the most common downstream I-9, W-2, and tax-record failures before the pro reaches WorkBright. The app should make the user understand exactly which legal identity data is being used, compare that data against the uploaded identity document, and block or correct mistakes early.

The simulation should cover:

- Initial app onboarding and identity capture.
- Fetching the user's name from the initial app state.
- W-2 Step 1: identity verification using a Persona-like ID scan simulation.
- W-2 Step 2: profile confirmation for legal name, SSN, and DOB.
- A review-and-confirm checkpoint before the user proceeds.
- Document image validation through an n8n workflow that calls GPT using files uploaded from Google Drive.
- WorkBright handoff and simulated document upload.
- Error states for wrong document type, unclear images, name mismatch, SSN mismatch, DOB mismatch, duplicate SSN, and vertical ID scanning issues.

The product is not intended to connect to real Persona, WorkBright, SSA, DHS, or tax systems during the simulation. It should simulate those interactions with clear UI, deterministic test cases, and mock backend responses.

## 2. Product Goals

### Primary Goal

Reduce W-2 and I-9 rejection risk by validating legal identity data before the user submits forms to WorkBright.

### User Goals

- The pro can see the name captured from the initial app state.
- The pro can understand that the full legal name must match the identity card.
- The pro can enter SSN and DOB before moving forward.
- The pro can upload the correct document and receive clear feedback if the upload is wrong, unclear, or mismatched.
- The pro has one clear chance to edit W-2 Step 1 and Step 2 information before final confirmation.

### Business Goals

- Prevent name, SSN, and DOB mismatches before I-9 and W-2 forms are generated.
- Reduce support tickets caused by locked post-onboarding name and SSN fields.
- Prevent duplicate-account and duplicate-SSN edge cases from silently advancing.
- Make WorkBright simulation reliable enough to demo without manual explanation.

### Technical Goals

- Host the product on Replit.
- Build a clear React front end with a small backend API.
- Use mock data for the Persona and WorkBright stages.
- Use n8n as the automation layer for document validation.
- Use GPT through n8n to classify uploaded documents and extract name, SSN, DOB, document type, and image quality status.
- Include automated tests for the critical validation and flow-blocking logic.

## 3. Target Platform

The app should be hosted on Replit as a full-stack JavaScript or TypeScript app.

Recommended stack:

- Front end: React + Vite + TypeScript.
- Backend: Node.js + Express + TypeScript.
- Styling: Tailwind CSS or simple CSS modules.
- Test framework: Vitest for unit tests, Playwright for browser flow tests.
- File upload simulation: local browser upload, mocked Google Drive file references, or sample fixtures.
- Automation: n8n webhook endpoint.
- AI validation: GPT call inside n8n, returning structured JSON.

## 4. Main User Journey

### Stage 0 - App Start and Initial Identity State

The app starts with an initial pro identity object.

Example initial state:

```json
{
  "firstName": "Lakshya",
  "middleName": "",
  "lastName": "Bhambhani",
  "dateOfBirth": "1998-04-15",
  "email": "lakshya@example.com",
  "phone": "+1 555 010 9999",
  "accountId": "pro_mock_001"
}
```

The app should derive the displayed full name from this state.

The same initial name should later appear on W-2 Step 2 in grey helper text near the legal name field:

> Initial app name: Lakshya Bhambhani  
> Please enter your full legal name exactly as it appears on your identity card.

Recommended UI placement:

- Legal name input at the top.
- Grey helper text below the name input.
- Text should say: "Initial app name: Lakshya Bhambhani. Please put your full name as shown on your identity card."

This is better than appending the instruction in brackets inside the input because the helper text is easier to read and does not pollute the field value.

### Stage 1 - Basic Instawork Onboarding Simulation

The app should simulate the start of the Instawork Pro flow:

1. Profile photo.
2. Selfie or camera capture.
3. Date of birth.
4. Location.
5. Entry-level position selection.
6. Advanced position selection.
7. Resume import or skip.
8. Profile review and save.
9. Contractor agreement.
10. W-2 onboarding prompt.

The simulation can be linear and deterministic. The important requirement is that the user reaches the W-2 onboarding prompt with an initial identity state already present.

### Stage 2 - W-2 Step 1: Identity Verification

W-2 Step 1 simulates identity verification through Persona.

The user should:

1. Read the biometric consent screen.
2. Accept consent.
3. Upload or capture a government ID.
4. Complete a selfie/liveness simulation.
5. Wait for processing.

The system should simulate these Persona outcomes:

- Success.
- Camera permission denied.
- Vertical ID captured but misread.
- Bad image due to glare.
- Bad image due to focus.
- Bad image due to framing.
- Screenshot or photo of a photo detected.
- Wrong document type detected.
- Duplicate SSN or duplicate account detected.

The current problem is that Persona-like scanning may pass identity capture while later profile data silently diverges. The new product must connect Step 1 and Step 2 by carrying extracted OCR fields forward and comparing them against the user's confirmed profile data.

Required OCR output from Step 1:

```json
{
  "documentType": "drivers_license",
  "firstName": "Lakshya",
  "middleName": "",
  "lastName": "Bhambhani",
  "dateOfBirth": "1998-04-15",
  "documentNumber": "D1234567",
  "isOriginalPhysicalDocument": true,
  "imageQuality": "clear",
  "orientation": "horizontal",
  "confidence": 0.94
}
```

Vertical IDs must be accepted when the OCR confidence is high and the document type is valid. They should not be rejected only because they are vertical.

### Stage 3 - W-2 Step 2: Profile Confirmation

This step is the most important because it feeds I-9 Section 1 and W-2/ADP tax records.

Fields:

- Full legal first name.
- Middle name or middle initial, optional.
- Last name.
- Suffix, optional.
- Date of birth.
- SSN.
- Address.
- Email.
- Phone.

Name field behavior:

- The name from the initial app state should appear in grey helper text.
- The user must enter the full legal name exactly as shown on the ID.
- Middle name is optional.
- Matching should ignore middle name and middle initial.
- Matching should not ignore first name, last name, DOB, or SSN.
- Nicknames should fail. For example, Chris does not match Christopher.
- Missing suffix should warn or block depending on whether the uploaded ID contains the suffix.

SSN behavior:

- SSN can be typed by the user.
- Format should be validated as 9 digits.
- UI can display `XXX-XX-1234` after entry.
- Full SSN should not be shown again after confirmation.
- The backend simulation should store only a mock encrypted value or test-only value.

DOB behavior:

- Date picker should clearly use MM/DD/YYYY.
- The UI should show a format hint.
- The app should reject impossible dates, under-18 users, and common DD/MM swaps when detectable.

### Stage 4 - User Review and Edit Chance

Before moving to WorkBright, the user must see a confirmation screen for W-2 Steps 1 and 2.

The user gets one clear chance to edit:

- Identity document upload.
- Legal name.
- DOB.
- SSN.

The screen should say:

> Please review your W-2 identity information. After you confirm, this information will be used for your I-9 and W-2 tax records. Name and SSN changes may require support after submission.

Required actions:

- Edit Step 1.
- Edit Step 2.
- Confirm and continue.

If the user confirms and all validation passes, the app advances to WorkBright simulation.

If the user changes any field, validation must rerun.

## 5. n8n and GPT Document Validation Workflow

The scanner stage should use an n8n workflow that calls GPT with the uploaded document file.

### Input Source

The document file is uploaded or selected in the app. For the simulation, the file can be:

- Uploaded directly by the user in the browser.
- Selected from predefined test fixtures.
- Referenced as a Google Drive file URL or file ID.

n8n should retrieve the file from Google Drive and pass it to GPT for analysis.

### n8n Workflow

Recommended workflow:

1. Replit app sends document metadata and user-entered fields to an n8n webhook.
2. n8n receives:
   - Selected document type.
   - Google Drive file ID or uploaded file reference.
   - User legal first name.
   - User middle name, optional.
   - User last name.
   - User DOB.
   - User SSN.
   - Initial app name.
3. n8n fetches the file from Google Drive.
4. n8n calls GPT with the file and an extraction prompt.
5. GPT returns structured JSON only.
6. n8n normalizes and validates the JSON.
7. n8n returns a validation result to the Replit backend.
8. Replit backend returns the result to the UI.

### GPT Extraction Contract

GPT should return JSON in this shape:

```json
{
  "documentDetected": true,
  "documentType": "drivers_license",
  "isSelectedDocumentType": true,
  "isOriginalPhysicalDocument": true,
  "imageQuality": "clear",
  "imageQualityIssue": null,
  "firstName": "Lakshya",
  "middleName": "",
  "lastName": "Bhambhani",
  "suffix": "",
  "dateOfBirth": "1998-04-15",
  "ssnLast4": null,
  "fullSsnVisible": false,
  "confidence": 0.94,
  "warnings": [],
  "blockingErrors": []
}
```

For Social Security card uploads, the response may include SSN:

```json
{
  "documentDetected": true,
  "documentType": "social_security_card",
  "isSelectedDocumentType": true,
  "isOriginalPhysicalDocument": true,
  "imageQuality": "clear",
  "firstName": "Lakshya",
  "middleName": "",
  "lastName": "Bhambhani",
  "ssnLast4": "1234",
  "fullSsnVisible": true,
  "confidence": 0.91,
  "warnings": [],
  "blockingErrors": []
}
```

The app should not depend on GPT returning perfect data. The backend must validate the result and convert it into deterministic pass/fail states.

## 6. Validation Rules

### Document Type Validation

If the user selected one document type and uploaded another, show a red alert and ask for the correct image again.

Example:

> The uploaded document looks like a passport, but you selected Driver's License. Please upload the selected document type or change your selection.

### Image Quality Validation

If the image is unclear, blurry, dark, cropped, overexposed, or has glare, show a red alert and prompt the user to upload again.

Example:

> We could not read this image clearly. Please retake the photo in good lighting with the full document inside the frame.

### Original Physical Document Validation

Paper copies, screenshots, electronic replicas, or photos of photos should be rejected.

Example:

> This appears to be a screenshot, scan, or photo of a copy. Please upload a photo of the original physical ID.

### Legal Name Validation

The app compares the confirmed Step 2 name to the OCR name from Step 1.

Rules:

- First name must match exactly after trimming, case normalization, and punctuation cleanup.
- Last name must match exactly after trimming, case normalization, and punctuation cleanup.
- Middle name is optional and ignored for pass/fail.
- Suffix should be considered if present on the document.
- Nicknames do not pass.
- Maiden name does not pass unless it appears on the uploaded legal document.

Examples:

- Christopher Smith vs Chris Smith: fail.
- Lakshya A. Bhambhani vs Lakshya Bhambhani: pass because middle name is ignored.
- Maria Garcia Jr. vs Maria Garcia: warning or fail if suffix is on the ID and required for the record.

If name fails:

> Your legal name does not match the uploaded identity document. Please go back and correct your name before continuing.

### SSN Validation

SSN should be validated in three layers:

1. Format validation: exactly 9 digits.
2. Duplicate simulation: SSN is checked against mock existing accounts.
3. Document comparison: if an SSN card is uploaded, the SSN must match the entered SSN.

If SSN is wrong or mismatched:

> The SSN entered does not match the uploaded Social Security document. Please go back and correct your SSN before continuing.

If duplicate SSN is detected:

> This SSN is already associated with another Instawork account. Your W-2 onboarding cannot continue until support reviews the duplicate account issue.

Duplicate SSN behavior should simulate the real risk:

- Flag the new account.
- Block W-2 onboarding.
- Show support-resolution messaging.
- Do not proceed to WorkBright.

### DOB Validation

DOB must match OCR data from the uploaded identity document.

If DOB is wrong:

> Your date of birth does not match your identity document. Please go back and correct your date of birth.

The app should detect:

- Wrong year.
- Typo.
- MM/DD vs DD/MM swap when the date could be ambiguous.
- Under-18 user.

### Step 1 and Step 2 Connection

The app must not allow identity verification and profile confirmation to be disconnected.

Before WorkBright handoff, compare:

- Step 1 OCR first name vs Step 2 legal first name.
- Step 1 OCR last name vs Step 2 legal last name.
- Step 1 OCR DOB vs Step 2 DOB.
- Step 2 SSN vs uploaded SSN document if applicable.
- Step 2 SSN vs duplicate-account simulation.

If any blocking mismatch exists, the user goes back to the previous step.

## 7. WorkBright Simulation

After Step 1 and Step 2 are confirmed, the app should simulate uploading and completing required WorkBright forms.

Required WorkBright screens:

1. WorkBright terms and conditions.
2. WorkBright dashboard.
3. I-9 Phase 1: Personal Information.
4. I-9 Phase 2: Citizenship or immigration status.
5. I-9 Phase 3: Document selection.
6. I-9 Phase 4: Upload and OCR.
7. I-9 Phase 5: OCR review.
8. I-9 Phase 6: Sign and submit.

The WorkBright simulation should prefill I-9 personal information from the validated W-2 Step 2 data, not from unverified initial state.

Prefilled fields:

- Legal first name.
- Middle initial, optional.
- Last name.
- Other last names used, optional.
- Address.
- DOB.
- SSN, masked.
- Email.
- Phone.

The simulation should make it clear that the WorkBright section is a simulated handoff:

> WorkBright receives the confirmed legal identity data from W-2 onboarding. This simulation shows what would be uploaded and reviewed.

## 8. Product Plan

### Milestone 1 - Replit App Foundation

Build the base Replit app:

- React/Vite front end.
- Express backend.
- Shared TypeScript validation types.
- Basic routing for onboarding, W-2, validation, and WorkBright simulation.
- Mock identity state.
- Mock document fixtures.

Deliverable:

- App loads on Replit and shows the start of the onboarding flow.

### Milestone 2 - Instawork Onboarding Flow

Build the first part of the app:

- Profile photo simulation.
- DOB entry.
- Location screen.
- Position selection.
- Resume import or skip.
- Profile review and save.
- Contractor agreement.
- W-2 prompt.

Deliverable:

- User can reach W-2 onboarding with a stored initial name and DOB.

### Milestone 3 - W-2 Step 1 Identity Verification

Build Persona-like simulation:

- Consent screen.
- ID upload screen.
- Selfie/liveness screen.
- Processing screen.
- Mock OCR results.
- Error states for camera denial, vertical ID, unclear image, wrong type, screenshot/copy, and duplicate account.

Deliverable:

- Step 1 produces structured extracted identity data.

### Milestone 4 - W-2 Step 2 Profile Confirmation

Build profile confirmation:

- Legal name fields.
- Grey helper text showing initial app name.
- SSN entry.
- DOB entry.
- Address, email, phone.
- Review and edit screen.

Deliverable:

- Step 2 stores confirmed legal identity data and compares it against Step 1 OCR.

### Milestone 5 - n8n/GPT Validation Integration

Build integration:

- Backend endpoint to call n8n webhook.
- n8n workflow that fetches Google Drive file.
- GPT extraction prompt.
- Structured JSON response.
- Backend validation layer.
- UI alerts and retry prompts.

Deliverable:

- Uploaded document validation returns pass/fail with deterministic UI messages.

### Milestone 6 - WorkBright Simulation

Build WorkBright flow:

- Terms and dashboard.
- I-9 personal info.
- Citizenship selection.
- Document selection.
- Upload and OCR simulation.
- Review.
- Signature.
- Final pending-review status.

Deliverable:

- User can complete a simulated WorkBright upload only after W-2 Step 1 and 2 validation passes.

### Milestone 7 - Test Coverage and Demo Hardening

Add complete tests:

- Unit tests for validation rules.
- API tests for backend endpoints.
- UI flow tests for the happy path.
- UI flow tests for all critical failure paths.
- Fixture tests for document validation.

Deliverable:

- Demo can be run repeatedly without fragile manual setup.

## 9. Recommended Data Model

### Initial Identity

```ts
type InitialIdentity = {
  accountId: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  dateOfBirth?: string;
  email: string;
  phone: string;
};
```

### Step 1 OCR Result

```ts
type IdentityOcrResult = {
  documentDetected: boolean;
  documentType: string;
  selectedDocumentType: string;
  isSelectedDocumentType: boolean;
  isOriginalPhysicalDocument: boolean;
  imageQuality: "clear" | "unclear" | "glare" | "blur" | "cropped" | "dark";
  firstName?: string;
  middleName?: string;
  lastName?: string;
  suffix?: string;
  dateOfBirth?: string;
  ssnLast4?: string;
  fullSsnVisible?: boolean;
  confidence: number;
  warnings: string[];
  blockingErrors: string[];
};
```

### Step 2 Confirmed Profile

```ts
type ConfirmedW2Profile = {
  legalFirstName: string;
  legalMiddleName?: string;
  legalLastName: string;
  suffix?: string;
  dateOfBirth: string;
  ssn: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zip: string;
  email: string;
  phone: string;
};
```

### Validation Result

```ts
type ValidationResult = {
  status: "pass" | "warning" | "blocked";
  canProceedToWorkBright: boolean;
  warnings: string[];
  blockingErrors: string[];
  nextAction:
    | "continue"
    | "retry_document_upload"
    | "edit_profile"
    | "contact_support";
};
```

## 10. Critical Test Plan

### Happy Path Tests

- User starts app with initial name.
- User completes initial onboarding.
- User accepts W-2 identity consent.
- User uploads correct ID.
- OCR returns matching name and DOB.
- User enters matching legal name and SSN.
- User confirms review screen.
- User reaches WorkBright simulation.
- WorkBright I-9 is prefilled from confirmed W-2 data.
- User uploads matching document and signs successfully.

### Name Mismatch Tests

- Chris vs Christopher should block.
- Missing last name should block.
- Maiden name mismatch should block.
- Middle name missing should pass.
- Middle initial mismatch should not block.
- Suffix mismatch should warn or block based on configured rule.

### SSN Tests

- SSN with fewer than 9 digits should block.
- SSN with letters should block.
- SSN transposition should block when compared to SSN document.
- Duplicate SSN should block and show support message.
- SSN should be masked after entry.

### DOB Tests

- DOB mismatch should block.
- Wrong year should block.
- MM/DD vs DD/MM swap should warn or block.
- Under-18 DOB should block.

### Document Upload Tests

- Correct selected document type should pass.
- Passport uploaded when driver's license selected should block.
- Social Security card uploaded when passport selected should block.
- Unclear image should prompt retry.
- Glare image should prompt retry.
- Cropped image should prompt retry.
- Screenshot should block.
- Photo of a photo should block.
- Paper copy should block.
- Vertical ID should pass when confidence is high.
- Vertical ID should retry when OCR confidence is low.

### Step Connection Tests

- Step 1 OCR name and Step 2 confirmed name must be compared.
- Step 1 OCR DOB and Step 2 DOB must be compared.
- Step 2 SSN and uploaded SSN document must be compared when SSN document is used.
- User cannot proceed to WorkBright with any blocking error.
- Editing Step 1 or Step 2 reruns validation.

### WorkBright Tests

- WorkBright cannot open before W-2 Step 1 and 2 pass.
- WorkBright personal info uses confirmed profile data.
- WorkBright document selection blocks invalid citizenship/document combinations.
- WorkBright upload review shows extracted data.
- Missing required document expiry blocks submit.
- Signature is required before final submission.
- Final state shows pending admin review.

### n8n/GPT Integration Tests

- n8n webhook timeout shows retry message.
- GPT invalid JSON response is handled safely.
- GPT low-confidence response triggers manual retry.
- Google Drive missing file returns clear error.
- Google Drive permission error returns clear error.
- Backend never trusts GPT directly without validation.

## 11. UX Copy Requirements

### Legal Name Helper Text

Use below the name field:

> Initial app name: Lakshya Bhambhani. Please put your full legal name as shown on your identity card.

### Wrong Document Type

> The uploaded document does not match the selected document type. Please upload the correct document or change your selection.

### Unclear Image

> We could not read this image clearly. Please retake the photo in good lighting with the full document inside the frame.

### Screenshot or Copy

> This appears to be a screenshot, scan, paper copy, or photo of a photo. Please upload a photo of the original physical document.

### Name Mismatch

> Your legal name does not match the uploaded identity document. Please go back and correct your name before continuing.

### SSN Mismatch

> The SSN entered does not match the uploaded Social Security document. Please go back and correct your SSN before continuing.

### DOB Mismatch

> Your date of birth does not match your identity document. Please go back and correct your date of birth.

### Duplicate SSN

> This SSN is already associated with another Instawork account. W-2 onboarding is blocked until support reviews the duplicate account issue.

### Final Confirmation

> Please review your W-2 identity information. After you confirm, this information will be used for your I-9 and W-2 tax records. Name and SSN changes may require support after submission.

## 12. Definition of Done

The build is complete when:

- The app is hosted and accessible on Replit.
- The user can move from app start to W-2 Step 1.
- The user can complete W-2 Step 1 identity simulation.
- The user can complete W-2 Step 2 profile confirmation.
- The app displays the initial app name as grey helper text near the legal name field.
- The app validates name, DOB, SSN, document type, image quality, and duplicate SSN before WorkBright.
- The app prompts retry for unclear or wrong documents.
- The app sends document validation requests through n8n/GPT or a mock with the same response contract.
- The app simulates WorkBright upload and I-9 completion.
- The test suite covers happy path, mismatches, duplicates, unclear images, wrong document types, vertical IDs, and WorkBright blocking rules.

## 13. Important Product Decisions

- The WorkBright handoff must use confirmed W-2 Step 2 data, not raw initial profile data.
- Middle name is optional and ignored during name matching.
- First name and last name mismatches are blocking.
- SSN mismatches are blocking.
- DOB mismatches are blocking.
- Duplicate SSN is blocking and routes to support.
- Wrong document type is blocking.
- Unclear image is retryable.
- Screenshot, paper copy, and photo-of-photo documents are blocking.
- Vertical IDs should be supported, not automatically rejected.
- The simulation should use deterministic fixtures so demos and tests are stable.

## 14. Canvas Source-of-Truth and Inter-Relationship

The Replit build should be based on the three existing canvas artifacts. They are related but they do not serve the same purpose.

### `instawork-pro-onboarding-flow.canvas.tsx`

This is the narrative source of truth for the actual Instawork app journey before WorkBright.

It documents the in-app user experience from profile creation through W-2 Step 1 and Step 2. It includes:

- The 23-screen Instawork onboarding and W-2 path.
- The actual app-style screen names, copy, and branching notes.
- The Profile tab W-2 prompt.
- Persona biometric consent, government ID capture, selfie, liveness, and verification states.
- The "Verify Profile Details" screen.
- The dedicated "Add Your SSN" screen.
- The W-2 progress screen where Steps 1 and 2 become checked.
- Static documentation of the WorkBright I-9 phases.

This canvas should guide the user journey, screen sequence, and Instawork UI/UX requirements.

### `instawork-w2-full.canvas.tsx`

This is the combined source of truth for the full 30-step flow.

It connects:

- Instawork onboarding.
- W-2 setup.
- W-2 documentation.
- WorkBright handoff.
- Interactive WorkBright simulation.

It also defines the seven end-to-end phases:

1. Identity.
2. Preferences.
3. Profile Build.
4. Legal & Compliance.
5. W-2 Setup.
6. W-2 Documentation.
7. WorkBright.

This canvas should guide the Replit information architecture because it shows how Instawork onboarding and WorkBright belong in one continuous product flow.

### `workbright-simulation.canvas.tsx`

This is the standalone source of truth for the WorkBright simulation.

It includes:

- WorkBright loading state.
- Terms and conditions overlay.
- WorkBright forms dashboard.
- Five form types: AWS, E-Verify, I-9, State Tax, and W-4.
- I-9 personal information.
- Citizenship and immigration status.
- Document selection.
- Upload and OCR.
- OCR review.
- Electronic signature.
- Final form status changes.

This canvas should guide the WorkBright-specific UI, form status model, I-9 wizard behavior, and document validation messaging.

### Relationship Summary

The Replit app should combine all three canvases into one coherent product:

- Use `instawork-pro-onboarding-flow.canvas.tsx` for the real Instawork app onboarding and W-2 Step 1/2 flow.
- Use `instawork-w2-full.canvas.tsx` for the full end-to-end sequence and phase map.
- Use `workbright-simulation.canvas.tsx` for the interactive WorkBright/I-9 simulation after W-2 validation passes.

The app should not treat these as three separate products. They should become one connected journey where data collected in the Instawork phase is validated before the WorkBright phase opens.

## 15. Complete Screen-by-Screen User Journey

This section is the implementation-level journey that should be built on Replit.

### Phase A - Identity

#### Step 1 - Profile Photo

Purpose:

- Start the pro profile.
- Build trust before requesting camera/photo access.

UI requirements:

- Circular profile photo upload area.
- Friendly trust copy, similar to "Your profile picture is 100% safe with us."
- Primary action to upload or capture photo.

Data produced:

- `profilePhotoStatus: "uploaded" | "skipped" | "pending"`.

Validation:

- For simulation, allow success through a mock upload.
- If no photo is uploaded, the app may still continue if the demo mode allows it.

#### Step 2 - Camera / Selfie

Purpose:

- Simulate a camera capture screen.

UI requirements:

- Camera view.
- Face oval alignment guide.
- Shutter button.
- Retake option.

Data produced:

- `selfieCaptureStatus`.

Validation:

- Camera denied should show an access message.
- Retake should return to the same screen.

#### Step 3 - Date of Birth

Purpose:

- Capture DOB early in the onboarding flow.

UI requirements:

- Profile photo thumbnail.
- Date picker.
- Format hint: MM/DD/YYYY.
- Primary "Next" CTA.

Validation:

- Under 18 is blocked.
- Invalid dates are blocked.
- DOB is carried forward as initial profile data and later compared against W-2 Step 1 OCR and W-2 Step 2 confirmation.

### Phase B - Preferences

#### Step 4 - Location

Purpose:

- Capture location for nearby shifts.

UI requirements:

- Address input.
- Map preview with pin.
- Confirmation CTA.

Data produced:

- Address or city/state.

#### Step 5 - Entry-Level Positions

Purpose:

- Capture the first set of job interests.

UI requirements:

- Multi-select pill chips.
- At least one selected role.
- Examples: Concession / Stand Worker, Counter Staff / Cashier, Custodial, Driver, Event Setup and Takedown, General Labor, Warehouse Associate - Entry Level.

Validation:

- Block if no position is selected.

#### Step 6 - Advanced Positions

Purpose:

- Capture advanced experience categories.

UI requirements:

- Grouped, scrollable role list.
- Optional selections.
- Examples: Brand Ambassador, Security, Retail Merchandiser, Housekeeper, Forklift Driver, Warehouse Associate - Intermediate.

### Phase C - Profile Build

#### Step 7 - Resume Import

Purpose:

- Let the user import resume data or skip.

UI requirements:

- Primary "Import your resume" CTA.
- Secondary "Don't have a resume?" or skip link.

Branching:

- Import goes to auto-filled review.
- Skip goes to Review & Save Profile with empty sections.

#### Step 8 - Review & Save Profile

Purpose:

- Let the user review profile data before legal onboarding.

UI requirements:

- Profile photo.
- Name from initial app state.
- City or location.
- Sections for resume, professional summary, work experience, education, and certificates.
- Inline add/edit actions.
- Save profile CTA at the bottom.

Data produced:

- Initial app identity, including the user's name.

Critical requirement:

- The name shown here becomes the "initial app name" shown later as grey helper text on W-2 Step 2.

### Phase D - Legal & Compliance

#### Step 9 - Contractor Agreement

Purpose:

- Simulate legal acceptance before W-2 prompt.

UI requirements:

- Long agreement screen.
- Scroll-to-read behavior.
- Fixed footer while the user has not reached the bottom.
- "I accept" disabled until the user scrolls to the bottom.
- Back arrow returns to Review & Save Profile.

Validation:

- User cannot continue until agreement is accepted.

### Phase E - W-2 Setup

#### Step 10 - W-2 Onboarding Prompt

Purpose:

- Introduce W-2 onboarding from the Instawork Profile tab.

UI requirements:

- Screen appears inside the Instawork app shell.
- Bottom nav visible: Shifts, Jobs, My work, Messages, Profile.
- Profile tab active.
- Primary CTA: "Start onboarding."
- Dismiss option keeps user in app without W-2 completion.

#### Step 11 - W-2 Intro

Purpose:

- Explain what W-2 onboarding means.

UI requirements:

- AWS / Advantage Workforce Services explanation.
- Value props: more shifts from bigger partners, automatic tax withholding.
- FAQ link.
- Three-step W-2 progress explanation:
  1. Complete identity verification.
  2. Confirm your profile information.
  3. Submit required forms and complete document verification.
- Primary CTA: "Get started."

### Phase F - W-2 Documentation Step 1: Identity Verification

#### Step 12 - Biometric Consent Scroll

Purpose:

- Simulate Persona biometric consent.

UI requirements:

- Persona-style screen.
- "Verify your identity to start your W-2 process."
- Biometric Information Notice and Consent.
- Sections for collection, disclosure, retention, refusal, and revocation.
- Language selector.
- "Pass verifications" dev toggle may appear only in demo/admin mode.
- Secured with Persona copy.

Validation:

- User must scroll before acceptance controls become clear.

#### Step 13 - Biometric Consent Accept

Purpose:

- Capture consent decision.

UI requirements:

- "Do you give consent?" radio group.
- Yes and No options.
- "Begin verifying" CTA.

Branching:

- Yes continues to government ID capture.
- No blocks identity verification.

#### Step 14 - Government ID Camera Error

Purpose:

- Represent denied camera access.

UI requirements:

- Camera permission error.
- Copy: "Couldn't access camera. Please allow access to your device's camera."
- CTA to check camera settings.

Branching:

- User must grant access or choose upload fallback if the simulation supports it.

#### Step 15 - Government ID Camera Capture

Purpose:

- Capture or upload front of government ID.

UI requirements:

- Camera frame overlay.
- "Front of ID" label.
- Autocapture-on badge.
- Capture tips link.
- Shutter button.
- Retake option.

Validation cases:

- Horizontal ID success.
- Vertical ID success when readable.
- Vertical ID low-confidence retry.
- Glare retry.
- Blur retry.
- Cropped document retry.
- Screenshot/copy block.
- Wrong document type block.

#### Step 16 - Processing ID

Purpose:

- Simulate upload processing and OCR extraction.

UI requirements:

- Loading state.
- Copy that processing may take a few seconds.
- No manual user action.

Backend behavior:

- Calls mock validation or real n8n webhook.
- Receives structured OCR result.
- Stores Step 1 OCR result for Step 2 comparison.

#### Step 17 - Selfie Instructions

Purpose:

- Prepare user for selfie/liveness.

UI requirements:

- "Let's take a picture."
- Instructions to center face.
- Instructions to move face left and right.
- Good lighting guidance.
- No hats or face coverings guidance.
- Option to continue on another device can be simulated.

#### Step 18 - Selfie Capture

Purpose:

- Simulate selfie capture.

UI requirements:

- Oval crop or confirmation frame.
- Retake option.

#### Step 19 - Liveness - Look Left

Purpose:

- Simulate liveness anti-spoofing.

UI requirements:

- Circular camera view.
- Head-turn prompt: "Look slightly left."
- Direction indicator.
- Autocapture or "Take Photo" CTA.

#### Step 20 - Verifying

Purpose:

- Simulate final identity verification.

UI requirements:

- Progress indicator.
- "Verifying..." label.

Possible outcomes:

- Success moves to Step 21.
- Verification failure returns to the relevant retry step.
- Duplicate account or duplicate SSN blocks W-2 onboarding and routes to support.

### Phase G - W-2 Documentation Step 2: Profile Confirmation

#### Step 21 - Verify Profile Details

Purpose:

- Let the user confirm the legal data used for W-2, I-9, and tax records.

UI requirements:

- Clear title: "Verify profile details" or equivalent.
- Warning copy: this information may be passed to local, state, and federal governments.
- Editable fields with inline edit links.
- SSN row initially shows "None" until entered.
- SSN edit navigates to the dedicated SSN screen.

Required legal-name UI:

- Legal name input fields.
- Grey helper text below the name field:
  - "Initial app name: [Name from initial state]. Please put your full legal name as shown on your identity card."
- Helper text must not be inside the input value.

Validation:

- Legal first and last name must match Step 1 OCR.
- Middle name is optional and ignored.
- DOB must match Step 1 OCR.
- SSN format must be valid.
- If the document includes SSN, SSN must match.

#### Step 22 - Add Your SSN

Purpose:

- Collect SSN in a focused screen.

UI requirements:

- Dedicated page.
- Title: "Add your SSN."
- Subtitle: "US Federal Law requires us to collect an SSN for tax purposes."
- Input placeholder: XXX-XX-XXXX.
- Security message: "We do not perform credit checks, and your information is securely transmitted using SSL encryption."
- Save CTA in the top-right navigation area.

Validation:

- Exactly 9 digits.
- Allow hyphen formatting but normalize to digits.
- Mask SSN after save.
- Run duplicate SSN check.

#### Step 23 - W-2 Progress, Steps 1 and 2 Complete

Purpose:

- Show that identity verification and profile confirmation are complete.

UI requirements:

- Step 1 has a green filled checkmark.
- Step 2 has a green filled checkmark.
- Step 3 remains open.
- CTA changes to "Complete W-2 form."

Branching:

- CTA opens the WorkBright simulation.
- If validation was not completed, CTA must be disabled or blocked.

### Phase H - WorkBright and I-9

#### Step 24 - WorkBright Terms and Dashboard

Purpose:

- Simulate opening WorkBright after Instawork W-2 Steps 1 and 2.

UI requirements:

- Browser/webview styling.
- WorkBright domain-style header.
- Terms and conditions overlay.
- Agree action.
- Dashboard with required forms.

Forms:

- AWS Offer, Policies, and Arbitration Agreement.
- E-Verify Participation Notice.
- Form I-9.
- State Tax Form, California DE 4.
- W-4 Employee's Withholding Certificate.

#### Step 25 - I-9 Phase 1: Personal Info

Purpose:

- Prefill I-9 Section 1 personal data.

Required behavior:

- Use confirmed W-2 Step 2 data.
- Do not use unverified initial app data.
- SSN is masked.

#### Step 26 - I-9 Phase 2: Citizenship

Purpose:

- Capture citizenship or immigration attestation.

Options:

- U.S. citizen.
- Noncitizen national.
- Lawful permanent resident.
- Alien authorized to work.

Validation:

- Alien authorized to work requires work authorization expiration.
- Missing expiration blocks later submission.

#### Step 27 - I-9 Phase 3: Document Selection

Purpose:

- Select acceptable documents.

Rules:

- User can choose List A or List B + List C.
- Citizen plus Green Card should warn.
- Alien plus U.S. Passport should block.
- LPR plus EAD should warn.

#### Step 28 - I-9 Phase 4: Upload and OCR

Purpose:

- Simulate WorkBright document upload.

Required behavior:

- Upload uses the same validation principles as W-2 Step 1.
- Wrong document type blocks.
- Unclear image retries.
- OCR result is shown for review.

#### Step 29 - I-9 Phase 5: OCR Review

Purpose:

- Let user review extracted document data.

UI requirements:

- Show document title.
- Issuing authority.
- Document number.
- Expiration date.
- Warnings for missing or conflicting fields.

Validation:

- Missing expiry blocks when required.
- User cannot proceed with danger-level validation conflict.

#### Step 30 - I-9 Phase 6: Sign and Submit

Purpose:

- Simulate electronic signature.

UI requirements:

- Typed legal name.
- Signature pad or click-to-sign.
- Clear certification copy.
- Submit button.

Validation:

- Signature is required.
- Final state becomes pending admin review.

## 16. Instawork Actual App UI/UX Requirements

The Replit app should feel like the Instawork mobile app flow, even if it is implemented as a web simulation.

### Mobile-First Layout

- Use a centered mobile viewport for the Instawork app screens.
- Keep primary CTAs near the bottom.
- Use simple white backgrounds and strong spacing.
- Avoid dense desktop-style forms during the Instawork portion.
- Use progressive disclosure: one main task per screen.

### Navigation

- Before WorkBright, the user should feel inside the Instawork app.
- The W-2 prompt should appear on the Profile tab.
- Bottom nav labels should be: Shifts, Jobs, My work, Messages, Profile.
- Profile should be active when the W-2 prompt appears.
- Back actions should return to the previous logical app screen.

### Visual Components

- Pill chips for job position selection.
- Circular avatar/profile image.
- Face oval for camera/selfie capture.
- Map preview with pin for location.
- Long legal document with scroll requirement.
- Green checkmarks for completed W-2 steps.
- Grey helper text for non-editable contextual data.
- Red alert text for blocking validation errors.
- Yellow or neutral warnings for unusual but not blocking states.

### Copy Tone

The copy should be clear, reassuring, and direct.

Use:

- "Please put your full legal name as shown on your identity card."
- "We do not perform credit checks."
- "Your information is securely transmitted using SSL encryption."
- "This information may be passed to local, state, and federal governments to complete the W-2 process."

Avoid:

- Technical OCR language in user-facing errors.
- Ambiguous mismatch messages.
- Saying "AI failed" or "GPT failed" to the user.

### Error UX

Every blocking error must answer three questions:

1. What went wrong?
2. Why does it matter?
3. What should the user do next?

Examples:

- Wrong document type: tell the user what was selected and what appears to have been uploaded.
- Unclear image: ask for a retake in good lighting with the full document in frame.
- Name mismatch: send the user back to Step 2.
- SSN mismatch: send the user back to the SSN screen.
- Duplicate SSN: block and route to support.

### WorkBright UI Separation

The WorkBright section should feel like a handoff from Instawork.

Use:

- Browser/webview chrome.
- WorkBright dashboard styling.
- Form status badges.
- I-9 phase progress bar.
- Form list rows with statuses.

The user should understand that Instawork has completed Steps 1 and 2, and WorkBright is now handling Step 3 forms and document verification.

## 17. n8n Importable Workflow JSON Requirement

The build must include an accurate n8n workflow JSON file that can be imported directly into n8n.

Required file:

```text
n8n/instawork-w2-document-validation.workflow.json
```

The workflow JSON must be:

- Valid JSON with no comments.
- Importable through the n8n UI.
- Versioned with the app.
- Built against the actual n8n node schema used by the target n8n version.
- Configured with placeholder credential names, not real secrets.
- Tested by importing it into n8n before demo.

### Workflow Purpose

The workflow receives an upload validation request from the Replit backend, fetches the uploaded image or file from Google Drive, calls GPT to classify and extract document data, normalizes the result, and returns deterministic validation JSON to the app.

### Required n8n Nodes

Minimum node sequence:

1. Webhook Trigger - receives validation request.
2. Input Validator / Function - checks required fields.
3. Google Drive - downloads the file by file ID.
4. GPT / OpenAI - analyzes the uploaded file.
5. JSON Parser / Function - parses GPT output.
6. Validation Function - applies deterministic business rules.
7. Respond to Webhook - returns result to Replit.

Optional nodes:

- Error Trigger or error branch.
- Set node for normalized fields.
- IF nodes for missing file, low confidence, wrong document type, or duplicate SSN.
- Logging node for demo-only debug output.

### Webhook Request Contract

The Replit backend sends:

```json
{
  "requestId": "validation_001",
  "accountId": "pro_mock_001",
  "stage": "w2_step_1",
  "selectedDocumentType": "drivers_license",
  "googleDriveFileId": "GOOGLE_DRIVE_FILE_ID",
  "initialAppName": {
    "firstName": "Lakshya",
    "middleName": "",
    "lastName": "Bhambhani"
  },
  "confirmedProfile": {
    "legalFirstName": "Lakshya",
    "legalMiddleName": "",
    "legalLastName": "Bhambhani",
    "dateOfBirth": "1998-04-15",
    "ssn": "123456789"
  },
  "simulationFlags": {
    "duplicateSsnCheck": true,
    "allowVerticalId": true,
    "rejectScreenshots": true
  }
}
```

### Webhook Response Contract

n8n returns:

```json
{
  "requestId": "validation_001",
  "status": "pass",
  "canProceed": true,
  "nextAction": "continue",
  "extractedDocument": {
    "documentDetected": true,
    "documentType": "drivers_license",
    "selectedDocumentType": "drivers_license",
    "isSelectedDocumentType": true,
    "isOriginalPhysicalDocument": true,
    "imageQuality": "clear",
    "orientation": "vertical",
    "firstName": "Lakshya",
    "middleName": "",
    "lastName": "Bhambhani",
    "suffix": "",
    "dateOfBirth": "1998-04-15",
    "ssnLast4": null,
    "confidence": 0.94
  },
  "warnings": [],
  "blockingErrors": []
}
```

### Required Failure Responses

Wrong document type:

```json
{
  "status": "blocked",
  "canProceed": false,
  "nextAction": "retry_document_upload",
  "warnings": [],
  "blockingErrors": [
    {
      "code": "WRONG_DOCUMENT_TYPE",
      "message": "The uploaded document does not match the selected document type."
    }
  ]
}
```

Unclear image:

```json
{
  "status": "blocked",
  "canProceed": false,
  "nextAction": "retry_document_upload",
  "warnings": [],
  "blockingErrors": [
    {
      "code": "IMAGE_UNCLEAR",
      "message": "We could not read this image clearly. Please retake the photo."
    }
  ]
}
```

Name mismatch:

```json
{
  "status": "blocked",
  "canProceed": false,
  "nextAction": "edit_profile",
  "warnings": [],
  "blockingErrors": [
    {
      "code": "LEGAL_NAME_MISMATCH",
      "message": "The confirmed legal name does not match the uploaded identity document."
    }
  ]
}
```

Duplicate SSN:

```json
{
  "status": "blocked",
  "canProceed": false,
  "nextAction": "contact_support",
  "warnings": [],
  "blockingErrors": [
    {
      "code": "DUPLICATE_SSN",
      "message": "This SSN is already associated with another Instawork account."
    }
  ]
}
```

### GPT Prompt Requirements

The GPT prompt inside n8n must instruct the model to:

- Return JSON only.
- Classify the document type.
- Decide whether the uploaded document matches the selected document type.
- Extract first name, middle name, last name, suffix, DOB, and SSN only when visible.
- Detect whether the image appears to be an original physical document.
- Detect screenshot, paper copy, scan, photo of a photo, or electronic replica.
- Detect glare, blur, darkness, cropping, and low readability.
- Identify vertical IDs without rejecting them by default.
- Return confidence scores.
- Avoid guessing when fields are unclear.

The backend must still validate the GPT result. GPT output is evidence, not the final authority.

### n8n Workflow JSON Skeleton

The final implementation should replace this skeleton with a real n8n export from the target n8n version.

```json
{
  "name": "Instawork W-2 Document Validation",
  "nodes": [
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "instawork-w2-document-validation",
        "responseMode": "responseNode"
      },
      "id": "Webhook_ValidateDocument",
      "name": "Validate Document Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [0, 0]
    },
    {
      "parameters": {
        "jsCode": "const body = $json.body || $json; const required = ['requestId','accountId','selectedDocumentType','googleDriveFileId','confirmedProfile']; const missing = required.filter((key) => !body[key]); if (missing.length) { return [{ json: { status: 'blocked', canProceed: false, nextAction: 'retry_document_upload', blockingErrors: missing.map((key) => ({ code: 'MISSING_FIELD', message: `Missing required field: ${key}` })) } }]; } return [{ json: body }];"
      },
      "id": "Code_ValidateInput",
      "name": "Validate Input",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [240, 0]
    },
    {
      "parameters": {
        "operation": "download",
        "fileId": "={{ $json.googleDriveFileId }}"
      },
      "id": "GoogleDrive_DownloadFile",
      "name": "Download Google Drive File",
      "type": "n8n-nodes-base.googleDrive",
      "typeVersion": 3,
      "position": [480, 0],
      "credentials": {
        "googleDriveOAuth2Api": {
          "id": "REPLACE_WITH_CREDENTIAL_ID",
          "name": "Google Drive account"
        }
      }
    },
    {
      "parameters": {
        "resource": "chat",
        "operation": "message",
        "model": "gpt-4.1-mini",
        "messages": {
          "values": [
            {
              "role": "system",
              "content": "You extract identity-document data for a W-2 onboarding simulation. Return JSON only. Do not guess unclear fields."
            },
            {
              "role": "user",
              "content": "Analyze the uploaded document. Return documentDetected, documentType, isSelectedDocumentType, isOriginalPhysicalDocument, imageQuality, firstName, middleName, lastName, suffix, dateOfBirth, ssnLast4, fullSsnVisible, confidence, warnings, and blockingErrors. Selected document type: {{ $json.selectedDocumentType }}."
            }
          ]
        },
        "jsonOutput": true
      },
      "id": "OpenAI_ExtractDocument",
      "name": "Extract Document With GPT",
      "type": "n8n-nodes-base.openAi",
      "typeVersion": 1,
      "position": [720, 0],
      "credentials": {
        "openAiApi": {
          "id": "REPLACE_WITH_CREDENTIAL_ID",
          "name": "OpenAI account"
        }
      }
    },
    {
      "parameters": {
        "jsCode": "const result = $json; const errors = []; const warnings = []; if (!result.documentDetected) errors.push({ code: 'NO_DOCUMENT_DETECTED', message: 'No supported identity document was detected.' }); if (result.isSelectedDocumentType === false) errors.push({ code: 'WRONG_DOCUMENT_TYPE', message: 'The uploaded document does not match the selected document type.' }); if (result.imageQuality && result.imageQuality !== 'clear') errors.push({ code: 'IMAGE_UNCLEAR', message: 'We could not read this image clearly. Please retake the photo.' }); if (result.isOriginalPhysicalDocument === false) errors.push({ code: 'NOT_ORIGINAL_PHYSICAL_DOCUMENT', message: 'Please upload a photo of the original physical document.' }); const status = errors.length ? 'blocked' : warnings.length ? 'warning' : 'pass'; return [{ json: { status, canProceed: status !== 'blocked', nextAction: status === 'blocked' ? 'retry_document_upload' : 'continue', extractedDocument: result, warnings, blockingErrors: errors } }];"
      },
      "id": "Code_ApplyBusinessRules",
      "name": "Apply Business Rules",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [960, 0]
    },
    {
      "parameters": {
        "respondWith": "json",
        "responseBody": "={{ $json }}"
      },
      "id": "Respond_ReturnValidation",
      "name": "Return Validation Result",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1,
      "position": [1200, 0]
    }
  ],
  "connections": {
    "Validate Document Webhook": {
      "main": [
        [
          {
            "node": "Validate Input",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Validate Input": {
      "main": [
        [
          {
            "node": "Download Google Drive File",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Download Google Drive File": {
      "main": [
        [
          {
            "node": "Extract Document With GPT",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Extract Document With GPT": {
      "main": [
        [
          {
            "node": "Apply Business Rules",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Apply Business Rules": {
      "main": [
        [
          {
            "node": "Return Validation Result",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "active": false,
  "settings": {
    "executionOrder": "v1"
  },
  "versionId": "replace-after-real-export"
}
```

Important: the skeleton above documents the required shape, but the production-ready file must be exported from n8n after credentials, binary file handling, and OpenAI file/image input configuration are verified. The final JSON must be tested by importing it into n8n, running a sample Google Drive file, and confirming the exact response contract.

## 18. Expanded Build Acceptance Criteria

The Replit build should be accepted only when all of these are true:

- The screen order matches the 30-step journey from Instawork onboarding to WorkBright submission.
- The app explains W-2 onboarding before asking for sensitive data.
- The app shows initial app name as contextual grey helper text during legal-name confirmation.
- Step 1 Persona-like OCR data is stored and connected to Step 2 confirmation data.
- Step 2 cannot silently diverge from Step 1.
- Middle name is optional and ignored during name matching.
- First name, last name, DOB, and SSN mismatches block the flow.
- Duplicate SSN blocks the flow and routes to support.
- Wrong document type blocks and prompts upload again.
- Unclear image prompts upload again.
- Screenshot/copy/photo-of-photo blocks.
- Vertical IDs are supported when readable.
- WorkBright cannot open until W-2 Steps 1 and 2 are valid.
- WorkBright I-9 personal information is filled from confirmed W-2 Step 2 data.
- WorkBright upload and OCR are simulated.
- WorkBright final status becomes pending admin review after signature.
- The n8n workflow JSON exists, imports successfully, and returns the documented response contract.
- Unit, API, and browser flow tests cover the main happy path and all critical failure paths.

