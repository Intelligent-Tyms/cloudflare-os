// Each Intelligence product's connector: the gatekeeper vendor id Admin → Intelligence writes
// to after provisioning and the setup-store value names it expects. Kept here (not imported
// from the gatekeeper packages) because the workshop reaches a gatekeeper only over its
// service binding; the names are the contract.
//
// organization: mirror of packages/gatekeeper-intelligence/src/config.ts.
// data: no connector is bound yet (the Data Intelligence gatekeeper is pending); until it
// ships, an active Data instance reports "missing-key" and Reconnect rotates the key into the
// connector once it exists.
import type { IntelligenceProductKind } from "@gadgets/workshop-shared/api";

export type IntelligenceConnectorSetup = {
  /** The gatekeeper's vendor id (its GATEKEEPER_<ID> binding, lowercased). */
  vendorId: string;
  mcpUrl: string;
  url: string;
  assistantKey: string;
  required: readonly string[];
};

export const INTELLIGENCE_CONNECTORS: Record<IntelligenceProductKind, IntelligenceConnectorSetup | null> = {
  organization: {
    vendorId: "intelligence",
    mcpUrl: "INTELLIGENCE_MCP_URL",
    url: "INTELLIGENCE_WIKI_URL",
    assistantKey: "INTELLIGENCE_ASSISTANT_KEY",
    required: ["INTELLIGENCE_MCP_URL", "INTELLIGENCE_ASSISTANT_KEY"],
  },
  data: null,
};
