import { afterEach, describe, expect, it, vi } from "vitest";

import { McpClient } from "../src/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("McpClient.readResource", () => {
  it("sends resources/read with the bearer and joins the text parts", async () => {
    const seen: { method: string; params: unknown; authorization: string | null }[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      seen.push({ method: request.method, params: request.params, authorization: new Headers(init?.headers).get("Authorization") });
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: request.id,
        result: { contents: [
          { uri: "ops://acme/alerts", mimeType: "application/json", text: "{\"recent\":[]}" },
          { uri: "ops://acme/alerts", blob: "AAAA" },
        ] },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new McpClient("https://acme.ops.example.com/mcp", async () => "person-token");

    const read = await client.readResource("ops://acme/alerts");

    expect(read).toEqual({ uri: "ops://acme/alerts", mimeType: "application/json", text: "{\"recent\":[]}" });
    expect(seen).toEqual([{ method: "resources/read", params: { uri: "ops://acme/alerts" }, authorization: "Bearer person-token" }]);
  });

  it("returns empty text when the server sends no text contents", async () => {
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      const { id } = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new McpClient("https://acme.ops.example.com/mcp", async () => null);
    expect(await client.readResource("ops://acme/attention")).toEqual({ uri: "ops://acme/attention", mimeType: null, text: "" });
  });
});
