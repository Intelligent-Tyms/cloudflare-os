// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  ConnectedAccountsSubscriber,
  ObserverAccountChoice,
  ObserverBindingNeed,
} from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
    },
  )
  const Select = Object.assign(
    ({ children }: { children: ReactNode }) => <div data-testid="account-select">{children}</div>,
    { Option: ({ children }: { children: ReactNode }) => <div>{children}</div> },
  )
  return {
    Dialog,
    Loader: () => <span>Loading</span>,
    Select,
    Text: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('./components/Avatar', () => ({ default: () => <span data-testid="avatar" /> }))

import ObserverConfigModal from './ObserverConfigModal'

const VENDOR = {
  displayName: 'Google',
  color: '#4285f4',
} as VendorDescription

const DOC_RESOURCE: SupportedResource = {
  urlPattern: 'https://docs.google.com/document/d/:docId/*',
  title: 'Google Doc',
  description: 'Read and edit documents you choose.',
  grantable: true,
}

const GMAIL_RESOURCE_PATTERN = 'https://mail.google.com/*'

const NEED: ObserverBindingNeed = {
  gatekeeperId: 12,
  vendorId: 'google',
  resourceTitle: 'Q3 planning',
  resourceUrl: 'https://docs.google.com/document/d/quarterly',
}

function account(id: number, uniqueName: string, grantedResourceUrlPatterns?: string[]) {
  return {
    id,
    description: {
      displayName: uniqueName,
      uniqueName,
      grantedResourceUrlPatterns,
    } as AccountDescription,
  }
}

type ApiOverrides = {
  subscribeConnectedAccounts?: Mock<(
    subscriber: ConnectedAccountsSubscriber,
  ) => Promise<{ [Symbol.dispose](): void }>>
  connectAccount?: Mock<(vendorId: string, resourceUrlPatterns?: string[]) => Promise<{ url: string }>>
  ensureAccountResources?: Mock<(
    accountId: number,
    resourceUrlPatterns: string[],
  ) => Promise<{ url?: string }>>
  reconnectAccount?: Mock<(accountId: number) => Promise<{ url: string }>>
}

function fakeApi(
  accountEntries: ReturnType<typeof account>[],
  overrides: ApiOverrides = {},
): RpcStub<AuthenticatedApi> {
  return {
    subscribeConnectedAccounts: overrides.subscribeConnectedAccounts ?? ((subscriber: ConnectedAccountsSubscriber) => {
      for (const entry of accountEntries) {
        subscriber.add(entry.id, entry.description, VENDOR, [DOC_RESOURCE], true, 'google')
      }
      subscriber.ready()
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
        [Symbol.dispose]() {},
      })
    }),
    listGatekeeperVendors: async () => [{
      id: 'google',
      description: VENDOR,
      supportedResources: [DOC_RESOURCE],
    }],
    listAddableGatekeepers: async () => [],
    connectAccount: overrides.connectAccount ??
      vi.fn<(vendorId: string, resourceUrlPatterns?: string[]) => Promise<{ url: string }>>(),
    ensureAccountResources: overrides.ensureAccountResources ??
      vi.fn<(accountId: number, resourceUrlPatterns: string[]) => Promise<{ url?: string }>>(),
    reconnectAccount: overrides.reconnectAccount ??
      vi.fn<(accountId: number) => Promise<{ url: string }>>(),
  } as unknown as RpcStub<AuthenticatedApi>
}

