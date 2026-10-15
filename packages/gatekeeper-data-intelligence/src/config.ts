// The one Data Intelligence organization this connector talks to, as the tenant's administrator
// (or the provisioning flow in Tyms Admin › Intelligence) configured it.
//
// A sibling of gatekeeper-intelligence's config, and deliberately the same shape: the endpoint is
// a setting rather than user input, there is no connect form, one preissued key serves the whole
// workshop, an unconfigured tenant hides the connector instead of offering a dead end, and there
// is no deploy-time fallback -- every value is per tenant, written by the workshop after
// provisioning or pasted by an admin.

import type { VendorSetupInput } from "@gadgets/workshop-shared/gatekeeper";
import { fetchOptions } from "@gadgets/mcp-shared/fetch";
import { sameEndpoint } from "@gadgets/mcp-shared/scope";

/** The configured organization, once the tenant's setup values have been read and validated. */
export type DataIntelligenceConfig = {
  /** The organization's MCP endpoint (Streamable HTTP), e.g. `https://acme.data.tyms.ai/mcp`. */
  endpoint: string;
  /** Where a person opens the workbench. */
  consoleUrl: string;
};

/** Stable id used in binding names, action kinds, and generated type names. */
export const DATA_INTELLIGENCE_SERVER_ID = "data-intelligence";

/** The setup values one tenant's store holds. */
export type DataIntelligenceSetupValues = {
  DATA_INTELLIGENCE_MCP_URL?: string;
  DATA_INTELLIGENCE_CONSOLE_URL?: string;
  DATA_INTELLIGENCE_ASSISTANT_KEY?: string;
};

/** The names an administrator (or the provisioning flow) may set; also the store's key allowlist. */
export const DATA_INTELLIGENCE_SETUP_NAMES: (keyof DataIntelligenceSetupValues)[] =
  ["DATA_INTELLIGENCE_MCP_URL", "DATA_INTELLIGENCE_CONSOLE_URL", "DATA_INTELLIGENCE_ASSISTANT_KEY"];

/** The two values without which the connector stays unconfigured. */
export const DATA_INTELLIGENCE_REQUIRED_NAMES: (keyof DataIntelligenceSetupValues)[] =
  ["DATA_INTELLIGENCE_MCP_URL", "DATA_INTELLIGENCE_ASSISTANT_KEY"];

export const SETUP_INPUTS: VendorSetupInput[] = [
  {
    name: "DATA_INTELLIGENCE_MCP_URL",
    kind: "var",
    label: "Data Intelligence MCP endpoint URL",
    setupSteps: [
      "Provision Data Intelligence under Admin → Intelligence; the connection is set up for you.",
      "To connect by hand instead, paste the organization's MCP endpoint URL (https://<slug>.data.tyms.ai/mcp).",
      "Paste an API key minted in the Data Intelligence console under Organization → API keys for the tyms-assistant.",
    ],
  },
  { name: "DATA_INTELLIGENCE_CONSOLE_URL", kind: "var", label: "Workbench URL", optional: true },
  { name: "DATA_INTELLIGENCE_ASSISTANT_KEY", kind: "secret", label: "Assistant API key" },
];

export const SETUP_VALUE_MAX_LENGTH = 2048;

/**
 * Parses one tenant's values into the configuration, or null when unusable. A missing or unusable
 * `DATA_INTELLIGENCE_MCP_URL` returns null rather than throwing, so the connector advertises
 * nothing and the Workshop hides it. The key is deliberately not part of this: whether a usable
 * endpoint has a key is `isConfigured`'s question, and the key is only ever released through
 * `assistantKeyOf`.
 */
export function parseDataIntelligenceConfig(
  values: DataIntelligenceSetupValues, allowInsecure: boolean,
): DataIntelligenceConfig | null {
  const endpoint = parseUrl(values.DATA_INTELLIGENCE_MCP_URL, allowInsecure);
  if (!endpoint) return null;
  const consoleUrl = parseUrl(values.DATA_INTELLIGENCE_CONSOLE_URL, allowInsecure)?.toString()
    ?? `${endpoint.origin}/`;
  return { endpoint: endpoint.toString(), consoleUrl };
}

