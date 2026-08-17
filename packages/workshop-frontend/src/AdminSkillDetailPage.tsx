// Detail page for one agent skill (/admin/skills/$skillName): the full description, where the
// skill lives, and the deployment-wide on/off control. The list at /admin/skills stays a bare
// index; everything per-skill lives here.

import { useEffect, useState } from 'react'
import { RpcStub } from 'capnweb'
import { Link, useNavigate } from '@tanstack/react-router'
import { Switch, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowLeft, TriangleAlert } from 'lucide-react'
import { useAuthenticatedApi } from './AuthContext'
import { AdminApi, AdminSkill } from '@gadgets/workshop-shared/api'
import { useDocumentTitle } from './useDocumentTitle'
import { useGatekeeperApps } from './useGatekeeperApps'

export default function AdminSkillDetailPage({ skillName }: { skillName: string }) {
  const { authenticatedApi, isAdmin } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const navigate = useNavigate()
  useDocumentTitle(`/${skillName} · Skills · Admin`)
  const driveApp = useGatekeeperApps().find((app) => app.title === 'Knowledge')

  // The admin capability (minted once, like AdminPage). Wrapped in an object so useState doesn't
  // treat the (callable) RPC stub as a state updater function.
  const [admin, setAdmin] = useState<{ api: RpcStub<AdminApi> } | null>(null)
  const [skill, setSkill] = useState<AdminSkill | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)

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
        if (!cancelled) setSkill(view.skills.find((s) => s.name === skillName) ?? null)
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load skill:', err)
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
  }, [isAdmin, authenticatedApi, skillName])

  const setEnabled = async (enabled: boolean) => {
    if (!admin || !skill || busy) return
    setBusy(true)
    // Optimistic: the switch reflects the intent immediately; a failure reverts and reports.
    setSkill({ ...skill, enabled })
    try {
      await admin.api.setSkillEnabled(skill.name, enabled)
      if (skill.missing && enabled) {
        // Clearing a stale entry removes the skill entirely; the list is where that shows.
        navigate({ to: '/admin/$section', params: { section: 'skills' } })
      }
    } catch (err) {
      console.error('Skill update failed:', err)
      toasts.add({ title: "Couldn't update the skill", variant: 'error' })
      setSkill(skill)
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh]">
        <p className="text-kumo-subtle">Loading skill...</p>
      </div>
    )
  }

  if (loadError || !isAdmin) {
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-16 text-center">
        <p className="text-sm text-kumo-danger">Something went wrong loading this skill.</p>
        <button onClick={() => window.location.reload()} className="text-kumo-brand mt-2 text-sm underline">
          Try again
        </button>
      </div>
    )
  }

  if (!skill) {
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-16 text-center">
        <p className="text-sm text-kumo-subtle">This skill no longer exists.</p>
        <Link
          to="/admin/$section"
          params={{ section: 'skills' }}
          className="text-kumo-brand mt-2 inline-block text-sm underline"
        >
          Back to Skills
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-8 space-y-6">
      <div>
        <Link
          to="/admin/$section"
          params={{ section: 'skills' }}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium tracking-[-0.25px] text-kumo-subtle transition-colors hover:text-kumo-default"
        >
          <ArrowLeft size={14} />
          Skills
        </Link>
        <h1 className="mt-3 font-mono text-2xl font-semibold text-kumo-default">/{skill.name}</h1>
        {skill.description && (
          <p className="text-sm text-kumo-subtle mt-2 max-w-2xl">{skill.description}</p>
        )}
      </div>

      {skill.missing ? (
        <div className="flex items-start gap-3 rounded-xl border border-kumo-line bg-kumo-elevated p-6">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-kumo-warning" />
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-kumo-strong">No longer in Knowledge</h2>
            <p className="mt-0.5 text-sm text-kumo-subtle">
              This skill was turned off and its file has since been removed. It stays off; clear
              the setting to forget it.
            </p>
            <button
              onClick={() => setEnabled(true)}
              disabled={busy}
              className="mt-3 text-sm font-medium text-kumo-brand underline disabled:opacity-50"
            >
              Clear setting
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
            <div className="flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-semibold text-kumo-strong">Offered to everyone</h2>
                <p className="text-sm text-kumo-subtle mt-0.5">
                  When off, the skill leaves the <span className="font-mono text-[12px]">/</span>{' '}
                  picker and assistants stop seeing it. Conversations that already used it keep
                  their history.
                </p>
              </div>
              <Switch checked={skill.enabled} disabled={busy} onCheckedChange={setEnabled} />
            </div>
          </div>

          {skill.sources.length > 0 && (
            <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
              <h2 className="text-lg font-semibold text-kumo-strong">Where it lives</h2>
              <p className="text-sm text-kumo-subtle mt-0.5">
                {skill.sources.length === 1 ? 'From the folder ' : 'From the folders '}
                <span className="font-medium text-kumo-default">{skill.sources.join(', ')}</span>.
                {driveApp && (
                  <>
                    {' '}
                    Edit or remove it in{' '}
                    <Link
                      to="/integrations/$appId"
                      params={{ appId: driveApp.id }}
                      className="text-kumo-brand underline"
                    >
                      Knowledge
                    </Link>
                    .
                  </>
                )}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
