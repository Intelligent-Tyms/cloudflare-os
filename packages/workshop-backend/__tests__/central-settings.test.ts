import { describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_CONFIG, parseAdminConfig, serializeAdminConfig } from "../src/admin-config";
import { adoptCentralSettings, catalogFingerprint, centralSettingsOf, fetchCentralLogo, hasCentralSettings, pullCentralSettings, reportCatalog, sanitizeCentralSettings, seedCentralSettings } from "../src/central-settings";

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
  disabledSkills: ["pdf"],
  disabledModels: ["gpt-4o"],
};
const logo = "a".repeat(64);
const pulled = { ...settings, logo };

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
    expect(sanitizeCentralSettings(pulled)).toEqual(pulled);
    const odd = sanitizeCentralSettings({
      siteName: "x".repeat(100),
      accentColor: "red",
      banner: { text: 5, color: "purple" },
      instanceInstructions: null,
      disabledSkills: ["a", "a", 3, ""],
      logo: "not-a-hash",
    });
    expect(odd.disabledSkills).toEqual(["a"]);
    expect(odd.disabledModels).toEqual([]);
    expect(odd.logo).toBe("");
    expect(odd.siteName).toHaveLength(40);
    expect(odd.accentColor).toBe("");
    expect(odd.banner).toEqual({ text: "", color: "info" });
    expect(odd.instanceInstructions).toBe("");
    expect(sanitizeCentralSettings(null)).toEqual({ ...centralSettingsOf(DEFAULT_ADMIN_CONFIG), logo: "" });
  });

  it("pull names the version applied and reads the three answers", async () => {
    await withFetch(() => Response.json({ version: 3, settings: pulled, missing: ["logo"] }), async (calls) => {
      expect(await pullCentralSettings(configured, 2))
          .toEqual({ kind: "settings", version: 3, settings: pulled, missing: ["logo"] });
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

  it("seeds and adopts with this deployment's own values and logo", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await withFetch(() => Response.json({ version: 1, settings: pulled }), async (calls) => {
      expect(await seedCentralSettings(configured, settings, png))
          .toEqual({ kind: "settings", version: 1, settings: pulled, missing: [] });
      expect(calls[0]).toMatchObject({
        url: "https://control.example.com/tenant-api/config/seed", method: "POST",
        body: { settings, logoPng: btoa(String.fromCharCode(...png)) },
      });
      await adoptCentralSettings(configured, settings, null);
      expect(calls[1]).toMatchObject({
        url: "https://control.example.com/tenant-api/config/adopt", body: { settings, logoPng: null },
      });
    });
  });

  it("fetches the logo with its hash", async () => {
    await withFetch(() => Response.json({ png: btoa("PNG!"), sha256: logo }), async (calls) => {
      const fetched = await fetchCentralLogo(configured);
      expect(new TextDecoder().decode(fetched.png)).toBe("PNG!");
      expect(fetched.sha256).toBe(logo);
      expect(calls[0].url).toBe("https://control.example.com/tenant-api/config/logo");
    });
    await withFetch(() => Response.json({ error: "no logo" }, { status: 404 }), async () => {
      await expect(fetchCentralLogo(configured)).rejects.toThrow("no logo");
    });
  });

  it("reports the catalog, and fingerprints it stably", async () => {
    const catalog = { skills: [{ name: "pdf", description: "PDFs", sources: ["Company"] }], models: null };
    await withFetch(() => Response.json({ ok: true }), async (calls) => {
      await reportCatalog(configured, catalog);
      expect(calls[0]).toMatchObject({ url: "https://control.example.com/tenant-api/catalog", body: catalog });
    });
    expect(await catalogFingerprint(catalog)).toBe(await catalogFingerprint(structuredClone(catalog)));
    expect(await catalogFingerprint(catalog)).not.toBe(await catalogFingerprint({ ...catalog, skills: [] }));
  });

  it("record the applied version in the admin config", () => {
    expect(parseAdminConfig("{}").centralSettingsVersion).toBe(0);
    expect(parseAdminConfig('{"centralSettingsVersion":-1}').centralSettingsVersion).toBe(0);
    expect(parseAdminConfig('{"centralLogoSha":"x"}').centralLogoSha).toBe("");
    const config = { ...DEFAULT_ADMIN_CONFIG, ...settings, centralSettingsVersion: 4, centralLogoSha: logo };
    expect(parseAdminConfig(serializeAdminConfig(config))).toEqual(config);
    expect(centralSettingsOf(config)).toEqual(settings);
  });
});
