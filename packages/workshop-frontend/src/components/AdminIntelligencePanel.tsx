import { useEffect, useState } from 'react'
import { RpcStub } from 'capnweb'
import { Link } from '@tanstack/react-router'
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

// Admin → Intelligence: the Tyms Intelligence products for this workspace. Each is provisioned
// here and only here — the control plane creates it on its cell and hands the assistant key
// back once, which this panel's backend stores in the product's connector. A null overview
// means the deployment has no central directory (self-hosted), so there is nothing to provision.

type ProductCopy = {
  kind: IntelligenceProductKind
  title: string
  blurb: string
  /** What the product's URL is called in the details grid. */
  urlLabel: string
  /** What a deprovision does to it, for the confirm prompt. */
  deprovisionNote: string
  /** A product-specific line in the details grid, if any. */
  note?: { label: string; text: string }
}

const PRODUCTS: ProductCopy[] = [
  {
    kind: 'organization',
    title: 'Organization',
    blurb: 'Your organization’s reviewed knowledge, synthesized from its own documents into a wiki the assistant answers from and cites.',
    urlLabel: 'Wiki',
    deprovisionNote: 'The wiki is suspended now and purged after 30 days; the assistant disconnects immediately.',
    note: { label: 'Precedence', text: 'Verified wiki pages are injected into every new chat. Changes reach new chats only.' },
  },
  {
    kind: 'data',
    title: 'Data',
    blurb: 'Your own databases and warehouses, connected read-only. Analysts work in the data workbench; the assistant answers from the same connections and cites every query it ran.',
    urlLabel: 'Workbench',
    deprovisionNote: 'Every database connection is disconnected and the workbench is suspended now and purged after 30 days; the assistant disconnects immediately.',
    note: { label: 'Access', text: 'Read-only, enforced at the database role, on every statement and by row and time limits. Data stays at its source.' },
  },
]

