// The verifier an observer's own connected account mints, handed by the Workshop to the facet's
// `addObserver`. The Workshop promises to pass a verifier only to the gatekeeper that created it,
// so the facet can trust what it says about the account behind it (see the note on
// `GatekeeperUserVerifier` in `@gadgets/workshop-shared/gatekeeper`).

import { WorkerEntrypoint } from "cloudflare:workers";

import type { McpGatekeeperUserAccount, McpGatekeeperUserProps } from "./user.js";

/** What the facet learns about an observer's account. */
export type ObserverAccount = {
  /** The account Durable Object's id, for the facet to reach the account again later. */
  accountObjectId: string;
  /** The endpoint the account is connected to, compared against the facet's own. */
  endpoint: string;
};

/**
 * The non-standard method the MCP facets call on a verifier they minted, over and above the
 * (empty) `GatekeeperUserVerifier` contract.
 */
export interface McpVerifierApi {
  observerAccount(): Promise<ObserverAccount>;
}

/** Symbol-named hook that cannot be invoked as an RPC method. */
export const mcpVerifierAccount = Symbol("mcpVerifierAccount");

/** Common verifier for both MCP connectors: names the account it was minted for. */
export abstract class McpVerifierBase<E, P extends McpGatekeeperUserProps = McpGatekeeperUserProps>
  extends WorkerEntrypoint<E, P> implements McpVerifierApi {

  /** Supplies the account capability without exposing an RPC-addressable method. */
  protected abstract [mcpVerifierAccount](): McpGatekeeperUserAccount;

  async observerAccount(): Promise<ObserverAccount> {
    const server = await this[mcpVerifierAccount]().getServer();
    return { accountObjectId: this.ctx.props.accountObjectId, endpoint: server.endpoint };
  }
}
