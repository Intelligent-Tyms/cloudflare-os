// Shared helpers for the admin Billing & usage and Plans panels.

// Credits are the display unit: 1 credit = $0.001, so the micro-USD ledger converts at
// 1,000 micro-USD per credit and plan cents at 10 credits per cent. Money the user
// actually pays (plan prices, top-up purchases) stays in dollars.
export const credits = (microUsd: number) => {
  const value = microUsd / 1_000
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return rounded.toLocaleString()
}
export const creditsFromCents = (cents: number) => (cents * 10).toLocaleString()
export const usdFromCents = (cents: number) =>
  cents % 100 === 0 ? `$${(cents / 100).toLocaleString()}` : `$${(cents / 100).toFixed(2)}`
export const shortDate = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

export const STATUS_STYLES: Record<string, string> = {
  active: 'bg-kumo-success/10 text-kumo-success',
  trialing: 'bg-kumo-info/10 text-kumo-info',
  past_due: 'bg-kumo-warning/10 text-kumo-warning',
  paused: 'bg-kumo-warning/10 text-kumo-warning',
  cancelled: 'bg-kumo-danger/10 text-kumo-danger',
  incomplete: 'bg-kumo-tint text-kumo-subtle',
}

// Stripe checkout returns before its webhook applies the purchase, so the page would show
// the pre-payment plan and balances. These sessionStorage stashes are written just before
// redirecting to checkout and read back on the ?plan=success / ?topup=success return, so
// we know what to poll for and when it has landed.
export const PENDING_PLAN_KEY = 'tyms.billing.pendingPlan'
export const PENDING_TOPUP_KEY = 'tyms.billing.pendingTopup'
export const CHECKOUT_POLL_MS = 2_500
export const CHECKOUT_POLL_ATTEMPTS = 24

export const takeStash = <T,>(key: string): T | null => {
  try {
    const raw = sessionStorage.getItem(key)
    sessionStorage.removeItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
