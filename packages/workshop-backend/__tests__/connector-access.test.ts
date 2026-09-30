import { describe, expect, it } from "vitest";
import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { AdminConfig } from "../src/admin-config.js";
import {
  ADMIN_ADDS_CONNECTORS,
  connectableResources,
  memberConnectPatterns,
} from "../src/connector-access.js";

const resource = (urlPattern: string, extra: Partial<SupportedResource> = {}): SupportedResource =>
    ({ urlPattern, title: urlPattern, description: "", ...extra });

const MERCURY = resource("https://mcp.mercury.com/mcp", { grantable: true });
const MARKETS = resource("https://mi.example.com/mcp", { grantable: true });
const ANY_SERVER = resource("https://*", { connectableBy: "admin" });
const GMAIL = resource("https://mail.google.com/*", { grantable: true });

const config = (disabledResources: Record<string, string[]> = {}): AdminConfig =>
    ({ disabledResources, disabledGatekeepers: [] }) as unknown as AdminConfig;

describe("connectableResources", () => {
  it("offers a member everything but what is reserved for administrators", () => {
    expect(connectableResources([MERCURY, ANY_SERVER], {})).toEqual([MERCURY]);
    expect(connectableResources([MERCURY, ANY_SERVER], { admin: false })).toEqual([MERCURY]);
  });

  it("offers an administrator everything", () => {
    expect(connectableResources([MERCURY, ANY_SERVER], { admin: true }))
        .toEqual([MERCURY, ANY_SERVER]);
  });
});

describe("memberConnectPatterns", () => {
  it("leaves a vendor that reserves nothing exactly as asked", () => {
    expect(memberConnectPatterns(config(), "google", [GMAIL], undefined)).toBeUndefined();
    // The empty list is meaningful (a connect that asks for no resource access) and survives.
    expect(memberConnectPatterns(config(), "google", [GMAIL], [])).toEqual([]);
    expect(memberConnectPatterns(config(), "google", [GMAIL], [GMAIL.urlPattern]))
        .toEqual([GMAIL.urlPattern]);
  });

  it("narrows an open-ended connect to what a member may sign in to", () => {
    expect(memberConnectPatterns(config(), "mcp", [MERCURY, MARKETS, ANY_SERVER], undefined))
        .toEqual([MERCURY.urlPattern, MARKETS.urlPattern]);
  });

  it("drops a reserved pattern from a connect that names it among others", () => {
    expect(memberConnectPatterns(
        config(), "mcp", [MERCURY, ANY_SERVER], [MERCURY.urlPattern, ANY_SERVER.urlPattern]))
        .toEqual([MERCURY.urlPattern]);
  });

  it("refuses a connect that could only reach a reserved type", () => {
    expect(() => memberConnectPatterns(config(), "mcp", [ANY_SERVER], undefined))
        .toThrow(ADMIN_ADDS_CONNECTORS);
    expect(() => memberConnectPatterns(
        config(), "mcp", [MERCURY, ANY_SERVER], [ANY_SERVER.urlPattern]))
        .toThrow(ADMIN_ADDS_CONNECTORS);
    expect(() => memberConnectPatterns(config(), "mcp", [MERCURY, ANY_SERVER], []))
        .toThrow(ADMIN_ADDS_CONNECTORS);
  });

  it("does not narrow to a resource the deployment turned off", () => {
    const off = config({ mcp: [MERCURY.urlPattern] });
    expect(memberConnectPatterns(off, "mcp", [MERCURY, MARKETS, ANY_SERVER], undefined))
        .toEqual([MARKETS.urlPattern]);
    expect(() => memberConnectPatterns(off, "mcp", [MERCURY, ANY_SERVER], undefined))
        .toThrow(ADMIN_ADDS_CONNECTORS);
  });
});
