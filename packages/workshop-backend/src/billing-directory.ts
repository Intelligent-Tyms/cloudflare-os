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
  // Absent on snapshots cached before the trial cutover; consumers treat undefined as null.
  trialEndsAt?: number | null;
  cancelAt?: number | null;
  // The card Stripe charges next, and whether it expires before that charge. Absent on
  // snapshots cached before the fields existed.
  card?: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  cardExpiresBeforeNextCharge?: boolean;
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
  /**
   * The organisation's billing account (one USD balance, managed only on billing.tyms.ai).
   * The control plane always sends it; absent only on snapshots cached before it existed.
   */
  account?: CentralAccount;
};

/** Mirrors the control plane's AccountView: the slice products read to stop and to link. */
export type CentralAccount = {
  /** prepay | postpay */
  mode: string;
  /** active | suspended */
  status: string;
  /** The prepaid balance (0 on postpay). */
  balanceMicroUsd: number;
  /** Whether metered work may run: an active account with funds (and no limit reached), or postpay. */
  canRun: boolean;
  /** The workspace's page on billing.tyms.ai. */
  billingUrl: string;
  /** Under this prepaid balance the account counts as running low. */
  lowBalanceMicroUsd: number;
  /**
   * What a spending limit has stopped this month: `['all']`, or service groups (`ai`,
   * `messaging`, `data`). Empty while nothing is stopped; absent on older snapshots.
   */
  stopped?: string[];
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

