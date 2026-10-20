// Every outbound request this gatekeeper makes on behalf of a connected MCP server.
//
// Validating the URL is not enough: `fetch` follows redirects by default, so a server that passed
// validation can answer 307 and send the next request to a host `validateCustomEndpoint` exists to
// refuse, after every check has run. Redirects are therefore followed here, re-checking each hop,
// with `Authorization` dropped when a hop leaves the original origin. Unconditional rather than
// opt-in, since a caller forgetting to opt in is the failure mode.

import { createLogger } from "@gadgets/observability/logger";
import { isBlockedHost } from "./endpoint.js";
import type { FetchLike } from "@modelcontextprotocol/client";

const logger = createLogger<{ routeSuffix: string; routeBinding: string }>({ component: "mcp.fetch" });

// Enough for the http->https and apex->www hops real deployments use. Discovery already tries
// several candidate URLs, so a longer chain is more likely a loop than a working server.
const MAX_REDIRECTS = 3;
/** Default wall-clock budget for one outbound operation, including redirects and body streaming. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Policy and deadline options applied to one outbound operation. */
export type FetchOptions = {
  /** Permits plain HTTP and private hosts for local development. */
  allowInsecure?: boolean;
  /** Bounds the complete operation, including redirects and response-body streaming. */
  timeoutMs?: number;
  /** Absolute deadline shared by every request in a multi-page or retried operation. */
  deadline?: number;
  /**
   * Request headers that, like `Authorization`, are issued for one origin and must not follow a
   * redirect to another. Names are matched case-insensitively, as `Headers` does.
   */
  originBoundHeaders?: string[];
  /**
   * Replaces the platform `fetch` for every hop of the operation. Used to reach a Worker on the
   * caller's own zone through a service binding: Cloudflare routes a same-zone subrequest to the
   * DNS origin, not to the Worker on that route, so the URL alone cannot get there.
   */
  fetchImpl?: typeof fetch;
};

/**
 * The environment variables this package reads for outbound requests. Each Worker's own `Env`
 * satisfies it structurally. The service bindings `MCP_HOST_ROUTES` names are read by name from
 * the same object, so they need no field here.
 */
export type InsecureEnv = {
  /** When `"true"`, permits plain HTTP and private hosts. Local development only. */
  MCP_ALLOW_INSECURE?: string;
  /**
   * JSON object mapping a host suffix to the name of a service binding on this Worker, e.g.
   * `{"organization.tyms.ai":"MCP_HOST_ROUTE_1"}`. A request to that host, or to any subdomain of
   * it, goes through the binding with its URL unchanged; see `hostRoutedFetch`.
   */
  MCP_HOST_ROUTES?: string;
};

/** Outbound failure known to have happened before the platform `fetch()` call began. */
export class FetchNotStartedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchNotStartedError";
  }
}

/**
 * The outbound policy a Worker's environment asks for: the local-development escape hatch, and the
 * same-zone host routes when any are configured. One definition, since the first switch turns off
 * the SSRF checks and copies of it would be copies of that.
 *
 * The routes only choose *how* an allowed request leaves the Worker. `guardedFetch` still checks
 * every URL, first hop and redirect alike, before it reaches `fetchImpl`, so a routed host passes
 * the same blocklist and scheme checks as any other. A caller's own `fetchImpl` spread over these
 * options replaces the routing.
 */
export function fetchOptions(env: InsecureEnv): FetchOptions {
  const options: FetchOptions = { allowInsecure: (env.MCP_ALLOW_INSECURE ?? "").toLowerCase() === "true" };
  const routed = hostRoutedFetch(env);
  if (routed) options.fetchImpl = routed;
  return options;
}

type HostRoute = { suffix: string; binding: Fetcher };

// Configuration problems are logged once per isolate rather than on every request: fetchOptions
// runs for each MCP operation, and the configuration cannot change while the isolate lives.
const reported = new Set<string>();

function reportOnce(key: string, message: string, fields: { routeSuffix?: string; routeBinding?: string }): void {
  if (reported.has(key)) return;
  reported.add(key);
  logger.warn(message, { event: "mcp.fetch.host_route.invalid", ...fields });
}

function isFetcher(value: unknown): value is Fetcher {
  return typeof value === "object" && value !== null
    && typeof (value as { fetch?: unknown }).fetch === "function";
}

/** Normalizes a host or suffix for comparison: case-insensitive, without a trailing root dot. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

function parseHostRoutes(env: InsecureEnv): HostRoute[] {
  const raw = env.MCP_HOST_ROUTES?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reportOnce(`json:${raw}`, "MCP_HOST_ROUTES is not valid JSON; ignoring it", {});
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    reportOnce(`shape:${raw}`, "MCP_HOST_ROUTES is not a JSON object; ignoring it", {});
    return [];
  }
  const routes: HostRoute[] = [];
  for (const [rawSuffix, name] of Object.entries(parsed)) {
    const suffix = normalizeHost(rawSuffix);
    const binding = typeof name === "string"
      ? (env as unknown as Record<string, unknown>)[name]
      : undefined;
    if (!suffix || typeof name !== "string" || !isFetcher(binding)) {
      reportOnce(`route:${rawSuffix}=${String(name)}`,
        "MCP host route has no usable service binding; ignoring it",
        { routeSuffix: rawSuffix, routeBinding: String(name) });
      continue;
    }
    routes.push({ suffix, binding });
  }
  // Longest suffix first, so a more specific route wins over a broader one it sits under.
  return routes.toSorted((a, b) => b.suffix.length - a.suffix.length);
}

/**
 * A `fetch` that sends requests for configured hosts through service bindings, or undefined when
 * no usable route is configured.
 *
 * Cloudflare sends a Worker's subrequest to a host on its own zone to that host's DNS origin, never
 * to the Worker serving its route, so an MCP server on the same zone as this gatekeeper (a Tyms
 * product such as `<slug>.organization.tyms.ai`, connected as a company server) answers 522 to a
 * plain `fetch`. The deployment binds the Worker behind each such zone and names it in
 * `MCP_HOST_ROUTES`. The URL is passed unchanged, since the Worker behind the binding resolves the
 * tenant from the host. The match is made per request, not per operation, so each redirect hop
 * goes wherever its own host routes; every other host uses the platform `fetch`.
 */
