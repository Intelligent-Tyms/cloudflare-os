// A KV namespace shared by many tenants, seen by one of them. Every key the tenant reads or writes
// is stored under `prefix`, and keys coming back from a list have it removed, so the parts' code
// sees what it would see in a namespace of its own. Workers for Platforms tenants share three
// namespaces this way rather than holding three each: the account allows 1,000 namespaces.
//
// Only the KV operations the parts use, plus list and getWithMetadata, are modelled; anything else
// on the returned object is missing rather than unprefixed, so a new call fails loudly instead of
// reading another tenant's keys.

type GetArgs = [type?: unknown];

/** `kv` restricted to keys under `prefix`. `prefix` must be non-empty and should end in "/". */
export function prefixedKv(kv: KVNamespace, prefix: string): KVNamespace {
  if (!prefix) throw new Error("A shared KV namespace needs a non-empty tenant prefix.");
  let inner = kv as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  let key = (name: string) => prefix + name;
  let keys = (names: string | string[]) => Array.isArray(names) ? names.map(key) : key(names);

  // A bulk get returns a Map keyed by the stored keys; give it back keyed by the tenant's.
  let unprefixMap = (result: unknown) => {
    if (!(result instanceof Map)) return result;
    return new Map([...result].map(([name, value]) => [String(name).slice(prefix.length), value]));
  };

  let wrapped = {
    async get(names: string | string[], ...args: GetArgs) {
      return unprefixMap(await inner.get.call(kv, keys(names), ...args));
    },
    async getWithMetadata(names: string | string[], ...args: GetArgs) {
      return unprefixMap(await inner.getWithMetadata.call(kv, keys(names), ...args));
    },
    put(name: string, value: unknown, options?: unknown) {
      return inner.put.call(kv, key(name), value, options);
    },
    delete(name: string) {
      return inner.delete.call(kv, key(name));
    },
    async list(options: KVNamespaceListOptions = {}) {
      let result = await kv.list({ ...options, prefix: prefix + (options.prefix ?? "") });
      return {
        ...result,
        keys: result.keys.map((entry) => ({ ...entry, name: entry.name.slice(prefix.length) })),
      };
    },
  };
  return wrapped as unknown as KVNamespace;
}
