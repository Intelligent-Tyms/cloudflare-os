import { describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_CONFIG, parseAdminConfig, serializeAdminConfig } from "../src/admin-config";
import { centralSettingsOf, hasCentralSettings, pullCentralSettings, sanitizeCentralSettings, seedCentralSettings } from "../src/central-settings";

const configured = {
  CENTRAL_TEAM_API_URL: "https://control.example.com/tenant-api",
  CENTRAL_TEAM_API_TOKEN: "acme-co:token",
} as unknown as Cloudflare.Env;

const settings = {
  organizationProfile: "We make anvils.",
  instanceInstructions: "Be brief.",
  siteName: "Acme",
  accentColor: "#3b82f6",
  announcement: "Welcome",
  banner: { text: "Maintenance tonight", color: "warning" as const },
};

async function withFetch<T>(
    respond: (url: string, init?: RequestInit) => Response,
    run: (calls: { url: string; method: string; body: unknown }[]) => Promise<T>): Promise<T> {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return respond(url, init);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("central settings", () => {
  it("are on only with a control plane", () => {
    expect(hasCentralSettings(configured)).toBe(true);
    expect(hasCentralSettings({ ...configured, CENTRAL_TEAM_API_TOKEN: undefined } as unknown as Cloudflare.Env))
        .toBe(false);
  });

  it("keep what the control plane sends within this deployment's limits", () => {
    expect(sanitizeCentralSettings(settings)).toEqual(settings);
    const odd = sanitizeCentralSettings({
      siteName: "x".repeat(100),
      accentColor: "red",
      banner: { text: 5, color: "purple" },
      instanceInstructions: null,
    });
    expect(odd.siteName).toHaveLength(40);
    expect(odd.accentColor).toBe("");
    expect(odd.banner).toEqual({ text: "", color: "info" });
    expect(odd.instanceInstructions).toBe("");
    expect(sanitizeCentralSettings(null)).toEqual(centralSettingsOf(DEFAULT_ADMIN_CONFIG));
  });

  it("pull names the version applied and reads the three answers", async () => {
    await withFetch(() => Response.json({ version: 3, settings }), async (calls) => {
      expect(await pullCentralSettings(configured, 2)).toEqual({ kind: "settings", version: 3, settings });
      expect(calls[0]).toMatchObject({ url: "https://control.example.com/tenant-api/config?since=2", method: "GET" });
    });
    await withFetch(() => Response.json({ version: 3, unchanged: true }), async () => {
      expect(await pullCentralSettings(configured, 3)).toEqual({ kind: "unchanged" });
    });
    await withFetch(() => Response.json({ version: 0, settings: null }), async () => {
      expect(await pullCentralSettings(configured, 0)).toEqual({ kind: "absent" });
    });
  });

  it("refuses settings without a version, and surfaces the control plane's errors", async () => {
    await withFetch(() => Response.json({ settings }), async () => {
      await expect(pullCentralSettings(configured, 0)).rejects.toThrow(/version/);
    });
    await withFetch(() => Response.json({ error: "unauthorized" }, { status: 401 }), async () => {
      await expect(pullCentralSettings(configured, 0)).rejects.toThrow("unauthorized");
    });
  });

  it("seeds with this deployment's own values", async () => {
    await withFetch(() => Response.json({ version: 1, settings }), async (calls) => {
      expect(await seedCentralSettings(configured, settings)).toEqual({ kind: "settings", version: 1, settings });
      expect(calls[0]).toMatchObject({
        url: "https://control.example.com/tenant-api/config/seed", method: "POST", body: { settings },
      });
    });
  });

  it("record the applied version in the admin config", () => {
    expect(parseAdminConfig("{}").centralSettingsVersion).toBe(0);
    expect(parseAdminConfig('{"centralSettingsVersion":-1}').centralSettingsVersion).toBe(0);
    const config = { ...DEFAULT_ADMIN_CONFIG, ...settings, centralSettingsVersion: 4 };
    expect(parseAdminConfig(serializeAdminConfig(config))).toEqual(config);
    expect(centralSettingsOf(config)).toEqual(settings);
  });
});
