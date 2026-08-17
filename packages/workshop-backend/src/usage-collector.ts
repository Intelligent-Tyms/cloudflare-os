// The tenant-side half of the metering pipeline: a single "default"-named Durable Object
// that buffers usage events from every producer (agent turns, one-shot completions, model
// bindings, channel messages), flushes them to the control plane in batches, and caches
// the entitlements snapshot the enforcement gates read.
//
// Delivery is at-least-once: events stay buffered until a flush succeeds, and the control
// plane deduplicates on sourceKey — so a crash between flush and delete debits nothing
// twice. Enforcement is fail-open: when the control plane is unreachable and no cached
// entitlements exist, getBillingState() returns null and callers allow the action — a
// billing outage must never brick a tenant.
import { DurableObject } from "cloudflare:workers";
import { createWorkshopLogger } from "./observability";
import {
  CentralEntitlements, UsageEventReport, fetchEntitlements, hasBillingDirectory, reportUsage,
} from "./billing-directory.js";

const FLUSH_DELAY_MS = 30_000;
const FLUSH_RETRY_MS = 60_000;
const FLUSH_BATCH = 400;
const ENTITLEMENTS_TTL_MS = 60_000;
// storage.delete() accepts at most 128 keys per call.
const DELETE_CHUNK = 128;

const logger = createWorkshopLogger("workshop.usage");

type CachedEntitlements = { fetchedAt: number; data: CentralEntitlements };

/**
 * What enforcement gates need, derived from the cached entitlements with locally buffered
 * (not-yet-flushed) debits already subtracted so a burst between flushes can't overspend.
 */
export type BillingState = {
  planCode: string;
  tier: string;
  subscriptionStatus: string;
  seatLimit: number | null;
  agentLimit: number | null;
  aiBalanceMicroUsd: number;
  messagingBalanceMicroUsd: number;
  channelRatesMicroUsd: Record<string, number>;
  // Non-null on the free plan: AI turns are gated by the per-user daily counter instead of
  // credits.
  freeDailyLlmCalls: number | null;
  // Stored provider-key alias for AI Gateway requests (cf-aig-byok-alias). null = the gateway's
  // default alias (free-tier key pool); the fail-safe when anything omits it.
  aiKeyAlias: string | null;
  periodEnd: number;
};

