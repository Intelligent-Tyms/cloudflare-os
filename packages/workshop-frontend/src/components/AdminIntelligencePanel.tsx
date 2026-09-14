import { useEffect, useRef, useState } from 'react'
import { RpcStub } from 'capnweb'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { ExternalLink } from 'lucide-react'
import {
  AdminApi,
  IntelligenceOverview,
  IntelligenceProductKind,
  IntelligenceProductOverview,
  INTELLIGENCE_PRODUCT_NAMES,
} from '@gadgets/workshop-shared/api'
import { credits } from './billing/billingFormat'

// Admin → <product> intelligence: the page where an admin manages one Tyms Intelligence
// product. Every plan may use the products, so there is no gate: the first visit sets the
// product up (the control plane creates it on its cell and hands the assistant key back once,
// which this panel's backend stores in the product's connector), and from then on the page
// opens the product's own console signed in, with shortcuts into its management screens. A
// null overview means the deployment has no central directory (self-hosted), so there is
// nothing to set up.

type Shortcut = { label: string; blurb: string; next: string }

type ProductCopy = {
  kind: IntelligenceProductKind
  title: string
  blurb: string
  /** The console's name on the primary button ("Open wiki"). */
  openLabel: string
  /** Where the primary button lands, as a path on the product host. */
  home: string
  /** The management screens inside the console, each a signed-in deep link. */
  shortcuts: Shortcut[]
  /** What the product's URL is called in the details grid. */
  urlLabel: string
  /** What turning it off does to it, for the confirm prompt. */
  offNote: string
  /** A product-specific line in the details grid, if any. */
  note?: { label: string; text: string }
}

const PRODUCTS: Record<IntelligenceProductKind, ProductCopy> = {
  organization: {
    kind: 'organization',
    title: 'Organization',
    blurb: 'Your organization’s reviewed knowledge, synthesized from its own documents into a wiki the assistant answers from and cites.',
    openLabel: 'Open wiki',
    home: '/company',
    shortcuts: [
      { label: 'Upload documents', blurb: 'Add sources; the wiki drafts pages from them.', next: '/company/manage/documents' },
      { label: 'Review queue', blurb: 'Drafts waiting for a person to verify or reject.', next: '/company/manage/documents?stage=needs-you' },
      { label: 'Pages', blurb: 'Everything published, and what is verified or stale.', next: '/company/manage/pages' },
      { label: 'Members', blurb: 'Who can read, contribute to, and approve the wiki.', next: '/company/manage/members' },
      { label: 'Policies', blurb: 'How synthesis runs and what it may publish.', next: '/company/manage/policies' },
    ],
    urlLabel: 'Wiki',
    offNote: 'The wiki is suspended now and purged after 30 days; the assistant disconnects immediately.',
    note: { label: 'Precedence', text: 'Verified wiki pages are injected into every new chat. Changes reach new chats only.' },
  },
  data: {
    kind: 'data',
    title: 'Data',
    blurb: 'Your own databases and warehouses, connected read-only. Analysts work in the data workbench; the assistant answers from the same connections and cites every query it ran.',
    openLabel: 'Open workbench',
    home: '/workbench',
    shortcuts: [
      { label: 'Connections', blurb: 'Add a database, check health, set limits and members.', next: '/connections' },
      { label: 'Workbench', blurb: 'Query connected data, chart it, save what is useful.', next: '/workbench' },
      { label: 'Context', blurb: 'Notes and glossary that guide the assistant’s queries.', next: '/context' },
      { label: 'Reports', blurb: 'Live reports built from saved queries.', next: '/reports' },
      { label: 'API keys', blurb: 'Keys for tools that read the workbench directly.', next: '/keys' },
    ],
    urlLabel: 'Workbench',
    offNote: 'Every database connection is disconnected and the workbench is suspended now and purged after 30 days; the assistant disconnects immediately.',
    note: { label: 'Access', text: 'Read-only, enforced at the database role, on every statement and by row and time limits. Data stays at its source.' },
  },
}

