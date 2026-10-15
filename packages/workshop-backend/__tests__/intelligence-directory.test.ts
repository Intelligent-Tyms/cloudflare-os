import { afterEach, describe, expect, it } from "vitest";
import {
  deprovisionInstance,
  fetchIntelligence,
  handoffUrl,
  hasIntelligenceDirectory,
  instanceOf,
  intelligenceErrorMessage,
  provisionInstance,
  rotateAssistantKey,
} from "../src/intelligence-directory";

const configured = {
  CENTRAL_TEAM_API_URL: "https://control.example.com/tenant-api",
  CENTRAL_TEAM_API_TOKEN: "acme-co:token",
} as unknown as Cloudflare.Env;

const instance = {
  kind: "organization", status: "active", hostname: "acme-co.organization.example.com",
  wikiUrl: "https://acme-co.organization.example.com/company",
  mcpUrl: "https://acme-co.organization.example.com/w/company/mcp",
  provisionedAt: 1, suspendedAt: null, lastError: null,
};

type Call = { url: string; method: string; authorization: string | null; body: unknown };

function stubFetch(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

describe("intelligence directory", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("is off unless the central directory credentials are both present", () => {
    expect(hasIntelligenceDirectory(configured)).toBe(true);
    for (const missing of ["CENTRAL_TEAM_API_URL", "CENTRAL_TEAM_API_TOKEN"]) {
      const env = { ...configured, [missing]: undefined } as unknown as Cloudflare.Env;
      expect(hasIntelligenceDirectory(env), missing).toBe(false);
    }
  });

  it("provisions with the tenant bearer and returns the once-only assistant key", async () => {
    const calls = stubFetch(() => Response.json({ instance, assistantKey: "oik_secret" }, { status: 201 }));
    const outcome = await provisionInstance(configured, "organization");
    expect(outcome.assistantKey).toBe("oik_secret");
    expect(outcome.instance.mcpUrl).toBe(instance.mcpUrl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://control.example.com/tenant-api/intelligence/organization/provision");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].authorization).toBe("Bearer acme-co:token");
  });

  it("reads the overview and finds the organization instance", async () => {
    stubFetch(() => Response.json({
      credits: { monthlyGrantMicroUsd: 1, allowanceMicroUsd: 1, topupMicroUsd: 0, balanceMicroUsd: 1 },
      instances: [{ ...instance, kind: "market", status: "failed" }, instance],
    }));
    const view = await fetchIntelligence(configured);
    expect(instanceOf(view, "organization")?.status).toBe("active");
    expect(instanceOf(view, "data")).toBeNull();
    expect(instanceOf({ ...view, instances: [{ ...instance, kind: "data" }] }, "data")?.kind).toBe("data");
    expect(instanceOf({ ...view, instances: [] }, "organization")).toBeNull();
  });

  it("maps the control plane's refusal codes to administrator-ready messages", async () => {
    stubFetch(() => Response.json({ error: "not_provisioned" }, { status: 404 }));
    await expect(handoffUrl(configured, "organization", { email: "a@acme.com", role: "admin" })).rejects.toThrow(/Organization Intelligence is not provisioned/);
    stubFetch(() => Response.json({ error: "already_active" }, { status: 409 }));
    await expect(provisionInstance(configured, "data")).rejects.toThrow(/Data Intelligence is already provisioned/);
    stubFetch(() => new Response("gateway down", { status: 502 }));
    await expect(deprovisionInstance(configured, "organization")).rejects.toThrow(/unavailable \(502\)/);
    expect(intelligenceErrorMessage("a valid email is required", 400)).toBe("a valid email is required");
    expect(intelligenceErrorMessage("cell_unreachable", 502, "data")).toMatch(/could not be reached/);
  });

  it("mints a signed-in console URL for the vouched admin, landing on the requested page", async () => {
    const calls = stubFetch(() => Response.json({ url: "https://acme-co.data.example.com/login?handoff=t&next=%2Fconnections" }));
    const url = await handoffUrl(configured, "data", { email: "a@acme.com", role: "admin" }, "/connections");
    expect(url).toContain("/login?handoff=");
    expect(calls[0].url).toBe("https://control.example.com/tenant-api/intelligence/data/handoff");
    expect(calls[0].body).toEqual({ email: "a@acme.com", role: "admin", next: "/connections" });
  });

  it("rotates the key through the control plane, never the cell", async () => {
    const calls = stubFetch(() => Response.json({ assistantKey: "oik_new" }));
    expect((await rotateAssistantKey(configured, "organization")).assistantKey).toBe("oik_new");
    expect(calls[0].url).toBe("https://control.example.com/tenant-api/intelligence/organization/rotate-key");
    expect(calls[0].body).toEqual({});
  });

  it("addresses the Data product by its own path segment", async () => {
    const calls = stubFetch(() => Response.json({ instance: { ...instance, kind: "data" }, assistantKey: "dik_secret" }, { status: 201 }));
    const outcome = await provisionInstance(configured, "data");
    expect(outcome.assistantKey).toBe("dik_secret");
    expect(calls[0].url).toBe("https://control.example.com/tenant-api/intelligence/data/provision");
    stubFetch(() => Response.json({ instance: { ...instance, kind: "data", status: "suspended" } }));
    expect((await deprovisionInstance(configured, "data")).instance.status).toBe("suspended");
  });
});
