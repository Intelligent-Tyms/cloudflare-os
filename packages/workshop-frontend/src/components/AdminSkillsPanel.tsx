// Admin panel for the deployment's agent skills.
//
// A skill is a SKILL.md file in a shared (public) Drive folder: its frontmatter names it and says
// when to use it, and the file body is the instructions the assistant follows. Skills are authored
// in Drive (including folders synced from git repositories); this panel only curates which of them
// are offered. Everything is enabled by default — disabling is the curation.

import { useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Button, Switch, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowUpRight, Check, TriangleAlert } from 'lucide-react'
import type { AdminApi, AdminSkill, SkillMarketplaceEntry } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import { useGatekeeperApps } from '../useGatekeeperApps'

export default function AdminSkillsPanel({
  admin,
  skills,
  onChanged,
}: {
  admin: RpcStub<AdminApi>
  skills: AdminSkill[]
  // Re-fetch after a mutation. Skills are curated rarely, so re-reading beats an optimistic local
  // copy that could disagree with what Drive currently holds.
  onChanged: () => Promise<void>
}) {
  const toasts = useKumoToastManager()
  const [busy, setBusy] = useState(false)
  // The Drive management app, for the "add skills" pointer. Discovered, not hardcoded: any
  // skills-providing connector's app would do, but today that is Drive.
  const driveApp = useGatekeeperApps().find((app) => app.title === 'Drive')

  // The marketplace catalog: undefined while loading, null when this deployment has none
  // configured (the section hides), [] when configured but empty.
  const [marketplace, setMarketplace] = useState<SkillMarketplaceEntry[] | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    admin.listSkillMarketplace()
      .then((entries) => { if (!cancelled) setMarketplace(entries) })
      .catch((err) => {
        console.error('Failed to load the skill marketplace:', err)
        if (!cancelled) setMarketplace(null)
      })
    return () => { cancelled = true }
  }, [admin])

  const liveSkillNames = useMemo(
    () => new Set(skills.filter((s) => !s.missing).map((s) => s.name)),
    [skills],
  )

  // Every mutation funnels through here, so the panel can't issue overlapping writes and always
  // re-reads the authoritative state afterwards.
  const mutate = async (op: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await op()
      await onChanged()
    } catch (err) {
      console.error('Skill update failed:', err)
      toasts.add({ title: "Couldn't update skills", variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const addSkillsHint = (
    <>
      Add skills by putting <code className="rounded bg-kumo-tint px-1 py-0.5 font-mono text-[12px]">SKILL.md</code>{' '}
      files in a shared{' '}
      {driveApp ? (
        <Link
          to="/gatekeepers/$appId"
          params={{ appId: driveApp.id }}
          className="text-kumo-brand underline"
        >
          Drive
        </Link>
      ) : (
        'Drive'
      )}{' '}
      folder — including folders synced from a git repository.
    </>
  )

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
      <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Skills</h2>
      <p className="mb-5 text-sm text-kumo-subtle">
        A skill teaches assistants how to perform a task, step by step. People invoke one by typing{' '}
        <span className="font-mono text-[12px]">/skill-name</span> in chat, and assistants pick
        relevant skills up on their own. {addSkillsHint}
      </p>

      {skills.length === 0 ? (
        <div className="rounded-lg border border-dashed border-kumo-line p-6 text-center text-sm text-kumo-subtle">
          No skills yet. {addSkillsHint}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {skills.map((skill) => (
            <SkillRow
              key={skill.name}
              skill={skill}
              busy={busy}
              onSetEnabled={(enabled) => mutate(() => admin.setSkillEnabled(skill.name, enabled))}
            />
          ))}
        </div>
      )}

      {/* Marketplace: hidden entirely when the deployment has no catalog configured. */}
      {marketplace !== null && marketplace !== undefined && (
        <div className="mt-8">
          <h3 className="mb-1 text-[15px] font-semibold text-kumo-strong">Skills marketplace</h3>
          <p className="mb-4 text-sm text-kumo-subtle">
            Curated skill packages. Installing one adds it as a shared Drive folder; its skills
            then appear above, where you can turn them off at any time. To uninstall, delete the
            folder in Drive.
          </p>
          {marketplace.length === 0 ? (
            <p className="text-sm text-kumo-inactive">Nothing in the marketplace yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {marketplace.map((entry) => (
                <MarketplaceRow
                  key={entry.id}
                  entry={entry}
                  busy={busy}
                  installed={
                    entry.skills.length > 0 &&
                    entry.skills.every((name) => liveSkillNames.has(name))
                  }
                  onInstall={() => mutate(async () => {
                    await admin.installSkillPackage(entry.id)
                    toasts.add({ title: `Installed “${entry.name}”`, variant: 'success' })
                  })}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MarketplaceRow({
  entry,
  busy,
  installed,
  onInstall,
}: {
  entry: SkillMarketplaceEntry
  busy: boolean
  installed: boolean
  onInstall: () => void
}) {
  return (
    <div className="flex items-start gap-4 rounded-lg border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[13px] font-medium text-kumo-strong">{entry.name}</span>
          {entry.skills.length > 0 && (
            <span className="font-mono text-[12px] text-kumo-inactive">
              {entry.skills.map((name) => `/${name}`).join(' ')}
            </span>
          )}
          {entry.repoUrl && (
            <a
              href={entry.repoUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-[12px] text-kumo-subtle underline"
            >
              source
              <ArrowUpRight size={12} />
            </a>
          )}
        </div>
        {entry.description && (
          <p className="mt-0.5 text-[13px] leading-[18px] text-kumo-subtle">{entry.description}</p>
        )}
      </div>
      {installed ? (
        <span className="inline-flex items-center gap-1 text-[13px] font-medium text-kumo-success">
          <Check size={14} />
          Installed
        </span>
      ) : (
        <Button variant="secondary" disabled={busy} onClick={onInstall}>
          Install
        </Button>
      )}
    </div>
  )
}

function SkillRow({
  skill,
  busy,
  onSetEnabled,
}: {
  skill: AdminSkill
  busy: boolean
  onSetEnabled: (enabled: boolean) => void
}) {
  if (skill.missing) {
    // A disabled skill whose file has since left Drive. Re-enabling is how the stale curation
    // entry is cleared (the disabled set is the whole state), so the action reads as a cleanup.
    return (
      <div className="flex items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base px-4 py-3">
        <TriangleAlert size={16} className="shrink-0 text-kumo-warning" />
        <div className="min-w-0 flex-1">
          <span className="font-mono text-[13px] text-kumo-subtle">/{skill.name}</span>
          <p className="text-[13px] text-kumo-subtle">
            This skill is no longer in Drive. It stays turned off; clear it to forget the setting.
          </p>
        </div>
        <Button variant="secondary" disabled={busy} onClick={() => onSetEnabled(true)}>
          Clear
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-4 rounded-lg border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-[13px] font-medium text-kumo-strong">/{skill.name}</span>
          {skill.sources.length > 0 && (
            <span className="text-[12px] text-kumo-inactive">
              in {skill.sources.join(', ')}
            </span>
          )}
        </div>
        {skill.description && (
          <p className="mt-0.5 text-[13px] leading-[18px] text-kumo-subtle">{skill.description}</p>
        )}
      </div>
      <Switch
        checked={skill.enabled}
        disabled={busy}
        onCheckedChange={(checked) => onSetEnabled(checked)}
      />
    </div>
  )
}
