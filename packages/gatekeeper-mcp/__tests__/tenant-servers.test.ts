import { describe, expect, it } from "vitest";

import {
  MAX_TENANT_SERVERS,
  asCatalogServer,
  mergeCatalog,
  parseTenantServers,
  serverInputName,
  tenantServerId,
  validateServerName,
  type TenantServer,
} from "../src/tenant-servers.js";
import {
  catalogResource,
  companySharingIn,
  keyInputName,
  type CatalogServer,
} from "../src/vetted-catalog.js";

const RESEND: CatalogServer = {
  id: "resend",
  name: "Resend",
  description: "",
  endpoint: "https://mcp.resend.example/mcp",
  vetted: false,
  sharing: "public",
  auth: "token",
  credential: "organization",
};

const LEDGER: TenantServer = {
  id: "custom-ledger",
  name: "Ledger",
  endpoint: "https://ledger.example.com/mcp",
  auth: "token",
  addedAt: 1,
};

describe("tenantServerId", () => {
  it("slugs the name under the tenant prefix", () => {
    expect(tenantServerId("Internal Ledger (prod)", new Set())).toBe("custom-internal-ledger-prod");
    expect(tenantServerId("  !!  ", new Set())).toBe("custom-server");
  });

  it("never reuses an id already taken", () => {
    const taken = new Set(["custom-ledger", "custom-ledger-2"]);
    expect(tenantServerId("Ledger", taken)).toBe("custom-ledger-3");
  });

  it("cannot produce a central catalog id, whatever the name", () => {
    expect(tenantServerId("resend", new Set(["resend"]))).toBe("custom-resend");
    expect(keyInputName(tenantServerId("resend", new Set()))).not.toBe(keyInputName("resend"));
  });
});

describe("validateServerName", () => {
  it("trims and collapses whitespace", () => {
    expect(validateServerName("  Internal   Ledger ")).toEqual({ ok: true, name: "Internal Ledger" });
  });

  it("refuses an empty or overlong name", () => {
    expect(validateServerName("   ").ok).toBe(false);
    expect(validateServerName("x".repeat(81)).ok).toBe(false);
  });
});

describe("parseTenantServers", () => {
  it("keeps well-formed records and drops the rest", () => {
    expect(parseTenantServers([
      LEDGER,
      { id: "resend", name: "No prefix", endpoint: "https://a.example/mcp" },
      { id: "custom-bad", name: "Bad URL", endpoint: "not a url" },
      { id: "custom-noname", name: "", endpoint: "https://a.example/mcp" },
      null,
    ])).toEqual([LEDGER]);
    expect(parseTenantServers(undefined)).toEqual([]);
  });

  it("treats any auth but token as none", () => {
    const [server] = parseTenantServers([{ ...LEDGER, auth: "oauth" }]);
    expect(server.auth).toBe("none");
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_TENANT_SERVERS + 5 }, (_, i) => ({
      ...LEDGER, id: `custom-s${i}`, endpoint: `https://s${i}.example.com/mcp`,
    }));
    expect(parseTenantServers(many)).toHaveLength(MAX_TENANT_SERVERS);
  });
});

describe("mergeCatalog", () => {
  it("appends the tenant's servers as company servers shared by membership", () => {
    const merged = mergeCatalog([RESEND], [LEDGER]);
    expect(merged.map((server) => server.id)).toEqual(["resend", "custom-ledger"]);
    expect(merged[1]).toMatchObject({
      credential: "organization", auth: "token", vetted: false, sharing: "public", custom: true,
    });
    expect(companySharingIn(merged, LEDGER.endpoint)).toBe("public");
  });

  it("lets the central catalog win an endpoint collision", () => {
    const shadowed: TenantServer = { ...LEDGER, endpoint: RESEND.endpoint };
    expect(mergeCatalog([RESEND], [shadowed])).toEqual([RESEND]);
  });

  it("leaves an endpoint nobody listed owner-only", () => {
    expect(companySharingIn(mergeCatalog([RESEND], []), LEDGER.endpoint)).toBe("owner-only");
  });
});

describe("a tenant server's connector", () => {
  it("owns the input that lists it and its key", () => {
    const resource = catalogResource(asCatalogServer(LEDGER));
    expect(resource.connector).toMatchObject({
      id: "custom-ledger",
      displayName: "Ledger",
      credentialScope: "organization",
      setupInputNames: [serverInputName("custom-ledger"), keyInputName("custom-ledger")],
    });
    expect(resource.connectableBy).toBeUndefined();
  });

  it("owns only its listing when it takes no key", () => {
    const resource = catalogResource(asCatalogServer({ ...LEDGER, auth: "none" }));
    expect(resource.connector?.setupInputNames).toEqual(["SERVER_CUSTOM_LEDGER"]);
  });

  it("leaves a central company server's inputs as they were", () => {
    expect(catalogResource(RESEND).connector?.setupInputNames).toEqual(["KEY_RESEND"]);
  });
});
