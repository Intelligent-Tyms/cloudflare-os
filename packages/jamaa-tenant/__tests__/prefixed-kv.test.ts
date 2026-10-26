import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { prefixedKv } from '../src/prefixed-kv';
import { withTenantEnv } from '../src/tenant';

const shared = (env as unknown as { SHARED_KV: KVNamespace }).SHARED_KV;

async function storedKeys(): Promise<string[]> {
  return (await shared.list()).keys.map((entry) => entry.name).toSorted();
}

describe('prefixedKv', () => {
  beforeEach(async () => {
    for (let name of await storedKeys()) await shared.delete(name);
  });

  it('stores every key under the prefix and reads it back unprefixed', async () => {
    let acme = prefixedKv(shared, 't/acme/');
    await acme.put('bp-1', 'acme blueprint', { metadata: { v: 1 } });
    await acme.put('nested/key', JSON.stringify({ ok: true }));

    expect(await storedKeys()).toEqual(['t/acme/bp-1', 't/acme/nested/key']);
    expect(await acme.get('bp-1')).toBe('acme blueprint');
    expect(await acme.get('nested/key', 'json')).toEqual({ ok: true });
    let withMeta = await acme.getWithMetadata('bp-1');
    expect(withMeta.metadata).toEqual({ v: 1 });

    await acme.delete('bp-1');
    expect(await acme.get('bp-1')).toBeNull();
  });

  it('keeps tenants apart on the same key', async () => {
    let acme = prefixedKv(shared, 't/acme/');
    let globex = prefixedKv(shared, 't/globex/');
    await acme.put('same', 'acme');
    await globex.put('same', 'globex');

    expect(await acme.get('same')).toBe('acme');
    expect(await globex.get('same')).toBe('globex');
    await globex.delete('same');
    expect(await acme.get('same')).toBe('acme');
  });

  it('lists only the tenant\'s keys, without the prefix', async () => {
    let acme = prefixedKv(shared, 't/acme/');
    await acme.put('a/1', 'x');
    await acme.put('a/2', 'x');
    await acme.put('b/1', 'x');
    await prefixedKv(shared, 't/acmeco/').put('a/1', 'not acme');

    expect((await acme.list()).keys.map((entry) => entry.name)).toEqual(['a/1', 'a/2', 'b/1']);
    expect((await acme.list({ prefix: 'a/' })).keys.map((entry) => entry.name))
        .toEqual(['a/1', 'a/2']);

    let first = await acme.list({ limit: 2 });
    expect(first.list_complete).toBe(false);
    let rest = await acme.list({ limit: 2, cursor: (first as { cursor: string }).cursor });
    expect(rest.keys.map((entry) => entry.name)).toEqual(['b/1']);
  });

  it('maps a bulk get back to the tenant\'s keys', async () => {
    let acme = prefixedKv(shared, 't/acme/');
    await acme.put('one', '1');
    await acme.put('two', '2');
    let values = await acme.get(['one', 'two']);
    expect([...values]).toEqual([['one', '1'], ['two', '2']]);
  });

  it('refuses an empty prefix', () => {
    expect(() => prefixedKv(shared, '')).toThrow(/non-empty/);
  });
});

describe('withTenantEnv shared KV', () => {
  it('narrows the shared namespaces when KV_PREFIX is set, and only then', async () => {
    let base = { BLUEPRINTS: shared, AVATARS: shared, CONTEXT_COLLECTIONS: shared };
    let tenant = withTenantEnv({ ...base, KV_PREFIX: 't/acme/' }, {});
    await tenant.AVATARS.put('user@acme.test', 'png');
    expect(await shared.get('t/acme/user@acme.test')).toBe('png');
    expect(tenant.BLUEPRINTS).not.toBe(shared);
    expect(tenant.CONTEXT_COLLECTIONS).not.toBe(shared);

    let stack = withTenantEnv(base, {});
    expect(stack.AVATARS).toBe(shared);
  });
});
