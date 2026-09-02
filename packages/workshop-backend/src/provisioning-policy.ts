// The provisioning policy for auto-provisioning ("ambient") gatekeepers — those that mint a connected
// account with no OAuth flow (VendorDescription.autoProvisionsAccount, e.g. the Context Library).
//
// Each such vendor has a three-state mode (see AmbientGatekeeperMode), set per deployment by the
// admin and stored in AdminConfig.ambientGatekeeperModes:
//   - 'disabled': not available; no account is provisioned, and any existing one stays dormant.
//   - 'optional': users opt in from the Integrations page; not forced on anyone.
//   - 'enabled':  auto-provisioned for every user (forced); they can't remove it. THE DEFAULT on
//                 Tyms deployments: ambient capabilities (Knowledge, Scheduled Tasks, Doc converter,
//                 Custom integration) work out of the box; admins opt out per vendor instead.
//
// These helpers are the single chokepoint for that decision; UserDurableObject reads AdminConfig and
// calls them when provisioning, listing, and surfacing ambient accounts.

import { AmbientGatekeeperMode } from "@gadgets/workshop-shared/api";
import { AdminConfig } from "./admin-config.js";
import { isPoolMode } from "./pool-mode.js";

export const DEFAULT_AMBIENT_GATEKEEPER_MODE: AmbientGatekeeperMode = "enabled";

type PolicyEnv = { POOL_MODE?: string };

/**
 * The configured mode for an ambient vendor, defaulting to "enabled" when the admin hasn't set one.
 * Tolerates a config persisted before this field existed (ambientGatekeeperModes may be undefined).
 * On a free pool every ambient vendor is "disabled" whatever the admin config says: Knowledge
 * collections are shared across the deployment's sharing domain, which on a pool means across
 * unrelated users.
 */
export function ambientGatekeeperMode(config: AdminConfig, vendorId: string, env: PolicyEnv)
    : AmbientGatekeeperMode {
  if (isPoolMode(env)) return "disabled";
  return config.ambientGatekeeperModes?.[vendorId.toLowerCase()] ?? DEFAULT_AMBIENT_GATEKEEPER_MODE;
}

/**
 * Whether this vendor's account is auto-provisioned for every user ("enabled" mode). Such accounts
 * are "forced": created for everyone, not user-removable, and hidden from the Integrations list.
 * ("optional" accounts are user-managed; "disabled" ones aren't offered.)
 */
export function shouldAutoProvisionAccount(config: AdminConfig, vendorId: string, env: PolicyEnv)
    : boolean {
  return ambientGatekeeperMode(config, vendorId, env) === "enabled";
}
