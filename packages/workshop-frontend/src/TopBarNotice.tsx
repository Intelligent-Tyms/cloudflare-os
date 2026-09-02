import { useEffect, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from '@tanstack/react-router'
import { useServerConfig, usePoolMode, usePoolUpgradeUrl } from './ServerConfigContext'
import { useOptionalAuthenticatedApi } from './AuthContext'
import type { PendingWorkspaceInfo } from '@gadgets/workshop-shared/api'

/**
 * Centered text in the top bar. Shows the deployment's admin-configured notice (rendered as inline
 * Markdown, so it can include links) when one is set. When no notice is set and the workspace is
 * on the free plan, falls back to a standing upgrade nudge — admins get a link to the plan picker,
 * members just see the plan. An admin-set announcement always wins over the fallback.
 *
 * On a pool deployment every user is a free user with no admin: the nudge links to the central
 * upgrade page, and once they've bought a workspace it tracks the build ("Setting up acme…",
 * "acme is ready", "taking longer") by polling the pending-workspace lookup.
 *
 * Designed to be placed inside a flex container that has `position: relative`; it absolutely-centers
 * itself so it doesn't affect the left/right layout. Hidden below the `lg` breakpoint where it would
 * crowd the bar.
 */

// Render the notice as a single inline run: paragraphs collapse to plain inline content and links
// become clickable anchors. Other block elements also render inline-ish, which is fine for a short
// one-line notice.
const INLINE_MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => <>{children}</>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-kumo-brand hover:underline pointer-events-auto"
    >
      {children}
    </a>
  ),
}

// How often a pool member's banner re-checks on their company workspace. Builds take minutes;
// the ready state is also announced by email, so this needn't be snappy.
const PENDING_POLL_MS = 60_000

export default function TopBarNotice() {
  const notice = (useServerConfig()?.announcement ?? '').trim()
  const auth = useOptionalAuthenticatedApi()
  const poolMode = usePoolMode()
  const poolUpgradeUrl = usePoolUpgradeUrl()
  const [freePlan, setFreePlan] = useState(false)
  const [pending, setPending] = useState<PendingWorkspaceInfo | null>(null)

  useEffect(() => {
    if (notice || !auth || poolMode) return
    let cancelled = false
    auth.authenticatedApi.getBillingGate()
      .then((gate) => { if (!cancelled) setFreePlan(gate?.isFreePlan ?? false) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [notice, auth, poolMode])

  useEffect(() => {
    if (notice || !auth || !poolMode) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      auth.authenticatedApi.getPendingWorkspace()
        .then((p) => { if (!cancelled) setPending(p) })
        .catch(() => {})
        .finally(() => { if (!cancelled) timer = setTimeout(check, PENDING_POLL_MS) })
    }
    check()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [notice, auth, poolMode])

  if (!notice && !freePlan && !poolMode) return null

  const externalLink = (href: string, label: string) => (
    <a href={href} className="text-kumo-brand hover:underline pointer-events-auto">{label}</a>
  )
  const poolContent = () => {
    if (pending?.status === 'ready') {
      return <>{pending.name} is ready. {externalLink(pending.url, 'Open')}</>
    }
    if (pending?.status === 'provisioning') {
      return <>Setting up {pending.name}. About 5 minutes.</>
    }
    if (pending?.status === 'delayed') {
      return <>{pending.name} is taking longer. We'll email you when it's ready.</>
    }
    return (
      <>
        Free plan.
        {poolUpgradeUrl && <> {externalLink(poolUpgradeUrl, 'Upgrade')}</>}
      </>
    )
  }

  return (
    <div
      aria-hidden="false"
      className="hidden lg:flex absolute inset-0 items-center justify-center pointer-events-none px-40"
    >
      <div className="max-w-full truncate text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
        {notice ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={INLINE_MARKDOWN_COMPONENTS}>
            {notice}
          </ReactMarkdown>
        ) : poolMode ? (
          poolContent()
        ) : (
          <>
            You're on the free plan.
            {auth?.isAdmin && (
              <>
                {' '}
                <Link
                  to="/admin/$section"
                  params={{ section: 'plans' }}
                  className="text-kumo-brand hover:underline pointer-events-auto"
                >
                  Upgrade
                </Link>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
