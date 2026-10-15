// Workspace settings managed centrally (multi-tenant installations): the organization profile,
// the instructions, the site name, the accent color, the top-bar notice and the banner are
// edited on the admin portal and stored by the control plane. The AdminSettings DO pulls them
// from CENTRAL_TEAM_API_URL/config about once a minute (its alarm) and writes them into
// AdminConfig, so every reader keeps reading the KV mirror as before (readAdminConfig).
//
// The first pull finds nothing there and seeds it with what this deployment held, so moving a
// workspace to central settings loses nothing. From then on AdminConfig.centralSettingsVersion
// is the version applied, and the admin page leaves these fields to the portal.

import { BannerColor, DEFAULT_BANNER_COLOR, MAX_ANNOUNCEMENT_LENGTH, MAX_INSTANCE_INSTRUCTIONS_LENGTH, MAX_ORGANIZATION_PROFILE_LENGTH, MAX_SITE_NAME_LENGTH, isBannerColor, isHexColor } from "@gadgets/workshop-shared/api";
import type { AdminConfig } from "./admin-config.js";

/** The AdminConfig fields the admin portal owns. */
export type CentralSettings = Pick<AdminConfig,
    "organizationProfile" | "instanceInstructions" | "siteName" | "accentColor" | "announcement" | "banner">;

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
  };
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * The settings as this deployment will apply them. The control plane validates to the same
 * limits; this checks again so nothing it sends can put AdminConfig outside them.
 */
export function sanitizeCentralSettings(input: unknown): CentralSettings {
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
  };
}

/** What the control plane answers: a version to apply, no change, or nothing stored yet. */
export type CentralSettingsPull =
  | {kind: "settings"; version: number; settings: CentralSettings}
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
  let d = (data ?? {}) as {version?: unknown; settings?: unknown; unchanged?: unknown};
  if (d.unchanged === true) return {kind: "unchanged"};
  if (d.settings === null || d.settings === undefined) return {kind: "absent"};
  if (typeof d.version !== "number" || !Number.isInteger(d.version) || d.version < 1) {
    throw new Error("The control plane sent settings without a version.");
  }
  return {kind: "settings", version: d.version, settings: sanitizeCentralSettings(d.settings)};
}

/** Pull the current settings, naming the version already applied (0 = none). */
export async function pullCentralSettings(
    env: Cloudflare.Env, sinceVersion: number): Promise<CentralSettingsPull> {
  return parsePull(await call(env, `/config?since=${sinceVersion}`));
}

/**
 * Store this deployment's own values as the first central version. A version stored meanwhile
 * (another pull won, or an admin saved on the portal) stands, and is what comes back.
 */
export async function seedCentralSettings(
    env: Cloudflare.Env, settings: CentralSettings): Promise<CentralSettingsPull> {
  return parsePull(await call(env, "/config/seed", {settings}));
}
