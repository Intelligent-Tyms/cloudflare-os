// Client for the control plane's Intelligence surface (Admin → Intelligence) on deployments
// that have one. Rides the same credentials as the team and billing directories
// (CENTRAL_TEAM_API_URL / CENTRAL_TEAM_API_TOKEN): all three are the control plane's
// /tenant-api surface, authenticated per tenant. Provisioning happens only here — never by
// hand against a cell — and the assistant key the cell mints arrives exactly once, in the
// provision response; the control plane never stores it, the intelligence gatekeeper does.

import {
  INTELLIGENCE_PRODUCT_NAMES,
  type BillingCreditBucket,
  type IntelligenceInstanceView,
  type IntelligenceProductKind,
} from "@gadgets/workshop-shared/api";

/** Mirrors the control plane's IntelligenceView (apps/control-plane/src/intelligence.ts). */
export type CentralIntelligence = {
  entitled: boolean;
  credits: BillingCreditBucket;
  instances: IntelligenceInstanceView[];
};

/** The provision response: the key is non-null only the first time the cell mints it. */
export type ProvisionOutcome = {
  instance: IntelligenceInstanceView;
  assistantKey: string | null;
};

/** Whether this deployment has a central directory configured. */
export function hasIntelligenceDirectory(env: Cloudflare.Env): boolean {
  return Boolean(env.CENTRAL_TEAM_API_URL && env.CENTRAL_TEAM_API_TOKEN);
}

// The control plane answers refusals with a short error code; these are the words an
// administrator sees for each, named for the product in play. Anything unlisted is surfaced
// verbatim (its messages are already end-user-ready for validation failures).
function errorMessages(product: string): Record<string, string> {
  return {
    not_entitled: `Your plan does not include ${product}. Upgrade under Admin → Plans.`,
    in_progress: `${product} is already being provisioned.`,
    already_active: `${product} is already provisioned for this workspace.`,
    decommissioned: `This workspace's ${product} instance was purged; contact Tyms support to provision a new one.`,
    not_provisioned: `${product} is not provisioned for this workspace.`,
    cell_failed: "The Intelligence cell did not accept the request. Try again in a moment.",
    cell_rejected: "The Intelligence cell rejected the request. Contact Tyms support.",
    cell_unconfigured: "No Intelligence cell is available for this workspace. Contact Tyms support.",
    cell_unreachable: "The Intelligence cell could not be reached. Try again in a moment.",
    no_cell: "No Intelligence cell is available for this workspace. Contact Tyms support.",
  };
}

export function intelligenceErrorMessage(
  code: string | undefined, status: number, kind: IntelligenceProductKind = "organization",
): string {
  const messages = errorMessages(INTELLIGENCE_PRODUCT_NAMES[kind]);
  if (code && messages[code]) return messages[code];
  if (code) return code;
  return `The intelligence directory is unavailable (${status}).`;
}

async function call<T>(
  env: Cloudflare.Env, path: string, body?: object, kind: IntelligenceProductKind = "organization",
): Promise<T> {
  let response = await fetch(`${env.CENTRAL_TEAM_API_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${env.CENTRAL_TEAM_API_TOKEN}`,
      ...(body === undefined ? {} : {"content-type": "application/json"}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = (await response.json().catch(() => ({}))) as T & {error?: string};
  if (!response.ok) {
    throw new Error(intelligenceErrorMessage(data.error, response.status, kind));
  }
  return data;
}

/** Entitlement, the Intelligence credit pool and every instance the tenant has. */
export async function fetchIntelligence(env: Cloudflare.Env): Promise<CentralIntelligence> {
  return await call(env, "/intelligence");
}

/** Provision (or resume) a product. Synchronous: the cell answers in seconds. */
export async function provisionInstance(env: Cloudflare.Env, kind: IntelligenceProductKind): Promise<ProvisionOutcome> {
  return await call(env, `/intelligence/${kind}/provision`, {}, kind);
}

/** Suspend the product; the control plane purges it after its retention window. */
export async function deprovisionInstance(
  env: Cloudflare.Env, kind: IntelligenceProductKind,
): Promise<{instance: IntelligenceInstanceView}> {
  return await call(env, `/intelligence/${kind}/deprovision`, {}, kind);
}

/** Mint a fresh assistant key on the product's cell; the previous key stops working at once. */
export async function rotateAssistantKey(
  env: Cloudflare.Env, kind: IntelligenceProductKind,
): Promise<{assistantKey: string}> {
  return await call(env, `/intelligence/${kind}/rotate-key`, {}, kind);
}

/** One product's instance out of a directory snapshot, or null when never provisioned. */
export function instanceOf(view: CentralIntelligence, kind: IntelligenceProductKind): IntelligenceInstanceView | null {
  return view.instances.find(instance => instance.kind === kind) ?? null;
}
