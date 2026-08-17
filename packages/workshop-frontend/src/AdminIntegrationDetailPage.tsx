// Detail page for one integration (/admin/integrations/$vendorId): its full description, and
// every per-integration control — availability, resource-type toggles, and runtime admin setup.
// The list at /admin/integrations stays a bare index; everything per-integration lives here.

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

export default function AdminIntegrationDetailPage({ vendorId }: { vendorId: string }) {
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

  useDocumentTitle(`${vendor?.displayName ?? vendorId} · Integrations · Admin`)

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
          console.error('Failed to load integration:', err)
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
        <p className="text-kumo-subtle">Loading integration...</p>
      </div>
    )
  }

  if (loadError || !isAdmin) {
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-16 text-center">
        <p className="text-sm text-kumo-danger">Something went wrong loading this integration.</p>
        <button onClick={() => window.location.reload()} className="text-kumo-brand mt-2 text-sm underline">
          Try again
        </button>
      </div>
    )
  }

  if (!vendor) {
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-16 text-center">
        <p className="text-sm text-kumo-subtle">This integration isn't installed on this deployment.</p>
        <Link
          to="/admin/$section"
          params={{ section: 'integrations' }}
          className="text-kumo-brand mt-2 inline-block text-sm underline"
        >
          Back to Integrations
        </Link>
      </div>
    )
  }

  const gkBusy = busy.has('gk')

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-8 space-y-6">
      <div>
        <Link
          to="/admin/$section"
          params={{ section: 'integrations' }}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium tracking-[-0.25px] text-kumo-subtle transition-colors hover:text-kumo-default"
        >
          <ArrowLeft size={14} />
          Integrations
        </Link>
        <div className="mt-3 flex items-center gap-3">
          {vendor.logo && (
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-kumo-line"
              style={vendor.color ? { backgroundColor: vendor.color } : undefined}
            >
              <img src={vendor.logo.url} alt="" className="h-6 w-6 object-contain" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-kumo-default">{vendor.displayName}</h1>
            {vendor.tagline && <p className="text-sm text-kumo-subtle mt-0.5">{vendor.tagline}</p>}
          </div>
        </div>
        {vendor.description && (
          <p className="text-sm text-kumo-subtle mt-3 max-w-2xl">{vendor.description}</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(vendor.departments ?? []).map((d) => (
            <span
              key={d}
              className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-kumo-tint text-kumo-subtle border border-kumo-line"
            >
              {integrationDepartmentLabel(d)}
            </span>
          ))}
          {vendor.url && (
            <a
              href={vendor.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-kumo-subtle hover:text-kumo-default transition-colors"
            >
              {new URL(vendor.url).hostname}
              <ExternalLink size={12} />
            </a>
          )}
        </div>
      </div>

      {vendor.autoProvisions ? (
        // Auto-provisioned ("ambient") integration: a three-state mode, no resources to toggle.
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong">Availability</h2>
          <p className="text-sm text-kumo-subtle mt-0.5">
            This integration is auto-provisioned: no account connection is needed.
          </p>
          <div className="flex gap-2 mt-4">
            {(
              [
                { value: 'disabled', label: 'Disabled', hint: 'Off for everyone' },
                { value: 'optional', label: 'Optional', hint: 'Users can add it themselves' },
                { value: 'enabled', label: 'Enabled', hint: 'On for everyone automatically' },
              ] as { value: AmbientGatekeeperMode; label: string; hint: string }[]
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                disabled={gkBusy}
                onClick={() => handleMode(opt.value)}
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
        </div>
      ) : (
        <>
          <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
            <div className="flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-semibold text-kumo-strong">Available to your team</h2>
                <p className="text-sm text-kumo-subtle mt-0.5">
                  When off, no one can connect it and assistants stop seeing its resources. Turning
                  it off is soft: it doesn’t revoke access an app already holds.
                </p>
              </div>
              <Switch checked={vendor.enabled} disabled={gkBusy} onCheckedChange={handleEnabledToggle} />
            </div>
          </div>

          {vendor.setup && (
            <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
              <div className="flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg font-semibold text-kumo-strong">Setup</h2>
                  <p className="text-sm text-kumo-subtle mt-0.5">
                    {vendor.setup.status === 'unconfigured'
                      ? 'Not set up yet — hidden from your team until an administrator completes setup.'
                      : 'Set up and ready for your team to connect.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSetupOpen(true)}
                  className={`shrink-0 text-sm font-medium px-3 py-1.5 rounded-lg border transition-colors ${
                    vendor.setup.status === 'unconfigured'
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20'
                      : 'border-kumo-line text-kumo-subtle hover:bg-kumo-tint'
                  }`}
                >
                  {vendor.setup.status === 'unconfigured' ? 'Set up' : 'Manage setup'}
                </button>
              </div>
            </div>
          )}

          <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
            <h2 className="text-lg font-semibold text-kumo-strong">Resources</h2>
            <p className="text-sm text-kumo-subtle mt-0.5">
              The resource types this integration offers. Turn one off to hide it from everyone.
            </p>
            {/* Resources are hidden while the integration is off — they can't be used until it's
                re-enabled. */}
            {!vendor.enabled ? (
              <p className="text-sm text-kumo-subtle mt-4">
                {vendor.resources.length} resource{vendor.resources.length === 1 ? '' : 's'} hidden
                while the integration is off.
              </p>
            ) : vendor.resources.length === 0 ? (
              <p className="text-sm text-kumo-subtle mt-4">
                {vendor.setup?.status === 'unconfigured'
                  ? 'No resources yet — they appear once setup is complete.'
                  : 'This integration offers no toggleable resources.'}
              </p>
            ) : (
              <div className="mt-4 space-y-1">
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
                    className="flex cursor-pointer items-center gap-4 px-3 py-2.5 rounded-lg hover:bg-kumo-tint transition-colors"
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
          </div>
        </>
      )}

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
