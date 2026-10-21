import { useEffect, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useServerConfig } from './ServerConfigContext'
import { useOptionalAuthenticatedApi } from './AuthContext'
import type { BillingGateInfo } from '@gadgets/workshop-shared/api'
import { billingLink } from './portalLinks'

/**
 * Centered text in the top bar. Shows the deployment's admin-configured notice (rendered as inline
 * Markdown, so it can include links) when one is set. Otherwise admins see a short billing notice
 * when the workspace is out of funds, has reached a spending limit, is suspended, or its prepaid
 * balance is running low, with a link
 * to billing.tyms.ai, so nobody learns the workspace stopped from a blocked turn. Billing itself
 * (balance, top-ups, plans of any kind) is never shown here: only that link.
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

const BILLING_NOTICES = {
  out_of_funds: { text: 'Out of funds.', link: 'Add funds', tone: 'text-kumo-danger' },
  limit_reached: { text: 'Limit reached.', link: 'Open billing', tone: 'text-kumo-warning' },
  suspended: { text: 'Workspace suspended.', link: 'Open billing', tone: 'text-kumo-danger' },
  low: { text: 'Balance low.', link: 'Add funds', tone: 'text-kumo-warning' },
} as const

function billingNotice(gate: BillingGateInfo | null) {
  if (!gate) return null
  if (gate.stop) return BILLING_NOTICES[gate.stop]
  return gate.lowBalance ? BILLING_NOTICES.low : null
}

export default function TopBarNotice() {
  const serverConfig = useServerConfig()
  const notice = (serverConfig?.announcement ?? '').trim()
  const auth = useOptionalAuthenticatedApi()
  const isAdmin = auth?.isAdmin ?? false
  const [gate, setGate] = useState<BillingGateInfo | null>(null)

  useEffect(() => {
    if (notice || !auth || !isAdmin) return
    let cancelled = false
    auth.authenticatedApi.getBillingGate()
      .then((g) => { if (!cancelled) setGate(g) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [notice, auth, isAdmin])

  const billing = notice || !isAdmin ? null : billingNotice(gate)
  if (!notice && !billing) return null

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
        ) : billing ? (
          <>
            <span className={billing.tone}>{billing.text}</span>{' '}
            <a
              href={billingLink(serverConfig)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-kumo-brand hover:underline pointer-events-auto"
            >
              {billing.link}
            </a>
          </>
        ) : null}
      </div>
    </div>
  )
}
