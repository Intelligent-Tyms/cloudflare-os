// Workspace settings managed centrally (multi-tenant installations): the organization profile,
// the instructions, the site name, the logo, the accent color, the top-bar notice, the banner,
// and the skills and AI models switched off are edited on the admin portal and stored by the
// control plane. The AdminSettings DO pulls them from CENTRAL_TEAM_API_URL/config about once a
// minute (its alarm) and writes them into AdminConfig (and the logo into R2), so every reader
// keeps reading as before (readAdminConfig, the site-logo route).
//
// The first pull finds nothing there and seeds it with what this deployment held, so moving a
// workspace to central settings loses nothing; a field the control plane's copy predates comes
// back named in `missing`, and the DO adopts its own value for it. From then on
// AdminConfig.centralSettingsVersion is the version applied, and the admin page leaves these
// fields to the portal. The logo travels by hash: the pull names it, and the DO fetches the
// image only when the hash differs from AdminConfig.centralLogoSha.
//
// What can be switched off depends on this deployment (its skills, its gateway's models), so
// the DO also reports that catalog for the portal to list (reportCatalog).

import { BannerColor, DEFAULT_BANNER_COLOR, MAX_ANNOUNCEMENT_LENGTH, MAX_INSTANCE_INSTRUCTIONS_LENGTH, MAX_ORGANIZATION_PROFILE_LENGTH, MAX_SITE_NAME_LENGTH, isBannerColor, isHexColor } from "@gadgets/workshop-shared/api";
import type { AdminConfig } from "./storage-schema/admin-settings-storage.js";

/** The AdminConfig fields the admin portal owns (the logo travels separately, by hash). */
export type CentralSettings = Pick<AdminConfig,
    "organizationProfile" | "instanceInstructions" | "siteName" | "accentColor" | "announcement" | "banner"
    | "disabledSkills" | "disabledModels">;

/** The settings as pulled: the fields above, plus the logo's SHA-256 ("" = default logo). */
export type CentralSettingsPayload = CentralSettings & {logo: string};

/** Bound on a switched-off list, matching the control plane's. */
const MAX_DISABLED_ENTRIES = 500;

/** How often the AdminSettings DO pulls. Portal saves show up within this. */
export const CENTRAL_SETTINGS_POLL_MS = 60_000;

/** Whether this deployment has a control plane to take its settings from. */
export function hasCentralSettings(env: Cloudflare.Env): boolean {
  return Boolean(env.CENTRAL_TEAM_API_URL && env.CENTRAL_TEAM_API_TOKEN);
}

export function centralSettingsOf(config: AdminConfig): CentralSettings {
  return {
    organizationProfile: config.organizationProfile,
    instanceInstructions: config.instanceInstructions,
    siteName: config.siteName,
    accentColor: config.accentColor,
    announcement: config.announcement,
    banner: config.banner,
    disabledSkills: config.disabledSkills,
    disabledModels: config.disabledModels,
  };
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0))]
      .slice(0, MAX_DISABLED_ENTRIES);
}

/**
 * The settings as this deployment will apply them. The control plane validates to the same
 * limits; this checks again so nothing it sends can put AdminConfig outside them.
 */
export function sanitizeCentralSettings(input: unknown): CentralSettingsPayload {
  let p = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  let banner = (p.banner && typeof p.banner === "object" ? p.banner : {}) as Record<string, unknown>;
  return {
    organizationProfile: text(p.organizationProfile, MAX_ORGANIZATION_PROFILE_LENGTH),
    instanceInstructions: text(p.instanceInstructions, MAX_INSTANCE_INSTRUCTIONS_LENGTH),
    siteName: text(p.siteName, MAX_SITE_NAME_LENGTH),
    accentColor: isHexColor(p.accentColor) ? p.accentColor : "",
    announcement: text(p.announcement, MAX_ANNOUNCEMENT_LENGTH),
    banner: {
      text: text(banner.text, MAX_ANNOUNCEMENT_LENGTH),
      color: isBannerColor(banner.color) ? banner.color as BannerColor : DEFAULT_BANNER_COLOR,
    },
    disabledSkills: names(p.disabledSkills),
    disabledModels: names(p.disabledModels),
    logo: typeof p.logo === "string" && /^[0-9a-f]{64}$/.test(p.logo) ? p.logo : "",
  };
}

