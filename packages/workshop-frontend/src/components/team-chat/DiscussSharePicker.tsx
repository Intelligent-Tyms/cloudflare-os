import { useEffect, useMemo, useState } from 'react'
import { Dialog, useKumoToastManager } from '@cloudflare/kumo'
import type { Channel as StreamChannel } from 'stream-chat'
import { Users } from 'lucide-react'
import { PersonAvatar } from '../PersonAvatar'
import { logRpcFailure } from '../../rpcErrors'
import type { DiscussContextValue } from './discuss-context'
import { SearchField, WORKSPACE_ATTACHMENT_TYPE, describeConversation } from './discuss-shared'
import type { WorkspaceAttachment } from './discuss-shared'

// "Send to Discuss": pick a conversation (or a teammate, which starts a DM) and post a card
// linking to a workspace. The message is sent from the browser as the caller, like any other
// message; the card is a custom attachment the Discuss surfaces render.

export default function DiscussSharePicker({
  open, onClose, discuss, workspaceId, title,
}: {
  open: boolean
  onClose: () => void
  discuss: DiscussContextValue
  workspaceId: string
  title: string
}) {
  const { client, session, teammates, api } = discuss
  const toasts = useKumoToastManager()
  const [query, setQuery] = useState('')
  const [note, setNote] = useState('')
  const [channels, setChannels] = useState<StreamChannel[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setChannels(null)
    client.queryChannels(
      { type: 'messaging', team: session.team, members: { $in: [session.userId] } },
      { last_message_at: -1 },
      { limit: 30, state: true, watch: false },
    ).then((list) => { if (!cancelled) setChannels(list) })
      .catch((err) => { console.warn('Discuss: could not list conversations', err); if (!cancelled) setChannels([]) })
    return () => { cancelled = true }
  }, [open, client, session.team, session.userId])

  const q = query.trim().toLowerCase()
  const rows = useMemo(() => {
    const conversations = (channels ?? []).map((c) => ({ kind: 'channel' as const, channel: c, info: describeConversation(c, session.userId, teammates) }))
    const dmEmails = new Set(conversations.filter((r) => r.info.kind === 'dm').map((r) => (r.info as { email: string | null }).email))
    const people = (teammates.list ?? []).filter((t) => !dmEmails.has(t.email)).map((t) => ({ kind: 'teammate' as const, teammate: t }))
    const all = [...conversations, ...people]
    if (!q) return all
    return all.filter((r) => (r.kind === 'channel' ? r.info.title : `${r.teammate.name} ${r.teammate.email}`).toLowerCase().includes(q))
  }, [channels, teammates, session.userId, q])

  const send = async (key: string, resolve: () => Promise<StreamChannel>, label: string) => {
    setBusy(key)
    try {
      const channel = await resolve()
      const card: WorkspaceAttachment = { type: WORKSPACE_ATTACHMENT_TYPE, title, workspace_id: workspaceId }
      const text = note.trim() ? `${note.trim()}\n${location.origin}/workspace/${workspaceId}` : `${location.origin}/workspace/${workspaceId}`
      await channel.sendMessage({ text, attachments: [card as unknown as Record<string, unknown>] })
      toasts.add({ title: `Sent to ${label}`, variant: 'success', actionProps: { children: 'Open', onClick: () => discuss.open(channel.cid) } })
      onClose()
    } catch (err) {
      logRpcFailure('Send to Discuss failed:', err)
      toasts.add({ title: err instanceof Error ? err.message : 'Could not send', variant: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next: boolean) => { if (!next) onClose() }}>
      <Dialog className="max-w-md">
        <div className="p-5 flex flex-col gap-3">
          <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
            Send to Discuss
          </Dialog.Title>
          <Dialog.Description className="text-[13px] leading-[18px] text-kumo-subtle">
            Share <span className="font-medium text-kumo-default">{title || 'this workspace'}</span> with a conversation or a teammate.
          </Dialog.Description>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note (optional)"
            maxLength={500}
            className="h-9 px-2.5 rounded-md border border-kumo-line bg-kumo-base text-sm text-kumo-default placeholder:text-kumo-inactive outline-none focus:border-kumo-ring"
          />
          <div className="flex">
            <SearchField value={query} onChange={setQuery} placeholder="Search conversations and teammates" autoFocus />
          </div>
          <div className="max-h-72 overflow-y-auto -mx-2">
            {channels === null && <div className="px-4 py-6 text-sm text-kumo-subtle">Loading…</div>}
            {channels !== null && rows.length === 0 && <div className="px-4 py-6 text-sm text-kumo-subtle">No matches.</div>}
            {rows.map((row) => {
              if (row.kind === 'channel') {
                const { channel, info } = row
                const key = channel.cid
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => send(key, async () => channel, info.title)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-kumo-tint text-left disabled:opacity-60"
                  >
                    {info.kind === 'dm' && info.email
                      ? <PersonAvatar api={api} userId={info.email} name={info.title} size={32} />
                      : (
                        <span className="w-8 h-8 rounded-full bg-kumo-tint text-kumo-subtle inline-flex items-center justify-center shrink-0">
                          <Users size={15} />
                        </span>
                      )}
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-kumo-default truncate">{info.title}</span>
                      <span className="block text-xs text-kumo-subtle">{info.kind === 'dm' ? 'Direct message' : `${info.memberCount} members`}</span>
                    </span>
                    <span className="text-xs font-medium text-kumo-default">{busy === key ? 'Sending…' : 'Send'}</span>
                  </button>
                )
              }
              const { teammate } = row
              const key = `t:${teammate.streamId}`
              return (
                <button
                  key={key}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => send(key, async () => {
                    const { cid } = await api.createTeamChatChannel([teammate.streamId])
                    const [type, id] = cid.split(':')
                    const channel = client.channel(type, id)
                    await channel.watch()
                    return channel
                  }, teammate.name)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-kumo-tint text-left disabled:opacity-60"
                >
                  <PersonAvatar api={api} userId={teammate.email} name={teammate.name} size={32} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-kumo-default truncate">{teammate.name}</span>
                    <span className="block text-xs text-kumo-subtle truncate">{teammate.email}</span>
                  </span>
                  <span className="text-xs font-medium text-kumo-default">{busy === key ? 'Sending…' : 'Send'}</span>
                </button>
              )
            })}
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
