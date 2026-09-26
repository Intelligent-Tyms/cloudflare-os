import { useState, useEffect } from 'react'
import { RpcStub } from 'capnweb'
import { Link } from '@tanstack/react-router'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import {
  AdminApi, BillingCreditType, BillingInvoice, BillingOverview, BillingPaymentDetails, TeamView,
} from '@gadgets/workshop-shared/api'
import { TabButton } from './TabButton'
import {
  credits, creditsFromCents, usdFromCents, shortDate, STATUS_STYLES,
  PENDING_TOPUP_KEY, CHECKOUT_POLL_MS, CHECKOUT_POLL_ATTEMPTS, takeStash,
} from './billing/billingFormat'

// Admin → Billing and usage: four tabs — Overview (plan + credit balances + top-ups),
// Usage (the period's metered usage), Invoices, and Payment details (card on file +
// Stripe billing portal). Everything proxies through AdminApi to the central billing
// directory; a null overview means this deployment has none configured. Comparing and
// switching plans lives on its own page (Admin → Plans, AdminPlansPanel).

const TOPUP_PRESETS_CENTS = [10_00, 25_00, 50_00]
const DAY_MS = 24 * 60 * 60 * 1000

type PendingTopup = { creditType: BillingCreditType; topupMicroUsd: number }

type BillingTab = 'overview' | 'usage' | 'invoices' | 'payment'
const TABS: { id: BillingTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'usage', label: 'Usage' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'payment', label: 'Payment details' },
]

const initialTab = (): BillingTab => {
  const tab = new URLSearchParams(window.location.search).get('tab')
  return TABS.some((t) => t.id === tab) ? (tab as BillingTab) : 'overview'
}

const INVOICE_STATUS_STYLES: Record<string, string> = {
  paid: 'bg-kumo-success/10 text-kumo-success',
  open: 'bg-kumo-warning/10 text-kumo-warning',
  uncollectible: 'bg-kumo-danger/10 text-kumo-danger',
  void: 'bg-kumo-tint text-kumo-subtle',
}

const invoiceAmount = (cents: number, currency: string) =>
  currency.toLowerCase() === 'usd'
    ? usdFromCents(cents)
    : `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`

const cardBrand = (brand: string) =>
  brand.length <= 4 ? brand.toUpperCase() : brand.charAt(0).toUpperCase() + brand.slice(1)

