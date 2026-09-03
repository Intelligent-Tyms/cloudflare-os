// The one wiki this connector talks to, as the tenant's administrator (or the provisioning flow in
// Tyms Admin › Intelligence) configured it.
//
// Like the portal connector, the endpoint is a setting rather than user input: there is no connect
// form, one preissued key serves the whole workshop, and an unconfigured tenant hides the connector
// instead of offering a dead end. Unlike the portal, there is no deploy-time fallback at all --
// every value is per tenant, written by the workshop after provisioning or pasted by an admin.

import type { VendorSetupInput } from "@gadgets/workshop-shared/gatekeeper";
import { fetchOptions } from "@gadgets/mcp-shared/fetch";
import { sameEndpoint } from "@gadgets/mcp-shared/scope";

/** The configured wiki, once the tenant's setup values have been read and validated. */
export type IntelligenceConfig = {
  /** The wiki's MCP endpoint (Streamable HTTP), e.g. `https://acme.organization.tyms.ai/w/company/mcp`. */
  endpoint: string;
  /** The wiki slug the endpoint addresses; `company` unless the path says otherwise. */
  wiki: string;
  /** Where a person opens the wiki. */
  wikiUrl: string;
  /** Prefix that turns a page path from the index (`/policies/expenses`) into a page URL. */
  pageBaseUrl: string;
  /** The precedence index as markdown, for the assistant's system prompt. */
  precedenceUrl: string;
};

/** Stable id used in binding names, action kinds, and generated type names. */
export const INTELLIGENCE_SERVER_ID = "intelligence";

/** The wiki addressed when the MCP path does not name one. */
const DEFAULT_WIKI = "company";

/** The setup values one tenant's store holds. */
export type IntelligenceSetupValues = {
  INTELLIGENCE_MCP_URL?: string;
  INTELLIGENCE_WIKI_URL?: string;
  INTELLIGENCE_ASSISTANT_KEY?: string;
};

/** The names an administrator (or the provisioning flow) may set; also the store's key allowlist. */
export const INTELLIGENCE_SETUP_NAMES: (keyof IntelligenceSetupValues)[] =
  ["INTELLIGENCE_MCP_URL", "INTELLIGENCE_WIKI_URL", "INTELLIGENCE_ASSISTANT_KEY"];

/** The two values without which the connector stays unconfigured. */
export const INTELLIGENCE_REQUIRED_NAMES: (keyof IntelligenceSetupValues)[] =
  ["INTELLIGENCE_MCP_URL", "INTELLIGENCE_ASSISTANT_KEY"];

export const SETUP_INPUTS: VendorSetupInput[] = [
  {
    name: "INTELLIGENCE_MCP_URL",
    kind: "var",
    label: "Wiki MCP endpoint URL",
    setupSteps: [
      "Provision Organization Intelligence under Admin → Intelligence; the connection is set up for you.",
      "To connect by hand instead, paste the wiki's MCP endpoint URL (shown in the wiki console under Organization → API keys).",
      "Paste an API key with the contribute scope, minted in the wiki console for the tyms-assistant.",
    ],
  },
  { name: "INTELLIGENCE_WIKI_URL", kind: "var", label: "Wiki URL", optional: true },
  { name: "INTELLIGENCE_ASSISTANT_KEY", kind: "secret", label: "Assistant API key" },
];

export const SETUP_VALUE_MAX_LENGTH = 2048;

/**
 * Parses one tenant's values into the wiki configuration, or null when unusable. A missing or
 * unusable `INTELLIGENCE_MCP_URL` returns null rather than throwing, so the connector advertises
 * nothing and the Workshop hides it. The key is deliberately not part of this: whether a usable
 * endpoint has a key is `isConfigured`'s question, and the key is only ever released through
 * `assistantKeyOf`.
 */
