import { describe, expect, it } from "vitest";
import { lintCollection, type LintRecord } from "../src/okf-lint";

const NOW = new Date("2026-08-14T12:00:00Z");
const RECENT = new Date("2026-08-13T12:00:00Z");

function md(path: string, body: string, lastUpdated = RECENT): LintRecord {
  return { path, contentType: "text/markdown", body, lastUpdated };
}

const CLEAN = `---
type: Policy
title: Expense policy
description: What can be expensed.
generated: { by: "human:allan", at: "2026-08-01T00:00:00Z" }
sources:
  - resource: human-attestation
status: stable
---
Body.
`;

describe("lintCollection", () => {
  it("stays silent on a clean canonical folder", () => {
    expect(lintCollection({ records: [md("policy.md", CLEAN)], canonical: true, now: NOW }))
        .toEqual([]);
  });

  it("flags conformance problems, strict ones only when canonical", () => {
    let records = [md("note.md", "# No frontmatter\n")];
    expect(lintCollection({ records, canonical: true, now: NOW })[0])
        .toContain("Missing YAML frontmatter");
    let typeOnly = [md("note.md", "---\ntype: Note\n---\nBody.\n")];
    expect(lintCollection({ records: typeOnly, canonical: false, now: NOW })).toEqual([]);
    expect(lintCollection({ records: typeOnly, canonical: true, now: NOW })[0])
        .toContain("Canonical files require");
  });

  it("flags stable files past stale_after", () => {
    let stale = CLEAN.replace("status: stable", "status: stable\nstale_after: 2026-08-01");
    let findings = lintCollection({ records: [md("policy.md", stale)], canonical: true, now: NOW });
    expect(findings[0]).toContain("stale since 2026-08-01");
  });

  it("flags drafts older than the age limit, not fresh ones", () => {
    let draft = CLEAN.replace("status: stable", "status: draft");
    let old = md("policy.md", draft, new Date("2026-07-01T00:00:00Z"));
    expect(lintCollection({ records: [old], canonical: true, now: NOW })[0])
        .toContain("draft for 44 days");
    expect(lintCollection({ records: [md("policy.md", draft)], canonical: true, now: NOW }))
        .toEqual([]);
  });

  it("flags broken bundle-absolute links and accepts live ones", () => {
    let body = CLEAN + "\nSee [other](/other.md) and [refs](/references/).\n";
    let alone = lintCollection({ records: [md("policy.md", body)], canonical: true, now: NOW });
    expect(alone.some(f => f.includes("broken link /other.md"))).toBe(true);
    expect(alone.some(f => f.includes("broken link /references/"))).toBe(true);
    let together = lintCollection({
      records: [
        md("policy.md", body),
        md("other.md", CLEAN),
        { path: "references/doc.pdf", contentType: "application/pdf", body: "x",
          lastUpdated: RECENT },
      ],
      canonical: true,
      now: NOW,
    });
    expect(together.some(f => f.includes("broken link"))).toBe(false);
  });

  it("flags uncited originals under references/", () => {
    let records = [
      md("policy.md", CLEAN),
      { path: "references/contract.pdf", contentType: "application/pdf", body: "x",
        lastUpdated: RECENT },
    ];
    let findings = lintCollection({ records, canonical: true, now: NOW });
    expect(findings.some(f => f.includes("no concept file cites"))).toBe(true);

    let cited = [
      md("policy.md", CLEAN + "\nOriginal: [contract](/references/contract.pdf)\n"),
      records[1],
    ];
    expect(lintCollection({ records: cited, canonical: true, now: NOW })
        .some(f => f.includes("no concept file cites"))).toBe(false);
  });

  it("flags a seeded copy lagging the shipped pack version", () => {
    let index = {
      path: "index.md", contentType: "text/markdown", lastUpdated: RECENT,
      body: "---\nokf_version: \"0.2\"\npack: company\npack_version: 1\n---\n\nIntro.\n",
    };
    let findings = lintCollection({
      records: [index], canonical: true, now: NOW,
      bundledPackVersions: new Map([["company", 3]]),
    });
    expect(findings.some(f => f.includes("seeded from the company pack v1") &&
        f.includes("ships v3"))).toBe(true);
    expect(lintCollection({
      records: [index], canonical: true, now: NOW,
      bundledPackVersions: new Map([["company", 1]]),
    })).toEqual([]);
  });
});