describe('ObserverConfigModal account selection', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    root = undefined
    container = undefined
  })

  async function render(
    accountEntries: ReturnType<typeof account>[],
    options: {
      api?: RpcStub<AuthenticatedApi>
      onConfirm?: (choices: ObserverAccountChoice[]) => void
    } = {},
  ) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ObserverConfigModal
          needs={[NEED]}
          authenticatedApi={options.api ?? fakeApi(accountEntries)}
          onConfirm={options.onConfirm ?? (() => {})}
          onCancel={() => {}}
        />,
      )
      await Promise.resolve()
    })
    return container
  }

  it('shows a single matching account directly instead of putting it in a dropdown', async () => {
    const rendered = await render([account(1, 'dan@cloudflare.com')])

    expect(rendered.textContent).toContain('dan@cloudflare.com')
    expect(rendered.querySelector('[data-testid="account-select"]')).toBeNull()
  })

  it('disposes a pending account subscription on unmount', async () => {
    const dispose = vi.fn<() => void>()
    const pendingSubscription = Object.assign(new Promise<{ [Symbol.dispose](): void }>(() => {}), {
      [Symbol.dispose]: dispose,
    })
    const subscribeConnectedAccounts = vi.fn<
      (subscriber: ConnectedAccountsSubscriber) => Promise<{ [Symbol.dispose](): void }>
    >().mockReturnValue(pendingSubscription)
    await render([], { api: fakeApi([], { subscribeConnectedAccounts }) })

    act(() => root!.unmount())
    root = undefined

    expect(dispose).toHaveBeenCalledOnce()
  })

  it('keeps the account dropdown when multiple accounts match', async () => {
    const rendered = await render([
      account(1, 'dan@cloudflare.com'),
      account(2, 'dan.personal@gmail.com'),
    ])

    expect(rendered.querySelectorAll('[data-testid="account-select"]')).toHaveLength(1)
  })

  it('requests the resource scope when connecting a new account', async () => {
    const connectAccount = vi.fn<
      (vendorId: string, resourceUrlPatterns?: string[]) => Promise<{ url: string }>
    >().mockResolvedValue({ url: 'https://accounts.google.test/oauth' })
    vi.spyOn(window, 'open').mockImplementation(() => null)
    const rendered = await render([], {
      api: fakeApi([], { connectAccount }),
    })

    const connect = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Connect')
    expect(connect).toBeDefined()
    await act(async () => connect!.click())

    expect(connectAccount).toHaveBeenCalledWith('google', [DOC_RESOURCE.urlPattern])
    expect(window.open).toHaveBeenCalledWith(
      'https://accounts.google.test/oauth', '_blank', 'noopener,noreferrer',
    )
  })

  it('expands an existing account grant before allowing verification', async () => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<{ url?: string }>
    >()
      .mockResolvedValue({ url: 'https://accounts.google.test/oauth' })
    vi.spyOn(window, 'open').mockImplementation(() => null)
    const underScoped = account(1, 'dan@cloudflare.com', [GMAIL_RESOURCE_PATTERN])
    const rendered = await render([underScoped], {
      api: fakeApi([underScoped], { ensureAccountResources }),
    })

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    const grant = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Grant the access needed to verify this resource')
    expect(verify?.disabled).toBe(true)
    expect(grant).toBeDefined()
    expect(rendered.textContent).not.toContain('Ready')

    await act(async () => grant!.click())

    expect(ensureAccountResources).toHaveBeenCalledWith(1, [DOC_RESOURCE.urlPattern])
    expect(window.open).toHaveBeenCalledWith(
      'https://accounts.google.test/oauth', '_blank', 'noopener,noreferrer',
    )
    expect(rendered.textContent).not.toContain('Ready')
    expect(verify?.disabled).toBe(true)
  })

  it('checks the resource grant when legacy account metadata omits it', async () => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<{ url?: string }>
    >().mockResolvedValue({ url: 'https://accounts.google.test/oauth' })
    vi.spyOn(window, 'open').mockImplementation(() => null)
    const legacy = account(1, 'dan@cloudflare.com')
    const rendered = await render([legacy], {
      api: fakeApi([legacy], { ensureAccountResources }),
    })

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    const grant = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Grant the access needed to verify this resource')
    expect(verify?.disabled).toBe(true)
    expect(grant).toBeDefined()

    await act(async () => grant!.click())

    expect(ensureAccountResources).toHaveBeenCalledWith(1, [DOC_RESOURCE.urlPattern])
    expect(window.open).toHaveBeenCalledWith(
      'https://accounts.google.test/oauth', '_blank', 'noopener,noreferrer',
    )
  })

  it('allows verification when the gatekeeper confirms an unknown grant needs no OAuth', async () => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<{ url?: string }>
    >().mockResolvedValue({})
    const legacy = account(1, 'dan@cloudflare.com')
    const rendered = await render([legacy], {
      api: fakeApi([legacy], { ensureAccountResources }),
    })

    const grant = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Grant the access needed to verify this resource')
    await act(async () => grant!.click())

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    expect(ensureAccountResources).toHaveBeenCalledWith(1, [DOC_RESOURCE.urlPattern])
    expect(rendered.textContent).toContain('Ready')
    expect(verify?.disabled).toBe(false)
  })

  it('allows verification when the account already has the required grant', async () => {
    const onConfirm = vi.fn<(choices: ObserverAccountChoice[]) => void>()
    const granted = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern])
    const rendered = await render([granted], { onConfirm })

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    expect(verify?.disabled).toBe(false)
    expect(rendered.textContent).toContain('Ready')

    await act(async () => verify!.click())
    expect(onConfirm).toHaveBeenCalledWith([{ gatekeeperId: 12, accountId: 1 }])
  })
  // An account the deployment provides (a company connector's, a built-in's): the subscriber's
  // trailing `provided` flag is set.
  function providedApi(entry: ReturnType<typeof account>, provided: boolean) {
    const subscribeConnectedAccounts = vi.fn<
      (subscriber: ConnectedAccountsSubscriber) => Promise<{ [Symbol.dispose](): void }>
    >().mockImplementation((subscriber) => {
      subscriber.add(entry.id, entry.description, VENDOR, [DOC_RESOURCE], true, 'google', provided)
      subscriber.ready()
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
    })
    return fakeApi([], { subscribeConnectedAccounts })
  }

  it('opens without asking when every binding runs on an account the company provides', async () => {
    const onConfirm = vi.fn<(choices: ObserverAccountChoice[]) => void>()
    const company = account(4, 'Set up by your administrator', [DOC_RESOURCE.urlPattern])
    await render([], { api: providedApi(company, true), onConfirm })
    await act(async () => { await Promise.resolve() })

    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onConfirm).toHaveBeenCalledWith([{ gatekeeperId: NEED.gatekeeperId, accountId: 4 }])
  })

  it('still asks before verifying against a person\'s own account', async () => {
    const onConfirm = vi.fn<(choices: ObserverAccountChoice[]) => void>()
    const own = account(4, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern])
    const rendered = await render([], { api: providedApi(own, false), onConfirm })
    await act(async () => { await Promise.resolve() })

    expect(onConfirm).not.toHaveBeenCalled()
    expect(rendered.textContent).toContain('Verify and open')
  })

  it('says who can help when the connector is not offered to this person', async () => {
    const api = { ...fakeApi([]), listGatekeeperVendors: async () => [] } as unknown as RpcStub<AuthenticatedApi>
    const rendered = await render([], { api })
    await act(async () => { await Promise.resolve() })

    expect([...rendered.querySelectorAll('button')].some(b => b.textContent === 'Connect')).toBe(false)
    expect(rendered.textContent).toContain('Ask an administrator to add it')
  })
  // One transport fronting several services, each a connector of its own: the company's account
  // reaches one, and each person signs in to the other.
  describe('a vendor whose services are connectors of their own', () => {
    const COMPANY_SERVER: SupportedResource = {
      urlPattern: 'https://ledger.example.com/mcp',
      title: 'Ledger',
      description: '',
      connector: { id: 'custom-ledger', displayName: 'Ledger', credentialScope: 'organization' },
    }
    const PERSONAL_SERVER: SupportedResource = {
      urlPattern: 'https://mcp.bank.example/mcp',
      title: 'Bank',
      description: '',
      grantable: true,
      connector: { id: 'bank', displayName: 'Bank', credentialScope: 'personal' },
    }
    const MCP_VENDOR = { displayName: 'Custom MCP server', autoProvisionsAccount: true } as VendorDescription
    const BANK_NEED: ObserverBindingNeed = {
      gatekeeperId: 8,
      vendorId: 'mcp',
      resourceTitle: 'Bank',
      resourceUrl: 'https://mcp.bank.example/mcp#tools=list_accounts',
    }

    function transportApi(overrides: {
      connectAccount: Mock<(vendorId: string, resourceUrlPatterns?: string[]) => Promise<{ url: string }>>
      provisionAmbientAccount: Mock<(vendorId: string) => Promise<void>>
    }) {
      return {
        subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
          // The account the company provides: it reaches the company's server only.
          subscriber.add(
            3, { displayName: 'Company MCP servers' } as AccountDescription, MCP_VENDOR,
            [COMPANY_SERVER], true, 'mcp', true)
          subscriber.ready()
          return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
        },
        listGatekeeperVendors: async () => [{
          id: 'mcp', description: MCP_VENDOR, supportedResources: [COMPANY_SERVER, PERSONAL_SERVER],
        }],
        listAddableGatekeepers: async () => [],
        ...overrides,
      } as unknown as RpcStub<AuthenticatedApi>
    }

    async function renderNeed(api: RpcStub<AuthenticatedApi>, onConfirm: (choices: ObserverAccountChoice[]) => void) {
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      await act(async () => {
        root!.render(
          <ObserverConfigModal needs={[BANK_NEED]} authenticatedApi={api} onConfirm={onConfirm} onCancel={() => {}} />,
        )
        await Promise.resolve()
      })
      await act(async () => { await Promise.resolve() })
      return container
    }

    it('does not offer the company account for a service each person signs in to', async () => {
      // A stand-in with the one behaviour these exact endpoints need from URLPattern: a pattern
      // that names no query or fragment matches any.
      vi.stubGlobal('URLPattern', class {
        #pattern: string
        constructor(pattern: string) { this.#pattern = pattern }
        test(url: string) { return url.split(/[?#]/)[0] === this.#pattern }
      })
      const connectAccount = vi.fn<
        (vendorId: string, resourceUrlPatterns?: string[]) => Promise<{ url: string }>
      >().mockResolvedValue({ url: 'https://connectors.test/popup' })
      const provisionAmbientAccount = vi.fn<(vendorId: string) => Promise<void>>()
      const onConfirm = vi.fn<(choices: ObserverAccountChoice[]) => void>()
      vi.spyOn(window, 'open').mockImplementation(() => null)
      try {
        const rendered = await renderNeed(transportApi({ connectAccount, provisionAmbientAccount }), onConfirm)

        // Not confirmed on the person's behalf, and not shown as the account in use.
        expect(onConfirm).not.toHaveBeenCalled()
        expect(rendered.textContent).not.toContain('Company MCP servers')

        const connect = [...rendered.querySelectorAll('button')].find(b => b.textContent === 'Connect')
        expect(connect).toBeDefined()
        await act(async () => connect!.click())

        // A sign-in to that one service, not the vendor's provided account.
        expect(connectAccount).toHaveBeenCalledWith('mcp', [PERSONAL_SERVER.urlPattern])
        expect(provisionAmbientAccount).not.toHaveBeenCalled()
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })
})
