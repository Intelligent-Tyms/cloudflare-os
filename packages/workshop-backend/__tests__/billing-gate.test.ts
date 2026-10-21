import { describe, expect, it } from "vitest";
import { billingGate, type BillingState } from "../src/usage-collector.js";

const base: BillingState = {
  planCode: "account",
  tier: "standard",
  subscriptionStatus: "active",
  seatLimit: null,
  agentLimit: null,
  aiBalanceMicroUsd: 5_000_000,
  aiMonthlyGrantMicroUsd: 0,
  messagingBalanceMicroUsd: 5_000_000,
  channelRatesMicroUsd: {},
  freeDailyLlmCalls: null,
  aiKeyAlias: "paid",
  periodEnd: 0,
  trialEndsAt: null,
  cardExpiresBeforeNextCharge: false,
  hasCard: true,
  account: {
    mode: "prepay",
    status: "active",
    balanceMicroUsd: 5_000_000,
    canRun: true,
    billingUrl: "https://billing.tyms.ai/acme",
    lowBalanceMicroUsd: 1_000_000,
    stopped: [],
  },
};

describe("billingGate", () => {
  it("runs on a funded account", () => {
    expect(billingGate(base)).toEqual({ stop: null, lowBalance: false });
  });

  it("flags a prepaid balance under the low mark", () => {
    expect(billingGate({ ...base, aiBalanceMicroUsd: 500_000 }))
      .toEqual({ stop: null, lowBalance: true });
  });

  it("stops when the balance is spent, counting unflushed debits", () => {
    expect(billingGate({ ...base, aiBalanceMicroUsd: 0 }))
      .toEqual({ stop: "out_of_funds", lowBalance: false });
    expect(billingGate({ ...base, account: { ...base.account!, canRun: false } }).stop)
      .toBe("out_of_funds");
  });

  it("reports a suspended account", () => {
    expect(billingGate({ ...base, aiBalanceMicroUsd: 0, account: { ...base.account!, status: "suspended", canRun: false } }))
      .toEqual({ stop: "suspended", lowBalance: false });
  });

  it("reports a spending limit that stopped everything or a service group", () => {
    expect(billingGate({ ...base, aiBalanceMicroUsd: 0, account: { ...base.account!, canRun: false, stopped: ["all"] } }))
      .toEqual({ stop: "limit_reached", lowBalance: false });
    expect(billingGate({ ...base, aiBalanceMicroUsd: 0, account: { ...base.account!, stopped: ["ai"] } }).stop)
      .toBe("limit_reached");
  });

  it("reads a snapshot cached before the stopped field existed", () => {
    const { stopped: _stopped, ...older } = base.account!;
    expect(billingGate({ ...base, account: older })).toEqual({ stop: null, lowBalance: false });
  });

  it("never nags postpay about a low balance", () => {
    expect(billingGate({ ...base, aiBalanceMicroUsd: 1, account: { ...base.account!, mode: "postpay" } }))
      .toEqual({ stop: null, lowBalance: false });
  });

  it("falls back to the legacy pools on a snapshot without an account", () => {
    const plan = { ...base, account: null, planCode: "team", aiBalanceMicroUsd: 0 };
    expect(billingGate(plan).stop).toBe("out_of_funds");
    expect(billingGate({ ...plan, tier: "enterprise" }).stop).toBeNull();
    expect(billingGate({ ...plan, freeDailyLlmCalls: 20 }).stop).toBeNull();
  });
});
