import { describe, expect, it } from "vitest";
import { evaluateOkf, isOkfConceptPath } from "../src/okf";

const CANONICAL_BODY = `---
type: Company Record
title: Incorporation
description: "Legal registration of the company: name, jurisdiction, number, date."
generated: { by: "process:pack-seed", at: "2026-08-13T00:00:00Z" }
sources:
  - resource: /references/certificate-of-incorporation.pdf
    title: Certificate of incorporation
status: draft
tags: [company, registry]
---
# Details

| Field | Value |
|---|---|
| Legal name | Acme Ltd |
`;

describe("isOkfConceptPath", () => {
  it("accepts markdown concept files", () => {
    expect(isOkfConceptPath("incorporation.md", "text/markdown")).toBe(true);
    expect(isOkfConceptPath("policies/expense-policy.md", "text/markdown")).toBe(true);
  });

  it("exempts non-markdown content", () => {
    expect(isOkfConceptPath("contract.pdf", "application/pdf")).toBe(false);
    expect(isOkfConceptPath("notes.txt", "text/plain")).toBe(false);
  });

  it("exempts originals under a references directory at any depth", () => {
    expect(isOkfConceptPath("references/filing.md", "text/markdown")).toBe(false);
    expect(isOkfConceptPath("legal/references/contract.md", "text/markdown")).toBe(false);
    // A file merely named references.md is a normal concept file.
    expect(isOkfConceptPath("references.md", "text/markdown")).toBe(true);
  });

  it("exempts reserved filenames at any level", () => {
    expect(isOkfConceptPath("index.md", "text/markdown")).toBe(false);
    expect(isOkfConceptPath("log.md", "text/markdown")).toBe(false);
    expect(isOkfConceptPath("metrics/index.md", "text/markdown")).toBe(false);
  });
});

describe("evaluateOkf", () => {
  it("passes a fully conformant canonical file", () => {
    let result = evaluateOkf(CANONICAL_BODY);
    expect(result.issues).toEqual([]);
    expect(result.strictIssues).toEqual([]);
    expect(result.type).toBe("Company Record");
    expect(result.status).toBe("draft");
  });

  it("passes baseline with type alone, flagging only strict requirements", () => {
    let result = evaluateOkf("---\ntype: Note\n---\nHello.\n");
    expect(result.issues).toEqual([]);
    expect(result.type).toBe("Note");
    expect(result.status).toBeUndefined();
    expect(result.strictIssues).toHaveLength(5);
  });

  it("flags a missing frontmatter block", () => {
    let result = evaluateOkf("# Just markdown\n");
    expect(result.issues).toEqual(["Missing YAML frontmatter."]);
    expect(result.type).toBeUndefined();
  });

  it("flags unparseable YAML", () => {
    let result = evaluateOkf("---\ntype: [unclosed\n---\nBody.\n");
    expect(result.issues).toEqual(["Frontmatter is not valid YAML."]);
  });

  it("flags non-mapping frontmatter", () => {
    let result = evaluateOkf("---\n- just\n- a list\n---\nBody.\n");
    expect(result.issues).toEqual(["Frontmatter must be a YAML mapping."]);
  });

  it("flags a missing or empty type", () => {
    expect(evaluateOkf("---\ntitle: No type\n---\nBody.\n").issues)
        .toEqual(["Missing required `type` field."]);
    expect(evaluateOkf("---\ntype: '  '\n---\nBody.\n").issues)
        .toEqual(["Missing required `type` field."]);
  });

  it("tolerates unknown keys and unknown types without issues", () => {
    let result = evaluateOkf(
        "---\ntype: Attested Widget\ncustom_key: { nested: true }\n---\nBody.\n");
    expect(result.issues).toEqual([]);
    expect(result.type).toBe("Attested Widget");
  });

  it("treats an unknown status as unset and strict-flags it", () => {
    let result = evaluateOkf("---\ntype: Note\nstatus: published\n---\nBody.\n");
    expect(result.status).toBeUndefined();
    expect(result.strictIssues).toContain(
        "Canonical files must set `status` explicitly (draft | stable | deprecated).");
  });

  it("requires sources entries to carry a resource", () => {
    let result = evaluateOkf(
        "---\ntype: Note\nsources:\n  - title: No resource here\n---\nBody.\n");
    expect(result.strictIssues).toContain(
        "Canonical files require at least one `sources` entry with a `resource`.");
  });

  it("requires generated to be a complete actor stamp", () => {
    let result = evaluateOkf("---\ntype: Note\ngenerated: { by: \"human:allan\" }\n---\nBody.\n");
    expect(result.strictIssues).toContain("Canonical files require `generated: { by, at }`.");
  });

  it("handles BOM and CRLF line endings", () => {
    let body = "\uFEFF---\r\ntype: Note\r\n---\r\nBody.\r\n";
    let result = evaluateOkf(body);
    expect(result.issues).toEqual([]);
    expect(result.type).toBe("Note");
  });
});
