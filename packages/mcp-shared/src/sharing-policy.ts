// How an MCP binding may be shared, and the words used when it cannot be.
//
// MCP has no per-record authorization to consult, so whether a collaborator may see what a Gadget
// read is a decision the deployment makes per endpoint, not one the connector can derive:
//
// - `owner-only`: `addObserver` refuses unconditionally. Holding a connection to the same origin
//   proves only that a person can authenticate to the service, not that they may read what this
//   Gadget read on its owner's credentials. Writes are still allowed, since writing back to the
//   server the data came from discloses it to nobody new. The default, and the only tier a
//   user-supplied endpoint ever gets.
// - `same-account`: a collaborator must connect their own account to the same endpoint, and every
//   read-only call the Gadget has made is replayed on that account and must succeed. Where the
//   server enforces access per account (a bank, a CRM), a call scoped to something the observer
//   cannot see fails, and so does the share. Results are not compared, only the fact of success:
//   the data behind most servers changes between two calls.
// - `public`: the endpoint serves data anyone may see (market rates, reference data), so any
//   collaborator may observe and nothing is verified.
//
// The policy is deployment configuration, read at point of use like the trust tier, never frozen
// onto an account. Reads are logged under every policy so a later tightening or loosening of the
// catalog stays honest about what has already been read. See the README for the alternatives that
// were rejected.

export const SHARING_POLICIES = ["owner-only", "same-account", "public"] as const;

export type McpSharingPolicy = (typeof SHARING_POLICIES)[number];

/** The policy a catalog or configuration value names, or `owner-only` for anything unrecognised. */
export function parseSharingPolicy(value: unknown): McpSharingPolicy {
  return typeof value === "string"
      && (SHARING_POLICIES as readonly string[]).includes(value.trim().toLowerCase())
    ? value.trim().toLowerCase() as McpSharingPolicy
    : "owner-only";
}

/**
 * Explains, to whoever tried to open a Gadget they do not own, why they cannot.
 *
 * @param source How to name the thing that was read from: a hostname for a bare endpoint, a gateway
 * name for a portal. Interpolated into a sentence, so it should read as a noun phrase.
 */
export function observerRefusalMessage(source: string): string {
  return `a workspace that reads from ${source} can only be opened by its owner, because there is no ` +
    `way to check whether anyone else is allowed to see what it read. Publish it as a blueprint ` +
    `instead, so each person connects their own account.`;
}

/** The chosen account is connected somewhere other than where this Gadget reads from. */
export function observerEndpointMismatchMessage(source: string, connectedTo: string): string {
  return `this workspace reads from ${source}, but the account you chose is connected to ` +
    `${connectedTo}. Connect your own account to ${source} and choose that one.`;
}

/** A read the Gadget made could not be repeated on the observer's own account. */
export function observerReplayFailureMessage(
  source: string, toolName: string, reason: string,
): string {
  return `your account on ${source} could not read everything this workspace has read from it: ` +
    `calling "${toolName}" failed (${reason}). If your access there has changed, reconnect the ` +
    `account and try again.`;
}

/** The Gadget has read more distinct things than can be checked against another account. */
export function observerLogOverflowMessage(source: string): string {
  return `this workspace has read too many different things from ${source} to confirm that ` +
    `anyone else may see all of them, so it can only be opened by its owner. Publish it as a ` +
    `blueprint instead, so each person connects their own account.`;
}