/** What the control plane answers: a version to apply, no change, or nothing stored yet. */
export type CentralSettingsPull =
  | {kind: "settings"; version: number; settings: CentralSettingsPayload; missing: string[]}
  | {kind: "unchanged"}
  | {kind: "absent"};

async function call(env: Cloudflare.Env, path: string, body?: object): Promise<unknown> {
  let response = await fetch(`${env.CENTRAL_TEAM_API_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${env.CENTRAL_TEAM_API_TOKEN}`,
      ...(body === undefined ? {} : {"content-type": "application/json"}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  let data = (await response.json().catch(() => ({}))) as {error?: string};
  if (!response.ok) {
    throw new Error(data.error ?? `The control plane's settings are unavailable (${response.status}).`);
  }
  return data;
}

function parsePull(data: unknown): CentralSettingsPull {
  let d = (data ?? {}) as {version?: unknown; settings?: unknown; unchanged?: unknown; missing?: unknown};
  if (d.unchanged === true) return {kind: "unchanged"};
  if (d.settings === null || d.settings === undefined) return {kind: "absent"};
  if (typeof d.version !== "number" || !Number.isInteger(d.version) || d.version < 1) {
    throw new Error("The control plane sent settings without a version.");
  }
  let missing = Array.isArray(d.missing) ? d.missing.filter((k): k is string => typeof k === "string") : [];
  return {kind: "settings", version: d.version, settings: sanitizeCentralSettings(d.settings), missing};
}

/** Pull the current settings, naming the version already applied (0 = none). */
export async function pullCentralSettings(
    env: Cloudflare.Env, sinceVersion: number): Promise<CentralSettingsPull> {
  return parsePull(await call(env, `/config?since=${sinceVersion}`));
}

function base64(data: Uint8Array): string {
  let s = "";
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Store this deployment's own values (and its logo, when it has one) as the first central
 * version. A version stored meanwhile (another pull won, or an admin saved on the portal)
 * stands, and is what comes back.
 */
export async function seedCentralSettings(
    env: Cloudflare.Env, settings: CentralSettings, logoPng: Uint8Array | null): Promise<CentralSettingsPull> {
  return parsePull(await call(env, "/config/seed", {settings, logoPng: logoPng && base64(logoPng)}));
}

/**
 * Hand over this deployment's own values for the fields the control plane's copy lacks (it
 * predates them). Only those fields are taken there; what comes back is the stored version.
 */
export async function adoptCentralSettings(
    env: Cloudflare.Env, settings: CentralSettings, logoPng: Uint8Array | null): Promise<CentralSettingsPull> {
  return parsePull(await call(env, "/config/adopt", {settings, logoPng: logoPng && base64(logoPng)}));
}

/** The logo the settings name, with its hash so a caller can tell it got the one it asked for. */
export async function fetchCentralLogo(env: Cloudflare.Env): Promise<{png: Uint8Array; sha256: string}> {
  let d = (await call(env, "/config/logo")) as {png?: unknown; sha256?: unknown};
  if (typeof d.png !== "string" || typeof d.sha256 !== "string") {
    throw new Error("The control plane sent no logo.");
  }
  return {png: Uint8Array.from(atob(d.png), c => c.charCodeAt(0)), sha256: d.sha256};
}

/** What this deployment can switch off, for the portal to list. */
export type CentralCatalog = {
  skills: {name: string; description: string; sources: string[]}[];
  /** Null outside AI Gateway mode, where models are added rather than switched off. */
  models: {id: string; name: string; provider: string; freePlan: boolean}[] | null;
};

/** How often the DO lists its catalog to see whether the portal's copy needs replacing. */
export const CENTRAL_CATALOG_CHECK_MS = 10 * 60_000;
/** Re-sent this often even when unchanged, so a lost report heals on its own. */
export const CENTRAL_CATALOG_REFRESH_MS = 6 * 60 * 60_000;

export async function reportCatalog(env: Cloudflare.Env, catalog: CentralCatalog): Promise<void> {
  await call(env, "/catalog", catalog);
}

/** A stable fingerprint of a catalog, to send it only when it changed. */
export async function catalogFingerprint(catalog: CentralCatalog): Promise<string> {
  let digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(catalog)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
