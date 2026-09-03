// Client for the control plane's Intelligence surface (Admin → Intelligence) on deployments
// that have one. Rides the same credentials as the team and billing directories
// (CENTRAL_TEAM_API_URL / CENTRAL_TEAM_API_TOKEN): all three are the control plane's
// /tenant-api surface, authenticated per tenant. Provisioning happens only here — never by
// hand against a cell — and the assistant key the cell mints arrives exactly once, in the
// provision response; the control plane never stores it, the intelligence gatekeeper does.

import type { BillingCreditBucket, IntelligenceInstanceView } from "@gadgets/workshop-shared/api";

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
// administrator sees for each. Anything unlisted is surfaced verbatim (its messages are
// already end-user-ready for validation failures).
const ERROR_MESSAGES: Record<string, string> = {
  not_entitled: "Your plan does not include Organization Intelligence. Upgrade under Admin → Plans.",
  in_progress: "Organization Intelligence is already being provisioned.",
  already_active: "Organization Intelligence is already provisioned for this workspace.",
  decommissioned: "This workspace's wiki was purged; contact Tyms support to provision a new one.",
  not_provisioned: "Organization Intelligence is not provisioned for this workspace.",
  cell_failed: "The Intelligence cell did not accept the request. Try again in a moment.",
  cell_rejected: "The Intelligence cell rejected the request. Contact Tyms support.",
  no_cell: "No Intelligence cell is available for this workspace. Contact Tyms support.",
};

export function intelligenceErrorMessage(code: string | undefined, status: number): string {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  if (code) return code;
  return `The intelligence directory is unavailable (${status}).`;
}

async function call<T>(env: Cloudflare.Env, path: string, body?: object): Promise<T> {
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
    throw new Error(intelligenceErrorMessage(data.error, response.status));
  }
  return data;
}

/** Entitlement, the Intelligence credit pool and every instance the tenant has. */
export async function fetchIntelligence(env: Cloudflare.Env): Promise<CentralIntelligence> {
  return await call(env, "/intelligence");
}

/** Provision (or resume) Organization Intelligence. Synchronous: the cell answers in seconds. */
export async function provisionOrganization(env: Cloudflare.Env): Promise<ProvisionOutcome> {
  return await call(env, "/intelligence/organization/provision", {});
}

/** Suspend the wiki; the control plane purges it after its retention window. */
export async function deprovisionOrganization(env: Cloudflare.Env): Promise<{instance: IntelligenceInstanceView}> {
  return await call(env, "/intelligence/organization/deprovision", {});
}

/** Mint a fresh assistant key on the cell; the previous key stops working at once. */
export async function rotateAssistantKey(env: Cloudflare.Env): Promise<{assistantKey: string}> {
  return await call(env, "/intelligence/organization/rotate-key", {});
}

/** The Organization instance out of a directory snapshot, or null when never provisioned. */
export function organizationInstance(view: CentralIntelligence): IntelligenceInstanceView | null {
  return view.instances.find(instance => instance.kind === "organization") ?? null;
}
