// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    BASE_URL?: string;
    MCP_CLIENT_NAME?: string;
    MCP_ALLOW_INSECURE?: string;
  }

  interface GlobalProps {
    mainModule: typeof import("./intelligence.js");
    durableNamespaces: "VendorSetupStore" | "IntelligenceGatekeeper";
  }
}

interface Env extends Cloudflare.Env {}
