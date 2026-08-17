import { useState, useEffect } from 'react'
import { RpcStub } from 'capnweb'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { AdminApi, BillingOverview, BillingCreditType, BillingPlanOption, TeamView } from '@gadgets/workshop-shared/api'

// Admin → Billing and usage: the plan, teammate/assistant limits, credit balances, and the
// current period's usage. Everything proxies through AdminApi to the central billing
// directory; a null overview means this deployment has none configured.

// Credits are the display unit: 1 credit = $0.001, so the micro-USD ledger converts at
// 1,000 micro-USD per credit and plan cents at 10 credits per cent. Money the user
// actually pays (plan prices, top-up purchases) stays in dollars.
const credits = (microUsd: number) => {
  const value = microUsd / 1_000
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return rounded.toLocaleString()
}
const creditsFromCents = (cents: number) => (cents * 10).toLocaleString()
const usdFromCents = (cents: number) =>
  cents % 100 === 0 ? `$${(cents / 100).toLocaleString()}` : `$${(cents / 100).toFixed(2)}`
const shortDate = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

const TOPUP_PRESETS_CENTS = [10_00, 25_00, 50_00]

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-kumo-success/10 text-kumo-success',
  trialing: 'bg-kumo-info/10 text-kumo-info',
  past_due: 'bg-kumo-warning/10 text-kumo-warning',
  paused: 'bg-kumo-warning/10 text-kumo-warning',
  cancelled: 'bg-kumo-danger/10 text-kumo-danger',
  incomplete: 'bg-kumo-tint text-kumo-subtle',
}

