// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    BASE_URL?: string;
    MCP_ALLOW_INSECURE?: string;
    MCP_CLIENT_NAME?: string;
    MCP_CATALOG_URL?: string;
    /** The control plane's JamaaAppsEntrypoint: Tyms apps built into Jamaa (tyms-apps.ts). */
    TYMS_APPS?: import("./tyms-apps.js").TymsAppsService;
  }

  interface GlobalProps {
    mainModule: typeof import("./mcp.js");
    durableNamespaces: "McpAccount" | "McpGatekeeperImpl" | "VendorSetupStore";
  }
}

interface Env extends Cloudflare.Env {}
