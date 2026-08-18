import { useState, useEffect } from 'react'
import { RpcStub } from 'capnweb'
import { Link } from '@tanstack/react-router'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { AdminApi, BillingOverview, BillingCreditType, TeamView } from '@gadgets/workshop-shared/api'
import {
  credits, creditsFromCents, usdFromCents, shortDate, STATUS_STYLES,
  PENDING_TOPUP_KEY, CHECKOUT_POLL_MS, CHECKOUT_POLL_ATTEMPTS, takeStash,
} from './billing/billingFormat'

// Admin → Billing and usage: the plan, teammate/assistant limits, credit balances, and the
// current period's usage. Everything proxies through AdminApi to the central billing
// directory; a null overview means this deployment has none configured. Comparing and
// switching plans lives on its own page (Admin → Plans, AdminPlansPanel).

const TOPUP_PRESETS_CENTS = [10_00, 25_00, 50_00]

type PendingTopup = { creditType: BillingCreditType; topupMicroUsd: number }

export default function AdminBillingPanel({ admin }: { admin: RpcStub<AdminApi> }) {
  const toasts = useKumoToastManager()
  const [overview, setOverview] = useState<BillingOverview | null>(null)
  const [team, setTeam] = useState<TeamView | null>(null)
  const [loading, setLoading] = useState(true)
  const [topupBusy, setTopupBusy] = useState<string | null>(null)

  const reload = async () => {
    const [billing, teamView] = await Promise.all([
      admin.getBillingOverview().catch(() => null),
      admin.getTeam().catch(() => null),
    ])
    setOverview(billing)
    setTeam(teamView)
    return billing
  }

  useEffect(() => {
    let cancelled = false
    reload().then(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin])

  // Returning from a top-up checkout: acknowledge, clean the URL, and — when we know what
  // was bought (the pre-checkout stash) — poll until Stripe's webhook has actually applied
  // it, so the page never claims success while showing the old balance.
  useEffect(() => {
    let cancelled = false
    const pollUntil = async (
      done: (billing: BillingOverview) => boolean,
      onDone: () => void,
      onTimeout: () => void,
    ) => {
      for (let attempt = 0; attempt < CHECKOUT_POLL_ATTEMPTS; attempt++) {
        const billing = await reload().catch(() => null)
        if (cancelled) return
        if (billing && done(billing)) {
          onDone()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, CHECKOUT_POLL_MS))
        if (cancelled) return
      }
      onTimeout()
    }

    const params = new URLSearchParams(window.location.search)
    const outcome = params.get('topup')
    if (!outcome) return
    if (outcome === 'success') {
      const pending = takeStash<PendingTopup>(PENDING_TOPUP_KEY)
      if (!pending) {
        toasts.add({ title: 'Top-up complete. Your balance updates momentarily.', variant: 'success' })
      } else {
        toasts.add({ title: 'Payment complete. Adding your credits…', variant: 'success' })
        void pollUntil(
          (billing) => billing[pending.creditType].topupMicroUsd > pending.topupMicroUsd,
          () => toasts.add({ title: 'Top-up complete. Your credits are available now.', variant: 'success' }),
          () => toasts.add({ title: 'Payment received. Your credits can take a minute to appear.', variant: 'info' }),
        )
      }
    } else if (outcome === 'cancelled') {
      sessionStorage.removeItem(PENDING_TOPUP_KEY)
      toasts.add({ title: 'Top-up cancelled.', variant: 'info' })
    }
    params.delete('topup')
    const query = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleTopup = async (creditType: BillingCreditType, amountCents: number) => {
    const key = `${creditType}:${amountCents}`
    setTopupBusy(key)
    try {
      const base = `${window.location.origin}${window.location.pathname}`
      const url = await admin.createTopupCheckout(
        creditType, amountCents, `${base}?topup=success`, `${base}?topup=cancelled`)
      sessionStorage.setItem(PENDING_TOPUP_KEY, JSON.stringify({
        creditType,
        topupMicroUsd: overview?.[creditType].topupMicroUsd ?? 0,
      } satisfies PendingTopup))
      window.location.assign(url)
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Could not start checkout', variant: 'error' })
      setTopupBusy(null)
    }
  }

  if (loading) {
    return <p className="text-sm text-kumo-subtle">Loading billing…</p>
  }

  if (!overview) {
    return (
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <p className="text-sm text-kumo-subtle">
          This deployment has no central billing configured, so there is nothing to manage
          here. Plans and credits apply to workspaces managed through tyms.ai.
        </p>
      </div>
    )
  }

  const isFree = overview.freeDailyLlmCalls != null
  const isEnterprise = overview.tier === 'enterprise'
  const memberCount = team?.members.length ?? null
  const aiSpent = overview.usage
    .filter((r) => r.kind === 'ai')
    .reduce((sum, r) => sum + r.costMicroUsd, 0)
  const messageRows = overview.usage.filter((r) => r.kind === 'message')
  const messageCount = messageRows.reduce((sum, r) => sum + r.quantity, 0)
  const messagingSpent = messageRows.reduce((sum, r) => sum + r.costMicroUsd, 0)

  const statusChip = (
    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[overview.subscriptionStatus] ?? 'bg-kumo-tint text-kumo-subtle'}`}>
      {overview.subscriptionStatus.replace('_', ' ')}
    </span>
  )

  const creditCard = (
    label: string,
    creditType: BillingCreditType,
    bucket: BillingOverview['ai'],
    spentMicroUsd: number,
    footnote?: string,
  ) => {
    const grantUsed = Math.min(1, bucket.monthlyGrantMicroUsd > 0
      ? (bucket.monthlyGrantMicroUsd - bucket.allowanceMicroUsd) / bucket.monthlyGrantMicroUsd
      : 0)
    return (
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6 flex-1 min-w-[260px]">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold text-kumo-strong">{label}</h2>
          <span className="text-2xl font-semibold text-kumo-strong tabular-nums">{credits(bucket.balanceMicroUsd)}</span>
        </div>
        <p className="text-xs text-kumo-subtle mt-0.5">Credits remaining</p>

        {bucket.monthlyGrantMicroUsd > 0 && (
          <div className="mt-4">
            <div className="h-1.5 rounded-full bg-kumo-tint overflow-hidden">
              <div
                className="h-full rounded-full bg-kumo-brand transition-all"
                style={{ width: `${Math.round(grantUsed * 100)}%` }}
              />
            </div>
            <p className="text-xs text-kumo-subtle mt-2">
              {credits(bucket.monthlyGrantMicroUsd - bucket.allowanceMicroUsd)} of the{' '}
              {credits(bucket.monthlyGrantMicroUsd)} monthly credits used · resets {shortDate(overview.periodEnd)}
            </p>
          </div>
        )}

        <div className="mt-3 space-y-1 text-xs text-kumo-subtle">
          <p>Spent this period: <span className="text-kumo-default font-medium">{credits(spentMicroUsd)} credits</span></p>
          {bucket.topupMicroUsd > 0 && (
            <p>Top-up credits (roll over): <span className="text-kumo-default font-medium">{credits(bucket.topupMicroUsd)}</span></p>
          )}
          {footnote && <p>{footnote}</p>}
        </div>

        {!isEnterprise && (
          <div className="mt-5 pt-4 border-t border-kumo-line">
            <p className="text-xs font-medium text-kumo-subtle mb-2">Top up</p>
            <div className="flex gap-2 flex-wrap">
              {TOPUP_PRESETS_CENTS.map((cents) => (
                <Button
                  key={cents}
                  variant="secondary"
                  size="sm"
                  loading={topupBusy === `${creditType}:${cents}`}
                  disabled={topupBusy !== null}
                  onClick={() => void handleTopup(creditType, cents)}
                >
                  {creditsFromCents(cents)} · {usdFromCents(cents)}
                </Button>
              ))}
            </div>
            <p className="text-xs text-kumo-subtle mt-2">
              One-time credit purchase through our secure checkout (Stripe). Top-ups never expire.
            </p>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Plan */}
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-lg font-semibold text-kumo-strong">{overview.planName} plan</h2>
            {statusChip}
          </div>
          {!isEnterprise && (
            <Link
              to="/admin/$section"
              params={{ section: 'plans' }}
              className="text-sm font-medium text-kumo-brand hover:underline"
            >
              Change plan
            </Link>
          )}
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs text-kumo-subtle">Price</p>
            <p className="text-sm font-medium text-kumo-default mt-0.5">
              {overview.priceCents
                ? `${usdFromCents(overview.priceCents)} / ${overview.billingPeriod === 'annual' ? 'year' : 'month'}`
                : isEnterprise ? 'Custom' : 'Free'}
            </p>
          </div>
          <div>
            <p className="text-xs text-kumo-subtle">Teammates &amp; assistants</p>
            <p className="text-sm font-medium text-kumo-default mt-0.5">
              {memberCount != null ? memberCount : '—'}
              {overview.seatLimit != null ? ` of ${overview.seatLimit}` : ''} used
            </p>
          </div>
          <div>
            <p className="text-xs text-kumo-subtle">Credits renew</p>
            <p className="text-sm font-medium text-kumo-default mt-0.5">{shortDate(overview.periodEnd)}</p>
          </div>
        </div>
        {isEnterprise && (
          <p className="text-sm text-kumo-subtle mt-4 pt-4 border-t border-kumo-line">
            Your plan has custom AI and messaging volumes; credits are tracked below but never
            enforced. Contact your account team to change terms.
          </p>
        )}
      </div>

      {/* Credits */}
      {!isFree && (
        <div className="flex gap-6 flex-wrap">
          {creditCard('AI credits', 'ai', overview.ai, aiSpent,
            'Spent as your teammates and assistants do AI work.')}
          {creditCard('Messaging credits', 'messaging', overview.messaging, messagingSpent,
            'An email is 2 credits, WhatsApp 5, SMS 10, and voice 50 per message. Telegram and Slack are free.')}
        </div>
      )}

      {/* Usage this period */}
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <h2 className="text-lg font-semibold text-kumo-strong mb-1">Usage this period</h2>
        <p className="text-sm text-kumo-subtle mb-4">
          {shortDate(overview.periodStart)} – {shortDate(overview.periodEnd)}
        </p>
        {overview.usage.length === 0 ? (
          <p className="text-sm text-kumo-subtle">No metered usage yet this period.</p>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center gap-3 px-3 py-2 rounded-lg">
              <p className="flex-1 text-xs font-medium uppercase tracking-wide text-kumo-inactive">Item</p>
              <p className="w-24 text-right text-xs font-medium uppercase tracking-wide text-kumo-inactive">Count</p>
              <p className="w-24 text-right text-xs font-medium uppercase tracking-wide text-kumo-inactive">Credits</p>
            </div>
            {overview.usage
              .toSorted((a, b) => b.costMicroUsd - a.costMicroUsd)
              .map((row) => (
                <div
                  key={`${row.kind}:${row.channel ?? ''}:${row.direction ?? ''}`}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-kumo-tint transition-colors"
                >
                  <p className="flex-1 text-sm text-kumo-default">
                    {row.kind === 'ai'
                      ? 'AI requests'
                      : `${row.channel ?? 'channel'} messages${row.direction ? ` (${row.direction})` : ''}`}
                  </p>
                  <p className="w-24 text-right text-sm text-kumo-subtle tabular-nums">{row.quantity}</p>
                  <p className="w-24 text-right text-sm text-kumo-default tabular-nums">{credits(row.costMicroUsd)}</p>
                </div>
              ))}
            <div className="flex items-center gap-3 px-3 py-2 rounded-lg border-t border-kumo-line mt-1">
              <p className="flex-1 text-sm font-medium text-kumo-strong">Total</p>
              <p className="w-24 text-right text-sm text-kumo-subtle tabular-nums">
                {overview.usage.reduce((sum, r) => sum + r.quantity, 0)}
              </p>
              <p className="w-24 text-right text-sm font-medium text-kumo-strong tabular-nums">
                {credits(aiSpent + messagingSpent)}
              </p>
            </div>
          </div>
        )}
        {messageCount > 0 && messagingSpent === 0 && (
          <p className="text-xs text-kumo-subtle mt-3">
            Messages on free channels are counted for visibility but cost nothing.
          </p>
        )}
      </div>
    </div>
  )
}
