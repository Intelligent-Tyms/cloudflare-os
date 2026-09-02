import { describe, expect, it } from "vitest";
import { isPoolMode, poolModeRefusal } from "../src/pool-mode";
import { ambientGatekeeperMode, shouldAutoProvisionAccount } from "../src/provisioning-policy";
import { DEFAULT_ADMIN_CONFIG } from "../src/admin-config";

describe("pool mode", () => {
  it("is on only for an explicit POOL_MODE=true", () => {
    expect(isPoolMode({ POOL_MODE: "true" })).toBe(true);
    expect(isPoolMode({ POOL_MODE: " TRUE " })).toBe(true);
    expect(isPoolMode({ POOL_MODE: "false" })).toBe(false);
    expect(isPoolMode({ POOL_MODE: "1" })).toBe(false);
    expect(isPoolMode({ POOL_MODE: "" })).toBe(false);
    expect(isPoolMode({})).toBe(false);
  });

  it("refuses with the way out named", () => {
    expect(poolModeRefusal("Templates").message).toMatch(/free plan.*Upgrade/);
  });

  it("forces every ambient gatekeeper off on a pool, whatever the admin config says", () => {
    const enabled = { ...DEFAULT_ADMIN_CONFIG, ambientGatekeeperModes: { context: "enabled" as const } };
    expect(ambientGatekeeperMode(enabled, "context", {})).toBe("enabled");
    expect(shouldAutoProvisionAccount(enabled, "context", {})).toBe(true);
    expect(ambientGatekeeperMode(enabled, "context", { POOL_MODE: "true" })).toBe("disabled");
    expect(shouldAutoProvisionAccount(enabled, "context", { POOL_MODE: "true" })).toBe(false);
    // The default (unset) mode is "enabled" for companies and still "disabled" for pools.
    expect(ambientGatekeeperMode(DEFAULT_ADMIN_CONFIG, "scheduler", {})).toBe("enabled");
    expect(ambientGatekeeperMode(DEFAULT_ADMIN_CONFIG, "scheduler", { POOL_MODE: "true" })).toBe("disabled");
  });
});