export function parseIntelligenceConfig(
  values: IntelligenceSetupValues, allowInsecure: boolean,
): IntelligenceConfig | null {
  const endpoint = parseUrl(values.INTELLIGENCE_MCP_URL, allowInsecure);
  if (!endpoint) return null;

  const wiki = wikiOfEndpoint(endpoint);
  const origin = endpoint.origin;
  const wikiUrl = parseUrl(values.INTELLIGENCE_WIKI_URL, allowInsecure)?.toString()
    ?? `${origin}/${wiki}`;
  return {
    endpoint: endpoint.toString(),
    wiki,
    wikiUrl,
    pageBaseUrl: `${origin}/${wiki}`,
    precedenceUrl: `${origin}/api/w/${wiki}/precedence?format=md`,
  };
}

/** Whether the tenant holds everything a call needs: a usable endpoint and a key for it. */
export function isConfigured(values: IntelligenceSetupValues, allowInsecure: boolean): boolean {
  const config = parseIntelligenceConfig(values, allowInsecure);
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

// The cell serves each wiki's MCP server at `/w/{wiki}/mcp`; anything else is treated as the
// default wiki so a bare origin still works.
function wikiOfEndpoint(endpoint: URL): string {
  const match = /^\/w\/([a-z0-9][a-z0-9-]*)\/mcp\/?$/.exec(endpoint.pathname);
  return match?.[1] ?? DEFAULT_WIKI;
}

/**
 * Minimal structural stub for the VendorSetupStore singleton (defined in intelligence.ts; typed
 * structurally here to keep this module free of `cloudflare:workers`, so tests run in Node).
 */
export type IntelligenceSetupExports = {
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
const setupCache = new Map<string, { values: IntelligenceSetupValues; expiresAt: number }>();
const SETUP_CACHE_MS = 30_000;

export function invalidateIntelligenceSetupCache(tenant: string = ""): void {
  setupCache.delete(tenant);
}

export async function loadIntelligenceSetup(
  exports: IntelligenceSetupExports, tenant: string = "", options?: { fresh?: boolean },
): Promise<IntelligenceSetupValues> {
  const cached = setupCache.get(tenant);
  if (!options?.fresh && cached && Date.now() < cached.expiresAt) return cached.values;
  const stored = await exports.VendorSetupStore.getByName(tenant).getValues();
  // Rebuilt key by key: the RPC-returned record carries a disposer symbol that a plain spread
  // would drag into the literal's type.
  const values: IntelligenceSetupValues = {};
  for (const name of INTELLIGENCE_SETUP_NAMES) {
    if (stored[name] !== undefined) values[name] = stored[name];
  }
  setupCache.set(tenant, { values, expiresAt: Date.now() + SETUP_CACHE_MS });
  return values;
}

/** The wiki configuration for one tenant, or null when unconfigured. */
export async function loadIntelligenceConfig(
  env: Env, exports: IntelligenceSetupExports, tenant: string = "", options?: { fresh?: boolean },
): Promise<IntelligenceConfig | null> {
  return parseIntelligenceConfig(
    await loadIntelligenceSetup(exports, tenant, options), fetchOptions(env).allowInsecure === true);
}

/**
 * The assistant key, but only for the endpoint the tenant's setup currently names.
 *
 * An administrator repoints the wiki by editing the URL and key together, which touches no facet;
 * until the workshop re-reads its props a facet still names the old endpoint while this value is
 * already the new wiki's secret. The scoping therefore happens here, against the configuration the
 * key belongs to. Null covers both "no key" and "repointed"; callers fail the request closed.
 */
export function assistantKeyOf(
  values: IntelligenceSetupValues, allowInsecure: boolean, endpoint: string,
): string | null {
  const config = parseIntelligenceConfig(values, allowInsecure);
  if (!config || !sameEndpoint(config.endpoint, endpoint)) return null;
  const key = values.INTELLIGENCE_ASSISTANT_KEY?.trim();
  return key || null;
}

/** The tenant's key for `endpoint` (see `assistantKeyOf`). */
export async function loadAssistantKey(
  env: Env, exports: IntelligenceSetupExports, endpoint: string, tenant: string = "",
): Promise<string | null> {
  return assistantKeyOf(
    await loadIntelligenceSetup(exports, tenant), fetchOptions(env).allowInsecure === true, endpoint);
}