export default function AdminBillingPanel({ admin }: { admin: RpcStub<AdminApi> }) {
  const toasts = useKumoToastManager()
  const [overview, setOverview] = useState<BillingOverview | null>(null)
  const [team, setTeam] = useState<TeamView | null>(null)
  const [plans, setPlans] = useState<BillingPlanOption[]>([])
  const [loading, setLoading] = useState(true)
  const [topupBusy, setTopupBusy] = useState<string | null>(null)
  const [planBusy, setPlanBusy] = useState<string | null>(null)
  // Billing period for a plan switch; seeded from the current subscription once loaded.
  const [periodChoice, setPeriodChoice] = useState<'monthly' | 'annual'>('monthly')
  // Plan the user picked on the pricing page before signing up (?intent=<code> deep link,
  // carried through onboarding + first login): highlight that card so their choice is waiting.
  const [intentPlan, setIntentPlan] = useState<string | null>(null)

  const reload = async () => {
    const [billing, teamView, planList] = await Promise.all([
      admin.getBillingOverview().catch(() => null),
      admin.getTeam().catch(() => null),
      admin.listBillingPlans().catch(() => [] as BillingPlanOption[]),
    ])
    setOverview(billing)
    setTeam(teamView)
    setPlans(planList)
    return billing
  }

  useEffect(() => {
    let cancelled = false
    reload().then((billing) => {
      if (cancelled) return
      if (billing?.billingPeriod === 'annual') setPeriodChoice('annual')
      setLoading(false)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin])

  // Returning from a top-up or plan-change checkout: acknowledge and clean the URL. The
  // balance/plan updates once Stripe's webhook lands, usually within seconds.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const outcome = params.get('topup')
    const planOutcome = params.get('plan')
    const intent = params.get('intent')
    if (intent) {
      setIntentPlan(intent)
      if (params.get('period') === 'annual') setPeriodChoice('annual')
    }
    if (!outcome && !planOutcome && !intent) return
    if (outcome === 'success') {
      toasts.add({ title: 'Top-up complete. Your balance updates momentarily.', variant: 'success' })
    } else if (outcome === 'cancelled') {
      toasts.add({ title: 'Top-up cancelled.', variant: 'info' })
    }
    if (planOutcome === 'success') {
      toasts.add({ title: 'Payment complete. Your new plan activates momentarily.', variant: 'success' })
    } else if (planOutcome === 'cancelled') {
      toasts.add({ title: 'Plan change cancelled.', variant: 'info' })
    }
    params.delete('topup')
    params.delete('plan')
    params.delete('intent')
    params.delete('period')
    const query = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleTopup = async (creditType: BillingCreditType, amountCents: number) => {
    const key = `${creditType}:${amountCents}`
    setTopupBusy(key)
    try {
      const base = `${window.location.origin}${window.location.pathname}`
      const url = await admin.createTopupCheckout(
        creditType, amountCents, `${base}?topup=success`, `${base}?topup=cancelled`)
      window.location.assign(url)
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Could not start checkout', variant: 'error' })
      setTopupBusy(null)
    }
  }

  const handlePlanChange = async (target: BillingPlanOption) => {
    if (!overview) return
    const current = plans.find((p) => p.code === overview.planCode)
    const downgrade = target.priceCents < (current?.priceCents ?? 0)
    const confirmText =
      target.priceCents === 0
        ? `Switch to the ${target.name} plan? Your paid subscription is cancelled immediately, ` +
          `remaining monthly credit allowances are removed (purchased top-ups stay), and ` +
          `assistants move to daily limits.`
        : downgrade
          ? `Switch to the ${target.name} plan? Your credit allowances are reduced to the ` +
            `${target.name} plan's limits immediately.`
          : null
    if (confirmText && !confirm(confirmText)) return
    setPlanBusy(target.code)
    try {
      const base = `${window.location.origin}${window.location.pathname}`
      const billingPeriod = target.annualAvailable && periodChoice === 'annual' ? 'annual' : 'monthly'
      const result = await admin.changePlan(
        target.code, billingPeriod, `${base}?plan=success`, `${base}?plan=cancelled`)
      if (!result.applied && result.checkoutUrl) {
        window.location.assign(result.checkoutUrl)
        return
      }
      toasts.add({ title: `You're now on the ${target.name} plan.`, variant: 'success' })
      await reload()
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Plan change failed', variant: 'error' })
    } finally {
      setPlanBusy(null)
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
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-semibold text-kumo-strong">{overview.planName} plan</h2>
          {statusChip}
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

      {/* Change plan */}
      {!isEnterprise && plans.length > 0 && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
            <h2 className="text-lg font-semibold text-kumo-strong">Change plan</h2>
            <div className="flex rounded-lg border border-kumo-line overflow-hidden">
              {(['monthly', 'annual'] as const).map((period) => (
                <button
                  key={period}
                  type="button"
                  onClick={() => setPeriodChoice(period)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    periodChoice === period
                      ? 'bg-kumo-brand/10 text-kumo-brand'
                      : 'text-kumo-subtle hover:bg-kumo-tint'
                  }`}
                >
                  {period === 'monthly' ? 'Monthly' : 'Annual'}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((p) => {
              const annual = periodChoice === 'annual' && p.annualAvailable
              const isCurrent =
                overview.planCode === p.code &&
                (p.priceCents === 0 || overview.billingPeriod === (annual ? 'annual' : 'monthly'))
              const isIntent = !isCurrent && intentPlan === p.code
              return (
                <div
                  key={p.code}
                  className={`rounded-lg border p-4 flex flex-col gap-3 ${
                    isCurrent
                      ? 'border-kumo-brand bg-kumo-brand/5'
                      : isIntent
                        ? 'border-kumo-brand ring-1 ring-kumo-brand'
                        : 'border-kumo-line'
                  }`}
                >
                  <div>
                    <p className="text-sm font-semibold text-kumo-strong">{p.name}</p>
                    <p className="text-sm text-kumo-default mt-1">
                      {p.priceCents === 0
                        ? 'Free'
                        : annual
                          ? `${usdFromCents(p.annualPriceCents ?? 0)}/year`
                          : `${usdFromCents(p.priceCents)}/month`}
                    </p>
                  </div>
                  <ul className="text-xs text-kumo-subtle space-y-1 flex-1">
                    <li>
                      {p.seatLimit != null
                        ? `${p.seatLimit} teammate${p.seatLimit === 1 ? '' : 's'}, each with their own assistant`
                        : 'Custom teammate count'}
                    </li>
                    <li>
                      {p.aiCreditCentsMonthly > 0
                        ? `${creditsFromCents(p.aiCreditCentsMonthly)} AI credits / month`
                        : 'AI with daily limits'}
                    </li>
                    {p.messagingCreditCentsMonthly > 0 && (
                      <li>{creditsFromCents(p.messagingCreditCentsMonthly)} messaging credits / month</li>
                    )}
                  </ul>
                  <Button
                    variant={isCurrent ? 'ghost' : isIntent ? 'primary' : 'secondary'}
                    size="sm"
                    disabled={isCurrent || planBusy !== null}
                    loading={planBusy === p.code}
                    onClick={() => void handlePlanChange(p)}
                  >
                    {isCurrent ? 'Current plan' : `Switch to ${p.name}`}
                  </Button>
                </div>
              )
            })}
          </div>
          <p className="text-xs text-kumo-subtle mt-4">
            Upgrades take effect immediately with a prorated charge; downgrades apply immediately
            and reduce your credit allowances. Need more than the Plus plan?{' '}
            <a href="https://tyms.ai/contact" target="_blank" rel="noreferrer" className="text-kumo-brand underline">
              Talk to us
            </a>{' '}
            about a Custom plan.
          </p>
        </div>
      )}

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
