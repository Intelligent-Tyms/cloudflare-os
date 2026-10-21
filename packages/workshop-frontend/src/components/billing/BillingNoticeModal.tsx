import { useEffect, useState } from 'react'
import { Dialog, Button, Loader } from '@cloudflare/kumo'
import { ExternalLink, Zap } from 'lucide-react'
import type { BillingStop } from '@gadgets/workshop-shared/api'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import { useServerConfig } from '../../ServerConfigContext'
import { billingLink } from '../../portalLinks'

interface BillingNoticeModalProps {
  open: boolean
  onClose: () => void
}

const TITLES: Record<BillingStop, string> = {
  out_of_funds: 'Out of funds',
  limit_reached: 'Limit reached',
  suspended: 'Workspace suspended',
}

const BODIES: Record<BillingStop, string> = {
  out_of_funds: 'This workspace’s balance is used up, so the assistant has paused.',
  limit_reached: 'This workspace has reached a usage limit, so the assistant has paused.',
  suspended: 'This workspace’s billing account is suspended, so the assistant has paused.',
}

/**
 * Shown when an agent turn is blocked with a `usage_limit` error. Billing lives only on
 * billing.tyms.ai, so this is a short notice and a link there: admins get the button,
 * members are told who can fix it. The reason comes from the billing gate; without central
 * billing, the generic "limit reached" wording applies.
 */
export default function BillingNoticeModal({ open, onClose }: BillingNoticeModalProps) {
  const auth = useOptionalAuthenticatedApi()
  const serverConfig = useServerConfig()
  // undefined while the gate loads; null when billing gave no reason.
  const [stop, setStop] = useState<BillingStop | null | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    if (!auth) { setStop(null); return }
    let cancelled = false
    setStop(undefined)
    auth.authenticatedApi.getBillingGate()
      .then((gate) => { if (!cancelled) setStop(gate?.stop ?? null) })
      .catch(() => { if (!cancelled) setStop(null) })
    return () => { cancelled = true }
  }, [open, auth])

  const reason: BillingStop = stop ?? 'limit_reached'
  const isAdmin = auth?.isAdmin ?? false
  const url = billingLink(serverConfig)

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog className="p-6 sm:w-[480px]" size="base">
        <Dialog.Title className="text-lg font-semibold mb-2 flex items-center gap-2">
          <Zap size={22} strokeWidth={2.5} className="text-kumo-warning" />
          {stop === undefined ? 'Billing' : TITLES[reason]}
        </Dialog.Title>
        {stop === undefined ? (
          <div className="flex justify-center py-8"><Loader size="base" /></div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-kumo-subtle">
              {BODIES[reason]}{' '}
              {isAdmin
                ? 'Billing is managed at billing.tyms.ai.'
                : 'Ask a workspace admin to sort it out at billing.tyms.ai.'}
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={onClose}>Close</Button>
              {isAdmin && (
                <Button
                  variant="primary"
                  onClick={() => {
                    onClose()
                    window.open(url, '_blank', 'noopener,noreferrer')
                  }}
                >
                  Open billing
                  <ExternalLink size={14} />
                </Button>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
