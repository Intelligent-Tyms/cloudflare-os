// Pool mode: this deployment is a Tyms-owned stack hosting many unrelated free users as plain
// members (see scripts/tenant-config.mjs `tier=pool` in the tyms-app repo). Everyone gets chat
// with their own private workspaces and nothing that crosses users or is deployment-wide:
// no templates (the KV catalog and featured list are shared by every member), no workspace
// sharing or share links, no team chat, no Knowledge library, no other member's avatar.
//
// The var is set by the deploy tooling (POOL_MODE="true"); a company tenant never has it. These
// helpers are the single chokepoint for the decision so the guards read the same everywhere.

type PoolEnv = { POOL_MODE?: string };

export function isPoolMode(env: PoolEnv): boolean {
  return env.POOL_MODE?.trim().toLowerCase() === "true";
}

/** The refusal thrown by RPCs that pool members cannot use. Names the way out. */
export function poolModeRefusal(what: string): Error {
  return new Error(`${what} isn't available on the free plan. Upgrade to a workspace of your own to ` +
      "use it.");
}
