// A connected account's description is stored when it connects and otherwise re-read only for
// auto-provisioned accounts. A vendor that says its accounts' descriptions change on their own
// (VendorDescription.refreshesAccountDescriptions: the MCP connector marking a person's connection
// "not in use" once a built-in Tyms app takes its place) has its connected accounts re-read too.

import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { AccountDescription, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { UserDurableObject } from "../src/user.js";
import type { GatekeeperUserPickerTestHooks } from "./test-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_GATEKEEPER_USER_PICKER: DurableObjectNamespace<GatekeeperUserPickerTestHooks>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type Record = { id: number; vendorId: string; description: AccountDescription };
type UserInternals = UserDurableObject & {
  env: Cloudflare.Env;
  vendors: Map<string, { describe(): Promise<VendorDescription> }>;
  storage: { connectedAccounts: { get(id: number): Record | undefined; put(record: Record): void } };
};

const BLUEPRINTS = { get: async () => null } as unknown as KVNamespace;

function inUser<T>(userId: string, f: (user: UserInternals) => Promise<T> | T): Promise<T> {
  return runInDurableObject(env.TEST_USER.getByName(userId),
    (instance: UserDurableObject) => f(instance as UserInternals));
}

function vendor(refreshes: boolean): { describe(): Promise<VendorDescription> } {
  return {
    async describe() {
      return { displayName: "Vendor", url: "https://vendor.example", refreshesAccountDescriptions: refreshes };
    },
  };
}

it("re-reads the descriptions of a vendor that asks for it, and leaves the others as stored", async () => {
  const userId = `refresh${crypto.randomUUID().replaceAll("-", "")}`;
  const hooks = env.TEST_GATEKEEPER_USER_PICKER.getByName("");
  await inUser(userId, (user) => { user.env = { ...user.env, BLUEPRINTS }; });
  await hooks.createUser(userId, "Ann");
  const live = await hooks.addAccount(userId, "mcp", "live-account");
  const fixed = await hooks.addAccount(userId, "other", "fixed-account");

  await inUser(userId, (user) => {
    user.vendors = new Map([["mcp", vendor(true)], ["other", vendor(false)]]);
    for (const id of [live, fixed]) {
      const record = user.storage.connectedAccounts.get(id)!;
      user.storage.connectedAccounts.put({ ...record, description: { ...record.description, displayName: "stale" } });
    }
  });

  await env.TEST_USER.getByName(userId).listProvidedAccounts();

  await inUser(userId, (user) => {
    expect(user.storage.connectedAccounts.get(live)?.description.displayName).toBe("live-account");
    expect(user.storage.connectedAccounts.get(fixed)?.description.displayName).toBe("stale");
  });
});
