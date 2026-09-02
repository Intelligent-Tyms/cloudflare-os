import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Dialog, Button, Loader } from '@cloudflare/kumo'
import { Zap } from 'lucide-react'
import { BillingGateInfo } from '@gadgets/workshop-shared/api'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import { usePoolUpgradeUrl } from '../../ServerConfigContext'

interface UpgradeModalProps {
  open: boolean
  onClose: () => void
}

// Shown when an agent turn is blocked with a `usage_limit` error on a centrally billed
// deployment: the free plan's daily allowance ran out, or a paid workspace is out of AI
// credits. Admins get a straight path to the plan picker; members get a one-click way to
// ask their admins (throttled per workspace server-side). The legacy Cloudflare-limits
// deployments show OutOfCreditsModal instead — ChatInterface picks by server config.
export default function UpgradeModal({ open, onClose }: UpgradeModalProps) {
  const auth = useOptionalAuthenticatedApi()
  const navigate = useNavigate()
  // On a free pool the plan belongs to Tyms, not the member: upgrading means getting a workspace
  // of their own, which starts at the central account rather than this deployment's plans page.
  const poolUpgradeUrl = usePoolUpgradeUrl()
  // undefined = loading; null = no central billing configured.
  const [gate, setGate] = useState<BillingGateInfo | null | undefined>(undefined)
  const [requestState, setRequestState] =
    useState<'idle' | 'sending' | 'sent' | 'already'>('idle')

  useEffect(() => {
    if (!open || !auth) return
    setGate(undefined)
    setRequestState('idle')
    auth.authenticatedApi.getBillingGate()
      .then(setGate)
      .catch(() => setGate(null))
  }, [open, auth])

  const openPlans = () => {
    onClose()
    void navigate({ to: '/admin/$section', params: { section: 'plans' } })
  }

  const requestUpgrade = async () => {
    if (!auth) return
    setRequestState('sending')
    try {
      const { notified } = await auth.authenticatedApi.requestPlanUpgrade()
      setRequestState(notified ? 'sent' : 'already')
    } catch {
      setRequestState('idle')
    }
  }

  const isAdmin = auth?.isAdmin ?? false

  if (poolUpgradeUrl) {
    return (
      <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
        <Dialog className="p-6 sm:w-[520px]" size="base">
          <Dialog.Title className="text-lg font-semibold mb-2 flex items-center gap-2">
            <Zap size={22} strokeWidth={2.5} className="text-kumo-warning" />
            Upgrade your workspace
          </Dialog.Title>
          <div className="space-y-4">
            <p className="text-sm text-kumo-subtle">
              You've reached today's free limit. Upgrade to get a workspace of your own with a
              monthly credit allowance, teammates, templates, and every AI model.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={onClose}>Maybe later</Button>
              <Button variant="primary" onClick={() => window.location.assign(poolUpgradeUrl)}>
                See plans
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    )
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog className="p-6 sm:w-[520px]" size="base">
        <Dialog.Title className="text-lg font-semibold mb-2 flex items-center gap-2">
          <Zap size={22} strokeWidth={2.5} className="text-kumo-warning" />
          {gate?.isFreePlan === false ? 'Out of AI credits' : 'Upgrade your workspace'}
        </Dialog.Title>

        {gate === undefined ? (
          <div className="flex justify-center py-8"><Loader size="base" /></div>
        ) : (
          <div className="space-y-4">
            {gate === null ? (
              <p className="text-sm text-kumo-subtle">
                This workspace has reached its usage limit. Contact your administrator to
                continue.
              </p>
            ) : gate.isFreePlan ? (
              <p className="text-sm text-kumo-subtle">
                You've reached today's free limit. Upgrade for a monthly credit allowance,
                more teammates, and every AI model.
              </p>
            ) : (
              <p className="text-sm text-kumo-subtle">
                This workspace is out of AI credits. Your monthly allowance renews
                automatically, or {isAdmin ? 'you' : 'an admin'} can top up or move to a
                bigger plan now.
              </p>
            )}

            {gate !== null && !isAdmin && (
              requestState === 'sent' ? (
                <p className="text-sm text-kumo-default">
                  Your workspace admins have been notified by email.
                </p>
              ) : requestState === 'already' ? (
                <p className="text-sm text-kumo-default">
                  Your workspace admins were already notified recently.
                </p>
              ) : (
                <p className="text-sm text-kumo-subtle">
                  Only workspace admins can change the plan, but you can let them know
                  you're blocked.
                </p>
              )
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={onClose}>
                {gate !== null && (isAdmin || requestState === 'idle') ? 'Maybe later' : 'Close'}
              </Button>
              {gate !== null && isAdmin && (
                <Button variant="primary" onClick={openPlans}>
                  View plans
                </Button>
              )}
              {gate !== null && !isAdmin && requestState !== 'sent' && requestState !== 'already' && (
                <Button
                  variant="primary"
                  onClick={() => void requestUpgrade()}
                  loading={requestState === 'sending'}
                >
                  Request upgrade
                </Button>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
