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
  // Stored provider-key alias for AI Gateway requests (cf-aig-byok-alias); null/absent = the
  // gateway's default alias (free-tier key pool). Absent on snapshots cached before the field
  // existed, so consumers must treat undefined as null.
  aiKeyAlias?: string | null;
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

/** A plan offered in the tenant's self-serve plan picker. */
export type CentralPlanOption = {
  code: string;
  name: string;
  description: string | null;
  priceCents: number;
  annualPriceCents: number | null;
  seatLimit: number | null;
  agentLimit: number | null;
  aiCreditCentsMonthly: number;
  messagingCreditCentsMonthly: number;
  annualAvailable: boolean;
};

/** The self-serve plan catalog (standard tier, purchasable or free). */
export async function fetchPlans(env: Cloudflare.Env): Promise<CentralPlanOption[]> {
  let {plans} = await call<{plans: CentralPlanOption[]}>(env, "/plans");
  return plans;
}

/**
 * Change the tenant's plan. Applied immediately for paid↔paid and paid→free; free→paid
 * returns a checkout URL instead, and the change lands when payment completes.
 */
export async function changePlan(env: Cloudflare.Env, opts: {
  planCode: string;
  billingPeriod: "monthly" | "annual";
  successUrl: string;
  cancelUrl: string;
}): Promise<{applied: boolean; checkoutUrl: string | null}> {
  let result = await call<{applied: boolean; checkoutUrl?: string | null}>(
      env, "/billing/change-plan", opts);
  return {applied: result.applied, checkoutUrl: result.checkoutUrl ?? null};
}

/**
 * Ask the control plane to email the workspace's owner and admins that a teammate wants a
 * plan upgrade. The caller throttles; this just fires the notification.
 */
export async function requestUpgrade(
    env: Cloudflare.Env, opts: {requestedBy: string}): Promise<void> {
  await call(env, "/billing/upgrade-request", opts);
}

/** One invoice from the tenant's Stripe history (Admin → Billing and usage). */
export type CentralInvoice = {
  id: string;
  number: string | null;
  createdAt: number;
  description: string | null;
  amountCents: number;
  currency: string;
  status: string;
  hostedUrl: string | null;
  pdfUrl: string | null;
};

/** Invoice history, newest first. Empty for workspaces that never paid. */
export async function fetchInvoices(env: Cloudflare.Env): Promise<CentralInvoice[]> {
  let {invoices} = await call<{invoices: CentralInvoice[]}>(env, "/billing/invoices");
  return invoices;
}

/** The billing email and default card on file. */
export type CentralPaymentDetails = {
  billingEmail: string | null;
  card: {brand: string; last4: string; expMonth: number; expYear: number} | null;
};

/** Payment details, or null for workspaces with no billing profile (never paid). */
export async function fetchPaymentDetails(
    env: Cloudflare.Env): Promise<CentralPaymentDetails | null> {
  let {payment} = await call<{payment: CentralPaymentDetails | null}>(env, "/billing/payment");
  return payment;
}

/**
 * Start a Stripe billing-portal session (card, billing email, address, tax ids) and
 * return its URL. Refused for workspaces with no billing profile.
 */
export async function createBillingPortalSession(
    env: Cloudflare.Env, returnUrl: string): Promise<string> {
  let {portalUrl} = await call<{portalUrl: string | null}>(env, "/billing/portal", {returnUrl});
  if (!portalUrl) throw new Error("The billing service returned no portal link.");
  return portalUrl;
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