export function hostRoutedFetch(env: InsecureEnv): typeof fetch | undefined {
  const routes = parseHostRoutes(env);
  if (routes.length === 0) return undefined;
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    let host: string;
    try {
      host = normalizeHost(new URL(url).hostname);
    } catch {
      return globalThis.fetch(input, init);
    }
    const route = routes.find(({ suffix }) => host === suffix || host.endsWith(`.${suffix}`));
    return route ? route.binding.fetch(input, init) : globalThis.fetch(input, init);
  };
}

/**
 * Cap on any single response body this gatekeeper buffers.
 *
 * Every response here is parsed whole -- JSON-RPC frames and SSE streams alike -- so the body is in
 * memory before any higher-level limit can apply. `listTools` bounds the catalog it *keeps*, which
 * bounds nothing about what arrives, and a `tools/call` result is not bounded at all: a server
 * answering one request with a gigabyte exhausts the Worker.
 */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Reads a response body as text, refusing one larger than `maxBytes`.
 *
 * Refused rather than truncated: half a JSON document does not parse, and a clipped SSE stream can
 * lose the very event carrying the response, which would surface as a confusing protocol error
 * instead of the size problem it is. The body is cancelled on refusal so the transfer stops rather
 * than running to completion unread.
 */
export async function readTextCapped(
  response: Response, maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`The server's response exceeded ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** Gives SDK OAuth helpers the same redirect and response-size policy as the local MCP transport. */
export function sdkFetch(options: FetchOptions = {}): FetchLike {
  const operationOptions: FetchOptions = {
    ...options,
    deadline: options.deadline
      ?? Date.now() + (options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
  };
  return async (url, init) => {
    const response = await guardedFetch(String(url), init ?? {}, operationOptions);
    const body = await readTextCapped(response);
    return new Response(body || null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * Whether a URL may be requested at all. Fails closed: an unparseable URL is refused rather than
 * handed to `fetch` to find out.
 */
export function isAllowedUrl(url: string, options: FetchOptions = {}): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (options.allowInsecure) return true;
  if (parsed.protocol !== "https:") return false;
  return !isBlockedHost(parsed.hostname);
}

/**
 * Fetches `url`, following redirects manually so each hop is checked.
 *
 * Throws if the first URL is not allowed; a redirect to a refused host returns the 3xx response
 * itself, which every caller already treats as a failure.
 */
export async function guardedFetch(
  url: string, init: RequestInit, options: FetchOptions = {},
): Promise<Response> {
  if (!isAllowedUrl(url, options)) {
    throw new FetchNotStartedError(`Refusing to contact ${hostForMessage(url)}.`);
  }

  let current = url;
  let headers = new Headers(init.headers);
  let method = init.method ?? "GET";
  let body = init.body;
  const origin = new URL(url).origin;
  let signal = init.signal ?? undefined;
  if (options.deadline !== undefined || options.timeoutMs !== undefined) {
    const remaining = options.deadline === undefined
      ? options.timeoutMs!
      : Math.max(0, options.deadline - Date.now());
    if (remaining === 0) throw new FetchNotStartedError("The outbound operation timed out.");
    const timeout = AbortSignal.timeout(remaining);
    signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(current, {
      ...init, method, body, headers, redirect: "manual", signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("Location");
    if (!location || hop >= MAX_REDIRECTS) return response;

    const next = new URL(location, current).toString();
    if (!isAllowedUrl(next, options)) return response;

    const crossOrigin = new URL(next).origin !== origin;
    const becomesGet = response.status === 303
      || (response.status < 307 && method !== "GET" && method !== "HEAD");

    // A 307/308 preserves the request method and body. Following one across origins from an OAuth
    // token endpoint would hand its authorization code, PKCE verifier, refresh token, and client id
    // to a host those credentials were never intended for. Dropping Authorization is not enough:
    // the secrets are in the form body. Return the redirect response rather than changing its
    // semantics to GET or forwarding the body. The same check also covers an unusual GET-with-body.
    if (crossOrigin && body != null && !becomesGet) return response;

    // Credentials and transport sessions are scoped to the origin they were issued for. A
    // cross-origin hop still happens when it can be made without replaying a body, since it may be a
    // legitimate CDN or login host, but it carries neither the bearer nor the origin's MCP session
    // capability.
    if (crossOrigin) {
      headers = new Headers(headers);
      headers.delete("Authorization");
      headers.delete("Mcp-Session-Id");
      for (const name of options.originBoundHeaders ?? []) headers.delete(name);
    }

    // 303 means "fetch the result of this with GET", and browsers downgrade 301/302 on POST too.
    // Replaying the body would resend it to a host that only said "look over there". At the token
    // endpoint that body carries the authorization code, PKCE verifier, and client secret.
    if (becomesGet) {
      method = "GET";
      body = undefined;
      headers = new Headers(headers);
      headers.delete("Content-Type");
      headers.delete("Content-Length");
    }
    await response.body?.cancel().catch(() => undefined);
    current = next;
  }
}

function hostForMessage(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "that address";
  }
}
