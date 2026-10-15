import { describe, expect, it } from "vitest";

import { cellFetchOptions, isCellHost } from "../src/cell.js";

describe("isCellHost", () => {
  it("matches the base domain and its subdomains only", () => {
    expect(isCellHost("acme.organization.tyms.ai", "organization.tyms.ai")).toBe(true);
    expect(isCellHost("organization.tyms.ai", "organization.tyms.ai")).toBe(true);
    expect(isCellHost("evil-organization.tyms.ai", "organization.tyms.ai")).toBe(false);
    expect(isCellHost("acme.organization.tyms.ai.attacker.com", "organization.tyms.ai")).toBe(false);
    expect(isCellHost("acme.organization.tyms.ai", undefined)).toBe(false);
  });
});

describe("cellFetchOptions", () => {
  const binding = { fetch: async () => new Response("via binding") } as unknown as Fetcher;
  const env = { INTELLIGENCE_CELL: binding, INTELLIGENCE_BASE_DOMAIN: "organization.tyms.ai" };

  it("routes wiki hosts through the binding and leaves the URL intact", async () => {
    const options = cellFetchOptions(env, "https://acme.organization.tyms.ai/w/company/mcp");
    expect(options.fetchImpl).toBeDefined();
    const response = await options.fetchImpl!("https://acme.organization.tyms.ai/health");
    expect(await response.text()).toBe("via binding");
  });

  it("uses the platform fetch for other hosts, without a binding, or for a bad URL", () => {
    expect(cellFetchOptions(env, "https://wiki.customer.example/w/company/mcp")).toEqual({});
    expect(cellFetchOptions({ INTELLIGENCE_BASE_DOMAIN: "organization.tyms.ai" },
      "https://acme.organization.tyms.ai/w/company/mcp")).toEqual({});
    expect(cellFetchOptions(env, "not a url")).toEqual({});
  });
});
