import { describe, expect, it } from "vitest";
import {
  buildPromptContextBlock, COLLECTION_CONTEXT_MAX_CHARS, rewriteIndexLinks,
} from "../src/prompt-context";

const INDEX_BODY = `---
okf_version: "0.2"
pack: company
pack_version: 1
---

The organization-wide truth core.

# Company Record
* [Incorporation](/incorporation.md) - Legal registration of the company.
* [Registered address](/registered-address.md) - The registered office.

# Reference material
* [References](references/) - Original documents.
`;

describe("rewriteIndexLinks", () => {
  it("rewrites bundle-absolute links into citation URLs with an encoded doc id", () => {
    let out = rewriteIndexLinks("abc123", "* [Incorporation](/incorporation.md) - Legal.");
    expect(out).toBe(
        "* [Incorporation](/integrations/context?p=abc123%2Fincorporation.md) - Legal.");
  });

  it("encodes nested paths and leaves non-absolute links alone", () => {
    let out = rewriteIndexLinks("abc123",
        "[Revenue](/metrics/revenue.md) [Docs](https://example.com/x) [Rel](references/)");
    expect(out).toContain("?p=abc123%2Fmetrics%2Frevenue.md");
    expect(out).toContain("(https://example.com/x)");
    expect(out).toContain("(references/)");
  });
});

describe("buildPromptContextBlock", () => {
  it("strips frontmatter, keeps the body, and rewrites entry links", () => {
    let block = buildPromptContextBlock([
      {collectionId: "abc123", title: "Company", indexBody: INDEX_BODY},
    ]);
    expect(block.startsWith("## Company")).toBe(true);
    expect(block).not.toContain("okf_version");
    expect(block).not.toContain("pack_version");
    expect(block).toContain("The organization-wide truth core.");
    expect(block).toContain("(/integrations/context?p=abc123%2Fincorporation.md)");
  });

  it("orders collections deterministically by title", () => {
    let block = buildPromptContextBlock([
      {collectionId: "z", title: "Finance", indexBody: "# A\n* [f](/f.md)"},
      {collectionId: "a", title: "Company", indexBody: "# B\n* [c](/c.md)"},
    ]);
    expect(block.indexOf("## Company")).toBeLessThan(block.indexOf("## Finance"));
  });

  it("truncates an oversized index with a footer", () => {
    let long = "# Files\n" + "* [x](/x.md) - " + "y".repeat(COLLECTION_CONTEXT_MAX_CHARS);
    let block = buildPromptContextBlock([
      {collectionId: "abc", title: "Big", indexBody: long},
    ]);
    expect(block).toContain("index truncated");
    expect(block.length).toBeLessThan(COLLECTION_CONTEXT_MAX_CHARS + 200);
  });
});