export default function AdminBillingPanel({ admin }: { admin: RpcStub<AdminApi> }) {
  const toasts = useKumoToastManager()
  const [tab, setTab] = useState<BillingTab>(initialTab)
  const [overview, setOverview] = useState<BillingOverview | null>(null)
  const [team, setTeam] = useState<TeamView | null>(null)
  const [loading, setLoading] = useState(true)
  const [topupBusy, setTopupBusy] = useState<string | null>(null)
  // Invoices and payment details hit the billing provider, so they load lazily on the
  // first visit to their tab. null/undefined = not fetched yet.
  const [invoices, setInvoices] = useState<BillingInvoice[] | null>(null)
  const [invoicesError, setInvoicesError] = useState<string | null>(null)
  const [payment, setPayment] = useState<BillingPaymentDetails | null | undefined>(undefined)
  const [paymentError, setPaymentError] = useState<string | null>(null)
  const [portalBusy, setPortalBusy] = useState(false)

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

  const selectTab = (next: BillingTab) => {
    setTab(next)
    const params = new URLSearchParams(window.location.search)
    if (next === 'overview') params.delete('tab')
    else params.set('tab', next)
    const query = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''))
  }

  useEffect(() => {
    let cancelled = false
    if (tab === 'invoices' && invoices === null && invoicesError === null) {
      admin.listBillingInvoices()
        .then((rows) => { if (!cancelled) setInvoices(rows) })
        .catch((err) => {
          if (!cancelled) setInvoicesError(err instanceof Error ? err.message : 'Could not load invoices')
        })
    }
    if (tab === 'payment' && payment === undefined && paymentError === null) {
      admin.getBillingPaymentDetails()
        .then((details) => { if (!cancelled) setPayment(details) })
        .catch((err) => {
          if (!cancelled) setPaymentError(err instanceof Error ? err.message : 'Could not load payment details')
        })
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

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

  const handlePortal = async () => {
    setPortalBusy(true)
    try {
      const url = await admin.createBillingPortalSession(
        `${window.location.origin}${window.location.pathname}?tab=payment`)
      window.location.assign(url)
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Could not open the billing portal', variant: 'error' })
      setPortalBusy(false)
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

  const trialing = overview.subscriptionStatus === 'trialing'
  const statusChip = (
    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[overview.subscriptionStatus] ?? 'bg-kumo-tint text-kumo-subtle'}`}>
      {trialing ? 'free trial' : overview.subscriptionStatus.replace('_', ' ')}
    </span>
  )

  // Low-credit thresholds as a fraction of what the period started with (allowance plus
  // top-ups). Same cut-offs as the top bar nudge so the two never disagree.
  const LOW_FRACTION = 0.2
  const CRITICAL_FRACTION = 0.05

  // One card per credit type, two sections: the monthly allowance (resets) and top-ups (roll
  // over). The hero number is the sum, because that is what the enforcement gate checks.
  const creditCard = (
    label: string,
    creditType: BillingCreditType,
    bucket: BillingOverview['ai'],
    footnote?: string,
  ) => {
    const grant = bucket.monthlyGrantMicroUsd
    const total = grant + bucket.topupMicroUsd
    const balance = Math.max(0, bucket.balanceMicroUsd)
    const used = Math.max(0, grant - bucket.allowanceMicroUsd)
    const allowanceFraction = grant > 0 ? Math.min(1, Math.max(0, bucket.allowanceMicroUsd) / grant) : 0
    const remainingFraction = total > 0 ? Math.min(1, balance / total) : 0
    const level: 'ok' | 'low' | 'critical' | 'out' =
      balance <= 0 ? 'out'
      : remainingFraction < CRITICAL_FRACTION ? 'critical'
      : remainingFraction < LOW_FRACTION ? 'low'
      : 'ok'
    const warn = !isEnterprise && level !== 'ok'
    // Literal class strings so Tailwind sees them.
    const toneText = level === 'low' ? 'text-kumo-warning' : 'text-kumo-danger'
    const toneChip = level === 'low' ? 'bg-kumo-warning/10 text-kumo-warning' : 'bg-kumo-danger/10 text-kumo-danger'
    const toneBar = level === 'low' ? 'bg-kumo-warning' : 'bg-kumo-danger'
    const daysLeft = Math.max(0, Math.ceil((overview.periodEnd - Date.now()) / DAY_MS))
    const renews = daysLeft === 0 ? 'Renews today'
      : daysLeft === 1 ? 'Renews tomorrow' : `Renews in ${daysLeft} days`

    // Projected run-out: spend so far in the period, extrapolated. Only worth saying when it
    // lands before the allowance renews.
    const elapsedDays = Math.max(1, (Date.now() - overview.periodStart) / DAY_MS)
    const perDay = used / elapsedDays
    const runOutAt = perDay > 0 ? Date.now() + (balance / perDay) * DAY_MS : null
    const runsOutEarly = runOutAt !== null && balance > 0 && runOutAt < overview.periodEnd

    const sectionTitle = 'text-xs font-medium text-kumo-default'
    const meta = 'text-xs text-kumo-subtle'

    return (
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6 flex-1 min-w-[260px]">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold text-kumo-strong">{label}</h2>
          <span className={`text-2xl font-semibold tabular-nums ${warn ? toneText : 'text-kumo-strong'}`}>
            {credits(balance)}
          </span>
        </div>
        <p className={`${meta} mt-0.5 flex items-center gap-2`}>
          Available now
          {warn && (
            <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${toneChip}`}>
              {level === 'out' ? 'Out' : level === 'critical' ? 'Almost out' : 'Low'}
            </span>
          )}
        </p>

        {grant > 0 && (
          <div className="mt-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className={sectionTitle}>Monthly allowance</p>
              <p className={`${meta} tabular-nums`}>{credits(bucket.allowanceMicroUsd)} of {credits(grant)}</p>
            </div>
            <div
              className="mt-2 h-1.5 rounded-full bg-kumo-tint overflow-hidden"
              role="progressbar"
              aria-label={`${label} monthly allowance remaining`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(allowanceFraction * 100)}
            >
              <div
                className={`h-full rounded-full transition-all ${warn ? toneBar : 'bg-kumo-brand'}`}
                style={{ width: `${Math.round(allowanceFraction * 100)}%` }}
              />
            </div>
            <p className={`${meta} mt-2`}>{renews} · {shortDate(overview.periodEnd)}</p>
            {!isEnterprise && runsOutEarly && runOutAt !== null && (
              <p className="text-xs text-kumo-warning mt-1">
                At this pace, runs out around {shortDate(runOutAt)}.
              </p>
            )}
          </div>
        )}

        {!isEnterprise && (
          <div className="mt-5 pt-4 border-t border-kumo-line">
            <div className="flex items-baseline justify-between gap-3">
              <p className={sectionTitle}>Top-ups</p>
              <p className={`${meta} tabular-nums`}>
                {bucket.topupMicroUsd > 0 ? `${credits(bucket.topupMicroUsd)} · Never expire` : 'None'}
              </p>
            </div>
            <div className="mt-2 flex gap-2 flex-wrap">
              {TOPUP_PRESETS_CENTS.map((cents) => (
                <Button
                  key={cents}
                  variant="secondary"
                  size="sm"
                  loading={topupBusy === `${creditType}:${cents}`}
                  disabled={topupBusy !== null}
                  onClick={() => void handleTopup(creditType, cents)}
                >
                  Add {creditsFromCents(cents)} · {usdFromCents(cents)}
                </Button>
              ))}
            </div>
            <p className={`${meta} mt-2`}>One-time payment through Stripe.</p>
          </div>
        )}

        {footnote && <p className={`${meta} mt-4`}>{footnote}</p>}
      </div>
    )
  }

  const overviewTab = (
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
        {overview.cardExpiresBeforeNextCharge && overview.card && (
          <p className="text-sm text-kumo-warning mt-4 pt-4 border-t border-kumo-line">
            Your {cardBrand(overview.card.brand)} ending {overview.card.last4} expires{' '}
            {String(overview.card.expMonth).padStart(2, '0')}/{overview.card.expYear}, before your next
            payment{trialing && overview.trialEndsAt ? ` on ${shortDate(overview.trialEndsAt)}` : overview.periodEnd ? ` on ${shortDate(overview.periodEnd)}` : ''}.{' '}
            <button type="button" onClick={() => setTab('payment')} className="text-kumo-brand underline">
              Update your card
            </button>{' '}
            so the payment goes through.
          </p>
        )}
        {overview.cancelAt ? (
          <p className="text-sm text-kumo-warning mt-4 pt-4 border-t border-kumo-line">
            Your plan ends {shortDate(overview.cancelAt)}. Undo this under Plans.
          </p>
        ) : trialing && overview.trialEndsAt && !overview.card ? (
          <p className="text-sm text-kumo-warning mt-4 pt-4 border-t border-kumo-line">
            Free trial until {shortDate(overview.trialEndsAt)}.{' '}
            <button type="button" onClick={() => setTab('payment')} className="text-kumo-brand underline">
              Add a card
            </button>{' '}
            to keep your workspace after that. Adding one also raises your trial credits.
          </p>
        ) : trialing && overview.trialEndsAt ? (
          <p className="text-sm text-kumo-subtle mt-4 pt-4 border-t border-kumo-line">
            Free trial until {shortDate(overview.trialEndsAt)}. Your card is charged then and
            your full monthly credits arrive. Trial credits are a smaller allowance.
          </p>
        ) : null}
        {isEnterprise && (
          <p className="text-sm text-kumo-subtle mt-4 pt-4 border-t border-kumo-line">
            Your plan has custom AI and messaging volumes; credits are tracked but never
            enforced. Contact your account team to change terms.
          </p>
        )}
      </div>

      {/* Credits */}
      {!isFree && (
        <div className="flex gap-6 flex-wrap">
          {creditCard('AI credits', 'ai', overview.ai)}
          {creditCard('Messaging credits', 'messaging', overview.messaging,
            'Per message: email 2, WhatsApp 5, SMS 10, voice 50. Telegram and Slack are free.')}
        </div>
      )}
    </div>
  )

  const usageTab = (
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
  )

  const invoicesTab = (
    <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
      <h2 className="text-lg font-semibold text-kumo-strong mb-4">Invoices</h2>
      {invoicesError ? (
        <p className="text-sm text-kumo-danger">{invoicesError}</p>
      ) : invoices === null ? (
        <p className="text-sm text-kumo-subtle">Loading invoices…</p>
      ) : invoices.length === 0 ? (
        <p className="text-sm text-kumo-subtle">
          No invoices yet. They appear here once your workspace is on a paid plan.
        </p>
      ) : (
        <div className="space-y-1">
          <div className="hidden sm:flex items-center gap-3 px-3 py-2 rounded-lg">
            <p className="w-28 text-xs font-medium uppercase tracking-wide text-kumo-inactive">Date</p>
            <p className="flex-1 text-xs font-medium uppercase tracking-wide text-kumo-inactive">Description</p>
            <p className="w-20 text-right text-xs font-medium uppercase tracking-wide text-kumo-inactive">Amount</p>
            <p className="w-20 text-right text-xs font-medium uppercase tracking-wide text-kumo-inactive">Status</p>
            <p className="w-24 text-right text-xs font-medium uppercase tracking-wide text-kumo-inactive">Links</p>
          </div>
          {invoices.map((inv) => (
            <div
              key={inv.id}
              className="flex flex-wrap sm:flex-nowrap items-center gap-3 px-3 py-2 rounded-lg hover:bg-kumo-tint transition-colors"
            >
              <p className="w-28 text-sm text-kumo-default">{shortDate(inv.createdAt)}</p>
              <p className="flex-1 min-w-[140px] text-sm text-kumo-default truncate">
                {inv.description ?? inv.number ?? 'Invoice'}
              </p>
              <p className="w-20 text-right text-sm text-kumo-default tabular-nums">
                {invoiceAmount(inv.amountCents, inv.currency)}
              </p>
              <p className="w-20 text-right">
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${INVOICE_STATUS_STYLES[inv.status] ?? 'bg-kumo-tint text-kumo-subtle'}`}>
                  {inv.status}
                </span>
              </p>
              <p className="w-24 text-right text-sm space-x-2">
                {inv.hostedUrl && (
                  <a href={inv.hostedUrl} target="_blank" rel="noreferrer" className="text-kumo-brand hover:underline">
                    View
                  </a>
                )}
                {inv.pdfUrl && (
                  <a href={inv.pdfUrl} target="_blank" rel="noreferrer" className="text-kumo-brand hover:underline">
                    PDF
                  </a>
                )}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  const paymentTab = (
    <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
      <h2 className="text-lg font-semibold text-kumo-strong mb-4">Payment details</h2>
      {paymentError ? (
        <p className="text-sm text-kumo-danger">{paymentError}</p>
      ) : payment === undefined ? (
        <p className="text-sm text-kumo-subtle">Loading payment details…</p>
      ) : payment === null ? (
        <p className="text-sm text-kumo-subtle">
          No payment method on file. One is added with your first payment.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs text-kumo-subtle">Payment method</p>
              <p className="text-sm font-medium text-kumo-default mt-0.5">
                {payment.card
                  ? `${cardBrand(payment.card.brand)} ending ${payment.card.last4}`
                  : 'None on file'}
              </p>
              {payment.card && (
                <p className={`text-xs mt-0.5 ${overview.cardExpiresBeforeNextCharge ? 'text-kumo-warning' : 'text-kumo-subtle'}`}>
                  Expires {String(payment.card.expMonth).padStart(2, '0')}/{payment.card.expYear}
                  {overview.cardExpiresBeforeNextCharge ? ', before your next payment. Update it below.' : ''}
                </p>
              )}
            </div>
            <div>
              <p className="text-xs text-kumo-subtle">Billing email</p>
              <p className="text-sm font-medium text-kumo-default mt-0.5">
                {payment.billingEmail ?? '—'}
              </p>
            </div>
          </div>
          <div className="pt-4 border-t border-kumo-line">
            <Button
              variant={payment.card ? 'secondary' : 'primary'}
              size="sm"
              loading={portalBusy}
              onClick={() => void handlePortal()}
            >
              {payment.card ? 'Manage payment details' : 'Add a card'}
            </Button>
            <p className="text-xs text-kumo-subtle mt-2">
              {payment.card
                ? 'Update your card, billing email, address, and tax IDs through our secure billing portal (Stripe).'
                : overview.trialEndsAt != null
                  ? 'Add a card before your trial ends to keep your workspace. It is charged when the trial ends.'
                  : 'Add a card, billing email, address, and tax IDs through our secure billing portal (Stripe).'}
            </p>
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-5 border-b border-kumo-line">
        {TABS.map((t) => (
          <TabButton key={t.id} active={tab === t.id} onClick={() => selectTab(t.id)} className="h-9">
            {t.label}
          </TabButton>
        ))}
      </div>

      {tab === 'overview' && overviewTab}
      {tab === 'usage' && usageTab}
      {tab === 'invoices' && invoicesTab}
      {tab === 'payment' && paymentTab}
    </div>
  )
}
