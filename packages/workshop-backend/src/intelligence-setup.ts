// Each Intelligence product's connector: the gatekeeper vendor id Admin → Intelligence writes
// to after provisioning and the setup-store value names it expects. Kept here (not imported
// from the gatekeeper packages) because the workshop reaches a gatekeeper only over its
// service binding; the names are the contract.
//
// organization: mirror of packages/gatekeeper-intelligence/src/config.ts.
// data: mirror of packages/gatekeeper-data-intelligence/src/config.ts. Its vendor id has an
// underscore because the binding is GATEKEEPER_DATA_INTELLIGENCE.
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
  data: {
    vendorId: "data_intelligence",
    mcpUrl: "DATA_INTELLIGENCE_MCP_URL",
    url: "DATA_INTELLIGENCE_CONSOLE_URL",
    assistantKey: "DATA_INTELLIGENCE_ASSISTANT_KEY",
    required: ["DATA_INTELLIGENCE_MCP_URL", "DATA_INTELLIGENCE_ASSISTANT_KEY"],
  },
};
