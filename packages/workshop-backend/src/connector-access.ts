// Who may add a connector, and who only signs in to one.
//
// Adding a connector is an administrator's job: turning it on, entering the company's credential,
// registering the OAuth app people sign in through, adding a server by its address. A member's
// part is to sign in where a connector uses their own account, and nothing else. Most vendors
// need no rule for that, since all a member can do with them is sign in. The exception is a
// resource type whose connect flow asks for an address or a credential (see
// SupportedResource.connectableBy): those are hidden from members and their connects refused.
import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { type AdminConfig, filterEnabledResources } from "./admin-config.js";

/**
 * Who is asking about or starting a connection. Whether a user administers the deployment is the
 * API layer's call (see AuthenticatedApiImpl), so a caller that knows says so; everyone else,
 * the agent included, is treated as a member.
 */
export type ConnectorCaller = { admin?: boolean };

/** What a member is told where only an administrator may act. */
export const ADMIN_ADDS_CONNECTORS =
    "Only an administrator can add this connector. Ask one to add it under Admin → Connectors.";

/** The resource types this caller may start a connection to. */
export function connectableResources(
    resources: SupportedResource[], caller: ConnectorCaller): SupportedResource[] {
  return caller.admin ? resources : resources.filter(r => r.connectableBy !== "admin");
}

/**
 * The resource patterns a member's connect may carry to a vendor. A vendor that reserves nothing
 * for administrators is left exactly as asked, including the meaningful empty list (a connect
 * for a non-resource purpose). One that does has the connect narrowed to the types a member may
 * use and the deployment has on, so the vendor's connect page has nothing else to offer; a
 * connect that names only reserved types, or a vendor with nothing else, is refused.
 */
export function memberConnectPatterns(
    config: AdminConfig, vendorId: string, resources: SupportedResource[],
    requested: string[] | undefined): string[] | undefined {
  if (!resources.some(r => r.connectableBy === "admin")) return requested;
  let allowed = filterEnabledResources(config, vendorId, connectableResources(resources, {}))
      .map(r => r.urlPattern);
  let narrowed = requested === undefined
      ? allowed
      : requested.filter(pattern => allowed.includes(pattern));
  if (narrowed.length === 0) throw new Error(ADMIN_ADDS_CONNECTORS);
  return narrowed;
}