export class UsageCollectorDurableObject extends DurableObject<Cloudflare.Env> {
  /** Buffer events for the next flush. Fire-and-forget friendly: never throws. */
  async record(events: UsageEventReport[]): Promise<void> {
    if (!hasBillingDirectory(this.env) || events.length === 0) return;
    let pending = await this.#pendingDebits();
    let rates = (await this.#cachedEntitlements())?.data.channelRatesMicroUsd ?? {};
    for (let event of events) {
      await this.ctx.storage.put(`event:${event.sourceKey}`, event);
      // Track the local debit estimate; message events are priced from the cached rate
      // card (0 if unknown — the server prices authoritatively at flush time).
      let cost = event.kind === "ai"
          ? Math.max(0, Math.floor(event.costMicroUsd ?? 0))
          : (rates[event.channel ?? ""] ?? 0) * (event.quantity ?? 1);
      if (event.kind === "ai") pending.ai += cost;
      else pending.messaging += cost;
    }
    await this.ctx.storage.put("pendingDebits", pending);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_DELAY_MS);
    }
  }

  async alarm(): Promise<void> {
    await this.#flush();
  }

  /**
   * The current billing state for enforcement, or null when billing is not configured or
   * no entitlements have ever been fetched and the control plane is unreachable.
   */
  async getBillingState(): Promise<BillingState | null> {
    if (!hasBillingDirectory(this.env)) return null;
    let cached = await this.#cachedEntitlements();
    if (!cached || Date.now() - cached.fetchedAt > ENTITLEMENTS_TTL_MS) {
      try {
        let data = await fetchEntitlements(this.env);
        cached = { fetchedAt: Date.now(), data };
        await this.ctx.storage.put("entitlements", cached);
      } catch (err) {
        if (!cached) {
          logger.warn("entitlements unavailable and not cached; billing checks fail open", {
            event: "usage.entitlements.unavailable", error: err,
          });
          return null;
        }
        // Stale cache beats fail-open: keep enforcing with the last known snapshot.
      }
    }
    let pending = await this.#pendingDebits();
    let e = cached.data;
    return {
      planCode: e.planCode,
      tier: e.tier,
      subscriptionStatus: e.subscriptionStatus,
      seatLimit: e.seatLimit,
      agentLimit: e.agentLimit,
      aiBalanceMicroUsd: e.ai.balanceMicroUsd - pending.ai,
      messagingBalanceMicroUsd: e.messaging.balanceMicroUsd - pending.messaging,
      channelRatesMicroUsd: e.channelRatesMicroUsd,
      freeDailyLlmCalls: e.freeDailyLlmCalls,
      aiKeyAlias: e.aiKeyAlias ?? null,
      periodEnd: e.periodEnd,
    };
  }

  /**
   * Claim the workspace-wide upgrade-request notification slot: true (and the slot is
   * stamped) when no request went out within the cooldown, false otherwise — so a stuck
   * teammate mashing "Request upgrade" can't flood the admins' inboxes.
   */
  async claimUpgradeRequestSlot(cooldownMs: number): Promise<boolean> {
    let last = await this.ctx.storage.get<number>("upgradeRequestedAt");
    let now = Date.now();
    if (last != null && now - last < cooldownMs) return false;
    await this.ctx.storage.put("upgradeRequestedAt", now);
    return true;
  }

  async #cachedEntitlements(): Promise<CachedEntitlements | undefined> {
    return await this.ctx.storage.get<CachedEntitlements>("entitlements");
  }

  async #pendingDebits(): Promise<{ ai: number; messaging: number }> {
    return (await this.ctx.storage.get<{ ai: number; messaging: number }>("pendingDebits"))
        ?? { ai: 0, messaging: 0 };
  }

  async #flush(): Promise<void> {
    let entries = await this.ctx.storage.list<UsageEventReport>({ prefix: "event:", limit: FLUSH_BATCH });
    if (entries.size === 0) return;
    try {
      let result = await reportUsage(this.env, [...entries.values()]);
      let keys = [...entries.keys()];
      for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
        await this.ctx.storage.delete(keys.slice(i, i + DELETE_CHUNK));
      }
      // The flush response's entitlements already include these debits, so the local
      // pending estimate resets alongside. Events recorded while the flush was in flight
      // stay buffered and are re-estimated on the next record()/flush cycle; the brief
      // undercount is acceptable (enforcement re-checks server truth within the TTL).
      await this.ctx.storage.put("pendingDebits", { ai: 0, messaging: 0 });
      if (result.entitlements) {
        await this.ctx.storage.put(
            "entitlements", { fetchedAt: Date.now(), data: result.entitlements });
      }
      logger.debug("usage flushed", { event: "usage.flush.ok", size: entries.size });
    } catch (err) {
      logger.warn("usage flush failed; will retry", { event: "usage.flush.failed", error: err });
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_RETRY_MS);
      return;
    }
    // More buffered than one batch: keep draining promptly.
    let remaining = await this.ctx.storage.list({ prefix: "event:", limit: 1 });
    if (remaining.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
  }
}

// ── producer conveniences ────────────────────────────────────────────────────
// Producers hold a ctx with exports (DOs and entrypoints); both helpers are safe to call
// unconditionally — they no-op without a billing directory and never throw.

/** The deployment's single collector instance. */
export function usageCollector(ctx: { exports: any }): DurableObjectStub<UsageCollectorDurableObject> {
  return ctx.exports.UsageCollectorDurableObject.getByName("default");
}

/** Fire-and-forget event recording; errors are logged, never thrown. */
export function recordUsage(
    ctx: { exports: any; waitUntil(p: Promise<unknown>): void },
    env: Cloudflare.Env,
    events: UsageEventReport[]): void {
  if (!hasBillingDirectory(env) || events.length === 0) return;
  ctx.waitUntil(
      usageCollector(ctx).record(events).catch(err => {
        logger.warn("failed to record usage", { event: "usage.record.failed", error: err });
      }));
}

/** Dollars (pi cost totals) to integer micro-USD. */
export function dollarsToMicroUsd(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.round(dollars * 1_000_000);
}
