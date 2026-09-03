// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GadgetClient, Overseer, UnboundGatekeeperInfo } from '@gadgets/workshop-shared/api'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => ({
  Dialog: Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
    },
  ),
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: ComponentProps<'button'> & { tone?: string }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, danger: _danger, ...props }: ComponentProps<'button'> & { danger?: boolean }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopInput: (props: ComponentProps<'input'>) => <input {...props} />,
}))
vi.mock('./GatekeeperModal', () => ({ default: () => null }))
vi.mock('./components/GatekeeperIcon', () => ({ GatekeeperIcon: () => <span data-testid="icon" /> }))
vi.mock('./components/HookToggle', () => ({ HookToggle: () => null }))
vi.mock('./components/EmptyState', () => ({
  EmptyState: ({ title }: { title: string }) => <div data-testid="empty">{title}</div>,
}))
vi.mock('./components/BlueprintBindingCard', () => ({
  BlueprintBindingCard: () => null,
  loadBindingCardData: async () => null,
}))
vi.mock('./useVendorBranding', () => ({ useVendorBranding: () => new Map() }))
vi.mock('./errorReporting', () => ({ reportIssue: vi.fn<(site: string, caught: unknown) => void>() }))

import Connections from './Connections'

const MCP: UnboundGatekeeperInfo = {
  id: 18,
  resourceTitle: 'mi-api-preview.tyms.ai',
  resourceUrl: 'https://mi-api-preview.tyms.ai/mcp',
  vendorId: 'mcp',
  connectionType: 'gatekeeper',
}

function stubs(unbound: UnboundGatekeeperInfo[]) {
  let current = unbound
  const overseer = {
    listHooks: async () => [],
    listUnboundGatekeepers: vi.fn<() => Promise<UnboundGatekeeperInfo[]>>(async () => current),
    removeUnboundGatekeeper: vi.fn<(id: number) => Promise<void>>(async (id) => {
      current = current.filter(gk => gk.id !== id)
    }),
  }
  const gadget = {
    getId: async () => 1,
    getTitle: async () => 'Deal desk',
    listBindings: async () => [],
  }
  return {
    overseer,
    props: {
      overseer: overseer as unknown as RpcStub<Overseer>,
      gadget: gadget as unknown as RpcStub<GadgetClient>,
      authenticatedApi: {} as RpcStub<AuthenticatedApi>,
    },
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function render(ui: ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(ui) })
  // Let the mount-time load settle.
  await act(async () => { await Promise.resolve() })
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')]
    .find(b => b.getAttribute('aria-label') === label || b.textContent?.trim() === label)
  if (!match) throw new Error(`No button "${label}"`)
  return match
}

describe('Connections: connections not used by any app', () => {
  it('shows nothing extra when every connection is bound', async () => {
    const { props } = stubs([])
    await render(<Connections {...props} />)
    expect(document.body.textContent).not.toContain('Not used by any app')
    expect(document.querySelector('[data-testid="empty"]')).not.toBeNull()
  })

  it('lists unbound connections and removes one after confirmation', async () => {
    const { overseer, props } = stubs([MCP])
    const onConnectionsChange = vi.fn<() => void>()
    await render(<Connections {...props} onConnectionsChange={onConnectionsChange} />)

    expect(document.body.textContent).toContain('Not used by any app')
    expect(document.body.textContent).toContain('mi-api-preview.tyms.ai')

    await act(async () => { button('Remove from workspace').click() })
    expect(document.body.textContent).toContain('Remove mi-api-preview.tyms.ai?')
    expect(overseer.removeUnboundGatekeeper).not.toHaveBeenCalled()

    await act(async () => { button('Remove').click() })
    await act(async () => { await Promise.resolve() })

    expect(overseer.removeUnboundGatekeeper).toHaveBeenCalledWith(18)
    expect(onConnectionsChange).toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Not used by any app')
  })

  it('keeps the row and cancels cleanly', async () => {
    const { overseer, props } = stubs([MCP])
    await render(<Connections {...props} />)

    await act(async () => { button('Remove from workspace').click() })
    await act(async () => { button('Cancel').click() })

    expect(overseer.removeUnboundGatekeeper).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('mi-api-preview.tyms.ai')
  })
})