export default function AdminIntelligencePanel({ admin, kind }: { admin: RpcStub<AdminApi>; kind: IntelligenceProductKind }) {
  const toasts = useKumoToastManager()
  const copy = PRODUCTS[kind]
  const name = INTELLIGENCE_PRODUCT_NAMES[kind]
  const [overview, setOverview] = useState<IntelligenceOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
  // First-visit setup runs once per page load; a failure shows on the page with a retry.
  const autoSetup = useRef(false)

  useEffect(() => {
    let cancelled = false
    admin.getIntelligenceOverview()
      .then((view) => { if (!cancelled) setOverview(view) })
      .catch(() => { if (!cancelled) setOverview(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [admin])

  const run = async (op: () => Promise<IntelligenceOverview>, successTitle?: string): Promise<boolean> => {
    setBusy(true)
    try {
      setOverview(await op())
      if (successTitle) toasts.add({ title: successTitle, variant: 'success' })
      return true
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Something went wrong', variant: 'error' })
      return false
    } finally {
      setBusy(false)
    }
  }

  const setUp = async () => {
    setSetupError(null)
    setBusy(true)
    try {
      setOverview(await admin.provisionIntelligence(kind))
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const product = overview?.[kind]
  useEffect(() => {
    if (!product || product.instance !== null || autoSetup.current) return
    autoSetup.current = true
    void setUp()
    // setUp is stable for the page's lifetime; the effect keys on the first overview only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product])

  // Opens the product's console in a new tab. The tab is opened on the click itself (so the
  // browser allows it) and pointed at the signed-in URL once the backend has minted it.
  const open = (next?: string) => {
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    admin.openIntelligence(kind, next)
      .then(({ url }) => {
        if (tab) tab.location.href = url
        else window.location.assign(url)
      })
      .catch((err: unknown) => {
        tab?.close()
        toasts.add({ title: err instanceof Error ? err.message : `${name} could not be opened`, variant: 'error' })
      })
  }

  const turnOff = async () => {
    if (!confirm(`Turn off ${name}? ${copy.offNote}`)) return
    await run(() => admin.deprovisionIntelligence(kind), `${name} turned off`)
  }

  const reconnect = () =>
    run(() => admin.reconnectIntelligence(kind), 'Assistant reconnected with a new key')

  if (loading) {
    return <p className="text-sm text-kumo-subtle">Loading {copy.title.toLowerCase()} intelligence…</p>
  }

  if (!overview || !product) {
    return (
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <p className="text-sm text-kumo-subtle">
          This deployment has no central directory configured, so Tyms Intelligence products
          are not available here.
        </p>
      </div>
    )
  }

  const instance = product.instance
  const status = productStatus(product)

  // Not active yet: setting up, or a state that needs a decision before management begins.
  if (instance?.status !== 'active') {
    return (
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-kumo-strong">{copy.title}</h2>
          {statusChip(busy && !instance ? { label: 'Setting up', tone: 'attention' } : status)}
        </div>
        {!instance && busy && (
          <p className="text-sm text-kumo-subtle">
            Setting up {name} for this workspace. This takes a few seconds; the assistant is
            connected automatically.
          </p>
        )}
        {!instance && !busy && setupError && (
          <>
            <p className="text-sm text-kumo-danger">{name} could not be set up: {setupError}</p>
            <Button variant="primary" size="sm" onClick={setUp}>Try again</Button>
          </>
        )}
        {instance?.status === 'provisioning' && (
          <>
            <p className="text-sm text-kumo-subtle">{name} is still being set up. Check back in a moment.</p>
            <Button variant="secondary" size="sm" onClick={() => run(() => admin.getIntelligenceOverview().then((v) => v ?? overview))} loading={busy} disabled={busy}>
              Refresh
            </Button>
          </>
        )}
        {instance?.status === 'failed' && (
          <>
            <p className="text-sm text-kumo-danger">
              Setup failed{instance.lastError ? `: ${instance.lastError}` : ''}.
            </p>
            <Button variant="primary" size="sm" onClick={setUp} loading={busy} disabled={busy}>Try again</Button>
          </>
        )}
        {instance?.status === 'suspended' && (
          <>
            <p className="text-sm text-kumo-subtle">
              {name} is turned off. Its data is kept for 30 days from when it was turned off; turning it on
              again within that window restores everything.
            </p>
            <Button variant="primary" size="sm" onClick={() => run(() => admin.provisionIntelligence(kind), `${name} is back on`)} loading={busy} disabled={busy}>
              Turn on
            </Button>
          </>
        )}
        {instance?.status === 'decommissioned' && (
          <p className="text-sm text-kumo-subtle">
            This workspace’s {name} instance was purged after its retention window. Contact Tyms support to set up a new one.
          </p>
        )}
        {!instance && !busy && !setupError && (
          <Button variant="primary" size="sm" onClick={setUp}>Set up {name}</Button>
        )}
      </div>
    )
  }

  const used = Math.max(0, overview.credits.monthlyGrantMicroUsd + overview.credits.topupMicroUsd
      - overview.credits.balanceMicroUsd)

  return (
    <div className="space-y-6">
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6 space-y-5">
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-kumo-strong">{copy.title}</h2>
              {statusChip(status)}
            </div>
            <p className="text-sm text-kumo-subtle mt-0.5">{copy.blurb}</p>
          </div>
          <div className="shrink-0">
            <Button variant="primary" size="sm" onClick={() => open(copy.home)}>
              {copy.openLabel}
              <ExternalLink size={14} className="ml-1.5" />
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {copy.shortcuts.map((shortcut) => (
            <button
              key={shortcut.next}
              type="button"
              onClick={() => open(shortcut.next)}
              className="group flex items-start justify-between gap-3 rounded-lg border border-kumo-line bg-kumo-base p-4 text-left transition-colors hover:bg-kumo-tint"
            >
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-kumo-strong">{shortcut.label}</span>
                <span className="mt-0.5 block text-xs leading-4 text-kumo-subtle">{shortcut.blurb}</span>
              </span>
              <ExternalLink size={14} className="mt-0.5 shrink-0 text-kumo-subtle transition-colors group-hover:text-kumo-default" />
            </button>
          ))}
        </div>
      </div>

      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <dl className="grid gap-3 sm:grid-cols-2 text-sm">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">{copy.urlLabel}</dt>
            <dd className="mt-1">
              {product.url ? (
                <button
                  type="button"
                  onClick={() => open(copy.home)}
                  className="inline-flex items-center gap-1 text-kumo-brand hover:underline"
                >
                  {hostOf(product.url)}
                  <ExternalLink size={12} />
                </button>
              ) : (
                <span className="text-kumo-subtle">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">Assistant connection</dt>
            <dd className="mt-1 flex items-center gap-2">
              {product.connector === 'connected' && <span className="text-kumo-default">Connected</span>}
              {product.connector === 'missing-key' && (
                <>
                  <span className="text-amber-600">Key missing</span>
                  <Button variant="secondary" size="xs" onClick={reconnect} disabled={busy}>
                    Reconnect assistant
                  </Button>
                </>
              )}
              {product.connector === 'off' && <span className="text-kumo-subtle">Not connected</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">Intelligence credits</dt>
            <dd className="mt-1 text-kumo-default">
              {credits(used)} used of {credits(overview.credits.monthlyGrantMicroUsd)} this period
              {overview.credits.topupMicroUsd > 0 && (
                <span className="text-kumo-subtle"> (+{credits(overview.credits.topupMicroUsd)} top-up)</span>
              )}
              <span className="text-kumo-subtle">. One pool, shared by every Intelligence product.</span>
            </dd>
          </div>
          {copy.note && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">{copy.note.label}</dt>
              <dd className="mt-1 text-kumo-subtle">{copy.note.text}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <div className="flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-kumo-strong">Turn off {copy.title.toLowerCase()} intelligence</h3>
            <p className="text-xs text-kumo-subtle mt-0.5">{copy.offNote}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={turnOff} disabled={busy}>
            Turn off
          </Button>
        </div>
      </div>
    </div>
  )
}

function productStatus(product: IntelligenceProductOverview): { label: string; tone: 'on' | 'off' | 'attention' } {
  const status = product.instance?.status
  if (status === 'active') {
    return product.connector === 'connected'
      ? { label: 'On', tone: 'on' }
      : { label: 'On, assistant not connected', tone: 'attention' }
  }
  if (status === 'provisioning') return { label: 'Setting up', tone: 'attention' }
  if (status === 'suspended') return { label: 'Off', tone: 'off' }
  if (status === 'failed') return { label: 'Setup failed', tone: 'attention' }
  if (status === 'decommissioned') return { label: 'Purged', tone: 'off' }
  return { label: 'Not set up', tone: 'off' }
}

function statusChip(status: { label: string; tone: 'on' | 'off' | 'attention' }) {
  if (status.tone === 'attention') {
    return (
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-600">
        {status.label}
      </span>
    )
  }
  if (status.tone === 'off') {
    return (
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-kumo-tint text-kumo-subtle border border-kumo-line">
        {status.label}
      </span>
    )
  }
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-600">
      {status.label}
    </span>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// The products without a cell yet. Their admin pages exist so the hub reads as the full set,
// but there is nothing to set up.
const COMING_SOON_COPY: Record<'market' | 'process', string> = {
  market: 'Competitive insight and industry trends: the outward-looking counterpart to Organization Intelligence.',
  process: 'Process metrics, workflows, and performance, so assistants can answer about how work actually flows.',
}

export function AdminIntelligenceComingSoon({ kind }: { kind: 'market' | 'process' }) {
  return (
    <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-kumo-strong">
              {kind === 'market' ? 'Market' : 'Process'}
            </h2>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-kumo-tint text-kumo-subtle border border-kumo-line">
              Coming later
            </span>
          </div>
          <p className="text-sm text-kumo-subtle mt-0.5">{COMING_SOON_COPY[kind]}</p>
          <p className="text-sm text-kumo-subtle mt-3">
            Not available yet. It will be set up from this page, the same way as Organization
            and Data, and draw on the same Intelligence credit pool.
          </p>
        </div>
      </div>
    </div>
  )
}
