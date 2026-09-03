import { useEffect, useState } from 'react'
import { RpcStub } from 'capnweb'
import { Link } from '@tanstack/react-router'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { ExternalLink } from 'lucide-react'
import { AdminApi, IntelligenceOverview } from '@gadgets/workshop-shared/api'
import { credits } from './billing/billingFormat'

// Admin → Intelligence: the Tyms Intelligence products for this workspace. Organization
// Intelligence (the organization's wiki) is provisioned here and only here — the control plane
// creates it on the Intelligence cell and hands the assistant key back once, which this panel's
// backend stores in the intelligence connector. A null overview means the deployment has no
// central directory (self-hosted), so there is nothing to provision.
export default function AdminIntelligencePanel({ admin }: { admin: RpcStub<AdminApi> }) {
  const toasts = useKumoToastManager()
  const [overview, setOverview] = useState<IntelligenceOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    admin.getIntelligenceOverview()
      .then((view) => { if (!cancelled) setOverview(view) })
      .catch(() => { if (!cancelled) setOverview(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [admin])

  const run = async (op: () => Promise<IntelligenceOverview>, successTitle: string): Promise<boolean> => {
    setBusy(true)
    try {
      setOverview(await op())
      toasts.add({ title: successTitle, variant: 'success' })
      return true
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Something went wrong', variant: 'error' })
      return false
    } finally {
      setBusy(false)
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

  const status = organizationStatus(overview)
  const instance = overview.instance
  const active = instance?.status === 'active'
  const canProvision = overview.entitled && !active && instance?.status !== 'provisioning'
      && instance?.status !== 'decommissioned'
  const used = Math.max(0, overview.credits.monthlyGrantMicroUsd + overview.credits.topupMicroUsd
      - overview.credits.balanceMicroUsd)

  const handleProvision = () =>
    run(() => admin.provisionIntelligence(), 'Organization Intelligence is ready')

  const handleDeprovision = async () => {
    if (!confirm('Deprovision Organization Intelligence? The wiki is suspended now and purged after 30 days; the assistant disconnects immediately.')) return
    await run(() => admin.deprovisionIntelligence(), 'Organization Intelligence suspended')
  }

  const handleReconnect = () =>
    run(() => admin.reconnectIntelligence(), 'Assistant reconnected with a new key')

  return (
    <div className="space-y-6">
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6 space-y-5">
        {/* Organization */}
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-kumo-strong">Organization</h2>
              {statusChip(status)}
            </div>
            <p className="text-sm text-kumo-subtle mt-0.5">
              Your organization&rsquo;s reviewed knowledge, synthesized from its own documents into a
              wiki the assistant answers from and cites.
            </p>
            {instance?.status === 'failed' && instance.lastError && (
              <p className="text-sm text-kumo-danger mt-2">Last attempt failed: {instance.lastError}</p>
            )}
          </div>
          <div className="shrink-0 flex items-center gap-2">
            {!overview.entitled && !active && (
              <Link to="/admin/$section" params={{ section: 'plans' }}>
                <Button variant="primary" size="sm">Upgrade</Button>
              </Link>
            )}
            {canProvision && (
              <Button variant="primary" size="sm" onClick={handleProvision} loading={busy} disabled={busy}>
                {instance?.status === 'suspended' ? 'Restore' : 'Provision'}
              </Button>
            )}
            {active && (
              <Button variant="secondary" size="sm" onClick={handleDeprovision} disabled={busy}>
                Deprovision
              </Button>
            )}
          </div>
        </div>

        {active && (
          <dl className="grid gap-3 sm:grid-cols-2 text-sm">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">Wiki</dt>
              <dd className="mt-1">
                {overview.wikiUrl ? (
                  <a
                    href={overview.wikiUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-kumo-brand hover:underline"
                  >
                    {hostOf(overview.wikiUrl)}
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
                {overview.connector === 'connected' && <span className="text-kumo-default">Connected</span>}
                {overview.connector === 'missing-key' && (
                  <>
                    <span className="text-amber-600">Key missing</span>
                    <Button variant="secondary" size="xs" onClick={handleReconnect} disabled={busy}>
                      Reconnect assistant
                    </Button>
                  </>
                )}
                {overview.connector === 'off' && <span className="text-kumo-subtle">Not connected</span>}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">Intelligence credits</dt>
              <dd className="mt-1 text-kumo-default">
                {credits(used)} used of {credits(overview.credits.monthlyGrantMicroUsd)} this period
                {overview.credits.topupMicroUsd > 0 && (
                  <span className="text-kumo-subtle"> (+{credits(overview.credits.topupMicroUsd)} top-up)</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">Precedence</dt>
              <dd className="mt-1 text-kumo-subtle">
                Verified wiki pages are injected into every new chat. Changes reach new chats only.
              </dd>
            </div>
          </dl>
        )}
      </div>

      {/* The other intelligences, not yet available. */}
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <div className="space-y-3">
          {['Market', 'Data', 'Process'].map((name) => (
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

function organizationStatus(overview: IntelligenceOverview): { label: string; tone: 'on' | 'off' | 'attention' } {
  const status = overview.instance?.status
  if (status === 'active') {
    return overview.connector === 'connected'
      ? { label: 'Active', tone: 'on' }
      : { label: 'Active, assistant not connected', tone: 'attention' }
  }
  if (status === 'provisioning') return { label: 'Provisioning', tone: 'attention' }
  if (status === 'suspended') return { label: 'Suspended', tone: 'attention' }
  if (status === 'failed') return { label: 'Failed', tone: 'attention' }
  if (status === 'decommissioned') return { label: 'Purged', tone: 'off' }
  return overview.entitled ? { label: 'Not provisioned', tone: 'off' } : { label: 'Not in your plan', tone: 'off' }
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
