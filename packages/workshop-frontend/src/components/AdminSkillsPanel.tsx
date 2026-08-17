// Admin panel for the deployment's agent skills: a scannable list, one row per skill, each
// linking to its detail page (/admin/skills/$skillName) where the description, sources, and
// enable/disable control live. The marketplace keeps a compact section below the list.
//
// A skill is a SKILL.md file in a shared Knowledge folder; skills are authored in Knowledge (or
// installed from the marketplace) — this page only curates which ones are offered.

import { useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowUpRight, Check, ChevronRight, TriangleAlert } from 'lucide-react'
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
  // Re-fetch after a mutation (marketplace installs happen here; toggles live on detail pages).
  onChanged: () => Promise<void>
}) {
  const toasts = useKumoToastManager()
  const [busy, setBusy] = useState(false)
  // The Knowledge management app, for the "add skills" pointer. Discovered, not hardcoded: any
  // skills-providing integration's app would do, but today that is Knowledge.
  const driveApp = useGatekeeperApps().find((app) => app.title === 'Knowledge')

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

  const install = async (entry: SkillMarketplaceEntry) => {
    if (busy) return
    setBusy(true)
    try {
      await admin.installSkillPackage(entry.id)
      toasts.add({ title: `Installed “${entry.name}”`, variant: 'success' })
      await onChanged()
    } catch (err) {
      console.error('Skill package install failed:', err)
      toasts.add({
        title: err instanceof Error ? err.message : "Couldn't install the skill package",
        variant: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
        <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Skills</h2>
        <p className="mb-5 text-sm text-kumo-subtle">
          Skills teach assistants how to perform specific tasks. Select one to see what it does
          and turn it on or off. Add your own as{' '}
          <code className="rounded bg-kumo-tint px-1 py-0.5 font-mono text-[12px]">SKILL.md</code>{' '}
          files in a shared{' '}
          {driveApp ? (
            <Link
              to="/integrations/$appId"
              params={{ appId: driveApp.id }}
              className="text-kumo-brand underline"
            >
              Knowledge
            </Link>
          ) : (
            'Knowledge'
          )}{' '}
          folder.
        </p>

        {skills.length === 0 ? (
          <div className="rounded-lg border border-dashed border-kumo-line p-6 text-center text-sm text-kumo-subtle">
            No skills yet.
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-kumo-line rounded-lg border border-kumo-line">
            {skills.map((skill) => (
              <Link
                key={skill.name}
                to="/admin/skills/$skillName"
                params={{ skillName: skill.name }}
                className="group flex items-center gap-3 bg-kumo-base px-4 py-3 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-kumo-tint"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium text-kumo-strong">
                  /{skill.name}
                </span>
                {skill.missing ? (
                  <span className="inline-flex items-center gap-1 text-[12px] font-medium text-kumo-warning">
                    <TriangleAlert size={13} />
                    Missing
                  </span>
                ) : !skill.enabled ? (
                  <span className="rounded-full bg-kumo-tint px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.04em] text-kumo-subtle">
                    Off
                  </span>
                ) : null}
                <ChevronRight size={16} className="shrink-0 text-kumo-inactive transition-colors group-hover:text-kumo-default" />
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Marketplace: hidden entirely when the deployment has no catalog configured. */}
      {marketplace !== null && marketplace !== undefined && marketplace.length > 0 && (
        <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
          <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Marketplace</h2>
          <p className="mb-5 text-sm text-kumo-subtle">
            Curated skill packages. Installing adds a shared Knowledge folder; delete the folder to
            uninstall.
          </p>
          <div className="flex flex-col divide-y divide-kumo-line rounded-lg border border-kumo-line">
            {marketplace.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 bg-kumo-base px-4 py-3 first:rounded-t-lg last:rounded-b-lg">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[13px] font-medium text-kumo-strong">{entry.name}</span>
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
                    <p className="mt-0.5 truncate text-[13px] leading-[18px] text-kumo-subtle">
                      {entry.description}
                    </p>
                  )}
                </div>
                {entry.skills.length > 0 &&
                entry.skills.every((name) => liveSkillNames.has(name)) ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-kumo-success">
                    <Check size={14} />
                    Installed
                  </span>
                ) : (
                  <Button variant="secondary" disabled={busy} onClick={() => install(entry)}>
                    Install
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
