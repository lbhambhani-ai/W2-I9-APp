import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type N8nNode = {
  name: string;
  parameters?: {
    text?: string;
    jsCode?: string;
  };
};

const workflow = JSON.parse(readFileSync("I9 Folder/I9 final.json", "utf8")) as {
  nodes: N8nNode[];
};

function nodeText(name: string): string {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`Missing workflow node: ${name}`);
  return node.parameters?.text ?? node.parameters?.jsCode ?? "";
}

describe("I-9 document workflow", () => {
  it("keeps the supported expired LPR document exceptions in the verification prompts", () => {
    const primaryPrompt = nodeText("Analyze I9 Document");
    const fallbackPrompt = nodeText("Analyze I9 Document (Fallback)");

    for (const prompt of [primaryPrompt, fallbackPrompt]) {
      expect(prompt).toContain("expired-green-card-i797");
      expect(prompt).toContain("Form I-797 extension notice");
      expect(prompt).toContain("foreign-passport-i551-stamp");
      expect(prompt).toContain("ADIT stamp");
    }
  });

  it("supports expired EAD auto-extension in prompts and response formatting", () => {
    const primaryPrompt = nodeText("Analyze I9 Document");
    const fallbackPrompt = nodeText("Analyze I9 Document (Fallback)");
    const formatter = nodeText("Format I9 Response");

    for (const prompt of [primaryPrompt, fallbackPrompt]) {
      expect(prompt).toContain("EAD AUTO-EXTENSION");
      expect(prompt).toContain("Form I-766");
      expect(prompt).toContain("Form I-797C");
      expect(prompt).toContain("DOCUMENT_EXPIRED");
    }

    expect(formatter).toContain("isAutoExtendedEad");
    expect(formatter).toContain("DOCUMENT_EXPIRED");
    expect(formatter).toContain("employment-authorization-card");
  });

  it("includes I-9 expired document exception rules in both prompts", () => {
    const primaryPrompt = nodeText("Analyze I9 Document");
    const fallbackPrompt = nodeText("Analyze I9 Document (Fallback)");

    for (const prompt of [primaryPrompt, fallbackPrompt]) {
      expect(prompt).toContain("I-9 EXPIRED DOCUMENT EXCEPTION RULES");

      expect(prompt).toContain("I551_EXTENSION_NOTICE");
      expect(prompt).toContain("Permanent Resident Card");
      expect(prompt).toContain("Form I-797 Notice of Action");

      expect(prompt).toContain("ADIT_STAMP_ACCEPTED");
      expect(prompt).toContain("I-551/ADIT stamp");

      expect(prompt).toContain("RECEIPT_DOCUMENT_ACCEPTED");
      expect(prompt).toContain("Receipt for Lost, Stolen, or Damaged Documents");
      expect(prompt).toContain("90 days");
    }
  });

  it("lists all I-9 exception flag codes in the FLAG CODES section", () => {
    const primaryPrompt = nodeText("Analyze I9 Document");
    const fallbackPrompt = nodeText("Analyze I9 Document (Fallback)");

    const exceptionCodes = [
      "VENEZUELAN_PASSPORT_EXPIRY_BYPASS",
      "EAD_AUTO_EXTENSION",
      "I551_EXTENSION_NOTICE",
      "ADIT_STAMP_ACCEPTED",
      "RECEIPT_DOCUMENT_ACCEPTED",
    ];

    for (const prompt of [primaryPrompt, fallbackPrompt]) {
      for (const code of exceptionCodes) {
        expect(prompt).toContain(code);
      }
    }
  });

  it("formatter handles I-9 expiry exception flags as safety net", () => {
    const formatter = nodeText("Format I9 Response");

    expect(formatter).toContain("i9ExpiryExceptionCodes");
    expect(formatter).toContain("EAD_AUTO_EXTENSION");
    expect(formatter).toContain("I551_EXTENSION_NOTICE");
    expect(formatter).toContain("ADIT_STAMP_ACCEPTED");
    expect(formatter).toContain("RECEIPT_DOCUMENT_ACCEPTED");
    expect(formatter).toContain("VENEZUELAN_PASSPORT_EXPIRY_BYPASS");
    expect(formatter).toContain("hasExpiryException");
  });
});
