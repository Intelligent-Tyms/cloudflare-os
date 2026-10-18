import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-github",
  entrypoint: ".wrangler/validate/src/github.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "GitHubGatekeeperImpl"] },
  // Tyms fork: admin-entered OAuth app setup, keyed by tenant. v1 is ours (already applied in
  // production), so upstream's migrations land one tag later than upstream numbers them.
  { tag: "v1", new_sqlite_classes: ["VendorSetupStore"] },
  { tag: "v2", new_sqlite_classes: ["GitHubHookDriver"] },
];
