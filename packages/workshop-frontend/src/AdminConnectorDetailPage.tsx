// Detail page for one connector (/admin/connectors/$vendorId). Two columns: what the connector
// is and how it behaves on the left, the controls on the right in the order an administrator
// meets them — set it up, make it available, curate its resources.
import { useEffect, useState } from 'react'
import { RpcStub } from 'capnweb'
import { Link } from '@tanstack/react-router'
import { Switch, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { useAuthenticatedApi } from './AuthContext'
import { AdminApi, AdminResourceVendor, AmbientGatekeeperMode } from '@gadgets/workshop-shared/api'
import { integrationDepartmentLabel } from '@gadgets/workshop-shared/gatekeeper'
import { useDocumentTitle } from './useDocumentTitle'
import AdminIntegrationSetupModal from './components/AdminIntegrationSetupModal'
import { StatusPill } from './components/AdminConnectorsGallery'
import { scopeMeta, vendorScopeGroup } from './adminConnectorScope'

// How a shared workspace behaves for each credential scope, in the administrator's terms.
const SHARING_NOTE: Record<ReturnType<typeof vendorScopeGroup>, string> = {
  organization:
    'A shared workspace opens for any member of the team. Everyone acts through the company credential.',
  personal:
    'Each recipient of a shared workspace connects their own account, and the connector checks that it can reach what the workspace read.',
  builtin: 'A shared workspace opens for any member of the team.',
}

function Panel({ step, title, hint, aside, children }: {
  step?: number
  title: string
  hint?: string
  aside?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
      <div className="flex items-start gap-4">
        {step !== undefined && (
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-kumo-tint text-[12px] font-semibold tabular-nums text-kumo-subtle">
            {step}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] leading-5 font-semibold tracking-[-0.25px] text-kumo-strong">{title}</h2>
          {hint && <p className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">{hint}</p>}
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </section>
  )
}

export default function AdminConnectorDetailPage({ vendorId }: { vendorId: string }) {
  const { authenticatedApi, isAdmin } = useAuthenticatedApi()
  const toasts = useKumoToastManager()

  // The admin capability (minted once, like AdminPage). Wrapped in an object so useState doesn't
  // treat the (callable) RPC stub as a state updater function.
  const [admin, setAdmin] = useState<{ api: RpcStub<AdminApi> } | null>(null)
  const [vendor, setVendor] = useState<AdminResourceVendor | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  // Controls busy toggling: 'gk' for the vendor-level control, or a resource urlPattern.
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [setupOpen, setSetupOpen] = useState(false)

  useDocumentTitle(`${vendor?.displayName ?? vendorId} · Connectors · Admin`)

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    let cancelled = false
    let stub: RpcStub<AdminApi> | null = null
    ;(async () => {
      try {
        const api = await authenticatedApi.getAdminApi()
        if (cancelled) {
          api?.[Symbol.dispose]?.()
          return
        }
        if (!api) {
          setLoadError(true)
          return
        }
        stub = api
        setAdmin({ api })
        const view = await api.getSettings()
        if (!cancelled) setVendor(view.resourceVendors.find((v) => v.vendorId === vendorId) ?? null)
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load connector:', err)
          setLoadError(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      stub?.[Symbol.dispose]?.()
    }
  }, [isAdmin, authenticatedApi, vendorId])

  // Re-fetch this vendor's state (used to revert an optimistic toggle on error, and after setup
  // changes — applying setup can change the advertised resources).
  const reload = async () => {
    if (!admin) return
    const view = await admin.api.getSettings()
    setVendor(view.resourceVendors.find((v) => v.vendorId === vendorId) ?? null)
  }

  const withBusy = async (key: string, run: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(key))
    try {
      await run()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed'
      toasts.add({ title: message, variant: 'error' })
      await reload().catch(() => {})
    } finally {
      setBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const handleEnabledToggle = (enabled: boolean) => {
    if (!admin || !vendor || vendor.autoProvisions) return
    setVendor({ ...vendor, enabled })
    void withBusy('gk', () => admin.api.setGatekeeperMode(vendorId, enabled ? 'enabled' : 'disabled'))
  }

  const handleMode = (mode: AmbientGatekeeperMode) => {
    if (!admin || !vendor || !vendor.autoProvisions) return
    setVendor({ ...vendor, ambientMode: mode })
    void withBusy('gk', () => admin.api.setGatekeeperMode(vendorId, mode))
  }

  const handleResourceToggle = (urlPattern: string, enabled: boolean) => {
    if (!admin || !vendor || vendor.autoProvisions) return
    setVendor({
      ...vendor,
      resources: vendor.resources.map((r) => (r.urlPattern === urlPattern ? { ...r, enabled } : r)),
    })
    void withBusy(urlPattern, () => admin.api.setResourceEnabled(vendorId, urlPattern, enabled))
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh]">
        <p className="text-kumo-subtle">Loading connector...</p>
      </div>
    )
  }

  if (loadError || !isAdmin) {
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-16 text-center">
        <p className="text-sm text-kumo-danger">Something went wrong loading this connector.</p>
        <button onClick={() => window.location.reload()} className="text-kumo-brand mt-2 text-sm underline">
          Try again
        </button>
      </div>
    )
  }

  if (!vendor) {
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-16 text-center">
        <p className="text-sm text-kumo-subtle">This connector isn't installed on this deployment.</p>
        <Link
          to="/admin/$section"
          params={{ section: 'connectors' }}
          className="text-kumo-brand mt-2 inline-block text-sm underline"
        >
          Back to Connectors
        </Link>
      </div>
    )
  }

  const gkBusy = busy.has('gk')
  const scope = vendorScopeGroup(vendor)
  const meta = scopeMeta(vendor)
  const needsSetup = vendor.setup?.status === 'unconfigured'
  // An organization credential is what turns the connector on: until an administrator enters
  // it, enabling would offer the team something nobody can use.
  const enableBlockedBySetup = scope === 'organization' && needsSetup

  let step = 0
  const nextStep = () => ++step

  // Runtime admin setup: the organization's credential (a B2B login, a company API key) or the
  // OAuth app people sign in through. Shown for every vendor that accepts setup, ambient or not.
  const setupPanel = vendor.setup && (
    <Panel
      step={nextStep()}
      title={scope === 'organization' ? 'Company credential' : 'Setup'}
      hint={
        scope === 'organization'
          ? needsSetup
            ? 'Entered once by an administrator. Until then, no one on the team can use this connector.'
            : 'Entered once by an administrator. Everyone on the team uses it without signing in.'
          : needsSetup
            ? 'Not set up yet. Hidden from your team until an administrator completes setup.'
            : 'Set up and ready for your team to connect.'
      }
      aside={
        <button
          type="button"
          onClick={() => setSetupOpen(true)}
          className={`text-sm font-medium px-3 py-1.5 rounded-lg border transition-colors ${
            needsSetup
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20'
              : 'border-kumo-line text-kumo-subtle hover:bg-kumo-tint'
          }`}
        >
          {needsSetup ? 'Set up' : 'Manage setup'}
        </button>
      }
    />
  )

  const availabilityPanel = vendor.autoProvisions ? (
    <Panel
      step={nextStep()}
      title="Availability"
      hint={
        scope === 'organization'
          ? 'Runs on the company credential: no one signs in.'
          : 'Provided automatically. No account connection is needed.'
      }
    >
      <div className="flex gap-2">
        {(
          [
            { value: 'disabled', label: 'Off', hint: 'Off for everyone' },
            { value: 'optional', label: 'Optional', hint: 'People add it themselves' },
            { value: 'enabled', label: 'On for everyone', hint: 'Added automatically' },
          ] as { value: AmbientGatekeeperMode; label: string; hint: string }[]
        ).map((opt) => (
          <button
            key={opt.value}
            type="button"
            disabled={gkBusy}
            onClick={() => handleMode(opt.value)}
            aria-pressed={(vendor.ambientMode ?? 'enabled') === opt.value}
            className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
              (vendor.ambientMode ?? 'enabled') === opt.value
                ? 'border-kumo-brand bg-kumo-brand/10'
                : 'border-kumo-line hover:bg-kumo-tint'
            }`}
          >
            <span className="block text-sm font-medium text-kumo-default">{opt.label}</span>
            <span className="block text-xs text-kumo-subtle mt-0.5">{opt.hint}</span>
          </button>
        ))}
      </div>
    </Panel>
  ) : (
    <Panel
      step={nextStep()}
      title="Available to your team"
      hint={
        enableBlockedBySetup
          ? 'Enter the company credential first. The connector turns on for everyone once it is set up.'
          : scope === 'organization'
            ? 'When on, everyone on the team can use it through the company credential. Turning it off is soft: it doesn’t revoke access an app already holds.'
            : 'When off, no one can connect it and assistants stop seeing its resources. Turning it off is soft: it doesn’t revoke access an app already holds.'
      }
      aside={
        <Switch
          checked={vendor.enabled && !enableBlockedBySetup}
          disabled={gkBusy || enableBlockedBySetup}
          onCheckedChange={handleEnabledToggle}
        />
      }
    />
  )

  const resourcesPanel = !vendor.autoProvisions && (
    <Panel
      step={nextStep()}
      title="Resources"
      hint="The kinds of things this connector reaches. Turn one off to hide it from everyone."
    >
      {/* Resources are hidden while the connector is off — they can't be used until it's
          re-enabled. */}
      {!vendor.enabled ? (
        <p className="text-sm text-kumo-subtle">
          {vendor.resources.length} resource{vendor.resources.length === 1 ? '' : 's'} hidden while
          the connector is off.
        </p>
      ) : vendor.resources.length === 0 ? (
        <p className="text-sm text-kumo-subtle">
          {needsSetup ? 'Resources appear once setup is complete.' : 'This connector offers no toggleable resources.'}
        </p>
      ) : (
        <div className="-mx-2 space-y-0.5">
          {vendor.resources.map((resource) => (
            <div
              key={resource.urlPattern}
              role="button"
              tabIndex={0}
              onClick={() =>
                !busy.has(resource.urlPattern) &&
                handleResourceToggle(resource.urlPattern, !resource.enabled)
              }
              onKeyDown={(e) => {
                if (e.currentTarget !== e.target) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  if (!busy.has(resource.urlPattern)) {
                    handleResourceToggle(resource.urlPattern, !resource.enabled)
                  }
                }
              }}
              className="flex cursor-pointer items-center gap-4 rounded-lg px-2 py-2.5 transition-colors hover:bg-kumo-tint"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-kumo-default truncate">{resource.title}</p>
                <p className="text-xs text-kumo-subtle mt-0.5">{resource.description}</p>
              </div>
              <span onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={resource.enabled}
                  disabled={busy.has(resource.urlPattern)}
                  onCheckedChange={(enabled) => handleResourceToggle(resource.urlPattern, enabled)}
                />
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 sm:px-8 py-8">
      <Link
        to="/admin/$section"
        params={{ section: 'connectors' }}
        className="inline-flex items-center gap-1.5 text-[13px] font-medium tracking-[-0.25px] text-kumo-subtle transition-colors hover:text-kumo-default"
      >
        <ArrowLeft size={14} />
        Connectors
      </Link>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <div
          className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-kumo-line/60"
          style={{ backgroundColor: vendor.color ?? 'var(--color-kumo-tint)' }}
        >
          {vendor.logo ? (
            <img src={vendor.logo.url} alt="" className="h-8 w-8 object-contain" />
          ) : (
            <span className="text-lg font-semibold text-kumo-strong">{vendor.displayName[0]}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-[-0.35px] text-kumo-strong">{vendor.displayName}</h1>
          {vendor.tagline && <p className="mt-0.5 text-sm text-kumo-subtle">{vendor.tagline}</p>}
        </div>
        <StatusPill vendor={vendor} className="!px-3 !py-1 !text-[12px]" />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[280px_1fr] lg:gap-8">
        <aside className="flex flex-col gap-6 lg:sticky lg:top-6">
          {vendor.description && (
            <p className="text-[13px] leading-[19px] tracking-[-0.2px] text-kumo-default">{vendor.description}</p>
          )}

          <dl className="m-0 flex flex-col gap-4 text-[13px] leading-[18px]">
            <div>
              <dt className="font-medium text-kumo-strong">Who signs in</dt>
              <dd className="m-0 mt-0.5 text-kumo-subtle">
                <span className="text-kumo-default">{meta.label}.</span> {meta.hint}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-kumo-strong">When a workspace is shared</dt>
              <dd className="m-0 mt-0.5 text-kumo-subtle">{SHARING_NOTE[scope]}</dd>
            </div>
            {(vendor.departments?.length ?? 0) > 0 && (
              <div>
                <dt className="font-medium text-kumo-strong">Departments</dt>
                <dd className="m-0 mt-1.5 flex flex-wrap gap-1.5">
                  {vendor.departments!.map((d) => (
                    <span
                      key={d}
                      className="rounded-full border border-kumo-line bg-kumo-tint px-2 py-0.5 text-[11px] font-medium text-kumo-subtle"
                    >
                      {integrationDepartmentLabel(d)}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            {vendor.url && (
              <div>
                <dt className="font-medium text-kumo-strong">Website</dt>
                <dd className="m-0 mt-0.5">
                  <a
                    href={vendor.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-kumo-subtle transition-colors hover:text-kumo-default"
                  >
                    {new URL(vendor.url).hostname}
                    <ExternalLink size={12} />
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </aside>

        <div className="flex min-w-0 flex-col gap-4">
          {setupPanel}
          {availabilityPanel}
          {resourcesPanel}
        </div>
      </div>

      {admin && setupOpen && (
        <AdminIntegrationSetupModal
          open={setupOpen}
          vendorId={vendor.vendorId}
          displayName={vendor.displayName}
          admin={admin.api}
          onOpenChange={(open) => { if (!open) setSetupOpen(false) }}
          onChanged={() => { reload().catch(() => {}) }}
        />
      )}
    </div>
  )
}
