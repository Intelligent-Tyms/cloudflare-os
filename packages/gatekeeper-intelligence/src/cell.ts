/**
 * Reaching the wiki from inside the fleet.
 *
 * Wiki hosts (`<slug>.organization.tyms.ai`) are served by the Intelligence cell Worker through
 * Workers routes on the tyms.ai zone, the zone this worker runs on. Cloudflare sends a subrequest
 * from a Worker to a host on its own zone to that host's DNS origin, never to the Worker on the
 * route, so a plain `fetch` of a wiki URL answers 522. deploy.mjs therefore binds the cell Worker
 * as `INTELLIGENCE_CELL` and every request to a host under `INTELLIGENCE_BASE_DOMAIN` goes through
 * it; the URL keeps the tenant host because the cell resolves the tenant from it. Other hosts (a
 * dedicated cell on a customer zone, local development) use the platform fetch.
 */
import type { FetchOptions } from "@gadgets/mcp-shared/fetch";

export type CellEnv = { INTELLIGENCE_CELL?: Fetcher; INTELLIGENCE_BASE_DOMAIN?: string };

/** Whether `host` is the base domain or a subdomain of it. */
export function isCellHost(host: string, baseDomain: string | undefined): boolean {
  const base = (baseDomain ?? "").trim().toLowerCase();
  if (!base) return false;
  const name = host.toLowerCase();
  return name === base || name.endsWith(`.${base}`);
}

/** Fetch options that route `endpoint` through the cell binding when it is a wiki host. */
export function cellFetchOptions(env: CellEnv, endpoint: string): Pick<FetchOptions, "fetchImpl"> {
  const cell = env.INTELLIGENCE_CELL;
  if (!cell) return {};
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return {};
  }
  if (!isCellHost(host, env.INTELLIGENCE_BASE_DOMAIN)) return {};
  return { fetchImpl: (input, init) => cell.fetch(input, init) };
}
