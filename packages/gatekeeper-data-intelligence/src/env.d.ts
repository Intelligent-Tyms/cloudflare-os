// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    BASE_URL?: string;
    MCP_CLIENT_NAME?: string;
    MCP_ALLOW_INSECURE?: string;
    /**
     * Service binding to the Data Intelligence cell Worker (`tyms-di-cell`), injected by
     * deploy.mjs from `dataIntelligence.cellWorker`. Tenant hosts under
     * DATA_INTELLIGENCE_BASE_DOMAIN are on the same zone as this worker, and a same-zone
     * subrequest never reaches a Worker on a route.
     */
    DATA_INTELLIGENCE_CELL?: Fetcher;
    /** Base domain of the tenant hosts (`<slug>.<domain>`) the binding serves. */
    DATA_INTELLIGENCE_BASE_DOMAIN?: string;
  }

  interface GlobalProps {
    mainModule: typeof import("./data-intelligence.js");
    durableNamespaces: "VendorSetupStore" | "DataIntelligenceGatekeeper";
  }
}

interface Env extends Cloudflare.Env {}
