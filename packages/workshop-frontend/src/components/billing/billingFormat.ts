// Shared helpers for credit amounts (top-bar notices, Intelligence credits).

// Credits are the display unit: 1 credit = $0.001, so the micro-USD ledger converts at
// 1,000 micro-USD per credit and plan cents at 10 credits per cent. Money the user
// actually pays (plan prices, top-up purchases) stays in dollars.
export const credits = (microUsd: number) => {
  const value = microUsd / 1_000
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return rounded.toLocaleString()
}
