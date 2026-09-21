import { describe, expect, it } from "vitest";
import {
  assistantKeyOf,
  isConfigured,
  parseDataIntelligenceConfig,
} from "../src/config.js";
import { DATA_INTELLIGENCE_PROMPT_CONTEXT } from "../src/prompt.js";

const MCP = "https://acme.data.tyms.ai/mcp";
const KEY = "dik_" + "a".repeat(43);

describe("parseDataIntelligenceConfig", () => {
  it("returns null when unconfigured, so the connector hides itself", () => {
    expect(parseDataIntelligenceConfig({}, false)).toBeNull();
    expect(parseDataIntelligenceConfig({ DATA_INTELLIGENCE_MCP_URL: "   " }, false)).toBeNull();
  });

  it("rejects unparseable, non-HTTPS and credential-bearing URLs", () => {
    expect(parseDataIntelligenceConfig({ DATA_INTELLIGENCE_MCP_URL: "not a url" }, false)).toBeNull();
    expect(parseDataIntelligenceConfig({ DATA_INTELLIGENCE_MCP_URL: "http://acme.localhost/mcp" }, false)).toBeNull();
    expect(parseDataIntelligenceConfig({ DATA_INTELLIGENCE_MCP_URL: "https://x:y@acme.data.tyms.ai/mcp" }, false)).toBeNull();
  });

  it("permits plain HTTP only when insecure fetches are allowed (local development)", () => {
    const url = "http://acme.localhost:8788/mcp";
    expect(parseDataIntelligenceConfig({ DATA_INTELLIGENCE_MCP_URL: url }, false)).toBeNull();
    expect(parseDataIntelligenceConfig({ DATA_INTELLIGENCE_MCP_URL: url }, true)?.endpoint).toBe(url);
  });

  it("defaults the workbench to the endpoint's origin and prefers the one provisioning wrote", () => {
    expect(parseDataIntelligenceConfig({ DATA_INTELLIGENCE_MCP_URL: MCP + "#frag" }, false))
      .toEqual({ endpoint: MCP, consoleUrl: "https://acme.data.tyms.ai/" });
    expect(parseDataIntelligenceConfig({
      DATA_INTELLIGENCE_MCP_URL: MCP, DATA_INTELLIGENCE_CONSOLE_URL: "https://acme.data.tyms.ai/workbench",
    }, false)?.consoleUrl).toBe("https://acme.data.tyms.ai/workbench");
    // An unusable workbench URL falls back rather than hiding a working connector.
    expect(parseDataIntelligenceConfig({
      DATA_INTELLIGENCE_MCP_URL: MCP, DATA_INTELLIGENCE_CONSOLE_URL: "javascript:alert(1)",
    }, false)?.consoleUrl).toBe("https://acme.data.tyms.ai/");
  });
});

describe("isConfigured", () => {
  it("needs a usable endpoint and a key", () => {
    expect(isConfigured({ DATA_INTELLIGENCE_MCP_URL: MCP }, false)).toBe(false);
    expect(isConfigured({ DATA_INTELLIGENCE_ASSISTANT_KEY: KEY }, false)).toBe(false);
    expect(isConfigured({ DATA_INTELLIGENCE_MCP_URL: MCP, DATA_INTELLIGENCE_ASSISTANT_KEY: "  " }, false)).toBe(false);
    expect(isConfigured({ DATA_INTELLIGENCE_MCP_URL: MCP, DATA_INTELLIGENCE_ASSISTANT_KEY: KEY }, false)).toBe(true);
  });
});

describe("assistantKeyOf", () => {
  const values = { DATA_INTELLIGENCE_MCP_URL: MCP, DATA_INTELLIGENCE_ASSISTANT_KEY: ` ${KEY} ` };

  it("releases the key only for the endpoint the setup names", () => {
    expect(assistantKeyOf(values, false, MCP)).toBe(KEY);
    // The whole URL is the endpoint's identity: another path on the same host is another server.
    expect(assistantKeyOf(values, false, "https://acme.data.tyms.ai/mcp/")).toBeNull();
    // A facet minted before a repoint still names the old endpoint: it gets nothing.
    expect(assistantKeyOf(values, false, "https://other.data.tyms.ai/mcp")).toBeNull();
    expect(assistantKeyOf(values, false, "https://acme.data.tyms.ai.attacker.com/mcp")).toBeNull();
  });

  it("releases nothing while unconfigured", () => {
    expect(assistantKeyOf({ DATA_INTELLIGENCE_ASSISTANT_KEY: KEY }, false, MCP)).toBeNull();
    expect(assistantKeyOf({ DATA_INTELLIGENCE_MCP_URL: MCP }, false, MCP)).toBeNull();
  });
});

describe("the prompt block", () => {
  it("puts get_context before SQL, names every tool it tells the agent to use, and fits the cap", () => {
    const text = DATA_INTELLIGENCE_PROMPT_CONTEXT;
    expect(text.indexOf("get_context")).toBeLessThan(text.indexOf("run_sql"));
    for (const tool of ["list_connections", "get_context", "search_schema", "describe_table", "dry_run", "run_sql", "save_report"]) {
      expect(text).toContain(`\`${tool}\``);
    }
    expect(text.length).toBeLessThan(4_000);
  });
});
