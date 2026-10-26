import { describe, expect, it } from 'vitest';
import {
  createTenantHandler, READY_PATH, tenantClass, withTenantEnv, type TenantParts,
} from '../src/tenant';

// ctx.exports as the runtime shapes it: an entrypoint export is a function taking { props }.
function stubExports(names: string[], extra: Record<string, unknown> = {}) {
  let made: { entrypoint: string; props: unknown }[] = [];
  let exports: Record<string, unknown> = { ...extra };
  for (let name of names) {
    exports[name] = ({ props }: { props: unknown }) => {
      made.push({ entrypoint: name, props });
      return { entrypoint: name, props };
    };
  }
  return { exports, made };
}

function part(label: string): ExportedHandler<Cloudflare.Env> {
  return {
    fetch: async (req) => new Response(`${label} ${new URL(req.url).pathname}`),
  };
}

function ctxWith(exports: object): ExecutionContext {
  return { exports, waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as
      ExecutionContext;
}

async function route(parts: TenantParts, path: string, env: object = {}, exports: object = {}) {
  let handler = createTenantHandler(parts);
  let res = await handler.fetch!(new Request(`https://acme.jamaa.tyms.ai${path}`),
      env as Cloudflare.Env, ctxWith(exports));
  return { status: res.status, text: await res.text() };
}

describe('withTenantEnv', () => {
  it('fills each intra-tenant binding from the entrypoint this script exports', () => {
    let { exports } = stubExports(
        ['GatekeeperVendor', 'ChannelsAdmin', 'ChannelsDelivery', 'ExternalMessageGateway']);
    let env = withTenantEnv({ CONTEXT_SHARING_DOMAIN: 'tenant-acme' }, exports) as
        Record<string, unknown>;

    expect(env.GATEKEEPER_CONTEXT).toEqual(
        { entrypoint: 'GatekeeperVendor', props: { sharingDomain: 'tenant-acme' } });
    expect(env.CHANNELS).toEqual({ entrypoint: 'ChannelsAdmin', props: {} });
    expect(env.CHANNELS_DELIVERY).toEqual({ entrypoint: 'ChannelsDelivery', props: {} });
    expect(env.WORKSHOP_TELEGRAM).toEqual(
        { entrypoint: 'ExternalMessageGateway', props: { source: 'telegram' } });
    expect(env.WORKSHOP_SLACK).toEqual(
        { entrypoint: 'ExternalMessageGateway', props: { source: 'slack' } });
    expect(env.WORKSHOP_EMAIL).toEqual(
        { entrypoint: 'ExternalMessageGateway', props: { source: 'email' } });
  });

  it('leaves out bindings whose entrypoint this script does not export', () => {
    // A tenant without the channels part: the workshop sees no channels worker, as on a stack
    // deployed without one.
    let { exports } = stubExports(['GatekeeperVendor']);
    let env = withTenantEnv({}, exports) as Record<string, unknown>;
    expect(Object.keys(env)).toEqual(['GATEKEEPER_CONTEXT']);
  });

  it('keeps a binding that is already present', () => {
    let { exports, made } = stubExports(['GatekeeperVendor']);
    let real = { real: true };
    let env = withTenantEnv({ GATEKEEPER_CONTEXT: real }, exports) as Record<string, unknown>;
    expect(env.GATEKEEPER_CONTEXT).toBe(real);
    expect(made).toEqual([]);
  });

  it('falls back to the public origin for the sharing domain, as upstream deploys do', () => {
    let { exports } = stubExports(['GatekeeperVendor']);
    let env = withTenantEnv({ PUBLIC_BASE_URL: 'https://acme.jamaa.tyms.ai' }, exports) as
        Record<string, unknown>;
    expect(env.GATEKEEPER_CONTEXT).toMatchObject(
        { props: { sharingDomain: 'https://acme.jamaa.tyms.ai' } });
  });

  it('does not touch the runtime env object', () => {
    let { exports } = stubExports(['GatekeeperVendor']);
    let original = { A: 1 };
    let env = withTenantEnv(original, exports);
    expect(env).not.toBe(original);
    expect(original).toEqual({ A: 1 });
    expect(withTenantEnv(original, {})).toBe(original);
  });
});

describe('tenantClass', () => {
  class Part {
    constructor(readonly ctx: { exports: object }, readonly env: Record<string, unknown>,
        readonly extra?: string) {}
    hello() { return 'hi'; }
  }

  it('constructs the part with the tenant env and keeps its name and methods', () => {
    let Tenant = tenantClass(Part);
    let { exports } = stubExports(['ChannelsAdmin']);
    let instance = new Tenant({ exports }, { VAR: 'x' }, 'rest');

    expect(Tenant.name).toBe('Part');
    expect(instance).toBeInstanceOf(Part);
    expect(instance.hello()).toBe('hi');
    expect(instance.extra).toBe('rest');
    expect(instance.env.VAR).toBe('x');
    expect(instance.env.CHANNELS).toEqual({ entrypoint: 'ChannelsAdmin', props: {} });
  });
});

describe('tenant handler', () => {
  const parts = { workshop: part('workshop'), context: part('context') };

  it('routes the workshop prefixes to the workshop', async () => {
    for (let path of ['/api', '/api/central/admin', '/blueprint-screenshot',
      '/blueprint-screenshot/abc']) {
      expect((await route(parts, path)).text).toBe(`workshop ${path}`);
    }
  });

  it('routes /gatekeeper/context to Context and no other gatekeeper', async () => {
    expect((await route(parts, '/gatekeeper/context/x')).text).toBe('context /gatekeeper/context/x');
    expect((await route(parts, '/gatekeeper/google/oauth')).status).toBe(404);
  });

  it('serves everything else from ASSETS when present, else 404', async () => {
    let assets = { fetch: async () => new Response('assets') } as unknown as Fetcher;
    expect((await route(parts, '/apiary', { ASSETS: assets })).text).toBe('assets');
    expect((await route(parts, '/')).status).toBe(404);
  });

  it('strips /channels before handing a request to the channels part', async () => {
    let withChannels = { ...parts, channels: part('channels') };
    expect((await route(withChannels, '/channels/webhooks/telegram')).text)
        .toBe('channels /webhooks/telegram');
    expect((await route(withChannels, '/channels')).text).toBe('channels /');
    // Without the part the path is just another frontend path.
    expect((await route(parts, '/channels/webhooks/telegram')).status).toBe(404);
  });

  it('gives the parts the tenant env', async () => {
    let seen: Record<string, unknown> | undefined;
    let workshop: ExportedHandler<Cloudflare.Env> = {
      fetch: async (_req, env) => {
        seen = env as unknown as Record<string, unknown>;
        return new Response('ok');
      },
    };
    let { exports } = stubExports(['ChannelsAdmin']);
    await route({ ...parts, workshop }, '/api', {}, exports);
    expect(seen?.CHANNELS).toEqual({ entrypoint: 'ChannelsAdmin', props: {} });
  });

  it('reports ready once AdminSettings answers, with the release', async () => {
    let calls: string[] = [];
    let adminSettings = {
      getByName: (name: string) => ({
        ensureCentralSettingsSync: async () => { calls.push(name); },
      }),
    };
    let res = await route(parts, READY_PATH, { RELEASE_ID: 'abc1234' },
        { AdminSettings: adminSettings });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ ready: true, release: 'abc1234' });
    expect(calls).toEqual(['']);
  });

  it('reports not ready while AdminSettings fails', async () => {
    let adminSettings = {
      getByName: () => ({
        ensureCentralSettingsSync: async () => { throw new Error('starting'); },
      }),
    };
    let res = await route(parts, READY_PATH, {}, { AdminSettings: adminSettings });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.text)).toMatchObject({ ready: false });
  });
});
