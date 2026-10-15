import { describe, expect, it } from "vitest";

import {
  observerEndpointMismatchMessage,
  observerLogOverflowMessage,
  observerRefusalMessage,
  observerReplayFailureMessage,
  parseSharingPolicy,
} from "../src/sharing-policy.js";

describe("parseSharingPolicy", () => {
  it("recognises the three policies and nothing else", () => {
    expect(parseSharingPolicy("public")).toBe("public");
    expect(parseSharingPolicy(" Same-Account ")).toBe("same-account");
    expect(parseSharingPolicy("owner-only")).toBe("owner-only");
  });

  it("falls back to owner-only, the safe reading, for anything unrecognised", () => {
    expect(parseSharingPolicy(undefined)).toBe("owner-only");
    expect(parseSharingPolicy("everyone")).toBe("owner-only");
    expect(parseSharingPolicy(true)).toBe("owner-only");
  });
});

describe("observer messages", () => {
  it("tell the person what to do next", () => {
    expect(observerEndpointMismatchMessage("the MCP server mcp.mercury.com", "mcp.linear.app"))
      .toMatch(/connected to mcp\.linear\.app.*Connect your own account to the MCP server mcp\.mercury\.com/s);
    expect(observerReplayFailureMessage("the MCP server mcp.mercury.com", "get_account", "403"))
      .toMatch(/calling "get_account" failed \(403\).*reconnect/s);
    expect(observerLogOverflowMessage("the MCP server mcp.mercury.com")).toContain("blueprint");
  });
});

describe("observerRefusalMessage", () => {
  it("names the source and points at the path that does work", () => {
    // Whoever reads this has just been turned away from a link someone sent them, so it has to say
    // what to do next -- otherwise the owner's only recourse looks like "give up".
    const message = observerRefusalMessage("the MCP server mcp.linear.app");
    expect(message).toContain("mcp.linear.app");
    expect(message).toContain("only be opened by its owner");
    expect(message).toContain("blueprint");
  });
});
