import { describe, expect, it } from "vitest";
import { appendLogEntry, generateIndexMarkdown, type IndexEntry } from "../src/okf-system-files";

const META = { description: "The organization-wide truth core." };

const ENTRIES: IndexEntry[] = [
  { path: "shareholder-register.md", name: "Shareholder register", type: "Shareholder Register",
    description: "Share classes, holders, option pool." },
  { path: "incorporation.md", name: "Incorporation", type: "Company Record",
    description: "Legal registration of the company." },
  { path: "directors.md", name: "Directors and officers", type: "Company Record" },
  { path: "scratch-notes.md", name: "scratch-notes.md" },
];

describe("generateIndexMarkdown", () => {
  it("groups entries by type, sorted, with untyped files last", () => {
    let body = generateIndexMarkdown(META, ENTRIES);
    let headings = [...body.matchAll(/^# (.+)$/gm)].map(m => m[1]);
    expect(headings).toEqual(["Company Record", "Shareholder Register", "Files"]);
    expect(body).toContain(
        "* [Incorporation](/incorporation.md) - Legal registration of the company.");
    expect(body).toContain("* [Directors and officers](/directors.md)");
    expect(body.indexOf("# Company Record")).toBeLessThan(body.indexOf("# Files"));
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toContain('okf_version: "0.2"');
    expect(body).toContain(META.description);
  });

  it("preserves unknown frontmatter keys from an existing index (pack versions)", () => {
    let existing = "---\nokf_version: \"0.2\"\npack: company\npack_version: 1\n---\n\n# Old body\n";
    let body = generateIndexMarkdown(META, ENTRIES, existing);
    expect(body).toContain("pack: company");
    expect(body).toContain("pack_version: 1");
    expect(body).not.toContain("# Old body");
  });

  it("drops malformed existing frontmatter rather than emitting an invalid file", () => {
    let body = generateIndexMarkdown(META, ENTRIES, "---\n[broken\n---\nBody.\n");
    expect(body).toContain('okf_version: "0.2"');
    expect(body).not.toContain("[broken");
  });

  it("renders an empty collection as frontmatter and intro only", () => {
    let body = generateIndexMarkdown(META, []);
    expect(body).toContain('okf_version: "0.2"');
    expect(body).not.toContain("# Files");
  });
});

describe("appendLogEntry", () => {
  const at = new Date("2026-08-13T10:00:00Z");

  it("initializes a titled log with the first entry", () => {
    let body = appendLogEntry(undefined, "Company", {
      at, action: "Creation", detail: "[incorporation.md](/incorporation.md)", actor: "account:a1",
    });
    expect(body).toBe([
      "# Company Update Log",
      "",
      "## 2026-08-13",
      "* **Creation**: [incorporation.md](/incorporation.md) by account:a1.",
      "",
    ].join("\n"));
  });

  it("prepends same-day entries under the existing date heading", () => {
    let first = appendLogEntry(undefined, "Company", {
      at, action: "Creation", detail: "[a.md](/a.md)",
    });
    let second = appendLogEntry(first, "Company", {
      at: new Date("2026-08-13T11:00:00Z"), action: "Update", detail: "[a.md](/a.md)",
    });
    let lines = second.trimEnd().split("\n");
    expect(lines[2]).toBe("## 2026-08-13");
    expect(lines[3]).toContain("**Update**");
    expect(lines[4]).toContain("**Creation**");
    expect(second.match(/^## /gm)).toHaveLength(1);
  });

  it("starts a new date section above older ones", () => {
    let first = appendLogEntry(undefined, "Company", {
      at, action: "Creation", detail: "[a.md](/a.md)",
    });
    let second = appendLogEntry(first, "Company", {
      at: new Date("2026-08-14T09:00:00Z"), action: "Deletion", detail: "[a.md](/a.md)",
    });
    expect(second.indexOf("## 2026-08-14")).toBeLessThan(second.indexOf("## 2026-08-13"));
  });

  it("preserves a seeded pack log under a matching title", () => {
    let seeded = "# Company Update Log\n\n## 2026-08-01\n* **Creation**: Seeded from the company pack v1.\n";
    let body = appendLogEntry(seeded, "Company", {
      at, action: "Update", detail: "[incorporation.md](/incorporation.md)",
    });
    expect(body.indexOf("## 2026-08-13")).toBeLessThan(body.indexOf("## 2026-08-01"));
    expect(body).toContain("Seeded from the company pack v1.");
    expect(body.match(/# Company Update Log/g)).toHaveLength(1);
  });

  it("keeps a foreign log body below new entries instead of clobbering it", () => {
    let foreign = "# Legacy Notes\n\nHand-written history.\n";
    let body = appendLogEntry(foreign, "Company", {
      at, action: "Update", detail: "[a.md](/a.md)",
    });
    expect(body.startsWith("# Company Update Log")).toBe(true);
    expect(body).toContain("Hand-written history.");
    expect(body.indexOf("## 2026-08-13")).toBeLessThan(body.indexOf("# Legacy Notes"));
  });

  it("drops the oldest date sections when over the size cap", () => {
    let body: string | undefined;
    for (let day = 1; day <= 9; day++) {
      body = appendLogEntry(body, "Company", {
        at: new Date(`2026-08-0${day}T00:00:00Z`),
        action: "Update",
        detail: `[file-${day}.md](/file-${day}.md) ${"x".repeat(120)}`,
      });
    }
    let capped = appendLogEntry(body, "Company", {
      at: new Date("2026-08-10T00:00:00Z"), action: "Update", detail: "[final.md](/final.md)",
    }, 600);
    expect(capped).toContain("## 2026-08-10");
    expect(capped).not.toContain("## 2026-08-01");
    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(600);
  });
});
