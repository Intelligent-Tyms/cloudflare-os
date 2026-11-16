import { describe, expect, it } from "vitest";

import {
  MAX_TENANT_SERVERS,
  appReplacing,
  asCatalogServer,
  builtInAppRefusal,
  mergeCatalog,
  parseTenantServers,
  serverInputName,
  serverUrlInput,
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
import { appCatalogServers } from "../src/tyms-apps.js";

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

describe("a Tyms app taking over a company server on its host", () => {
  // As the control plane lists them once Organization and Data Intelligence are apps.
  const APPS = appCatalogServers([
    { app: "organization", name: "Organization Intelligence", description: "", icon: null, mcpUrl: "https://acme.organization.tyms.ai/mcp" },
    { app: "data", name: "Data Intelligence", description: "", icon: null, mcpUrl: "https://acme.data.tyms.ai/mcp" },
  ]);
  // As administrators added them, with the oik_/dik_ key: the company wiki's endpoint, and Data's /mcp.
  const WIKI: TenantServer = { id: "custom-company-wiki", name: "Company wiki", endpoint: "https://ACME.organization.tyms.ai/w/company/mcp", auth: "token", addedAt: 1 };
  const DATA: TenantServer = { id: "custom-data", name: "Data", endpoint: "https://acme.data.tyms.ai/mcp", auth: "token", addedAt: 2 };
  const OTHER_WORKSPACE: TenantServer = { id: "custom-globex-wiki", name: "Globex wiki", endpoint: "https://globex.organization.tyms.ai/w/company/mcp", auth: "token", addedAt: 3 };

  it("matches by host, whatever the path or case", () => {
    expect(appReplacing(WIKI, APPS)?.app).toBe("organization");
    expect(appReplacing(DATA, APPS)?.app).toBe("data");
    expect(appReplacing(OTHER_WORKSPACE, APPS)).toBeUndefined();
    expect(appReplacing(LEDGER, APPS)).toBeUndefined();
    expect(appReplacing({ endpoint: "not a url" }, APPS)).toBeUndefined();
  });

  it("only an app takes over, not a central catalog server on the same host", () => {
    expect(appReplacing(WIKI, [{ ...RESEND, endpoint: "https://acme.organization.tyms.ai/mcp" }])).toBeUndefined();
  });

  it("leaves the tenant's server out of the catalog, so its tools are listed once and its key is not sent", () => {
    const merged = mergeCatalog([RESEND], [WIKI, DATA, LEDGER, OTHER_WORKSPACE], APPS);
    expect(merged.map((server) => server.id)).toEqual(["resend", "custom-ledger", "custom-globex-wiki", "app-organization", "app-data"]);
    expect(companySharingIn(merged, WIKI.endpoint)).toBe("owner-only");
  });

  it("gives the server back once the app is gone (the record was never deleted)", () => {
    expect(mergeCatalog([], [WIKI, DATA]).map((server) => server.id)).toEqual(["custom-company-wiki", "custom-data"]);
  });

  it("says so where setup lists the server, which an administrator can still remove", () => {
    expect(serverUrlInput(LEDGER)).toEqual({ name: serverInputName(LEDGER.id), kind: "var", label: "Server URL" });
    const input = serverUrlInput(WIKI, appReplacing(WIKI, APPS));
    expect(input).toMatchObject({
      name: serverInputName(WIKI.id),
      kind: "var",
      label: "Server URL (not in use: Organization Intelligence is built into Jamaa)",
    });
    expect(input.setupSteps?.join(" ")).toContain("its key is not sent");
  });

  it("refuses a new server on the app's host in the app's name", () => {
    expect(builtInAppRefusal(appReplacing(WIKI, APPS)!)).toBe(
      "Organization Intelligence is built into Jamaa: everyone uses it as themselves, with nothing to set up. " +
      "Its API keys are for scripts and integrations, not for Jamaa.");
  });
});
