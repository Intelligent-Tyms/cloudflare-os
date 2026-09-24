import { describe, expect, it } from "vitest";

import { companyResources, mcpResourceFor, mcpResources } from "../src/resources.js";
import type { CatalogServer } from "../src/vetted-catalog.js";

const STRIPE: CatalogServer = {
  id: "stripe",
  name: "Stripe",
  description: "Payments",
  endpoint: "https://mcp.stripe.com/v1",
  vetted: true,
  sharing: "owner-only",
  auth: "oauth",
  credential: "personal",
};

const RESEND: CatalogServer = {
  id: "resend",
  name: "Resend",
  description: "",
  endpoint: "https://mcp.resend.example/mcp",
  vetted: true,
  sharing: "public",
  auth: "token",
  credential: "organization",
};

describe("mcpResources", () => {
  it("advertises HTTP only in insecure mode", () => {
    expect(mcpResources(false).map(resource => resource.urlPattern)).toEqual(["https://*"]);
    expect(mcpResources(true).map(resource => resource.urlPattern)).toEqual([
      "https://*",
      "http://*",
    ]);
  });

  it("lists catalog servers first, grantable, ahead of the BYO catch-alls", () => {
    const resources = mcpResources(false, [STRIPE]);
    expect(resources.map(resource => resource.urlPattern)).toEqual([
      "https://mcp.stripe.com/v1",
      "https://*",
    ]);
    expect(resources[0]).toMatchObject({ title: "Stripe", grantable: true });
    expect(resources[1].grantable).toBeUndefined();
  });

  it("keeps company servers out of the personal list and offers them separately", () => {
    expect(mcpResources(false, [RESEND, STRIPE]).map(resource => resource.urlPattern)).toEqual([
      "https://mcp.stripe.com/v1",
      "https://*",
    ]);
    const [resource] = companyResources([RESEND]);
    expect(resource).toMatchObject({
      urlPattern: "https://mcp.resend.example/mcp",
      title: "Resend",
      description: "Tools from Resend, set up for the whole company.",
    });
    expect(resource.grantable).toBe(false);
  });

  it("returns the resource matching the connected endpoint", () => {
    expect(mcpResourceFor("https://mcp.example.com/mcp").urlPattern).toBe("https://*");
    expect(mcpResourceFor("http://localhost:3000/mcp").urlPattern).toBe("http://*");
  });

  it("reports a catalog member as its own catalog resource", () => {
    expect(mcpResourceFor("https://mcp.stripe.com/v1", [STRIPE]).urlPattern)
      .toBe("https://mcp.stripe.com/v1");
    expect(mcpResourceFor("https://elsewhere.example/mcp", [STRIPE]).urlPattern)
      .toBe("https://*");
  });
});
