import { describe, expect, it } from "vitest";
import { appendVerification, deriveOkfTier, evaluateOkf, removeVerification } from "../src/okf";
import { generateIndexMarkdown } from "../src/okf-system-files";

const CHANGE = new Date("2026-08-14T10:00:00Z");
const BEFORE = "2026-08-13T10:00:00Z";
const AFTER = "2026-08-14T10:00:00Z";

describe("deriveOkfTier", () => {
  it("is unverified without stamps and when all stamps predate the content change", () => {
    expect(deriveOkfTier(undefined, CHANGE)).toBe("unverified");
    expect(deriveOkfTier([{ by: "human:allan", at: BEFORE }], CHANGE)).toBe("unverified");
  });

  it("treats human: and account: actors as human-grade", () => {
    expect(deriveOkfTier([{ by: "human:allan", at: AFTER }], CHANGE)).toBe("human-reviewed");
    expect(deriveOkfTier([{ by: "account:abc123", at: AFTER }], CHANGE)).toBe("human-reviewed");
  });

  it("grades non-human actors as machine-confirmed and ignores unparseable stamps", () => {
    expect(deriveOkfTier([{ by: "process:knowledge-lint", at: AFTER }], CHANGE))
        .toBe("machine-confirmed");
    expect(deriveOkfTier([{ by: "human:allan", at: "not-a-date" }], CHANGE)).toBe("unverified");
  });
});

describe("evaluateOkf verified parsing", () => {
  it("parses a verified list and accepts a bare mapping as one entry", () => {
    let list = evaluateOkf(
        "---\ntype: Note\nverified:\n  - { by: \"human:a\", at: \"2026-08-14\" }\n---\nBody.\n");
    expect(list.verified).toEqual([{ by: "human:a", at: "2026-08-14" }]);
    let bare = evaluateOkf(
        "---\ntype: Note\nverified: { by: \"human:a\", at: \"2026-08-14\" }\n---\nBody.\n");
    expect(bare.verified).toHaveLength(1);
  });
});

describe("appendVerification", () => {
  const BODY = `---
type: Company Record
title: Incorporation
description: Registration.
generated: { by: "process:pack-seed", at: "2026-08-13T00:00:00Z" }
sources:
  - resource: human-attestation
status: draft
custom_key: kept
---
# Details

Content stays.
`;

  it("appends the stamp, promotes draft to stable, and preserves other keys and content", () => {
    let at = new Date("2026-08-14T12:00:00Z");
    let out = appendVerification(BODY, "account:abc123", at);
    let evaluation = evaluateOkf(out);
    expect(evaluation.verified).toEqual([{ by: "account:abc123", at: at.toISOString() }]);
    expect(evaluation.status).toBe("stable");
    expect(evaluation.strictIssues).toEqual([]);
    expect(out).toContain("custom_key: kept");
    expect(out).toContain("Content stays.");
    expect(deriveOkfTier(evaluation.verified, at)).toBe("human-reviewed");
  });

  it("keeps existing verification stamps and leaves non-draft status alone", () => {
    let first = appendVerification(BODY, "account:one", new Date("2026-08-14T12:00:00Z"));
    let second = appendVerification(first, "account:two", new Date("2026-08-15T12:00:00Z"));
    let evaluation = evaluateOkf(second);
    expect(evaluation.verified).toHaveLength(2);
    expect(evaluation.status).toBe("stable");
  });

  it("rejects files without a frontmatter mapping", () => {
    expect(() => appendVerification("# No frontmatter\n", "account:a", new Date()))
        .toThrow(/frontmatter/);
  });
});

describe("removeVerification", () => {
  const SOURCE = `---
type: Policy
title: Expense policy
description: What can be expensed.
generated: { by: "human:allan", at: "2026-08-01T00:00:00Z" }
sources:
  - resource: human-attestation
status: draft
custom_key: kept
---
Content stays.
`;

  it("drops all stamps, returns the file to draft, and preserves everything else", () => {
    let verified = appendVerification(SOURCE, "account:one", new Date("2026-08-14T12:00:00Z"));
    let retracted = removeVerification(verified);
    let evaluation = evaluateOkf(retracted);
    expect(evaluation.verified).toBeUndefined();
    expect(evaluation.status).toBe("draft");
    expect(evaluation.strictIssues).toEqual([]);
    expect(retracted).toContain("custom_key: kept");
    expect(retracted).toContain("Content stays.");
  });

  it("rejects files without a frontmatter mapping", () => {
    expect(() => removeVerification("# No frontmatter\n")).toThrow(/frontmatter/);
  });
});

describe("index pending-review annotation", () => {
  it("marks entries that do not meet the precedence bar", () => {
    let body = generateIndexMarkdown({ description: "" }, [
      { path: "a.md", name: "A", type: "Policy", pendingReview: true },
      { path: "b.md", name: "B", type: "Policy" },
    ]);
    expect(body).toContain("* [A](/a.md) (pending review; does not override)");
    expect(body).toContain("* [B](/b.md)");
    expect(body).not.toContain("[B](/b.md) (pending");
  });
});
