import { describe, expect, it } from "vitest";

import { cellFetchOptions, isCellHost } from "../src/cell.js";

describe("isCellHost", () => {
  it("matches the base domain and its subdomains only", () => {
    expect(isCellHost("acme.data.tyms.ai", "data.tyms.ai")).toBe(true);
    expect(isCellHost("data.tyms.ai", "data.tyms.ai")).toBe(true);
    expect(isCellHost("evil-data.tyms.ai", "data.tyms.ai")).toBe(false);
    expect(isCellHost("acme.data.tyms.ai.attacker.com", "data.tyms.ai")).toBe(false);
    expect(isCellHost("acme.data.tyms.ai", undefined)).toBe(false);
  });
});

describe("cellFetchOptions", () => {
  const binding = { fetch: async () => new Response("via binding") } as unknown as Fetcher;
  const env = { DATA_INTELLIGENCE_CELL: binding, DATA_INTELLIGENCE_BASE_DOMAIN: "data.tyms.ai" };

  it("routes tenant hosts through the binding and leaves the URL intact", async () => {
    const options = cellFetchOptions(env, "https://acme.data.tyms.ai/mcp");
    expect(options.fetchImpl).toBeDefined();
    const response = await options.fetchImpl!("https://acme.data.tyms.ai/health");
    expect(await response.text()).toBe("via binding");
  });

  it("uses the platform fetch for other hosts, without a binding, or for a bad URL", () => {
    expect(cellFetchOptions(env, "https://data.customer.example/mcp")).toEqual({});
    expect(cellFetchOptions({ DATA_INTELLIGENCE_BASE_DOMAIN: "data.tyms.ai" },
      "https://acme.data.tyms.ai/mcp")).toEqual({});
    expect(cellFetchOptions(env, "not a url")).toEqual({});
  });
});
