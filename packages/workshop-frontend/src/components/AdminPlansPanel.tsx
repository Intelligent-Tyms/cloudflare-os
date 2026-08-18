import { useState, useEffect } from 'react'
import { RpcStub } from 'capnweb'
import { Link } from '@tanstack/react-router'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { AdminApi, BillingOverview, BillingPlanOption } from '@gadgets/workshop-shared/api'
import {
  usdFromCents, creditsFromCents, STATUS_STYLES,
  PENDING_PLAN_KEY, CHECKOUT_POLL_MS, CHECKOUT_POLL_ATTEMPTS, takeStash,
} from './billing/billingFormat'

// Admin → Plans: compare plans and switch the workspace to a new one. Split out of the
// Billing & usage page so upgrading has its own destination — every upgrade entry point
// (UpgradeModal, the free-plan top-bar nudge, pricing-page intent deep links, upgrade
// request emails) lands here. Balances, invoices, and usage stay on Billing & usage.

type PendingPlan = { code: string; name: string }

export default function AdminPlansPanel({ admin }: { admin: RpcStub<AdminApi> }) {
  const toasts = useKumoToastManager()
  const [overview, setOverview] = useState<BillingOverview | null>(null)
  const [plans, setPlans] = useState<BillingPlanOption[]>([])
  const [loading, setLoading] = useState(true)
  const [planBusy, setPlanBusy] = useState<string | null>(null)
  // Billing period for a plan switch; seeded from the current subscription once loaded.
  const [periodChoice, setPeriodChoice] = useState<'monthly' | 'annual'>('monthly')
  // Plan the user picked on the pricing page before signing up (?intent=<code> deep link,
  // carried through onboarding + first login): highlight that card so their choice is waiting.
  const [intentPlan, setIntentPlan] = useState<string | null>(null)

  const reload = async () => {
    const [billing, planList] = await Promise.all([
      admin.getBillingOverview().catch(() => null),
      admin.listBillingPlans().catch(() => [] as BillingPlanOption[]),
    ])
    setOverview(billing)
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

  // Returning from a plan-change checkout: acknowledge, clean the URL, and — when we know
  // what was bought (the pre-checkout stash) — poll until Stripe's webhook has actually
  // applied it, so the page never claims success while showing the old plan.
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
    const planOutcome = params.get('plan')
    const intent = params.get('intent')
    if (intent) {
      setIntentPlan(intent)
      if (params.get('period') === 'annual') setPeriodChoice('annual')
    }
    if (!planOutcome && !intent) return
    if (planOutcome === 'success') {
      const pending = takeStash<PendingPlan>(PENDING_PLAN_KEY)
      if (!pending) {
        toasts.add({ title: 'Payment complete. Your new plan activates momentarily.', variant: 'success' })
      } else {
        toasts.add({ title: 'Payment complete. Activating your new plan…', variant: 'success' })
        void pollUntil(
          (billing) => billing.planCode === pending.code,
          () => toasts.add({ title: `You're now on the ${pending.name} plan.`, variant: 'success' }),
          () => toasts.add({ title: 'Payment received. Your new plan can take a minute to activate.', variant: 'info' }),
        )
      }
    } else if (planOutcome === 'cancelled') {
      sessionStorage.removeItem(PENDING_PLAN_KEY)
      toasts.add({ title: 'Plan change cancelled.', variant: 'info' })
    }
    params.delete('plan')
    params.delete('intent')
    params.delete('period')
    const query = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        sessionStorage.setItem(PENDING_PLAN_KEY,
          JSON.stringify({ code: target.code, name: target.name } satisfies PendingPlan))
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
    return <p className="text-sm text-kumo-subtle">Loading plans…</p>
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

  const isEnterprise = overview.tier === 'enterprise'
  // The grid sells the paid ladder only. The free plan never gets a card — it would soak
  // up the current-plan highlight on free workspaces and describe what free includes;
  // paid workspaces that want out use the quiet downgrade link under the footnote.
  const paidPlans = plans.filter((p) => p.priceCents > 0)
  const freePlan = plans.find((p) => p.priceCents === 0)
  const currentPlan = plans.find((p) => p.code === overview.planCode)

  const statusChip = (
    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[overview.subscriptionStatus] ?? 'bg-kumo-tint text-kumo-subtle'}`}>
      {overview.subscriptionStatus.replace('_', ' ')}
    </span>
  )

  if (isEnterprise) {
    return (
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-semibold text-kumo-strong">{overview.planName} plan</h2>
          {statusChip}
        </div>
        <p className="text-sm text-kumo-subtle mt-3">
          Your plan has custom terms, including AI and messaging volumes. Contact your
          account team to change them, or{' '}
          <a href="https://tyms.ai/contact" target="_blank" rel="noreferrer" className="text-kumo-brand underline">
            talk to us
          </a>.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-lg font-semibold text-kumo-strong">
              You're on the {overview.planName} plan
            </h2>
            {statusChip}
          </div>
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
        {paidPlans.length === 0 ? (
          <p className="text-sm text-kumo-subtle">Plans are unavailable right now. Try again shortly.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {paidPlans.map((p) => {
              const annual = periodChoice === 'annual' && p.annualAvailable
              const isCurrent =
                overview.planCode === p.code &&
                overview.billingPeriod === (annual ? 'annual' : 'monthly')
              const isIntent = !isCurrent && intentPlan === p.code
              // Upgrading is the language of this page; period-only changes and downgrades
              // say what they are instead.
              const actionLabel = isCurrent
                ? 'Current plan'
                : p.code === overview.planCode
                  ? `Switch to ${annual ? 'annual' : 'monthly'} billing`
                  : p.priceCents > (currentPlan?.priceCents ?? 0)
                    ? `Upgrade to ${p.name}`
                    : `Downgrade to ${p.name}`
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
                      {annual
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
                    <li>{creditsFromCents(p.aiCreditCentsMonthly)} AI credits / month</li>
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
                    {actionLabel}
                  </Button>
                </div>
              )
            })}
          </div>
        )}
        <p className="text-xs text-kumo-subtle mt-4">
          Upgrades take effect immediately with a prorated charge; downgrades apply immediately
          and reduce your credit allowances. Need more than the Plus plan?{' '}
          <a href="https://tyms.ai/contact" target="_blank" rel="noreferrer" className="text-kumo-brand underline">
            Talk to us
          </a>{' '}
          about a Custom plan.
        </p>
        {freePlan && overview.planCode !== freePlan.code && (
          <p className="text-xs text-kumo-subtle mt-2">
            No longer need a paid plan?{' '}
            <button
              type="button"
              disabled={planBusy !== null}
              onClick={() => void handlePlanChange(freePlan)}
              className="text-kumo-brand underline disabled:opacity-50"
            >
              Downgrade to {freePlan.name}
            </button>
          </p>
        )}
      </div>

      <p className="text-sm text-kumo-subtle">
        Looking for balances, top-ups, or usage? They live under{' '}
        <Link
          to="/admin/$section"
          params={{ section: 'billing' }}
          className="text-kumo-brand hover:underline"
        >
          Billing &amp; usage
        </Link>.
      </p>
    </div>
  )
}
