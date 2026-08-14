// Client for the central billing API (entitlements + usage flushes) on deployments that
// have one. Rides the same credentials as the team directory (CENTRAL_TEAM_API_URL /
// CENTRAL_TEAM_API_TOKEN, injected by the deploy service): both are the control plane's
// /tenant-api surface, authenticated per tenant. Deployments without a control plane run
// unmetered — every consumer checks hasBillingDirectory() first.

/** Mirrors the control plane's EntitlementsView (apps/control-plane/src/billing.ts). */
export type CentralEntitlements = {
  planCode: string;
  planName: string;
  // 'enterprise' plans are exempt from credit enforcement (custom volumes / BYOK).
  tier: string;
  subscriptionStatus: string;
  billingPeriod: string;
  priceCents: number | null;
  seatLimit: number | null;
  agentLimit: number | null;
  ai: CentralCreditBucket;
  messaging: CentralCreditBucket;
  periodStart: number;
  periodEnd: number;
  channelRatesMicroUsd: Record<string, number>;
  freeDailyLlmCalls: number | null;
};

export type CentralCreditBucket = {
  monthlyGrantMicroUsd: number;
  allowanceMicroUsd: number;
  topupMicroUsd: number;
  balanceMicroUsd: number;
};

/** One metered event; sourceKey is the idempotency key for at-least-once flushing. */
export type UsageEventReport = {
  sourceKey: string;
  kind: "ai" | "message";
  channel?: string;
  direction?: "inbound" | "outbound";
  quantity?: number;
  // AI events only; message events are priced server-side from the channel rate card.
  costMicroUsd?: number;
  meta?: Record<string, unknown>;
};

/** Whether this deployment has a central billing directory configured. */
export function hasBillingDirectory(env: Cloudflare.Env): boolean {
  return Boolean(env.CENTRAL_TEAM_API_URL && env.CENTRAL_TEAM_API_TOKEN);
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
    throw new Error(data.error ?? `The billing directory is unavailable (${response.status}).`);
  }
  return data;
}

/** Current plan, limits, balances, and channel rate card. */
export async function fetchEntitlements(env: Cloudflare.Env): Promise<CentralEntitlements> {
  let {entitlements} = await call<{entitlements: CentralEntitlements}>(env, "/entitlements");
  return entitlements;
}

/** Flush a batch of usage events; the response carries fresh entitlements. */
export async function reportUsage(env: Cloudflare.Env, events: UsageEventReport[]): Promise<{
  accepted: number;
  duplicates: number;
  entitlements: CentralEntitlements | null;
}> {
  return await call(env, "/usage", {events});
}

/** Aggregated usage for the current credit period (Admin → Billing and usage). */
export type CentralUsageRow = {
  kind: string;
  channel: string | null;
  direction: string | null;
  events: number;
  quantity: number;
  costMicroUsd: number;
};

/** Entitlements plus the period's usage summary, for the admin billing page. */
export async function fetchBillingSummary(env: Cloudflare.Env): Promise<{
  entitlements: CentralEntitlements;
  usage: {periodStart: number; periodEnd: number; rows: CentralUsageRow[]};
}> {
  return await call(env, "/billing");
}

/** Start a one-time credit top-up checkout; returns the Stripe Checkout URL. */
export async function createTopupCheckout(env: Cloudflare.Env, opts: {
  creditType: "ai" | "messaging";
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  let {checkoutUrl} = await call<{checkoutUrl: string | null}>(env, "/billing/topup", opts);
  if (!checkoutUrl) throw new Error("The billing service returned no checkout link.");
  return checkoutUrl;
}
