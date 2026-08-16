import { Dialog, Input, Button, useKumoToastManager } from '@cloudflare/kumo'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { RpcStub } from 'capnweb'
import { AdminApi } from '@gadgets/workshop-shared/api'
import { VendorSetup } from '@gadgets/workshop-shared/gatekeeper'

// Admin setup flow for an integration that accepts runtime configuration (an OAuth app's
// client ID/secret, endpoints). Renders the vendor's own input schema; stored secrets are
// write-only — the panel shows presence and last-updated only, never values.
interface AdminIntegrationSetupModalProps {
  open: boolean
  vendorId: string
  displayName: string
  admin: RpcStub<AdminApi>
  onOpenChange: (open: boolean) => void
  // Called after setup was applied or removed, so the panel can reload vendor state.
  onChanged: () => void
}

export default function AdminIntegrationSetupModal({
  open, vendorId, displayName, admin, onOpenChange, onChanged,
}: AdminIntegrationSetupModalProps) {
  const toast = useKumoToastManager()
  const [setup, setSetup] = useState<VendorSetup | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Field edits by input name; a configured secret field only joins once Replace is clicked.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [replacing, setReplacing] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSetup(null)
    setLoadError(null)
    setDrafts({})
    setReplacing(new Set())
    admin.getIntegrationSetup(vendorId).then(
      (state) => { if (!cancelled) setSetup(state) },
      (error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error)) },
    )
    return () => { cancelled = true }
  }, [open, vendorId, admin])

  const configuredNames = new Set(setup?.configured.map((entry) => entry.name) ?? [])
  const dirtyEntries = Object.entries(drafts).filter(([, value]) => value.trim())
  // Every input must have a value on the way in: either newly typed or already stored.
  const complete = setup !== null && setup.inputs.every(
    (input) => drafts[input.name]?.trim() || (configuredNames.has(input.name) && !replacing.has(input.name)))
  const canSave = dirtyEntries.length > 0 && complete && !busy

  const handleCopyRedirect = async () => {
    if (!setup?.redirectUri) return
    await navigator.clipboard.writeText(setup.redirectUri)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleSave = async () => {
    if (!canSave) return
    setBusy(true)
    try {
      await admin.applyIntegrationSetup(vendorId, Object.fromEntries(
        dirtyEntries.map(([name, value]) => [name, value.trim()])))
      toast.add({ title: `${displayName} set up`, description: 'Your team can now connect their accounts.' })
      onChanged()
      onOpenChange(false)
    } catch (error) {
      toast.add({ title: 'Setup failed', description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async () => {
    if (busy) return
    if (!window.confirm(`Remove the ${displayName} setup? The integration hides from your team until it is set up again.`)) return
    setBusy(true)
    try {
      await admin.clearIntegrationSetup(vendorId)
      toast.add({ title: `${displayName} setup removed` })
      onChanged()
      onOpenChange(false)
    } catch (error) {
      toast.add({ title: 'Could not remove setup', description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const consoleUrl = setup?.inputs.find((input) => input.consoleUrl)?.consoleUrl
  const steps = setup?.inputs.find((input) => input.setupSteps?.length)?.setupSteps

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="max-w-xl">
        <div className="p-6">
          <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
            Set up {displayName}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">
            Create an OAuth app at {displayName} and paste its keys here. Your team then connects
            their own accounts — nobody shares logins.
          </Dialog.Description>

          {loadError && (
            <p className="mt-4 text-sm text-kumo-danger">{loadError}</p>
          )}
          {!setup && !loadError && (
            <p className="mt-4 text-sm text-kumo-subtle">Loading…</p>
          )}

          {setup && (
            <div className="mt-4 space-y-4">
              {steps && (
                <ol className="list-decimal pl-5 space-y-1 text-[13px] leading-[18px] text-kumo-subtle">
                  {steps.map((step) => <li key={step}>{step}</li>)}
                </ol>
              )}
              {consoleUrl && (
                <a
                  href={consoleUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-kumo-brand hover:underline"
                >
                  Open the {displayName} developer console
                  <ExternalLink size={14} />
                </a>
              )}

              {setup.redirectUri && (
                <div>
                  <p className="text-xs font-medium text-kumo-subtle mb-1">Redirect URI to register</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 min-w-0 truncate rounded-lg border border-kumo-line bg-kumo-tint/50 px-3 py-2 text-[12px] text-kumo-default">
                      {setup.redirectUri}
                    </code>
                    <Button type="button" variant="secondary" onClick={handleCopyRedirect}>
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {setup.inputs.map((input) => {
                  const stored = setup.configured.find((entry) => entry.name === input.name)
                  const showField = !stored || replacing.has(input.name)
                  return (
                    <div key={input.name}>
                      <label className="block text-xs font-medium text-kumo-subtle mb-1" htmlFor={`setup-${input.name}`}>
                        {input.label}
                      </label>
                      {showField ? (
                        <Input
                          id={`setup-${input.name}`}
                          type={input.kind === 'secret' ? 'password' : 'text'}
                          autoComplete="off"
                          value={drafts[input.name] ?? ''}
                          onChange={(e) => setDrafts((d) => ({ ...d, [input.name]: e.target.value }))}
                        />
                      ) : (
                        <div className="flex items-center gap-3 rounded-lg border border-kumo-line px-3 py-2">
                          <span className="flex-1 text-sm text-kumo-subtle">
                            Set{stored.updatedAt ? ` · updated ${new Date(stored.updatedAt).toLocaleDateString()}` : ''}
                          </span>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setReplacing((prev) => new Set(prev).add(input.name))}
                          >
                            Replace
                          </Button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="flex items-center gap-2 pt-2">
                <Button type="button" variant="primary" disabled={!canSave} onClick={handleSave}>
                  {busy ? 'Saving…' : 'Save setup'}
                </Button>
                <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <div className="flex-1" />
                {setup.configured.length > 0 && (
                  <Button type="button" variant="secondary" disabled={busy} onClick={handleRemove}>
                    Remove setup
                  </Button>
                )}
              </div>
              {setup.status === 'configured' && setup.configured.length === 0 && (
                <p className="text-xs text-kumo-subtle">
                  Currently configured by the deployment. Values you save here take precedence.
                </p>
              )}
            </div>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
