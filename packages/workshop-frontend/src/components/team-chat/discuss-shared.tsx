import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { DropdownMenu } from '@cloudflare/kumo'
import type { Channel as StreamChannel, Event, MessageResponse, OwnUserResponse } from 'stream-chat'
import { Attachment, ChannelList, useChatContext } from 'stream-chat-react'
import type { AttachmentProps, IconSlots } from 'stream-chat-react'
import {
  ArrowLeft, BellOff, Check, Ellipsis, Info, LayoutGrid, LogOut, Search, Sparkles, UserPlus, Users, X,
} from 'lucide-react'
import { PersonAvatar, initials } from '../PersonAvatar'
import { MENU_CONTENT, MENU_ITEM } from '../menuStyles'
import { logRpcFailure } from '../../rpcErrors'
import { MAX_GATEKEEPER_APP_PROMPT_LENGTH } from '../../gatekeeperAppNavigation'
import { useDiscuss } from './discuss-context'
import type { DiscussContextValue, TeammateIndex } from './discuss-context'

// Everything the dock and the full /discuss page share: conversation rows, the conversation
// header, the "new message" picker, the details panel (rename / members / mute / leave),
// message search, the "Ask Tyms" menu and the shared-workspace card.

// ---------------------------------------------------------------------------------------------
// Small controls