/** Whether the tenant holds everything a call needs: a usable endpoint and a key for it. */
export function isConfigured(values: DataIntelligenceSetupValues, allowInsecure: boolean): boolean {
  const config = parseDataIntelligenceConfig(values, allowInsecure);
  return config !== null && assistantKeyOf(values, allowInsecure, config.endpoint) !== null;
}

// The same rules `guardedFetch` applies anyway, enforced here so an `http://` typo hides the
// connector rather than failing on the first request with an error naming a URL nobody saw.
// URL userinfo is an ambient credential that fetch copies into requests, and this endpoint is
// shown back to administrators, so it is rejected rather than stripped.
function parseUrl(raw: string | undefined, allowInsecure: boolean): URL | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) return null;
  if (url.username || url.password) return null;
  url.hash = "";
  return url;
}

/**
 * Minimal structural stub for the VendorSetupStore singleton (defined in data-intelligence.ts; typed
 * structurally here to keep this module free of `cloudflare:workers`, so tests run in Node).
 */
export type DataIntelligenceSetupExports = {
  VendorSetupStore: {
    getByName(name: string): {
      getValues(): Promise<Record<string, string>>;
      getUpdatedAt(): Promise<Record<string, number>>;
    };
  };
};

// The store sits behind a Durable Object RPC and is consulted on the token path of every
// authenticated request, so results are cached per isolate briefly, per tenant; writers reset
// their own isolate's entry and other isolates converge within the TTL.
const setupCache = new Map<string, { values: DataIntelligenceSetupValues; expiresAt: number }>();
const SETUP_CACHE_MS = 30_000;

export function invalidateDataIntelligenceSetupCache(tenant: string = ""): void {
  setupCache.delete(tenant);
}

export async function loadDataIntelligenceSetup(
  exports: DataIntelligenceSetupExports, tenant: string = "", options?: { fresh?: boolean },
): Promise<DataIntelligenceSetupValues> {
  const cached = setupCache.get(tenant);
  if (!options?.fresh && cached && Date.now() < cached.expiresAt) return cached.values;
  const stored = await exports.VendorSetupStore.getByName(tenant).getValues();
  // Rebuilt key by key: the RPC-returned record carries a disposer symbol that a plain spread
  // would drag into the literal's type.
  const values: DataIntelligenceSetupValues = {};
  for (const name of DATA_INTELLIGENCE_SETUP_NAMES) {
    if (stored[name] !== undefined) values[name] = stored[name];
  }
  setupCache.set(tenant, { values, expiresAt: Date.now() + SETUP_CACHE_MS });
  return values;
}

/** The configuration for one tenant, or null when unconfigured. */
export async function loadDataIntelligenceConfig(
  env: Env, exports: DataIntelligenceSetupExports, tenant: string = "", options?: { fresh?: boolean },
): Promise<DataIntelligenceConfig | null> {
  return parseDataIntelligenceConfig(
    await loadDataIntelligenceSetup(exports, tenant, options), fetchOptions(env).allowInsecure === true);
}

/**
 * The assistant key, but only for the endpoint the tenant's setup currently names.
 *
 * An administrator repoints the connector by editing the URL and key together, which touches no facet;
 * until the workshop re-reads its props a facet still names the old endpoint while this value is
 * already the new endpoint's secret. The scoping therefore happens here, against the configuration the
 * key belongs to. Null covers both "no key" and "repointed"; callers fail the request closed.
 */
export function assistantKeyOf(
  values: DataIntelligenceSetupValues, allowInsecure: boolean, endpoint: string,
): string | null {
  const config = parseDataIntelligenceConfig(values, allowInsecure);
  if (!config || !sameEndpoint(config.endpoint, endpoint)) return null;
  const key = values.DATA_INTELLIGENCE_ASSISTANT_KEY?.trim();
  return key || null;
}

/** The tenant's key for `endpoint` (see `assistantKeyOf`). */
export async function loadAssistantKey(
  env: Env, exports: DataIntelligenceSetupExports, endpoint: string, tenant: string = "",
): Promise<string | null> {
  return assistantKeyOf(
    await loadDataIntelligenceSetup(exports, tenant), fetchOptions(env).allowInsecure === true, endpoint);
}
