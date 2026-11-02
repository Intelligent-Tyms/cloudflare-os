// Tyms apps built into Jamaa (tyms-docs specs/jamaa-in-apps-spec.md §4).
//
// When a workspace with Jamaa switches on a Tyms app (Tasks, …), the app is a connector here with
// nothing to set up: no key, no sign-in. Each app is a company server in this connector's catalog,
// reached through the account every member is provisioned, with two differences:
//
// - Credentials come from the Tyms control plane over the `TYMS_APPS` service binding
//   (JamaaAppsEntrypoint), never from an administrator. The shared per-tenant account holds a
//   **discovery token**, which lists the app's tools and nothing else, so connecting and building
//   tool types need no person. Every call that reads or changes data carries an **access token
//   for the person** the agent acts for, minted when the session starts, and again when an
//   approved call is applied, for the person who queued it (`StoredAction.actor`). Without a
//   person there is no call: a hook or scheduled run reaches the app with the discovery token
//   alone, which the app refuses.
// - The app is first-party, so its tool annotations drive approval ("vetted"), unlike a server an
//   administrator added by URL.
//
// The tenant comes from this connector's binding props, which a tenant cannot set; the control
// plane checks the person against the workspace exactly as it would their own sign-in to the app.
import type { CatalogServer } from "./vetted-catalog.js";

/** One app as the control plane lists it (tyms-os src/jamaa-apps.ts JamaaApp). */
export type TymsApp = {
  app: string;
  name: string;
  description: string;
  icon: string | null;
  mcpUrl: string;
};

export type TymsAppToken = { token: string; expiresAt: number };

/** The control plane's JamaaAppsEntrypoint, as this connector binds it (`TYMS_APPS`). */
export type TymsAppsService = {
  apps(slug: string): Promise<TymsApp[]>;
  token(slug: string, app: string, email: string): Promise<TymsAppToken>;
  discoveryToken(slug: string, app: string): Promise<TymsAppToken>;
};

export type TymsAppsEnv = { TYMS_APPS?: TymsAppsService };

/** Catalog ids of apps carry this prefix, so they never collide with a server a tenant added. */
const APP_ID_PREFIX = "app-";
const APP_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

const APPS_TTL_MS = 60_000;
/** Re-mint this long before a token expires, so a call made with a cached one lands in time. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

const appsCache = new Map<string, { apps: TymsApp[]; expiresAt: number }>();
const tokenCache = new Map<string, TymsAppToken>();

/** Test seam. */
export function resetTymsAppsCachesForTests(): void {
  appsCache.clear();
  tokenCache.clear();
}

export function isAppServerId(id: string): boolean {
  return id.startsWith(APP_ID_PREFIX);
}

/** The app an app server's catalog id names. */
export function appOfServerId(id: string): string | null {
  return isAppServerId(id) ? id.slice(APP_ID_PREFIX.length) : null;
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A company server for each app, checked like any other catalog input. */
export function appCatalogServers(apps: TymsApp[]): CatalogServer[] {
  const servers: CatalogServer[] = [];
  for (const app of apps) {
    const endpoint = safeHttpsUrl(app?.mcpUrl);
    if (!endpoint || typeof app.app !== "string" || !APP_PATTERN.test(app.app)) continue;
    if (typeof app.name !== "string" || !app.name.trim()) continue;
    const icon = safeHttpsUrl(app.icon);
    servers.push({
      id: `${APP_ID_PREFIX}${app.app}`,
      name: app.name.trim().slice(0, 120),
      description: typeof app.description === "string" ? app.description.slice(0, 300) : "",
      endpoint,
      vetted: true,
      // Each call runs as its person, and apps have things only some people see (a private Tasks
      // board). A workspace bound to an app opens for its owner alone, until observers can be
      // checked as themselves.
      sharing: "owner-only",
      auth: "token",
      credential: "organization",
      app: app.app,
      ...(icon ? { icon } : {}),
    });
  }
  return servers;
}

/** The apps this tenant has open, cached briefly per isolate; none without the binding or a tenant. */
export async function loadTymsApps(
  env: TymsAppsEnv, tenant: string, options?: { fresh?: boolean },
): Promise<CatalogServer[]> {
  if (!env.TYMS_APPS || !tenant) return [];
  const cached = appsCache.get(tenant);
  if (!options?.fresh && cached && Date.now() < cached.expiresAt) return appCatalogServers(cached.apps);
  let apps: TymsApp[];
  try {
    apps = await env.TYMS_APPS.apps(tenant);
  } catch {
    // Keep what was last known rather than dropping every app on one failed call; retry after
    // the TTL. A cold isolate with a failing control plane lists no apps, which is the safe side.
    apps = cached?.apps ?? [];
  }
  appsCache.set(tenant, { apps, expiresAt: Date.now() + APPS_TTL_MS });
  return appCatalogServers(apps);
}

/** The apps last loaded for a tenant, for a sync reader (a facet's `sharing` getter). */
export function lastKnownTymsApps(tenant: string): CatalogServer[] {
  return appCatalogServers(appsCache.get(tenant)?.apps ?? []);
}

async function cachedToken(key: string, mint: () => Promise<TymsAppToken>): Promise<string> {
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return cached.token;
  const minted = await mint();
  tokenCache.set(key, minted);
  return minted.token;
}

function requireService(env: TymsAppsEnv): TymsAppsService {
  if (!env.TYMS_APPS) throw new Error("Tyms apps are not available on this deployment.");
  return env.TYMS_APPS;
}

/** The token that lists an app's tools for a tenant, and nothing more. */
export function appDiscoveryToken(env: TymsAppsEnv, tenant: string, app: string): Promise<string> {
  return cachedToken(`discovery:${tenant}:${app}`,
    () => requireService(env).discoveryToken(tenant, app));
}

/**
 * An access token for `email` in a tenant's app. Throws with the control plane's reason when the
 * person may not use the app (not a member, the app switched off), which the agent shows as is.
 */
export function appPersonToken(
  env: TymsAppsEnv, tenant: string, app: string, email: string,
): Promise<string> {
  const person = email.trim().toLowerCase();
  return cachedToken(`person:${tenant}:${app}:${person}`,
    () => requireService(env).token(tenant, app, person));
}
