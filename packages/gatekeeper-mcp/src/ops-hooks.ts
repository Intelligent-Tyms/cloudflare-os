// Operational Intelligence change hooks (Tyms fork): wake a Gadget or agent when an ops alert fires
// or something new needs a person.
//
// Operational Intelligence (tyms-ops-intelligence docs/assistants.md, "Being told when something
// changes") offers the resources `ops://<slug>/alerts` and `ops://<slug>/attention`. Rather than
// hold a push stream open, which would keep a Durable Object awake per workspace, one driver per
// tenant reads them every minute as the person who enabled each hook and fires the hook when what
// they show changed (ops-watch.ts).
//
// The shape follows Google Chat's hooks (gatekeeper-google chat-hooks.ts): the session's
// `onOpsChange()` runs in the binding's facet, which mints a persistent stub to itself for delivery
// and binds an `OpsHookController` carrying it. The controller is a loopback entrypoint, so a
// `disable()` fired as the facet is deleted still reaches the driver.
//
// A Tyms app acts only for a person (tyms-apps.ts): the hook records who enabled it and every read
// runs on that person's access token from the control plane, so leaving the workspace or losing the
// app stops the reads.

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { HookDeliveryQueue, disposeStubs } from "@gadgets/gatekeeper-kit/hook-delivery-queue";
import { createLogger } from "@gadgets/observability/logger";
import type { ApprovalQueue, HookController, HookInitiator, HookTargetMetadata }
  from "@gadgets/workshop-shared/gatekeeper";
import { McpClient } from "@gadgets/mcp-shared/client";
import { clientName, type ConnectionEnv } from "@gadgets/mcp-shared/connection";
import { fetchOptions } from "@gadgets/mcp-shared/fetch";
import type { McpLogFields } from "@gadgets/mcp-shared/log";
import { appPersonToken, type TymsAppsEnv } from "./tyms-apps.js";
import {
  capabilitiesKey,
  forgetHook,
  pollHooks,
  registrationKey,
  type OpsChangeRaw,
  type OpsWatch,
  type OpsWatchRegistration,
} from "./ops-watch.js";

export { OPS_WATCHES, type OpsWatch } from "./ops-watch.js";

const logger = createLogger<McpLogFields>({ component: "gatekeeper.mcp.ops-hooks", vendorId: "mcp" });

type Env = Cloudflare.Env & TymsAppsEnv & ConnectionEnv;

/** The Tyms app whose resources these hooks watch. */
export const OPS_APP = "operations";
/** How often the driver reads what its hooks watch. */
export const POLL_INTERVAL_MS = 60_000;

/** What a Gadget's hook receives; see `opsHookTypes()`. */
export type OpsChange = {
  resource: OpsWatch;
  uri: string;
  noticedAt: string;
  content: unknown;
};

export interface OpsChangeHook {
  opsChanged(change: OpsChange): Promise<void>;
}
export type OpsChangeHookTarget = RpcTarget & OpsChangeHook;

/** Sealed into a hook's delivery stub by the facet's `ctx.restore()`. */
export type OpsHookParams = { watch: OpsWatch[] };

/** What a hook's delivery stub reaches: the binding's facet, narrowed to delivering. */
export interface OpsHookDelivery extends RpcTarget {
  deliver(callback: RpcStub<OpsChangeHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
          change: OpsChangeRaw): Promise<void>;
}

/** Everything a hook needs once enabled, captured when the facet binds it. */
export type OpsHookProps = OpsWatchRegistration & {
  key: string;
  delivery: RpcStub<OpsHookDelivery>;
};

/** The driver holding a tenant's ops hooks. */
export function opsHookDriverName(tenant: string, app: string): string {
  return `${tenant}:${app}`;
}

@validateRpc()
export class OpsHookController extends WorkerEntrypoint<Env, OpsHookProps>
    implements HookController<OpsChangeHookTarget> {
  async enable(initiator: Fetcher<HookInitiator<OpsChangeHookTarget>>,
               _target: HookTargetMetadata): Promise<void> {
    const { key, delivery, ...registration } = this.ctx.props;
    await this.#driver().register(key, registration, {
      delivery,
      initiator,
    });
  }

  async disable(): Promise<void> {
    await this.#driver().unregister(this.ctx.props.key);
  }

  #driver() {
    const { tenant, app } = this.ctx.props;
    return this.ctx.exports.OpsHookDriver.getByName(opsHookDriverName(tenant, app));
  }
}

// ── Driver ──────────────────────────────────────────────────────────

type Capabilities = {
  delivery: RpcStub<OpsHookDelivery>;
  initiator: Fetcher<HookInitiator<OpsChangeHookTarget>>;
};

