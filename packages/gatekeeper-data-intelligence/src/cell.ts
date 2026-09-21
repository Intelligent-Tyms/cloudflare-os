/**
 * Reaching Data Intelligence from inside the fleet.
 *
 * Tenant hosts (`<slug>.data.tyms.ai`) are served by the Data Intelligence cell Worker through
 * Workers routes on the tyms.ai zone, the zone this worker runs on. Cloudflare sends a subrequest
 * from a Worker to a host on its own zone to that host's DNS origin, never to the Worker on the
 * route, so a plain `fetch` of a tenant URL answers 522. deploy.mjs therefore binds the cell Worker
 * as `DATA_INTELLIGENCE_CELL` and every request to a host under `DATA_INTELLIGENCE_BASE_DOMAIN`
 * goes through it; the URL keeps the tenant host because the cell resolves the tenant from it.
 * Other hosts (a dedicated cell on a customer zone, local development) use the platform fetch.
 */
import type { FetchOptions } from "@gadgets/mcp-shared/fetch";

export type CellEnv = { DATA_INTELLIGENCE_CELL?: Fetcher; DATA_INTELLIGENCE_BASE_DOMAIN?: string };

/** Whether `host` is the base domain or a subdomain of it. */
export function isCellHost(host: string, baseDomain: string | undefined): boolean {
  const base = (baseDomain ?? "").trim().toLowerCase();
  if (!base) return false;
  const name = host.toLowerCase();
  return name === base || name.endsWith(`.${base}`);
}

/** Fetch options that route `endpoint` through the cell binding when it is a tenant host. */
export function cellFetchOptions(env: CellEnv, endpoint: string): Pick<FetchOptions, "fetchImpl"> {
  const cell = env.DATA_INTELLIGENCE_CELL;
  if (!cell) return {};
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return {};
  }
  if (!isCellHost(host, env.DATA_INTELLIGENCE_BASE_DOMAIN)) return {};
  return { fetchImpl: (input, init) => cell.fetch(input, init) };
}