export default function AdminIntelligencePanel({ admin }: { admin: RpcStub<AdminApi> }) {
  const toasts = useKumoToastManager()
  const [overview, setOverview] = useState<IntelligenceOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<IntelligenceProductKind | null>(null)

  useEffect(() => {
    let cancelled = false
    admin.getIntelligenceOverview()
      .then((view) => { if (!cancelled) setOverview(view) })
      .catch(() => { if (!cancelled) setOverview(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [admin])

  const run = async (kind: IntelligenceProductKind, op: () => Promise<IntelligenceOverview>, successTitle: string): Promise<boolean> => {
    setBusy(kind)
    try {
      setOverview(await op())
      toasts.add({ title: successTitle, variant: 'success' })
      return true
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Something went wrong', variant: 'error' })
      return false
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return <p className="text-sm text-kumo-subtle">Loading intelligence…</p>
  }

  if (!overview) {
    return (
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <p className="text-sm text-kumo-subtle">
          This deployment has no central directory configured, so Tyms Intelligence products
          cannot be provisioned here.
        </p>
      </div>
    )
  }

  const used = Math.max(0, overview.credits.monthlyGrantMicroUsd + overview.credits.topupMicroUsd
      - overview.credits.balanceMicroUsd)

  return (
    <div className="space-y-6">
      {PRODUCTS.map((copy) => (
        <ProductCard
          key={copy.kind}
          copy={copy}
          product={overview[copy.kind]}
          entitled={overview.entitled}
          busy={busy !== null}
          running={busy === copy.kind}
          onProvision={() => run(copy.kind, () => admin.provisionIntelligence(copy.kind), `${INTELLIGENCE_PRODUCT_NAMES[copy.kind]} is ready`)}
          onDeprovision={async () => {
            if (!confirm(`Deprovision ${INTELLIGENCE_PRODUCT_NAMES[copy.kind]}? ${copy.deprovisionNote}`)) return
            await run(copy.kind, () => admin.deprovisionIntelligence(copy.kind), `${INTELLIGENCE_PRODUCT_NAMES[copy.kind]} suspended`)
          }}
          onReconnect={() => run(copy.kind, () => admin.reconnectIntelligence(copy.kind), 'Assistant reconnected with a new key')}
        />
      ))}

      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <dl className="text-sm">
          <dt className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">Intelligence credits</dt>
          <dd className="mt-1 text-kumo-default">
            {credits(used)} used of {credits(overview.credits.monthlyGrantMicroUsd)} this period
            {overview.credits.topupMicroUsd > 0 && (
              <span className="text-kumo-subtle"> (+{credits(overview.credits.topupMicroUsd)} top-up)</span>
            )}
            <span className="text-kumo-subtle">. One pool, shared by every Intelligence product.</span>
          </dd>
        </dl>
      </div>

      {/* The other intelligences, not yet available. */}
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <div className="space-y-3">
          {['Market', 'Process'].map((name) => (
            <div key={name} className="flex items-center gap-3">
              <p className="flex-1 text-sm font-semibold text-kumo-subtle">{name}</p>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-kumo-tint text-kumo-subtle border border-kumo-line">
                Coming later
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ProductCard({ copy, product, entitled, busy, running, onProvision, onDeprovision, onReconnect }: {
  copy: ProductCopy
  product: IntelligenceProductOverview
  entitled: boolean
  busy: boolean
  running: boolean
  onProvision: () => void
  onDeprovision: () => void
  onReconnect: () => void
}) {
  const status = productStatus(product, entitled)
  const instance = product.instance
  const active = instance?.status === 'active'
  const canProvision = entitled && !active && instance?.status !== 'provisioning'
      && instance?.status !== 'decommissioned'

  return (
    <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6 space-y-5">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-kumo-strong">{copy.title}</h2>
            {statusChip(status)}
          </div>
          <p className="text-sm text-kumo-subtle mt-0.5">{copy.blurb}</p>
          {instance?.status === 'failed' && instance.lastError && (
            <p className="text-sm text-kumo-danger mt-2">Last attempt failed: {instance.lastError}</p>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {!entitled && !active && (
            <Link to="/admin/$section" params={{ section: 'plans' }}>
              <Button variant="primary" size="sm">Upgrade</Button>
            </Link>
          )}
          {canProvision && (
            <Button variant="primary" size="sm" onClick={onProvision} loading={running} disabled={busy}>
              {instance?.status === 'suspended' ? 'Restore' : 'Provision'}
            </Button>
          )}
          {active && (
            <Button variant="secondary" size="sm" onClick={onDeprovision} disabled={busy}>
              Deprovision
            </Button>
          )}
        </div>
      </div>

      {active && (
        <dl className="grid gap-3 sm:grid-cols-2 text-sm">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">{copy.urlLabel}</dt>
            <dd className="mt-1">
              {product.url ? (
                <a
                  href={product.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-kumo-brand hover:underline"
                >
                  {hostOf(product.url)}
                  <ExternalLink size={12} />
                </a>
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
                  <Button variant="secondary" size="xs" onClick={onReconnect} disabled={busy}>
                    Reconnect assistant
                  </Button>
                </>
              )}
              {product.connector === 'off' && <span className="text-kumo-subtle">Not connected</span>}
            </dd>
          </div>
          {copy.note && (
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">{copy.note.label}</dt>
              <dd className="mt-1 text-kumo-subtle">{copy.note.text}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  )
}

function productStatus(product: IntelligenceProductOverview, entitled: boolean): { label: string; tone: 'on' | 'off' | 'attention' } {
  const status = product.instance?.status
  if (status === 'active') {
    return product.connector === 'connected'
      ? { label: 'Active', tone: 'on' }
      : { label: 'Active, assistant not connected', tone: 'attention' }
  }
  if (status === 'provisioning') return { label: 'Provisioning', tone: 'attention' }
  if (status === 'suspended') return { label: 'Suspended', tone: 'attention' }
  if (status === 'failed') return { label: 'Failed', tone: 'attention' }
  if (status === 'decommissioned') return { label: 'Purged', tone: 'off' }
  return entitled ? { label: 'Not provisioned', tone: 'off' } : { label: 'Not in your plan', tone: 'off' }
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