export class OpsHookDriver extends DurableObject<Env> {
  #queue = new HookDeliveryQueue<OpsChangeRaw>(this.ctx.storage.kv, () => {
    logger.warn("dropped an ops change after repeated delivery failures", { event: "ops.hooks.delivery.dropped" });
  });

  async register(key: string, registration: OpsWatchRegistration, capabilities: Capabilities): Promise<void> {
    const replaced = this.ctx.storage.kv.get<Capabilities>(capabilitiesKey(key));
    this.ctx.storage.kv.put(registrationKey(key), registration);
    this.ctx.storage.kv.put(capabilitiesKey(key), capabilities);
    disposeStubs(replaced);
    // The first read records where each resource stands; changes after it are delivered.
    await this.#wakeBy(Date.now());
  }

  async unregister(key: string): Promise<void> {
    disposeStubs(this.ctx.storage.kv.get<Capabilities>(capabilitiesKey(key)));
    forgetHook(this.ctx.storage.kv, key);
    this.#queue.cancel(key);
  }

  /** Read what each hook watches, queue what changed, deliver what is due, and come back in a minute. */
  async alarm(): Promise<void> {
    const now = Date.now();
    await pollHooks({
      kv: this.ctx.storage.kv,
      now,
      read: (registration, uri) => this.#read(registration, uri),
      enqueue: (hookKey, messageId, change) => this.#queue.enqueue(hookKey, messageId, change, now),
      onError: error => logger.warn("failed to read an ops resource for a hook", { event: "ops.hooks.read.failed", error }),
    });
    await this.#queue.run(now, (hookKey, change) => this.#deliver(hookKey, change));
    await this.#reschedule(now);
  }

  /** One resource's text, read as the hook's person. */
  async #read(registration: OpsWatchRegistration, uri: string): Promise<string> {
    const token = await appPersonToken(this.env, registration.tenant, registration.app, registration.actor);
    const client = new McpClient(registration.endpoint, async () => token, null, fetchOptions(this.env));
    await client.initialize(clientName(this.env));
    return (await client.readResource(uri)).text;
  }

  async #deliver(hookKey: string, change: OpsChangeRaw): Promise<void> {
    // An unregistered hook's rows are finished, and it gets no new ones.
    const capabilities = this.ctx.storage.kv.get<Capabilities>(capabilitiesKey(hookKey));
    if (!capabilities) return;
    try {
      using hook = await capabilities.initiator.startHook();
      // @ts-expect-error Worker RPC's mapped types can't relate an ApprovalQueue stub to itself.
      await capabilities.delivery.deliver(hook.callback, hook.approvalQueue, change);
    } finally {
      disposeStubs(capabilities);
    }
  }

  async #wakeBy(time: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || time < current) await this.ctx.storage.setAlarm(time);
  }

  async #reschedule(now: number): Promise<void> {
    const times: number[] = [];
    const queueDue = this.#queue.nextDue();
    if (queueDue !== undefined) times.push(queueDue);
    if ([...this.ctx.storage.kv.list({ prefix: "reg:", limit: 1 })].length > 0) times.push(now + POLL_INTERVAL_MS);
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.min(...times));
  }
}

// ── Delivery (runs in the binding's facet) ──────────────────────────

const LABELS: Record<OpsWatch, { title: string; what: string }> = {
  alerts: { title: "an alert fired", what: "the latest alert firings" },
  attention: { title: "something needs attention", what: "the open review items and pending approvals" },
};

/** What a hook's delivery stub restores to in the facet: one firing at a time. */
@validateRpc()
export class OpsHookDeliveryImpl extends RpcTarget implements OpsHookDelivery {
  constructor(private readonly params: OpsHookParams, private readonly serverName: string) {
    super();
  }

  async deliver(callback: RpcStub<OpsChangeHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
                change: OpsChangeRaw): Promise<void> {
    if (!this.params.watch.includes(change.watch)) return;
    const label = LABELS[change.watch];
    await approvalQueue.authorizeObservation({
      title: `${this.serverName}: ${label.title}`,
      description: `Read ${label.what} from **${this.serverName}** (\`${change.uri}\`), ` +
        "as the person who enabled this hook, with personal data masked.",
    });
    await callback.opsChanged(toOpsChange(change));
  }
}

/** The change a Gadget's hook receives: the resource parsed as JSON when it is JSON. */
export function toOpsChange(change: OpsChangeRaw): OpsChange {
  let content: unknown = change.text;
  try {
    content = JSON.parse(change.text);
  } catch {
    // Not JSON (or cut short): hand over the text.
  }
  return { resource: change.watch, uri: change.uri, noticedAt: new Date(change.at).toISOString(), content };
}

/** Appended to an Operational Intelligence binding's generated session types. */
export function opsHookTypes(typeName: string): string {
  return `
/** A change on Operational Intelligence, delivered to an \`OpsChangeHook\`. */
export type OpsChange = {
  /** \`alerts\`: an alert (trigger) fired. \`attention\`: review items or approvals changed. */
  resource: "alerts" | "attention";
  uri: string;
  /** When the change was noticed (checked every minute), ISO 8601. */
  noticedAt: string;
  /** The resource as it reads now (JSON); personal data is masked. */
  content: unknown;
};

/** Implemented by a Gadget to hear about Operational Intelligence changes; see \`onOpsChange()\`. */
export interface OpsChangeHook {
  /**
   * Called once per change. A change may arrive more than once, so keep work idempotent (key it
   * on \`noticedAt\` and the content); one this throws for is retried with backoff, eight attempts
   * in all. Disabling the hook ends its retries.
   */
  opsChanged(change: OpsChange): Promise<void>;
}

export interface ${typeName} {
  /**
   * Have \`hook.opsChanged()\` called when an alert fires (\`alerts\`) or when what waits for a
   * person changes (\`attention\`), checked every minute and read as you, the person enabling it,
   * with personal data masked. Both are watched when \`watch\` is omitted. The hook starts
   * disabled until the user enables it. Every call creates a distinct hook.
   *
   * \`hook\` must be a persistent stub that restores through a Gadget's \`[restore]()\` method, as
   * "Persistent Stubs and \`ctx.restore()\`" in your instructions describes.
   */
  onOpsChange(hook: OpsChangeHook, options?: { watch?: ("alerts" | "attention")[] }): Promise<void>;
}
`;
}
