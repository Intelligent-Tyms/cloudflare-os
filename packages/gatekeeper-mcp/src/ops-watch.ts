// The polling core of Operational Intelligence change hooks (ops-hooks.ts), kept free of the
// Workers runtime so it can be tested directly: read what each hook watches, compare it with what
// was seen last, and queue a change when it differs.

/** What a hook can watch, each an `ops://<slug>/<name>` resource. */
export const OPS_WATCHES = ["alerts", "attention"] as const;
export type OpsWatch = (typeof OPS_WATCHES)[number];

const MINUTE_MS = 60_000;
/** How long a hook whose reads fail (its person left, the app was switched off) waits before trying again. */
export const FAILURE_BACKOFF_MS = 15 * MINUTE_MS;
/** The most of a resource a delivery carries; the hook can read the rest through its binding. */
export const MAX_CHANGE_CHARS = 32_000;

/** One change, as the driver queues it. */
export type OpsChangeRaw = { watch: OpsWatch; uri: string; text: string; at: number };

/** What the driver stores per hook to poll for it. */
export type OpsWatchRegistration = {
  watch: OpsWatch[];
  tenant: string;
  app: string;
  /** The app's MCP URL, `https://<slug>.ops.tyms.ai/mcp`. */
  endpoint: string;
  /** The person whose access the reads run on. */
  actor: string;
};

/** The slice of Durable Object KV storage the poll uses. */
export type WatchKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean | void;
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
};

export const registrationKey = (key: string) => `reg:${key}`;
export const capabilitiesKey = (key: string) => `caps:${key}`;
/** The last fingerprint seen of one watched resource for one hook. */
export const fingerprintKey = (key: string, watch: OpsWatch) => `fp:${key}:${watch}`;
/** Until when a hook whose reads failed is left alone. */
export const backoffKey = (key: string) => `backoff:${key}`;

/** `ops://<slug>/<watch>` for an app endpoint `https://<slug>.<…>/mcp`. */
export function opsResourceUri(endpoint: string, watch: OpsWatch): string {
  const slug = new URL(endpoint).hostname.split(".")[0]!.toLowerCase();
  return `ops://${slug}/${watch}`;
}

export async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Forget what a hook had seen, as it is unregistered. */
export function forgetHook(kv: WatchKv, key: string): void {
  kv.delete(registrationKey(key));
  kv.delete(capabilitiesKey(key));
  kv.delete(backoffKey(key));
  for (const watch of OPS_WATCHES) kv.delete(fingerprintKey(key, watch));
}

export type PollDeps = {
  kv: WatchKv;
  now: number;
  /** One resource's text, read as the registration's person. */
  read(registration: OpsWatchRegistration, uri: string): Promise<string>;
  enqueue(hookKey: string, messageId: string, change: OpsChangeRaw): void;
  onError?(error: unknown): void;
};

/**
 * One round over every registered hook. The first read of a resource only records where it stands;
 * a later one that differs queues a change. Hooks of one person watching one resource share its
 * read. A hook whose read fails is left alone for FAILURE_BACKOFF_MS.
 */
export async function pollHooks({ kv, now, read, enqueue, onError }: PollDeps): Promise<void> {
  // Listed up front: an enable handled while a read awaits would invalidate a live iterator.
  const registrations = [...kv.list<OpsWatchRegistration>({ prefix: "reg:" })];
  const reads = new Map<string, Promise<string>>();
  for (const [regKey, registration] of registrations) {
    const key = regKey.slice("reg:".length);
    if ((kv.get<number>(backoffKey(key)) ?? 0) > now) continue;
    try {
      for (const watch of registration.watch) {
        const uri = opsResourceUri(registration.endpoint, watch);
        const readKey = `${registration.actor}\n${registration.endpoint}\n${uri}`;
        let pending = reads.get(readKey);
        if (!pending) {
          pending = read(registration, uri);
          reads.set(readKey, pending);
        }
        const text = await pending;
        // Unregistered while the read was in flight.
        if (kv.get(registrationKey(key)) === undefined) break;
        const seen = await fingerprint(text);
        const before = kv.get<string>(fingerprintKey(key, watch));
        kv.put(fingerprintKey(key, watch), seen);
        if (before !== undefined && before !== seen) {
          enqueue(key, `${watch}:${now}`, { watch, uri, text: text.slice(0, MAX_CHANGE_CHARS), at: now });
        }
      }
      kv.delete(backoffKey(key));
    } catch (error) {
      onError?.(error);
      kv.put(backoffKey(key), now + FAILURE_BACKOFF_MS);
    }
  }
}
