import { afterEach, describe, expect, it, vi } from "vitest";
import { parseIntelligenceConfig } from "../src/config.js";
import {
  absolutizeIndexLinks,
  buildIntelligencePromptContext,
  fetchPrecedenceIndex,
  PRECEDENCE_CONTENT_MAX_CHARS,
  PrecedenceAuthError,
} from "../src/precedence.js";

const MCP = "https://acme.organization.tyms.ai/w/company/mcp";
const KEY = "oik_" + "b".repeat(43);
const config = parseIntelligenceConfig({ INTELLIGENCE_MCP_URL: MCP }, false)!;

const INDEX = `---
okf_version: 0.2
description: "Acme's company wiki"
---
# Policy

* [Expense policy](/policies/expenses) - what can be claimed
* [Travel policy](/policies/travel) - booking and per diems

# Process

* [Onboarding](/processes/onboarding) - first week
`;

describe("buildIntelligencePromptContext", () => {
  it("prefixes the citation instruction, keeps the description, drops the frontmatter", () => {
    const block = buildIntelligencePromptContext(INDEX, config);
    expect(block).toContain("cite it inline exactly as `[Title · human-reviewed](url)`");
    expect(block).toContain("https://acme.organization.tyms.ai/company");
    expect(block).toContain("Acme's company wiki");
    expect(block).not.toContain("okf_version");
  });

  it("makes the index links absolute page URLs and keeps their order", () => {
    const block = buildIntelligencePromptContext(INDEX, config);
    const links = [...block.matchAll(/\]\((https?:[^)]+)\)/g)].map(match => match[1]);
    expect(links).toEqual([
      "https://acme.organization.tyms.ai/company/policies/expenses",
      "https://acme.organization.tyms.ai/company/policies/travel",
      "https://acme.organization.tyms.ai/company/processes/onboarding",
    ]);
    // Byte-stable: the same input yields the same block, so the prompt cache keeps it.
    expect(buildIntelligencePromptContext(INDEX, config)).toBe(block);
  });

  it("clamps an oversized index at a line boundary and says so", () => {
    const lines = Array.from({ length: 2000 },
      (_, i) => `* [Page ${i}](/pages/${i}) - ${"x".repeat(20)}`);
    const block = buildIntelligencePromptContext(lines.join("\n"), config);
    const body = block.slice(block.indexOf("\n\n") + 2);
    expect(body.length).toBeLessThanOrEqual(PRECEDENCE_CONTENT_MAX_CHARS + 80);
    expect(block).toContain("(index truncated");
    // Never a half-written link for the model to complete.
    const beforeFooter = block.slice(0, block.indexOf("\n\n(index truncated"));
    expect(beforeFooter.endsWith(")") || beforeFooter.endsWith("x")).toBe(true);
    expect(/\]\([^)]*$/.test(beforeFooter)).toBe(false);
  });

  it("leaves absolute links alone", () => {
    expect(absolutizeIndexLinks("[a](https://elsewhere.example/x) [b](/y)", "https://w/company"))
      .toBe("[a](https://elsewhere.example/x) [b](https://w/company/y)");
  });
});

describe("fetchPrecedenceIndex", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the assistant key as a bearer to the precedence URL", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(INDEX, { status: 200, headers: { "content-type": "text/markdown" } });
    });
    const markdown = await fetchPrecedenceIndex(config, KEY);
    expect(markdown).toBe(INDEX);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://acme.organization.tyms.ai/api/w/company/precedence?format=md");
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(new Headers(calls[0].init?.headers).get("Accept")).toContain("text/markdown");
  });

  it("reports a refused key distinctly (the cell answers 404 for a bad key)", async () => {
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await expect(fetchPrecedenceIndex(config, KEY)).rejects.toBeInstanceOf(PrecedenceAuthError);
  });

  it("refuses an oversized body rather than buffering it", async () => {
    vi.stubGlobal("fetch", async () => new Response("x".repeat(300 * 1024), { status: 200 }));
    await expect(fetchPrecedenceIndex(config, KEY)).rejects.toThrow(/exceeded/);
  });
});