export function IconButton({
  label, onClick, children, className = '',
}: { label: string; onClick?: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-md text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint ${className}`}
    >
      {children}
    </button>
  )
}

export function UnreadPill({ count, mention }: { count: number; mention?: boolean }) {
  return (
    <span className="min-w-5 h-5 px-1.5 rounded-full bg-kumo-danger text-white text-[11px] font-semibold inline-flex items-center justify-center shrink-0">
      {mention ? '@' : count > 99 ? '99+' : count}
    </span>
  )
}

export function SearchField({
  value, onChange, placeholder, autoFocus, inputRef,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  autoFocus?: boolean
  inputRef?: React.RefObject<HTMLInputElement | null>
}) {
  return (
    <label className="flex-1 flex items-center gap-2 h-9 px-2.5 rounded-md bg-kumo-tint">
      <Search size={14} className="text-kumo-subtle shrink-0" />
      <input
        ref={inputRef}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 min-w-0 bg-transparent text-sm text-kumo-default placeholder:text-kumo-inactive outline-none"
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear" className="text-kumo-subtle hover:text-kumo-default">
          <X size={14} />
        </button>
      )}
    </label>
  )
}

// ---------------------------------------------------------------------------------------------
// Conversation list (+ message search)

export function ConversationList({ discuss, tick, activeCid, onNew }: { discuss: DiscussContextValue; tick: number; activeCid?: string; onNew: () => void }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const { session, teammates, client } = discuss
  const results = useMessageSearch(discuss, q)

  const filters = { type: 'messaging', team: session.team, members: { $in: [session.userId] } }

  return (
    <>
      <div className="px-3 py-2 shrink-0 flex">
        <SearchField value={query} onChange={setQuery} placeholder="Search conversations and messages" />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <ChannelList
          filters={filters}
          sort={{ last_message_at: -1 }}
          options={{ presence: true, state: true, watch: true, limit: 30 }}
          setActiveChannelOnMount={false}
          EmptyStateIndicator={() => <EmptyList onNew={onNew} />}
          renderChannels={(channels) => {
            const visible = q
              ? channels.filter((c) => describeConversation(c, session.userId, teammates).title.toLowerCase().includes(q))
              : channels
            return (
              <>
                {q && <SectionLabel>Conversations</SectionLabel>}
                {visible.length === 0 && (
                  <div className="px-4 py-6 text-center text-sm text-kumo-subtle">No conversations match.</div>
                )}
                {visible.map((c) => (
                  <ConversationRow key={c.cid} channel={c} discuss={discuss} active={c.cid === activeCid} tick={tick} />
                ))}
                {q.length >= 2 && (
                  <>
                    <SectionLabel>Messages</SectionLabel>
                    {results === null && <div className="px-4 py-3 text-xs text-kumo-subtle">Searching…</div>}
                    {results !== null && results.length === 0 && (
                      <div className="px-4 py-3 text-xs text-kumo-subtle">No messages match.</div>
                    )}
                    {results?.map((m) => {
                      const channel = m.cid ? client.activeChannels[m.cid] : undefined
                      const where = channel ? describeConversation(channel, session.userId, teammates).title : ''
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => { if (m.cid) discuss.open(m.cid) }}
                          className="w-full flex flex-col gap-0.5 px-3 py-2 text-left hover:bg-kumo-tint"
                        >
                          <span className="flex items-baseline gap-2">
                            <span className="flex-1 min-w-0 truncate text-xs font-medium text-kumo-default">
                              {m.user?.id === session.userId ? 'You' : m.user?.name ?? 'Teammate'}
                              {where && <span className="font-normal text-kumo-subtle"> in {where}</span>}
                            </span>
                            {m.created_at && <span className="shrink-0 text-[11px] text-kumo-inactive">{relativeTime(new Date(m.created_at))}</span>}
                          </span>
                          <span className="text-xs text-kumo-subtle line-clamp-2">{previewText(m)}</span>
                        </button>
                      )
                    })}
                  </>
                )}
              </>
            )
          }}
        />
      </div>
    </>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-kumo-inactive">{children}</div>
}

// Full-text search across the caller's conversations, debounced; null while a search is in
// flight, [] when nothing matched.
function useMessageSearch(discuss: DiscussContextValue, q: string): MessageResponse[] | null {
  const { client, session } = discuss
  const [results, setResults] = useState<MessageResponse[] | null>([])
  useEffect(() => {
    if (q.length < 2) { setResults([]); return }
    let cancelled = false
    setResults(null)
    const timer = setTimeout(async () => {
      try {
        const response = await client.search(
          { type: 'messaging', team: session.team, members: { $in: [session.userId] } },
          q,
          { limit: 8, sort: [{ created_at: -1 }] },
        )
        if (!cancelled) setResults(response.results.map((r) => r.message))
      } catch (err) {
        console.warn('Discuss: message search failed', err)
        if (!cancelled) setResults([])
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [client, session.team, session.userId, q])
  return results
}

export function ConversationRow({
  channel, discuss, active, tick,
}: { channel: StreamChannel; discuss: DiscussContextValue; active?: boolean; tick: number }) {
  const { setActiveChannel } = useChatContext()
  const { session, teammates, api } = discuss
  const info = describeConversation(channel, session.userId, teammates)
  const unread = channel.countUnread()
  const mentions = channel.countUnreadMentions()
  const muted = channel.muteStatus().muted
  const last = channel.state.latestMessages.at(-1) ?? channel.state.messages.at(-1)
  const snippet = last ? `${last.user?.id === session.userId ? 'You: ' : ''}${previewText(last)}` : 'No messages yet'
  const when = last?.created_at ? relativeTime(new Date(last.created_at)) : ''
  void tick

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setActiveChannel(channel)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveChannel(channel) } }}
      className={`group w-full flex items-center gap-3 px-3 py-2.5 text-left cursor-pointer focus:outline-none focus-visible:bg-kumo-tint ${active ? 'bg-kumo-tint' : 'hover:bg-kumo-tint'}`}
    >
      <ConversationAvatar info={info} api={api} size={40} />
      <span className="flex-1 min-w-0">
        <span className="flex items-baseline gap-2">
          <span className={`flex-1 min-w-0 truncate text-sm ${unread && !muted ? 'font-semibold text-kumo-strong' : 'font-medium text-kumo-default'}`}>
            {info.title}
          </span>
          {muted && <BellOff size={12} className="shrink-0 text-kumo-inactive" />}
          {when && <span className={`shrink-0 text-[11px] ${unread && !muted ? 'text-kumo-default' : 'text-kumo-inactive'}`}>{when}</span>}
        </span>
        <span className="flex items-center gap-2">
          <span className={`flex-1 min-w-0 truncate text-xs ${unread && !muted ? 'text-kumo-default' : 'text-kumo-subtle'}`}>{snippet}</span>
          {unread > 0 && <UnreadPill count={unread} mention={mentions > 0} />}
        </span>
      </span>
      <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100" onClick={(e) => e.stopPropagation()}>
        <RowMenu channel={channel} muted={muted} />
      </span>
    </div>
  )
}

function RowMenu({ channel, muted }: { channel: StreamChannel; muted: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={(
          <button
            type="button"
            aria-label="Conversation options"
            className="w-7 h-7 inline-flex items-center justify-center rounded-md text-kumo-subtle hover:text-kumo-default hover:bg-kumo-fill"
          >
            <Ellipsis size={14} />
          </button>
        )}
      />
      <DropdownMenu.Content className={MENU_CONTENT}>
        <DropdownMenu.Item
          icon={<BellOff size={13} className="mr-2" />}
          onClick={() => { void (muted ? channel.unmute() : channel.mute()) }}
          className={MENU_ITEM}
        >
          {muted ? 'Unmute' : 'Mute'}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

export function EmptyList({ onNew }: { onNew: () => void }) {
  return (
    <div className="px-6 py-10 flex flex-col items-center text-center gap-3">
      <span className="w-12 h-12 rounded-full bg-kumo-tint text-kumo-subtle inline-flex items-center justify-center">
        <Users size={22} />
      </span>
      <div className="text-sm font-medium text-kumo-default">No conversations yet</div>
      <div className="text-xs text-kumo-subtle">Message a teammate or start a group.</div>
      <button
        type="button"
        onClick={onNew}
        className="mt-1 h-9 px-3 rounded-md bg-kumo-brand text-white text-sm font-medium hover:bg-kumo-brand-hover"
      >
        New message
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Conversation header

export function ConversationHeader({
  channel, discuss, tick, onBack, showBack, onToggleInfo, infoOpen,
}: {
  channel: StreamChannel
  discuss: DiscussContextValue
  tick: number
  onBack: () => void
  /** Whether to show the back arrow (the dock does, the page only on phones). */
  showBack: boolean
  onToggleInfo: () => void
  infoOpen: boolean
}) {
  const { session, teammates, api } = discuss
  const info = describeConversation(channel, session.userId, teammates)
  void tick
  return (
    <div className="flex items-center gap-2.5 pl-1.5 pr-1.5 h-11 border-b border-kumo-line shrink-0">
      {showBack ? (
        <IconButton label="Back to conversations" onClick={onBack}><ArrowLeft size={16} /></IconButton>
      ) : <span className="w-1.5" />}
      <ConversationAvatar info={info} api={api} size={28} />
      <ConversationTitle info={info} />
      <AskTymsMenu channel={channel} discuss={discuss} title={info.title} />
      <IconButton label={infoOpen ? 'Hide details' : 'Details'} onClick={onToggleInfo} className={infoOpen ? 'bg-kumo-tint text-kumo-default' : ''}>
        <Info size={16} />
      </IconButton>
    </div>
  )
}

/** Name over a one-line status, at the app's 14/11 scale. Shared by the page header and the dock bar. */
export function ConversationTitle({ info }: { info: ConversationInfo }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-sm font-semibold text-kumo-default truncate leading-tight">{info.title}</div>
      <div className="text-[11px] leading-tight truncate text-kumo-subtle">{conversationSubtitle(info)}</div>
    </div>
  )
}

export function conversationSubtitle(info: ConversationInfo): string {
  if (info.kind === 'dm') {
    return info.online ? 'Online' : info.lastActive ? `Last active ${relativeTime(info.lastActive, true)}` : 'Offline'
  }
  return `${info.memberCount} members` + (info.onlineCount ? ` · ${info.onlineCount} online` : '')
}

// "Ask Tyms" hands the conversation to the assistant: it seeds a new workspace's first message
// with the transcript and an instruction, so the person sees exactly what the assistant gets
// and can edit before sending.
export function AskTymsMenu({ channel, discuss, title }: { channel: StreamChannel; discuss: DiscussContextValue; title: string }) {
  const navigate = useNavigate()
  const ask = (instruction: string) => {
    const prompt = buildAskTymsPrompt(channel, discuss.session.userId, title, instruction)
    discuss.collapse()
    void navigate({ to: '/', search: { prompt } })
  }
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={(
          <button
            type="button"
            title="Ask Tyms about this conversation"
            aria-label="Ask Tyms about this conversation"
            className="w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-md text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint"
          >
            <Sparkles size={16} />
          </button>
        )}
      />
      <DropdownMenu.Content className={MENU_CONTENT}>
        <DropdownMenu.Item className={MENU_ITEM} onClick={() => ask('Summarise this conversation: the key points, decisions, and anything still open.')}>
          Summarise this conversation
        </DropdownMenu.Item>
        <DropdownMenu.Item className={MENU_ITEM} onClick={() => ask('Draft a reply I could send next in this conversation. Match the tone, keep it short.')}>
          Draft a reply
        </DropdownMenu.Item>
        <DropdownMenu.Item className={MENU_ITEM} onClick={() => ask('Turn this conversation into a list of tasks with owners and, where mentioned, deadlines.')}>
          Turn into tasks
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

function buildAskTymsPrompt(channel: StreamChannel, selfId: string, title: string, instruction: string): string {
  const header = `${instruction}\n\nConversation "${title}" from Discuss (most recent last):\n\n`
  const budget = MAX_GATEKEEPER_APP_PROMPT_LENGTH - header.length - 40
  const lines: string[] = []
  let used = 0
  const messages = channel.state.messages.toReversed()
  for (const m of messages) {
    if (m.type === 'deleted' || m.type === 'system') continue
    const who = m.user?.id === selfId ? 'Me' : m.user?.name ?? 'Teammate'
    const line = `${who}: ${previewText(m)}`
    if (used + line.length + 1 > budget) { lines.push('[earlier messages omitted]'); break }
    lines.push(line)
    used += line.length + 1
  }
  return header + lines.toReversed().join('\n')
}

// ---------------------------------------------------------------------------------------------
// Details panel: rename, members, mute, leave

export function ConversationDetails({
  channel, discuss, tick, onClose, onLeft,
}: { channel: StreamChannel; discuss: DiscussContextValue; tick: number; onClose: () => void; onLeft: () => void }) {
  const { session, teammates, api } = discuss
  const info = describeConversation(channel, session.userId, teammates)
  const isGroup = info.kind === 'group'
  const [name, setName] = useState(info.title)
  const [adding, setAdding] = useState(false)
  const [toAdd, setToAdd] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const muted = channel.muteStatus().muted
  void tick

  const members = Object.values(channel.state.members)
  const memberIds = new Set(members.map((m) => m.user_id))
  const candidates = (teammates.list ?? []).filter((t) => !memberIds.has(t.streamId))

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await action()
    } catch (err) {
      logRpcFailure('Discuss update failed:', err)
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="flex items-center gap-2 px-3 h-10 border-b border-kumo-line">
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-kumo-inactive">Details</span>
        <IconButton label="Close details" onClick={onClose}><X size={14} /></IconButton>
      </div>

      {isGroup ? (
        <div className="px-3 pt-3 flex flex-col gap-1.5">
          <label className="text-xs text-kumo-subtle">Group name</label>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              className="flex-1 min-w-0 h-9 px-2.5 rounded-md border border-kumo-line bg-kumo-base text-sm text-kumo-default outline-none focus:border-kumo-ring"
            />
            <button
              type="button"
              disabled={busy !== null || !name.trim() || name.trim() === info.title}
              onClick={() => run('rename', () => api.updateTeamChatChannel(channel.cid, { name: name.trim() }))}
              className="h-9 px-3 rounded-md bg-kumo-brand text-white text-sm font-medium hover:bg-kumo-brand-hover disabled:opacity-50"
            >
              {busy === 'rename' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="px-3 pt-4 flex items-center gap-3">
          <ConversationAvatar info={info} api={api} size={44} />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-kumo-default truncate">{info.title}</div>
            {info.email && <div className="text-xs text-kumo-subtle truncate">{info.email}</div>}
          </div>
        </div>
      )}

      <div className="px-3 pt-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-kumo-subtle">{isGroup ? `${members.length} members` : 'Notifications'}</span>
          {isGroup && candidates.length > 0 && !adding && (
            <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1 text-xs font-medium text-kumo-default hover:underline">
              <UserPlus size={13} /> Add people
            </button>
          )}
        </div>

        {adding && (
          <div className="mt-2 rounded-md border border-kumo-line overflow-hidden">
            <div className="max-h-48 overflow-y-auto">
              {candidates.map((t) => {
                const on = toAdd.has(t.streamId)
                return (
                  <button
                    key={t.streamId}
                    type="button"
                    onClick={() => setToAdd((prev) => { const n = new Set(prev); if (n.has(t.streamId)) n.delete(t.streamId); else n.add(t.streamId); return n })}
                    className="w-full flex items-center gap-2.5 px-2.5 py-1.5 hover:bg-kumo-tint text-left"
                  >
                    <PersonAvatar api={api} userId={t.email} name={t.name} size={28} />
                    <span className="flex-1 min-w-0 text-sm text-kumo-default truncate">{t.name}</span>
                    <span className={`w-[18px] h-[18px] rounded-full border inline-flex items-center justify-center ${on ? 'bg-kumo-brand border-kumo-brand text-white' : 'border-kumo-line'}`}>
                      {on && <Check size={11} />}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="flex gap-2 p-2 border-t border-kumo-line bg-kumo-tint">
              <button type="button" onClick={() => { setAdding(false); setToAdd(new Set()) }} className="h-8 px-2.5 rounded-md text-xs font-medium text-kumo-default hover:bg-kumo-fill">Cancel</button>
              <button
                type="button"
                disabled={toAdd.size === 0 || busy !== null}
                onClick={() => run('add', async () => {
                  await api.updateTeamChatChannel(channel.cid, { addMembers: [...toAdd] })
                  setAdding(false)
                  setToAdd(new Set())
                })}
                className="flex-1 h-8 rounded-md bg-kumo-brand text-white text-xs font-medium hover:bg-kumo-brand-hover disabled:opacity-50"
              >
                {busy === 'add' ? 'Adding…' : `Add ${toAdd.size || ''}`.trim()}
              </button>
            </div>
          </div>
        )}

        {isGroup && (
          <ul className="mt-2 flex flex-col">
            {members.map((m) => {
              const id = m.user_id ?? ''
              const known = teammates.byStreamId.get(id)
              const isSelf = id === session.userId
              const label = isSelf ? 'You' : known?.name ?? m.user?.name ?? 'Teammate'
              return (
                <li key={id} className="flex items-center gap-2.5 py-1.5">
                  <span className="relative">
                    {known
                      ? <PersonAvatar api={api} userId={known.email} name={known.name} size={28} />
                      : isSelf
                        ? <PersonAvatar api={api} userId={discuss.selfUserId} name={session.name} size={28} />
                        : <InitialsAvatar name={label} size={28} />}
                    {m.user?.online && <span className="absolute -right-0.5 -bottom-0.5 w-2 h-2 rounded-full bg-kumo-success ring-2 ring-kumo-base" />}
                  </span>
                  <span className="flex-1 min-w-0 text-sm text-kumo-default truncate">{label}</span>
                  {!isSelf && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => run(`remove:${id}`, () => api.updateTeamChatChannel(channel.cid, { removeMembers: [id] }))}
                      className="text-[11px] text-kumo-subtle hover:text-kumo-danger disabled:opacity-50"
                    >
                      {busy === `remove:${id}` ? 'Removing…' : 'Remove'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        <button
          type="button"
          onClick={() => run('mute', () => (muted ? channel.unmute() : channel.mute()))}
          className="mt-3 w-full flex items-center gap-2.5 h-9 px-2 -mx-2 rounded-md text-sm text-kumo-default hover:bg-kumo-tint"
        >
          <BellOff size={15} className="text-kumo-subtle" />
          <span className="flex-1 text-left">{muted ? 'Unmute conversation' : 'Mute conversation'}</span>
          <span className={`w-8 h-[18px] rounded-full relative transition-colors ${muted ? 'bg-kumo-brand' : 'bg-kumo-fill'}`}>
            <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all ${muted ? 'left-[16px]' : 'left-[2px]'}`} />
          </span>
        </button>

        {isGroup && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run('leave', async () => { await api.leaveTeamChatChannel(channel.cid); onLeft() })}
            className="mt-1 mb-4 w-full flex items-center gap-2.5 h-9 px-2 -mx-2 rounded-md text-sm text-kumo-danger hover:bg-kumo-danger-tint disabled:opacity-50"
          >
            <LogOut size={15} />
            <span className="flex-1 text-left">{busy === 'leave' ? 'Leaving…' : 'Leave group'}</span>
          </button>
        )}
        {error && <div className="pb-3 text-xs text-kumo-danger">{error}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// New conversation

export function NewConversation({
  discuss, onBack, onCreated, showBack,
}: {
  discuss: DiscussContextValue
  onBack: () => void
  onCreated: (cid: string) => Promise<void>
  showBack: boolean
}) {
  const { api, teammates } = discuss
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => { searchRef.current?.focus() }, [])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const isGroup = selected.size > 1 || name.trim().length > 0
  const canCreate = selected.size > 0 && (!isGroup || name.trim().length > 0) && !busy

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const { cid } = await api.createTeamChatChannel([...selected], isGroup ? name.trim() : undefined)
      await onCreated(cid)
    } catch (err) {
      logRpcFailure('Failed to create conversation:', err)
      setError(err instanceof Error ? err.message : 'Could not start the conversation.')
      setBusy(false)
    }
  }

  const q = query.trim().toLowerCase()
  const list = teammates.list
  const visible = (list ?? []).filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.email.toLowerCase().includes(q),
  )
  const chosen = (list ?? []).filter((t) => selected.has(t.streamId))

  return (
    <>
      <div className="p-3 flex flex-col gap-2 shrink-0 border-b border-kumo-line">
        <div className="flex items-center gap-2">
          {showBack && <IconButton label="Back" onClick={onBack}><ArrowLeft size={16} /></IconButton>}
          <SearchField value={query} onChange={setQuery} placeholder="To: search teammates" inputRef={searchRef} />
        </div>
        {chosen.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chosen.map((t) => (
              <button
                key={t.streamId}
                type="button"
                onClick={() => toggle(t.streamId)}
                className="inline-flex items-center gap-1 h-7 pl-2 pr-1.5 rounded-full bg-kumo-tint text-xs text-kumo-default hover:bg-kumo-fill"
              >
                {t.name}
                <X size={12} className="text-kumo-subtle" />
              </button>
            ))}
          </div>
        )}
        {isGroup && (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Group name"
            maxLength={80}
            className="h-9 px-2.5 rounded-md border border-kumo-line bg-kumo-base text-sm text-kumo-default placeholder:text-kumo-inactive outline-none focus:border-kumo-ring"
          />
        )}
        {selected.size === 1 && !isGroup && (
          <div className="text-[11px] text-kumo-subtle">Add more people, or a name, to make a group.</div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {list === null && !teammates.error && (
          <div className="px-4 py-6 text-sm text-kumo-subtle">Loading teammates…</div>
        )}
        {teammates.error && <div className="px-4 py-6 text-sm text-kumo-danger">{teammates.error}</div>}
        {list !== null && visible.length === 0 && (
          <div className="px-4 py-6 text-sm text-kumo-subtle">
            {list.length === 0 ? 'No teammates yet. Invite people from Admin → Teammates.' : 'No matches.'}
          </div>
        )}
        {visible.map((t) => {
          const on = selected.has(t.streamId)
          return (
            <button
              key={t.streamId}
              type="button"
              onClick={() => toggle(t.streamId)}
              aria-pressed={on}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-kumo-tint text-left"
            >
              <PersonAvatar api={api} userId={t.email} name={t.name} size={36} />
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-kumo-default truncate">{t.name}</span>
                <span className="block text-xs text-kumo-subtle truncate">{t.email}</span>
              </span>
              <span
                className={`w-5 h-5 rounded-full border inline-flex items-center justify-center shrink-0 ${
                  on ? 'bg-kumo-brand border-kumo-brand text-white' : 'border-kumo-line'
                }`}
              >
                {on && <Check size={12} />}
              </span>
            </button>
          )
        })}
      </div>
      <div className="p-3 border-t border-kumo-line shrink-0 flex flex-col gap-2">
        {error && <div className="text-xs text-kumo-danger">{error}</div>}
        <button
          type="button"
          disabled={!canCreate}
          onClick={create}
          className="h-10 rounded-md bg-kumo-brand text-white text-sm font-medium hover:bg-kumo-brand-hover disabled:opacity-50 disabled:hover:bg-kumo-brand"
        >
          {busy
            ? 'Starting…'
            : isGroup
              ? `Create group · ${selected.size} people`
              : selected.size === 1
                ? `Message ${chosen[0]?.name ?? ''}`
                : 'Pick someone to message'}
        </button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Shared-workspace cards ("Send to Discuss")

export const WORKSPACE_ATTACHMENT_TYPE = 'tyms_workspace'

export type WorkspaceAttachment = { type: typeof WORKSPACE_ATTACHMENT_TYPE; title: string; workspace_id: string }

function isWorkspaceAttachment(a: unknown): a is WorkspaceAttachment {
  return typeof a === 'object' && a !== null && (a as { type?: unknown }).type === WORKSPACE_ATTACHMENT_TYPE
    && typeof (a as { workspace_id?: unknown }).workspace_id === 'string'
}

/** Stream's attachment renderer plus our workspace card. */
export function DiscussAttachment(props: AttachmentProps) {
  const cards = props.attachments.filter(isWorkspaceAttachment)
  const rest = props.attachments.filter((a) => !isWorkspaceAttachment(a))
  const discuss = useDiscuss()
  return (
    <>
      {cards.map((card) => (
        <Link
          key={card.workspace_id}
          to="/workspace/$id"
          params={{ id: card.workspace_id }}
          search={{}}
          onClick={() => discuss?.collapse()}
          className="discuss-workspace-card my-1 flex items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5 no-underline hover:bg-kumo-tint"
        >
          <span className="w-9 h-9 rounded-md bg-kumo-tint text-kumo-default inline-flex items-center justify-center shrink-0">
            <LayoutGrid size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] uppercase tracking-wide text-kumo-inactive">Workspace</span>
            <span className="block text-sm font-medium text-kumo-default truncate">{card.title || 'Untitled workspace'}</span>
          </span>
          <span className="text-xs font-medium text-kumo-default shrink-0">Open</span>
        </Link>
      ))}
      {rest.length > 0 && <Attachment {...props} attachments={rest} />}
    </>
  )
}

/** Stream icon overrides: a plain right arrow on the send button. */
export const DISCUSS_ICONS: IconSlots = {
  IconSend: (props) => (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  ),
}

// ---------------------------------------------------------------------------------------------
// Avatars

export function ConversationAvatar({ info, api, size }: { info: ConversationInfo; api: DiscussContextValue['api']; size: number }) {
  if (info.kind === 'dm') {
    return (
      <span className="relative shrink-0">
        {info.email
          ? <PersonAvatar api={api} userId={info.email} name={info.title} size={size} />
          : <InitialsAvatar name={info.title} size={size} />}
        {info.online && (
          <span className="absolute right-0 bottom-0 w-2.5 h-2.5 rounded-full bg-kumo-success ring-2 ring-kumo-base" />
        )}
      </span>
    )
  }
  return (
    <span
      className="shrink-0 rounded-full bg-kumo-tint text-kumo-subtle inline-flex items-center justify-center ring-1 ring-inset ring-kumo-line/50"
      style={{ width: size, height: size }}
    >
      <Users size={Math.round(size * 0.45)} />
    </span>
  )
}

export function InitialsAvatar({ name, size }: { name: string; size: number }) {
  return (
    <span
      className="shrink-0 rounded-full bg-kumo-tint text-kumo-default text-[10px] font-semibold inline-flex items-center justify-center ring-1 ring-inset ring-kumo-line/50"
      style={{ width: size, height: size }}
    >
      {initials(name)}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------
// Conversation description helpers

export type ConversationInfo =
  | { kind: 'dm'; title: string; email: string | null; online: boolean; lastActive: Date | null }
  | { kind: 'group'; title: string; memberCount: number; onlineCount: number }

export function describeConversation(channel: StreamChannel, selfId: string, teammates: TeammateIndex): ConversationInfo {
  const members = Object.values(channel.state.members)
  const others = members.filter((m) => m.user_id !== selfId)
  const name = (channel.data as { name?: string } | undefined)?.name
  if (!name && others.length === 1) {
    const other = others[0]
    const known = teammates.byStreamId.get(other.user_id ?? '')
    const user = other.user
    return {
      kind: 'dm',
      title: known?.name ?? user?.name ?? other.user_id ?? 'Teammate',
      email: known?.email ?? null,
      online: Boolean(user?.online),
      lastActive: user?.last_active ? new Date(user.last_active) : null,
    }
  }
  return {
    kind: 'group',
    title: name ?? (others.map((m) => teammates.byStreamId.get(m.user_id ?? '')?.name ?? m.user?.name ?? 'Teammate').join(', ') || 'Group'),
    memberCount: members.length,
    onlineCount: others.filter((m) => m.user?.online).length,
  }
}

export function previewText(message: { text?: string; attachments?: unknown[]; deleted_at?: Date | string | null; type?: string }): string {
  if (message.deleted_at || message.type === 'deleted') return 'Message deleted'
  const text = message.text?.trim()
  if (text) return text.replace(/\s+/g, ' ')
  const attachments = message.attachments ?? []
  if (attachments.some(isWorkspaceAttachment)) return 'Shared a workspace'
  if (attachments.length > 0) return 'Sent an attachment'
  return ''
}

/**
 * "now", "5m", "3h", "Mon", "12 Aug" — compact stamps for the list; the long form
 * ("5 minutes ago") is for the presence line.
 */
export function relativeTime(date: Date, long = false): string {
  const diff = Date.now() - date.getTime()
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return long ? 'just now' : 'now'
  if (minutes < 60) return long ? `${minutes} minute${minutes === 1 ? '' : 's'} ago` : `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return long ? `${hours} hour${hours === 1 ? '' : 's'} ago` : `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return long ? `${days} day${days === 1 ? '' : 's'} ago` : date.toLocaleDateString(undefined, { weekday: 'short' })
  return (long ? 'on ' : '') + date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** The menu of notification preferences shared by the dock and the page header. */
export function PrefsMenu({ discuss }: { discuss: DiscussContextValue }) {
  const { prefs, setPrefs } = discuss
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={(
          <button
            type="button"
            aria-label="Discuss options"
            title="Options"
            className="w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-md text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint"
          >
            <Ellipsis size={16} />
          </button>
        )}
      />
      <DropdownMenu.Content className={MENU_CONTENT}>
        <DropdownMenu.Item className={MENU_ITEM} onClick={() => setPrefs({ dnd: !prefs.dnd })}>
          {prefs.dnd ? 'Resume notifications' : 'Pause notifications'}
        </DropdownMenu.Item>
        <DropdownMenu.Item className={MENU_ITEM} onClick={() => setPrefs({ sound: !prefs.sound })}>
          {prefs.sound ? 'Turn sound off' : 'Turn sound on'}
        </DropdownMenu.Item>
        {discuss.emailWhenAway !== null && (
          <DropdownMenu.Item className={MENU_ITEM} onClick={() => discuss.setEmailWhenAway(!discuss.emailWhenAway)}>
            {discuss.emailWhenAway ? 'Stop emailing me when away' : 'Email me when away'}
          </DropdownMenu.Item>
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

// ---------------------------------------------------------------------------------------------
// Hooks shared by the dock and the page (both run inside a <Chat> provider)

/** A counter that bumps on presence and channel events so rows/headers re-read live state. */
const LIVE_EVENTS = [
  'user.presence.changed', 'channel.updated', 'member.added', 'member.removed', 'member.updated',
  'notification.added_to_channel', 'notification.removed_from_channel', 'notification.channel_mutes_updated',
] as const

/** Bumps on presence/channel events so rows and headers re-read live state. */
export function useLiveTick(): number {
  const { client } = useChatContext()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const subs = LIVE_EVENTS.map((type) => client.on(type, () => setTick((t) => t + 1)))
    return () => { for (const s of subs) s.unsubscribe() }
  }, [client])
  return tick
}

/**
 * Total unread across the caller's channels: seeded by the connect response and kept fresh by
 * the unread counter Stream attaches to notification events.
 */
export function useUnreadCount(): number {
  const { client } = useChatContext()
  const [unread, setUnread] = useState(() => (client.user as OwnUserResponse | undefined)?.total_unread_count ?? 0)
  useEffect(() => {
    const { unsubscribe } = client.on((event: Event) => {
      if (typeof event.total_unread_count === 'number') setUnread(event.total_unread_count)
    })
    return unsubscribe
  }, [client])
  return unread
}

/** Follows the app's theme mode (set on <html data-mode>) so Stream's components flip with it. */
const readDarkMode = () => document.documentElement.getAttribute('data-mode') === 'dark'

/** Whether the app is in dark mode right now. */
export function useDarkMode(): boolean {
  const [dark, setDark] = useState(readDarkMode)
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(readDarkMode()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

/** Stream theme class for the current app mode. */
export function streamTheme(dark: boolean): string {
  return dark ? 'str-chat__theme-dark' : 'str-chat__theme-light'
}
