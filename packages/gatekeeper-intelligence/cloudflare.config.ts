import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, bindings, defineGadgetsWorker,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-intelligence",
  entrypoint: ".wrangler/validate/src/intelligence.ts",

  // The wiki endpoint is administrator- or provisioning-supplied, never user input, but it is still a
  // URL this worker fetches: `global_fetch_strictly_public` makes workerd reject reserved IP
  // ranges after DNS resolution, which no hostname check can do.
  compatibilityFlags: ["allow_irrevocable_stub_storage", "global_fetch_strictly_public"],

  // Nothing tenant-specific is configured here. The wiki endpoint and the assistant key reach this
  // worker through the per-tenant setup store (Admin → Intelligence writes it after provisioning);
  // unset, the connector advertises nothing and the Workshop hides it.
  // tyms-os deploy.mjs also injects, from deployment.jsonc `intelligence`: the var INTELLIGENCE_BASE_DOMAIN and a
  // service binding INTELLIGENCE_CELL to the cell Worker. Wiki hosts share this worker's zone, and a same-zone
  // subrequest never reaches a Worker on a route, so requests to them travel over the binding
  // (src/cell.ts).
  env: {
    // Set to "true" to permit http:// and private-network endpoints. Local development only.
    MCP_ALLOW_INSECURE: bindings.text("false"),
  },

  observability: OBSERVABILITY,
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
} satisfies WranglerExtras;

/** Tyms fork: this worker's first (and live) migration tag is v1. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["VendorSetupStore", "IntelligenceGatekeeper"] },
];
