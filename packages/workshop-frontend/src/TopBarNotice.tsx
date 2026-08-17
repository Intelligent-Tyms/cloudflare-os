import { useEffect, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from '@tanstack/react-router'
import { useServerConfig } from './ServerConfigContext'
import { useOptionalAuthenticatedApi } from './AuthContext'

/**
 * Centered text in the top bar. Shows the deployment's admin-configured notice (rendered as inline
 * Markdown, so it can include links) when one is set. When no notice is set and the workspace is
 * on the free plan, falls back to a standing upgrade nudge — admins get a link to the plan picker,
 * members just see the plan. An admin-set announcement always wins over the fallback.
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

export default function TopBarNotice() {
  const notice = (useServerConfig()?.announcement ?? '').trim()
  const auth = useOptionalAuthenticatedApi()
  const [freePlan, setFreePlan] = useState(false)

  useEffect(() => {
    if (notice || !auth) return
    let cancelled = false
    auth.authenticatedApi.getBillingGate()
      .then((gate) => { if (!cancelled) setFreePlan(gate?.isFreePlan ?? false) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [notice, auth])

  if (!notice && !freePlan) return null

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
        ) : (
          <>
            You're on the free plan.
            {auth?.isAdmin && (
              <>
                {' '}
                <Link
                  to="/admin/$section"
                  params={{ section: 'billing' }}
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
