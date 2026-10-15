// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    BASE_URL?: string;
    MCP_CLIENT_NAME?: string;
    MCP_ALLOW_INSECURE?: string;
    /**
     * Service binding to the Intelligence cell Worker (`tyms-oi-cell`), injected by deploy.mjs
     * from `intelligence.cellWorker`. Wiki hosts under INTELLIGENCE_BASE_DOMAIN are on the same
     * zone as this worker, and a same-zone subrequest never reaches a Worker on a route.
     */
    INTELLIGENCE_CELL?: Fetcher;
    /** Base domain of the wiki hosts (`<slug>.<domain>`) the binding serves. */
    INTELLIGENCE_BASE_DOMAIN?: string;
  }

  interface GlobalProps {
    mainModule: typeof import("./intelligence.js");
    durableNamespaces: "VendorSetupStore" | "IntelligenceGatekeeper";
  }
}

interface Env extends Cloudflare.Env {}
