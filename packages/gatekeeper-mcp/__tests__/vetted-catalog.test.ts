import { describe, expect, it } from "vitest";

import { parseCatalog } from "../src/vetted-catalog.js";

describe("parseCatalog", () => {
  it("keeps well-formed rows and normalizes endpoints", () => {
    expect(parseCatalog({
      servers: [{
        id: "stripe",
        name: " Stripe ",
        description: "Payments",
        endpoint: "https://mcp.stripe.com/v1#frag",
      }],
    })).toEqual([{
      id: "stripe",
      name: "Stripe",
      description: "Payments",
      endpoint: "https://mcp.stripe.com/v1",
      vetted: true,
      sharing: "owner-only",
    }]);
  });

  it("carries the curator's sharing policy through and defaults it to owner-only", () => {
    const parsed = parseCatalog({
      servers: [
        { id: "rates", name: "Rates", endpoint: "https://rates.example/mcp", sharing: "public" },
        { id: "bank", name: "Bank", endpoint: "https://bank.example/mcp", sharing: "same-account" },
        { id: "odd", name: "Odd", endpoint: "https://odd.example/mcp", sharing: "everyone" },
        { id: "unset", name: "Unset", endpoint: "https://unset.example/mcp" },
      ],
    });
    expect(parsed.map(server => [server.id, server.sharing])).toEqual([
      ["rates", "public"], ["bank", "same-account"], ["odd", "owner-only"], ["unset", "owner-only"],
    ]);
  });

  it("drops malformed rows rather than failing the catalog", () => {
    expect(parseCatalog({
      servers: [
        { id: "Bad Id", name: "X", endpoint: "https://a.example" },
        { id: "no-name", name: "", endpoint: "https://a.example" },
        { id: "bad-url", name: "X", endpoint: "not a url" },
        { id: "http-only", name: "X", endpoint: "http://a.example" },
        { id: "userinfo", name: "X", endpoint: "https://user:pw@a.example" },
        { id: "ok", name: "OK", endpoint: "https://ok.example/mcp" },
      ],
    }).map(server => server.id)).toEqual(["ok"]);
  });

  it("carries the curator's vetted flag through", () => {
    const [listedOnly] = parseCatalog({
      servers: [{ id: "x", name: "X", endpoint: "https://x.example/mcp", vetted: false }],
    });
    expect(listedOnly.vetted).toBe(false);
  });

  it("tolerates garbage payloads", () => {
    expect(parseCatalog(null)).toEqual([]);
    expect(parseCatalog({})).toEqual([]);
    expect(parseCatalog({ servers: "nope" })).toEqual([]);
  });

  it("caps the catalog size", () => {
    const servers = Array.from({ length: 40 }, (_, i) => ({
      id: `server-${i}`, name: `S${i}`, endpoint: `https://s${i}.example/mcp`,
    }));
    expect(parseCatalog({ servers })).toHaveLength(24);
  });
});
