import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-google",
  entrypoint: ".wrangler/validate/src/google.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "GmailGatekeeperImpl"] },
  { tag: "v1", new_sqlite_classes: ["BigQueryGatekeeperImpl"] },
  { tag: "v2", new_sqlite_classes: ["GoogleCalendarGatekeeperImpl"] },
  { tag: "v3", new_sqlite_classes: ["GoogleSheetsGatekeeperImpl"] },
  // Tyms fork: v4 is ours (VendorSetupStore, already applied in production), so upstream's
  // migrations land one tag later than upstream numbers them (upstream v4 = our v5, and so on).
  { tag: "v4", new_sqlite_classes: ["VendorSetupStore"] },
  { tag: "v5", new_sqlite_classes: ["GoogleDriveGatekeeperImpl", "GoogleDocGatekeeperImpl"] },
  { tag: "v6", new_sqlite_classes: ["GoogleChatGatekeeperImpl"] },
];
