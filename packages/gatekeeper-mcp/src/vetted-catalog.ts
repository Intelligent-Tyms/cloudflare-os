// The deployment's vetted MCP server catalog.
//
// Curated on the control plane and fetched from `MCP_CATALOG_URL` (absent means an empty
// catalog: pure bring-your-own behavior, exactly as before). Listing an endpoint there is a
// review assertion with two effects: the server appears as a one-click choice in the connect
// flow, and its trust tier becomes "vetted", letting its own read-only/idempotent tool
// annotations drive auto-approval (see `classifyTool`). Rows the curator marked `vetted: false`
// are offered for discovery but stay at "byo".
//
// The catalog is deployment configuration, so like every trust decision here it is read at
// point of use and never persisted onto an account. It sits behind an HTTP fetch, though, and
// the facet's `trust` getter is synchronous — so reads go through a per-isolate cache that
// tolerates staleness: a cold cache answers "byo" (the conservative tier) and kicks a
// background refresh, converging within one call. Withdrawing an entry takes effect within the
// TTL; the tool-catalog cache is keyed on the tier and refetches when it flips.
import { createLogger } from "@gadgets/backend-utils/logger";
import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { McpLogFields } from "@gadgets/mcp-shared/log";
import { sameEndpoint } from "@gadgets/mcp-shared/scope";
import type { ServerTrust } from "@gadgets/mcp-shared/tools";

const logger = createLogger<McpLogFields>({
  component: "gatekeeper.mcp", vendorId: "mcp",
});

export type CatalogServer = {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  vetted: boolean;
};

type CatalogEnv = { MCP_CATALOG_URL?: string };

const CATALOG_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

// Every catalog entry becomes a SupportedResource the connect UI and the agent's
// listConnectableResources see, so an oversized catalog bloats prompts rather than adding
// value. Extra rows are dropped (in catalog order) and logged.
const MAX_CATALOG_SERVERS = 24;

const MAX_NAME = 120;
const MAX_DESCRIPTION = 300;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Parses the control plane's catalog payload defensively — it is external input to this
// worker. Malformed rows are dropped, not fatal. Exported for tests.
export function parseCatalog(payload: unknown): CatalogServer[] {
  const rows = (payload as { servers?: unknown })?.servers;
  if (!Array.isArray(rows)) return [];
  const servers: CatalogServer[] = [];
  for (const row of rows) {
    if (servers.length >= MAX_CATALOG_SERVERS) {
      logger.warn(`vetted catalog truncated: kept ${MAX_CATALOG_SERVERS} of ${rows.length}`, {
        event: "catalog.truncated",
      });
      break;
    }
    const record = row as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const rawEndpoint = typeof record.endpoint === "string" ? record.endpoint.trim() : "";
    if (!ID_PATTERN.test(id) || !name || name.length > MAX_NAME) continue;
    let url: URL;
    try {
      url = new URL(rawEndpoint);
    } catch {
      continue;
    }
    // Same rules as a typed endpoint: https only, and URL userinfo is an ambient credential.
    if (url.protocol !== "https:" || url.username || url.password) continue;
    url.hash = "";
    servers.push({
      id,
      name,
      description: typeof record.description === "string"
        ? record.description.slice(0, MAX_DESCRIPTION) : "",
      endpoint: url.toString(),
      vetted: record.vetted !== false,
    });
  }
  return servers;
}

// Last fetched catalog, kept past its TTL so sync readers always have an answer; `expiresAt`
// only gates when a refresh is due.
let cache: { servers: CatalogServer[]; expiresAt: number } | undefined;
let refreshing: Promise<void> | undefined;

// Test seam: reset module state between tests.
export function resetCatalogCacheForTests(): void {
  cache = undefined;
  refreshing = undefined;
}

async function fetchCatalog(url: string): Promise<void> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`catalog fetch returned ${response.status}`);
    cache = { servers: parseCatalog(await response.json()), expiresAt: Date.now() + CATALOG_TTL_MS };
  } catch (error) {
    logger.warn("vetted catalog fetch failed", { event: "catalog.fetch.failed", error });
    // Keep serving the last known catalog rather than flapping every listing to empty; retry
    // no sooner than the normal TTL.
    cache = { servers: cache?.servers ?? [], expiresAt: Date.now() + CATALOG_TTL_MS };
  }
}

// Brings the cache up to date. Await it on async paths (listings, connect); the sync trust
// getter instead calls `refreshCatalogInBackground`.
export async function ensureCatalog(env: CatalogEnv): Promise<CatalogServer[]> {
  const url = env.MCP_CATALOG_URL?.trim();
  if (!url) return [];
  if (!cache || Date.now() >= cache.expiresAt) {
    refreshing ??= fetchCatalog(url).finally(() => { refreshing = undefined; });
    await refreshing;
  }
  return cache?.servers ?? [];
}

export function refreshCatalogInBackground(env: CatalogEnv): void {
  const url = env.MCP_CATALOG_URL?.trim();
  if (!url || (cache && Date.now() < cache.expiresAt)) return;
  refreshing ??= fetchCatalog(url).finally(() => { refreshing = undefined; });
}

// The catalog as last known — possibly stale, possibly empty on a cold isolate. Sync callers
// pair this with `refreshCatalogInBackground` so cold answers converge.
export function catalogServers(): CatalogServer[] {
  return cache?.servers ?? [];
}

export function catalogEntryFor(endpoint: string): CatalogServer | undefined {
  return catalogServers().find((server) => sameEndpoint(server.endpoint, endpoint));
}

// The trust tier for an endpoint: "vetted" only while the current catalog lists it with
// vetting on. Conservative on a cold cache — a vetted server momentarily classifies as "byo"
// (approvals required), never the reverse.
export function trustFor(env: CatalogEnv, endpoint: string): ServerTrust {
  refreshCatalogInBackground(env);
  const entry = catalogEntryFor(endpoint);
  return entry?.vetted === true ? "vetted" : "byo";
}

// One connectable resource per catalog server. The urlPattern is the exact endpoint URL —
// deliberately never the `https://*` catch-all, which the Workshop treats as the
// whole-instance fallback (that stays the bring-your-own entry's job).
export function catalogResource(server: CatalogServer): SupportedResource {
  return {
    urlPattern: server.endpoint,
    title: server.name,
    description: server.description ||
      `Tools from ${server.name}, vetted by your organization.`,
    grantable: true,
  };
}
