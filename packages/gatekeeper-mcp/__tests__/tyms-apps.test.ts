import { afterEach, describe, expect, it } from "vitest";

import {
  appCatalogServers,
  appDiscoveryToken,
  appOfServerId,
  appPersonToken,
  lastKnownTymsApps,
  loadTymsApps,
  resetTymsAppsCachesForTests,
  type TymsApp,
  type TymsAppsService,
} from "../src/tyms-apps.js";
import { catalogResource, companyServers } from "../src/vetted-catalog.js";

afterEach(() => resetTymsAppsCachesForTests());

const TASKS: TymsApp = {
  app: "tasks",
  name: "Tasks",
  description: "Plan and track the team's work on boards.",
  icon: "https://home.tyms.ai/apps/tasks.svg",
  mcpUrl: "https://acme.tasks.tyms.ai/mcp",
};

/** A control plane that counts what it was asked. */
function controlPlane(apps: TymsApp[] = [TASKS]) {
  const calls: string[] = [];
  let n = 0;
  const service: TymsAppsService = {
    async apps(slug) {
      calls.push(`apps:${slug}`);
      return apps;
    },
    async token(slug, app, email) {
      calls.push(`token:${slug}:${app}:${email}`);
      return { token: `person-${email}-${++n}`, expiresAt: Date.now() + 3_600_000 };
    },
    async discoveryToken(slug, app) {
      calls.push(`discovery:${slug}:${app}`);
      return { token: `discovery-${++n}`, expiresAt: Date.now() + 3_600_000 };
    },
  };
  return { env: { TYMS_APPS: service }, calls };
}

describe("apps as catalog servers", () => {
  it("makes each app a vetted company server with nothing to set up", () => {
    const [server] = appCatalogServers([TASKS]);
    expect(server).toEqual({
      id: "app-tasks",
      name: "Tasks",
      description: TASKS.description,
      endpoint: "https://acme.tasks.tyms.ai/mcp",
      vetted: true,
      sharing: "owner-only",
      auth: "token",
      credential: "organization",
      app: "tasks",
      icon: "https://home.tyms.ai/apps/tasks.svg",
    });
    expect(appOfServerId(server.id)).toBe("tasks");
    expect(appOfServerId("custom-wiki")).toBeNull();
    expect(companyServers([server])).toEqual([server]);
  });

  it("presents an app as its own connector card with its glyph and no setup inputs", () => {
    const resource = catalogResource(appCatalogServers([TASKS])[0]);
    expect(resource.urlPattern).toBe("https://acme.tasks.tyms.ai/mcp");
    expect(resource.connector).toMatchObject({
      id: "app-tasks",
      displayName: "Tasks",
      logo: { url: "https://home.tyms.ai/apps/tasks.svg" },
      credentialScope: "organization",
    });
    expect(resource.connector).not.toHaveProperty("setupInputNames");
    expect(resource.description).toContain("built into Jamaa");
  });

  it("drops anything malformed from the control plane rather than trusting it", () => {
    expect(appCatalogServers([
      { ...TASKS, mcpUrl: "http://acme.tasks.tyms.ai/mcp" },
      { ...TASKS, mcpUrl: "https://user:pw@acme.tasks.tyms.ai/mcp" },
      { ...TASKS, app: "Not An App!" },
      { ...TASKS, name: " " },
      null as unknown as TymsApp,
    ])).toEqual([]);
    expect(appCatalogServers([{ ...TASKS, icon: "javascript:alert(1)" }])[0]).not.toHaveProperty("icon");
  });
});

describe("loading a tenant's apps", () => {
  it("asks the control plane once per TTL, and lists nothing without the binding or a tenant", async () => {
    const { env, calls } = controlPlane();
    expect((await loadTymsApps(env, "acme")).map((s) => s.id)).toEqual(["app-tasks"]);
    await loadTymsApps(env, "acme");
    expect(calls).toEqual(["apps:acme"]);
    await loadTymsApps(env, "acme", { fresh: true });
    expect(calls).toEqual(["apps:acme", "apps:acme"]);
    expect(lastKnownTymsApps("acme").map((s) => s.id)).toEqual(["app-tasks"]);
    expect(await loadTymsApps({}, "acme")).toEqual([]);
    expect(await loadTymsApps(env, "")).toEqual([]);
  });

  it("keeps the last known apps when the control plane fails", async () => {
    const { env } = controlPlane();
    await loadTymsApps(env, "acme");
    const failing = { TYMS_APPS: { ...env.TYMS_APPS, apps: async () => { throw new Error("down"); } } };
    expect((await loadTymsApps(failing, "acme", { fresh: true })).map((s) => s.id)).toEqual(["app-tasks"]);
    expect(await loadTymsApps(failing, "globex")).toEqual([]);
  });
});

describe("tokens", () => {
  it("reuses a person's token until shortly before it expires, per tenant, app and person", async () => {
    const { env, calls } = controlPlane();
    const first = await appPersonToken(env, "acme", "tasks", "Ann@Acme.test");
    expect(await appPersonToken(env, "acme", "tasks", "ann@acme.test")).toBe(first);
    expect(await appPersonToken(env, "acme", "tasks", "bob@acme.test")).not.toBe(first);
    expect(calls).toEqual(["token:acme:tasks:ann@acme.test", "token:acme:tasks:bob@acme.test"]);
  });

  it("re-mints a token within a minute of its expiry", async () => {
    let n = 0;
    const env = { TYMS_APPS: {
      ...controlPlane().env.TYMS_APPS,
      token: async () => ({ token: `t${++n}`, expiresAt: Date.now() + 30_000 }),
    } };
    expect(await appPersonToken(env, "acme", "tasks", "ann@acme.test")).toBe("t1");
    expect(await appPersonToken(env, "acme", "tasks", "ann@acme.test")).toBe("t2");
  });

  it("keeps discovery and person tokens apart, and passes the control plane's refusal on", async () => {
    const { env, calls } = controlPlane();
    expect(await appDiscoveryToken(env, "acme", "tasks")).toMatch(/^discovery-/);
    await appDiscoveryToken(env, "acme", "tasks");
    expect(calls).toEqual(["discovery:acme:tasks"]);
    const refusing = { TYMS_APPS: { ...env.TYMS_APPS, token: async () => { throw new Error("not a member of that workspace"); } } };
    await expect(appPersonToken(refusing, "acme", "tasks", "eve@evil.test")).rejects.toThrow("not a member of that workspace");
    await expect(appPersonToken({}, "acme", "tasks", "ann@acme.test")).rejects.toThrow("not available");
  });
});
