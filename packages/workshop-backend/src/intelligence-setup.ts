// The intelligence gatekeeper's setup-store value names, as Admin → Intelligence writes them
// after provisioning. Kept here (not imported from the gatekeeper package) because the
// workshop reaches the gatekeeper only over its service binding; the names are the contract.
// Mirror of packages/gatekeeper-intelligence/src/config.ts.
export const INTELLIGENCE_SETUP_NAMES = {
  mcpUrl: "INTELLIGENCE_MCP_URL",
  wikiUrl: "INTELLIGENCE_WIKI_URL",
  assistantKey: "INTELLIGENCE_ASSISTANT_KEY",
  required: ["INTELLIGENCE_MCP_URL", "INTELLIGENCE_ASSISTANT_KEY"],
} as const;
