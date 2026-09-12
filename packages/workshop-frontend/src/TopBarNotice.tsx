import { useEffect, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from '@tanstack/react-router'
import { useServerConfig } from './ServerConfigContext'
import { useOptionalAuthenticatedApi } from './AuthContext'
import type { BillingGateInfo } from '@gadgets/workshop-shared/api'
import { credits } from './components/billing/billingFormat'

/**
 * Centered text in the top bar. Shows the deployment's admin-configured notice (rendered as inline
 * Markdown, so it can include links) when one is set. When no notice is set and the workspace is
 * on the free plan, falls back to a standing upgrade nudge — admins get a link to the plan picker,
 * members just see the plan. While a paid plan is on its free trial it shows the days left
 * (admins get a link to Plans, where cancelling lives). On a paid plan it warns admins when AI credits are running
 * low (under a fifth of the period's credits, or out), with a link to Billing & usage where the
 * top-up is, so nobody learns the workspace is dry from a blocked turn. An admin-set announcement
 * always wins over the fallbacks.
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

// Below this share of the period's AI credits (allowance plus top-ups) admins get the nudge.
// Matches the "Running low" threshold on the Billing & usage card.
const LOW_CREDITS_FRACTION = 0.2

type LowCredits = { balanceMicroUsd: number; out: boolean }

function lowCredits(gate: BillingGateInfo | null): LowCredits | null {
  if (!gate || gate.isFreePlan) return null
  const balance = gate.aiBalanceMicroUsd
  const grant = gate.aiMonthlyGrantMicroUsd
  if (balance == null || grant == null || grant <= 0) return null
  if (balance <= 0) return { balanceMicroUsd: 0, out: true }
  return balance / grant < LOW_CREDITS_FRACTION ? { balanceMicroUsd: balance, out: false } : null
}

export default function TopBarNotice() {
  const notice = (useServerConfig()?.announcement ?? '').trim()
  const auth = useOptionalAuthenticatedApi()
  const [freePlan, setFreePlan] = useState(false)
  const [trialEndsAt, setTrialEndsAt] = useState<number | null>(null)
  const [low, setLow] = useState<LowCredits | null>(null)
  const [cardExpiring, setCardExpiring] = useState(false)

  useEffect(() => {
    if (notice || !auth) return
    let cancelled = false
    auth.authenticatedApi.getBillingGate()
      .then((gate) => {
        if (cancelled) return
        setFreePlan(gate?.isFreePlan ?? false)
        setTrialEndsAt(gate?.trialEndsAt ?? null)
        setLow(auth.isAdmin ? lowCredits(gate) : null)
        setCardExpiring(Boolean(auth.isAdmin && gate?.cardExpiresBeforeNextCharge))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [notice, auth])

  if (!notice && !freePlan && !low && !cardExpiring && trialEndsAt == null) return null

  // Days until the trial's first charge; the card is already on file, so this is
  // information, not a nudge. Admins get the link to where cancelling lives.
  const trialDaysLeft = trialEndsAt == null ? null : Math.max(0, Math.ceil((trialEndsAt - Date.now()) / 86_400_000))
  const trialLabel = trialDaysLeft == null ? ''
    : trialDaysLeft === 0 ? 'Free trial ends today.'
    : trialDaysLeft === 1 ? 'Free trial ends tomorrow.'
    : `Free trial: ${trialDaysLeft} days left.`

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
        ) : low ? (
          <>
            <span className={low.out ? 'text-kumo-danger' : 'text-kumo-warning'}>
              {low.out ? 'Out of AI credits.' : `AI credits low: ${credits(low.balanceMicroUsd)} left.`}
            </span>{' '}
            <Link
              to="/admin/$section"
              params={{ section: 'billing' }}
              className="text-kumo-brand hover:underline pointer-events-auto"
            >
              Top up
            </Link>
          </>
        ) : cardExpiring ? (
          <>
            <span className="text-kumo-warning">Your card on file expires before the next payment.</span>{' '}
            <Link
              to="/admin/$section"
              params={{ section: 'billing' }}
              className="text-kumo-brand hover:underline pointer-events-auto"
            >
              Update card
            </Link>
          </>
        ) : trialEndsAt != null ? (
          <>
            {trialLabel}
            {auth?.isAdmin && (
              <>
                {' '}
                <Link
                  to="/admin/$section"
                  params={{ section: 'plans' }}
                  className="text-kumo-brand hover:underline pointer-events-auto"
                >
                  Manage plan
                </Link>
              </>
            )}
          </>
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
