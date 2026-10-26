import {
  OBSERVABILITY, bindings, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

/**
 * The merged tenant Worker (src/tenant.ts). Its bindings are the union of the parts' own; the
 * bindings between parts are ctx.exports loopbacks and appear nowhere here. Not deployed from this
 * repo: tyms-os adds the channels gatekeeper, and its control plane uploads the bundle into a
 * dispatch namespace with each tenant's resources, vars and secrets. The parts' validated trees
 * must be built first (this package's `bundle` task does that).
 */
export default defineGadgetsWorker({
  name: "jamaa-tenant",
  entrypoint: "src/index.ts",

  // workshop-backend's flags; gatekeeper-context's are a subset of them.
  compatibilityFlags: [
    "allow_irrevocable_stub_storage",
    "global_fetch_strictly_public",
    "nodejs_compat",
  ],

  env: {
    // workshop-backend
    BROWSER: bindings.browser(),
    BLUEPRINTS: bindings.kv(),
    AVATARS: bindings.kv(),
    BLUEPRINT_CONTENT: bindings.r2({ name: "jamaa-tenant-blueprint-content" }),
    LOADER: bindings.workerLoader(),
    // gatekeeper-context
    CONTEXT_COLLECTIONS: bindings.kv(),
    WORKERS_AI: bindings.ai(),
  },

  observability: {
    ...OBSERVABILITY,
    // As workshop-backend.
    traces: { enabled: true, headSamplingRate: 0.5 },
  },
});

/**
 * One fresh history: a tenant script is new when it is first uploaded, so every class starts in
 * v1 rather than replaying each part's own tags. Later classes get later tags here, never edits
 * to v1. __tests__/merge.test.ts checks that every SQLite class a part declares is created.
 */
export const migrations: DurableObjectMigration[] = [
  {
    tag: "v1",
    new_sqlite_classes: [
      // workshop-backend
      "UserDurableObject",
      "OverseerDurableObject",
      "AdminSettings",
      "PendingLogin",
      "UsageCollectorDurableObject",
      "UserDirectoryDurableObject",
      // gatekeeper-context
      "ContextCollectionDurableObject",
      "UserLibraryDurableObject",
      "LibraryRegistryDurableObject",
      "ContextGatekeeper",
    ],
  },
];
