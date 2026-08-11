import { useState, useEffect, FormEvent } from 'react'
import { RpcStub } from 'capnweb'
import { Input, Button, useKumoToastManager } from '@cloudflare/kumo'
import { AdminApi, TeamView, TeamRole } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'

// Admin → Teammates: membership and invitations live in the central team directory (the same
// service that gates sign-in handoffs), so every action proxies through AdminApi to it. A null
// team means this deployment has no directory configured (e.g. self-hosted password mode).
export default function AdminTeamPanel({ admin }: { admin: RpcStub<AdminApi> }) {
  const toasts = useKumoToastManager()
  const { currentUser } = useAuthenticatedApi()
  const [team, setTeam] = useState<TeamView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<TeamRole>('member')

  useEffect(() => {
    let cancelled = false
    admin.getTeam()
      .then((view) => { if (!cancelled) setTeam(view) })
      .catch(() => { if (!cancelled) setTeam(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [admin])

  const run = async (op: () => Promise<TeamView>, successTitle: string): Promise<boolean> => {
    setBusy(true)
    try {
      setTeam(await op())
      toasts.add({ title: successTitle, variant: 'success' })
      return true
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Something went wrong', variant: 'error' })
      return false
    } finally {
      setBusy(false)
    }
  }

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault()
    const email = inviteEmail.trim()
    if (!email || busy) return
    if (await run(() => admin.inviteTeammate(email, inviteRole), `Invitation sent to ${email.toLowerCase()}`)) {
      setInviteEmail('')
    }
  }

  if (loading) {
    return <p className="text-sm text-kumo-subtle">Loading team…</p>
  }

  if (!team) {
    return (
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <p className="text-sm text-kumo-subtle">
          This deployment has no central team directory configured, so there is no teammate list
          here. Account creation is controlled from the Access page.
        </p>
      </div>
    )
  }

  const daysLeft = (ts: number) => Math.max(0, Math.ceil((ts - Date.now()) / 86_400_000))
  const roleChip = (role: string) => (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-kumo-tint text-kumo-subtle border border-kumo-line">
      {role}
    </span>
  )

  const roleOptions: { value: TeamRole; label: string; hint: string }[] = [
    { value: 'member', label: 'Member', hint: 'Uses the workspace' },
    { value: 'admin', label: 'Admin', hint: 'Full access to this admin area' },
  ]

  return (
    <div className="space-y-6">
      {/* Invite */}
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <h2 className="text-lg font-semibold text-kumo-strong mb-1">Invite a teammate</h2>
        <p className="text-sm text-kumo-subtle mb-5">
          They&rsquo;ll get an email invitation; once they accept, they sign in with their own
          account and get their own assistant.
        </p>
        <form onSubmit={handleInvite}>
          <Input
            label="Email"
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="teammate@company.com"
            disabled={busy}
          />
          <p className="text-xs font-medium text-kumo-subtle mt-4 mb-2">Role</p>
          <div className="flex gap-2">
            {roleOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                disabled={busy}
                onClick={() => setInviteRole(opt.value)}
                className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                  inviteRole === opt.value
                    ? 'border-kumo-brand bg-kumo-brand/10'
                    : 'border-kumo-line hover:bg-kumo-tint'
                }`}
              >
                <span className="block text-sm font-medium text-kumo-default">{opt.label}</span>
                <span className="block text-xs text-kumo-subtle mt-0.5">{opt.hint}</span>
              </button>
            ))}
          </div>
          <div className="flex justify-end mt-4">
            <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!inviteEmail.trim()}>
              Send invitation
            </Button>
          </div>
        </form>
      </div>

      {/* Members */}
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <h2 className="text-lg font-semibold text-kumo-strong mb-4">Members</h2>
        <div className="space-y-1">
          {team.members.map((m) => {
            const isSelf = currentUser?.id === m.email
            const removable = m.role !== 'owner' && !isSelf
            return (
              <div key={m.email} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-kumo-tint transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-kumo-default truncate">
                    {m.displayName?.trim() || m.email}
                    {isSelf && <span className="ml-2 text-xs text-kumo-subtle">(you)</span>}
                  </p>
                  {m.displayName?.trim() && <p className="text-xs text-kumo-subtle truncate">{m.email}</p>}
                </div>
                {roleChip(m.role)}
                {removable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(`Remove ${m.email} from this workspace?`)) return
                      void run(() => admin.removeTeammate(m.email), `${m.email} removed`)
                    }}
                  >
                    Remove
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Pending invitations */}
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <h2 className="text-lg font-semibold text-kumo-strong mb-4">Pending invitations</h2>
        {team.invitations.length === 0 ? (
          <p className="text-sm text-kumo-subtle">No pending invitations.</p>
        ) : (
          <div className="space-y-1">
            {team.invitations.map((i) => (
              <div key={i.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-kumo-tint transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-kumo-default truncate">{i.email}</p>
                  <p className="text-xs text-kumo-subtle">
                    {i.expired ? 'Expired' : `Expires in ${daysLeft(i.expiresAt)} day${daysLeft(i.expiresAt) === 1 ? '' : 's'}`}
                    {i.invitedBy ? ` · invited by ${i.invitedBy}` : ''}
                  </p>
                </div>
                {roleChip(i.role)}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => admin.resendTeamInvitation(i.id), `Invitation resent to ${i.email}`)}
                >
                  Resend
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => admin.revokeTeamInvitation(i.id), 'Invitation revoked')}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
