import { describe, expect, it } from "vitest";
import {
  assistantKeyOf,
  isConfigured,
  parseIntelligenceConfig,
} from "../src/config.js";

const MCP = "https://acme.organization.tyms.ai/w/company/mcp";
const KEY = "oik_" + "a".repeat(43);

describe("parseIntelligenceConfig", () => {
  it("returns null when unconfigured, so the connector hides itself", () => {
    expect(parseIntelligenceConfig({}, false)).toBeNull();
    expect(parseIntelligenceConfig({ INTELLIGENCE_MCP_URL: "   " }, false)).toBeNull();
  });

  it("rejects unparseable, non-HTTPS and credential-bearing URLs", () => {
    expect(parseIntelligenceConfig({ INTELLIGENCE_MCP_URL: "not a url" }, false)).toBeNull();
    expect(parseIntelligenceConfig({ INTELLIGENCE_MCP_URL: "http://acme.localhost/w/company/mcp" }, false)).toBeNull();
    expect(parseIntelligenceConfig({ INTELLIGENCE_MCP_URL: "https://x:y@acme.organization.tyms.ai/w/company/mcp" }, false)).toBeNull();
  });

  it("permits plain HTTP only when insecure fetches are allowed (local development)", () => {
    const url = "http://acme.localhost:8787/w/company/mcp";
    expect(parseIntelligenceConfig({ INTELLIGENCE_MCP_URL: url }, false)).toBeNull();
    expect(parseIntelligenceConfig({ INTELLIGENCE_MCP_URL: url }, true)?.endpoint).toBe(url);
  });

  it("derives the wiki, its URL and the precedence URL from the MCP endpoint", () => {
    const config = parseIntelligenceConfig({ INTELLIGENCE_MCP_URL: MCP + "#frag" }, false);
    expect(config).toEqual({
      endpoint: MCP,
      wiki: "company",
      wikiUrl: "https://acme.organization.tyms.ai/company",
      pageBaseUrl: "https://acme.organization.tyms.ai/company",
      precedenceUrl: "https://acme.organization.tyms.ai/api/w/company/precedence?format=md",
    });
  });

  it("follows a non-default wiki in the endpoint path and honours an explicit wiki URL", () => {
    const config = parseIntelligenceConfig({
      INTELLIGENCE_MCP_URL: "https://acme.organization.tyms.ai/w/sales/mcp",
      INTELLIGENCE_WIKI_URL: "https://acme.organization.tyms.ai/sales?tab=pages",
    }, false);
    expect(config?.wiki).toBe("sales");
    expect(config?.wikiUrl).toBe("https://acme.organization.tyms.ai/sales?tab=pages");
    expect(config?.pageBaseUrl).toBe("https://acme.organization.tyms.ai/sales");
    expect(config?.precedenceUrl).toBe("https://acme.organization.tyms.ai/api/w/sales/precedence?format=md");
  });
});

describe("assistantKeyOf", () => {
  it("releases the key only to the endpoint the setup names", () => {
    const values = { INTELLIGENCE_MCP_URL: MCP, INTELLIGENCE_ASSISTANT_KEY: KEY };
    expect(assistantKeyOf(values, false, MCP)).toBe(KEY);
    // A facet minted for the previous wiki must not receive the new wiki's key.
    expect(assistantKeyOf(values, false, "https://old.organization.tyms.ai/w/company/mcp")).toBeNull();
    expect(assistantKeyOf(values, false, "https://acme.organization.tyms.ai/w/sales/mcp")).toBeNull();
  });

  it("is null without a key or a usable endpoint", () => {
    expect(assistantKeyOf({ INTELLIGENCE_MCP_URL: MCP }, false, MCP)).toBeNull();
    expect(assistantKeyOf({ INTELLIGENCE_MCP_URL: MCP, INTELLIGENCE_ASSISTANT_KEY: "  " }, false, MCP)).toBeNull();
    expect(assistantKeyOf({ INTELLIGENCE_ASSISTANT_KEY: KEY }, false, MCP)).toBeNull();
  });
});

describe("isConfigured", () => {
  it("needs both a usable endpoint and a key", () => {
    expect(isConfigured({}, false)).toBe(false);
    expect(isConfigured({ INTELLIGENCE_MCP_URL: MCP }, false)).toBe(false);
    expect(isConfigured({ INTELLIGENCE_ASSISTANT_KEY: KEY }, false)).toBe(false);
    expect(isConfigured({ INTELLIGENCE_MCP_URL: MCP, INTELLIGENCE_ASSISTANT_KEY: KEY }, false)).toBe(true);
  });
});
