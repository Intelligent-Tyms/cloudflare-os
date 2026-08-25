import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { RpcStub } from 'capnweb'
import type { TeamChatSession, TeamChatTeammate, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { Channel as StreamChannel, Event, OwnUserResponse } from 'stream-chat'
import {
  Chat,
  Channel,
  ChannelList,
  MessageList,
  MessageComposer,
  Thread,
  Window,
  useChatContext,
  useCreateChatClient,
} from 'stream-chat-react'
import { ArrowLeft, Check, ChevronDown, ChevronUp, Search, SquarePen, Users, X } from 'lucide-react'
import 'stream-chat-react/dist/css/index.css'
import './team-chat.css'
import { PersonAvatar, initials } from '../PersonAvatar'
import { logRpcFailure } from '../../rpcErrors'

// Discuss: human-to-human messaging between the members of this deployment. It is a bar docked
// to the bottom-right corner (the way LinkedIn docks "Messaging"): collapsed, it shows the
// caller's avatar, the word Discuss and an unread count; expanded, it shows the latest
// conversations (people and groups), a conversation, or the "new message" picker. Everything
// chat-shaped (presence, unread counts, typing, receipts, reactions, attachments, threads)
// comes from Stream; this file is the Tyms-styled shell around it.

type View = 'list' | 'channel' | 'new'

const EXPANDED_KEY = 'tyms.discuss.expanded'

export default function TeamChatWidget({
  api,
  initialSession,
  selfUserId,
}: {
  api: RpcStub<AuthenticatedApi>
  initialSession: TeamChatSession
  /** The caller's app user id (their email) — the key the avatar store uses. */
  selfUserId: string
}) {
  // The token is handed to Stream as a provider so it refreshes itself on expiry.
  const sessionRef = useRef(initialSession)
  const tokenProvider = useCallback(async () => {
    if (sessionRef.current.expiresAt - Date.now() > 60_000) return sessionRef.current.token
    const fresh = await api.getTeamChatSession()
    if (!fresh) throw new Error('Discuss is no longer available.')
    sessionRef.current = fresh
    return fresh.token
  }, [api])

  const userData = useMemo(
    () => ({ id: initialSession.userId, name: initialSession.name }),
    [initialSession.userId, initialSession.name],
  )
  const client = useCreateChatClient({
    apiKey: initialSession.apiKey,
    tokenOrProvider: tokenProvider,
    userData,
  })

  const dark = useDarkMode()
  if (!client) return null

  return (
    <Chat client={client} theme={dark ? 'str-chat__theme-dark' : 'str-chat__theme-light'}>
      <DiscussDock api={api} session={initialSession} selfUserId={selfUserId} />
    </Chat>
  )
}

// ---------------------------------------------------------------------------------------------
// Dock

function DiscussDock({
  api,
  session,
  selfUserId,
}: {
  api: RpcStub<AuthenticatedApi>
  session: TeamChatSession
  selfUserId: string
}) {
  const { client, channel, setActiveChannel } = useChatContext()
  const [expanded, setExpanded] = useState<boolean>(() => readStoredBool(EXPANDED_KEY))
  const [view, setView] = useState<View>('list')
  const unread = useUnreadCount()
  const teammates = useTeammates(api)
  const presenceTick = usePresenceTick()

  useEffect(() => { writeStoredBool(EXPANDED_KEY, expanded) }, [expanded])

  // Selecting a conversation in the list (ChannelList sets the active channel) moves the
  // dock to the conversation view.
  useEffect(() => {
    if (channel) setView('channel')
  }, [channel])

  const backToList = useCallback(() => {
    setActiveChannel(undefined)
    setView('list')
  }, [setActiveChannel])

  const openCid = useCallback(async (cid: string) => {
    const [type, id] = cid.split(':')
    const target = client.channel(type, id)
    await target.watch()
    setActiveChannel(target)
    setView('channel')
    setExpanded(true)
  }, [client, setActiveChannel])

  const toggle = () => {
    if (!expanded) void requestNotificationPermission()
    setExpanded(!expanded)
  }

  useDocumentTitleBadge(unread)
  useNewMessageNotifications(session.userId, expanded, openCid)

  // Esc walks back: conversation → list → collapsed.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    if (view === 'list') setExpanded(false)
    else backToList()
  }

  const filters = useMemo(
    () => ({ type: 'messaging', team: session.team, members: { $in: [session.userId] } }),
    [session.team, session.userId],
  )

  const title = view === 'new' ? 'New message' : view === 'channel' && channel
    ? conversationTitle(channel, session.userId, teammates)
    : 'Discuss'

  return (
    <div
      className="team-chat fixed z-40 right-0 sm:right-6 w-full sm:w-[22rem]"
      style={{ bottom: 'var(--app-bottom, 0px)' }}
      onKeyDown={onKeyDown}
    >
      <div className="team-chat-dock flex flex-col rounded-t-xl border border-b-0 border-kumo-line bg-kumo-base shadow-[0_-4px_24px_rgba(0,0,0,0.08)] dark:shadow-[0_-4px_24px_rgba(0,0,0,0.5)] overflow-hidden">
        {/* Bar: always visible. */}
        <div className="flex items-center h-12 pl-3 pr-1.5 gap-2 shrink-0 select-none">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse Discuss' : 'Expand Discuss'}
            className="flex-1 min-w-0 flex items-center gap-2.5 h-full text-left"
          >
            <span className="relative shrink-0">
              <PersonAvatar api={api} userId={selfUserId} name={session.name} size={28} />
              <span className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full bg-kumo-success ring-2 ring-kumo-base" />
            </span>
            <span className="text-sm font-semibold text-kumo-default truncate">{title}</span>
            {!expanded && unread > 0 && <UnreadPill count={unread} />}
          </button>
          {expanded && view !== 'new' && (
            <IconButton label="New message" onClick={() => { setActiveChannel(undefined); setView('new') }}>
              <SquarePen size={16} />
            </IconButton>
          )}
          <IconButton label={expanded ? 'Collapse' : 'Expand'} onClick={toggle}>
            {expanded ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
          </IconButton>
        </div>

        {expanded && (
          <div className="team-chat-panel flex flex-col border-t border-kumo-line h-[min(30rem,calc(var(--app-height,100vh)-7rem))]">
            {view === 'list' && (
              <ConversationList
                filters={filters}
                selfId={session.userId}
                teammates={teammates}
                presenceTick={presenceTick}
                api={api}
                onNew={() => setView('new')}
              />
            )}
            {view === 'channel' && channel && (
              <Channel channel={channel}>
                {/* Stream lays out .str-chat__channel as a row (main panel | thread), so the
                    header must live inside <Window>, which is the column. */}
                <Window>
                  <ConversationHeader
                    channel={channel}
                    selfId={session.userId}
                    teammates={teammates}
                    presenceTick={presenceTick}
                    api={api}
                    onBack={backToList}
                  />
                  <MessageList />
                  <MessageComposer />
                </Window>
                <Thread />
              </Channel>
            )}
            {view === 'new' && (
              <NewConversation
                api={api}
                teammates={teammates}
                onBack={() => setView('list')}
                onCreated={openCid}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-md text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint"
    >
      {children}
    </button>
  )
}

function UnreadPill({ count }: { count: number }) {
  return (
    <span className="min-w-5 h-5 px-1.5 rounded-full bg-kumo-danger text-white text-[11px] font-semibold inline-flex items-center justify-center shrink-0">
      {count > 99 ? '99+' : count}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------
// Conversation list

function ConversationList({
  filters,
  selfId,
  teammates,
  presenceTick,
  api,
  onNew,
}: {
  filters: { type: string; team: string; members: { $in: string[] } }
  selfId: string
  teammates: TeammateIndex
  presenceTick: number
  api: RpcStub<AuthenticatedApi>
  onNew: () => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  return (
    <>
      <div className="px-3 py-2 shrink-0">
        <label className="flex items-center gap-2 h-9 px-2.5 rounded-md bg-kumo-tint">
          <Search size={14} className="text-kumo-subtle shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            className="flex-1 min-w-0 bg-transparent text-sm text-kumo-default placeholder:text-kumo-inactive outline-none"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear" className="text-kumo-subtle hover:text-kumo-default">
              <X size={14} />
            </button>
          )}
        </label>
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
              ? channels.filter((c) => conversationTitle(c, selfId, teammates).toLowerCase().includes(q))
              : channels
            if (visible.length === 0) {
              return <div className="px-4 py-8 text-center text-sm text-kumo-subtle">No conversations match.</div>
            }
            return visible.map((c) => (
              <ConversationRow
                key={c.cid}
                channel={c}
                selfId={selfId}
                teammates={teammates}
                presenceTick={presenceTick}
                api={api}
              />
            ))
          }}
        />
      </div>
    </>
  )
}

function ConversationRow({
  channel,
  selfId,
  teammates,
  presenceTick,
  api,
}: {
  channel: StreamChannel
  selfId: string
  teammates: TeammateIndex
  presenceTick: number
  api: RpcStub<AuthenticatedApi>
}) {
  const { setActiveChannel } = useChatContext()
  const info = describeConversation(channel, selfId, teammates)
  const unread = channel.countUnread()
  const last = channel.state.latestMessages.at(-1) ?? channel.state.messages.at(-1)
  const snippet = last ? `${last.user?.id === selfId ? 'You: ' : ''}${previewText(last)}` : 'No messages yet'
  const when = last?.created_at ? relativeTime(new Date(last.created_at)) : ''
  void presenceTick

  return (
    <button
      type="button"
      onClick={() => setActiveChannel(channel)}
      className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-kumo-tint focus:outline-none focus-visible:bg-kumo-tint"
    >
      <ConversationAvatar info={info} api={api} size={40} />
      <span className="flex-1 min-w-0">
        <span className="flex items-baseline gap-2">
          <span className={`flex-1 min-w-0 truncate text-sm ${unread ? 'font-semibold text-kumo-strong' : 'font-medium text-kumo-default'}`}>
            {info.title}
          </span>
          {when && <span className={`shrink-0 text-[11px] ${unread ? 'text-kumo-default' : 'text-kumo-inactive'}`}>{when}</span>}
        </span>
        <span className="flex items-center gap-2">
          <span className={`flex-1 min-w-0 truncate text-xs ${unread ? 'text-kumo-default' : 'text-kumo-subtle'}`}>{snippet}</span>
          {unread > 0 && <UnreadPill count={unread} />}
        </span>
      </span>
    </button>
  )
}

function EmptyList({ onNew }: { onNew: () => void }) {
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
// Conversation header (inside a channel)

function ConversationHeader({
  channel,
  selfId,
  teammates,
  presenceTick,
  api,
  onBack,
}: {
  channel: StreamChannel
  selfId: string
  teammates: TeammateIndex
  presenceTick: number
  api: RpcStub<AuthenticatedApi>
  onBack: () => void
}) {
  const info = describeConversation(channel, selfId, teammates)
  void presenceTick
  let subtitle: string
  if (info.kind === 'dm') {
    subtitle = info.online ? 'Online' : info.lastActive ? `Last active ${relativeTime(info.lastActive, true)}` : 'Offline'
  } else {
    subtitle = `${info.memberCount} members` + (info.onlineCount ? ` · ${info.onlineCount} online` : '')
  }
  return (
    <div className="flex items-center gap-2 pl-1 pr-3 h-12 border-b border-kumo-line shrink-0">
      <IconButton label="Back to conversations" onClick={onBack}>
        <ArrowLeft size={16} />
      </IconButton>
      <ConversationAvatar info={info} api={api} size={32} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-kumo-default truncate leading-tight">{info.title}</div>
        <div className={`text-[11px] leading-tight truncate ${info.kind === 'dm' && info.online ? 'text-kumo-success' : 'text-kumo-subtle'}`}>{subtitle}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Avatars

function ConversationAvatar({ info, api, size }: { info: ConversationInfo; api: RpcStub<AuthenticatedApi>; size: number }) {
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

function InitialsAvatar({ name, size }: { name: string; size: number }) {
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
// New conversation

function NewConversation({
  api,
  teammates,
  onBack,
  onCreated,
}: {
  api: RpcStub<AuthenticatedApi>
  teammates: TeammateIndex
  onBack: () => void
  onCreated: (cid: string) => Promise<void>
}) {
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
          <IconButton label="Back" onClick={onBack}><ArrowLeft size={16} /></IconButton>
          <label className="flex-1 flex items-center gap-2 h-9 px-2.5 rounded-md bg-kumo-tint">
            <Search size={14} className="text-kumo-subtle shrink-0" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="To: search teammates"
              className="flex-1 min-w-0 bg-transparent text-sm text-kumo-default placeholder:text-kumo-inactive outline-none"
            />
          </label>
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
// Conversation description helpers

type ConversationInfo =
  | { kind: 'dm'; title: string; email: string | null; online: boolean; lastActive: Date | null }
  | { kind: 'group'; title: string; memberCount: number; onlineCount: number }

function describeConversation(channel: StreamChannel, selfId: string, teammates: TeammateIndex): ConversationInfo {
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

function conversationTitle(channel: StreamChannel, selfId: string, teammates: TeammateIndex): string {
  return describeConversation(channel, selfId, teammates).title
}

function previewText(message: { text?: string; attachments?: unknown[]; deleted_at?: Date | string | null }): string {
  if (message.deleted_at) return 'Message deleted'
  const text = message.text?.trim()
  if (text) return text.replace(/\s+/g, ' ')
  if (message.attachments && message.attachments.length > 0) return 'Sent an attachment'
  return ''
}

// "now", "5m", "3h", "Mon", "12 Aug" — LinkedIn-style compact stamps for the list; the long form
// ("5 minutes ago") is for the presence line.
function relativeTime(date: Date, long = false): string {
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

// ---------------------------------------------------------------------------------------------
// Hooks

type TeammateIndex = {
  list: TeamChatTeammate[] | null
  byStreamId: Map<string, TeamChatTeammate>
  error: string | null
}

// The deployment's team directory, keyed by Stream id, so rows can show real names and avatars
// (avatars are keyed by email) and the "new message" picker has its list.
function useTeammates(api: RpcStub<AuthenticatedApi>): TeammateIndex {
  const [list, setList] = useState<TeamChatTeammate[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api.listTeamChatTeammates().then((result) => {
      if (!cancelled) setList(result)
    }).catch((err) => {
      logRpcFailure('Failed to list teammates:', err)
      if (!cancelled) setError('Could not load your teammates.')
    })
    return () => { cancelled = true }
  }, [api])
  return useMemo(() => ({
    list,
    byStreamId: new Map((list ?? []).map((t) => [t.streamId, t])),
    error,
  }), [list, error])
}

// Total unread across the caller's channels: seeded by the connect response and kept fresh by
// the unread counter Stream attaches to notification events.
function useUnreadCount(): number {
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

// A counter that bumps on presence changes so rows/headers re-read `user.online`.
function usePresenceTick(): number {
  const { client } = useChatContext()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const { unsubscribe } = client.on('user.presence.changed', () => setTick((t) => t + 1))
    return unsubscribe
  }, [client])
  return tick
}

// "(3) Tyms" in the tab title while there are unread messages.
function useDocumentTitleBadge(unread: number) {
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\+?\)\s/, '')
    document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${base}` : base
    return () => { document.title = document.title.replace(/^\(\d+\+?\)\s/, '') }
  }, [unread])
}

async function requestNotificationPermission() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return
  try { await Notification.requestPermission() } catch { /* ignored */ }
}

// A system notification for a teammate's message when the tab is hidden or the dock is
// collapsed; clicking it opens that conversation.
function useNewMessageNotifications(selfId: string, expanded: boolean, openCid: (cid: string) => Promise<void>) {
  const { client } = useChatContext()
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  useEffect(() => {
    const { unsubscribe } = client.on('message.new', (event: Event) => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      const message = event.message
      if (!message || event.user?.id === selfId) return
      if (!document.hidden && expandedRef.current) return
      const cid = event.cid
      const body = previewText(message)
      const n = new Notification(event.user?.name ?? 'New message', { body, tag: cid ?? message.id })
      n.addEventListener('click', () => {
        window.focus()
        if (cid) void openCid(cid)
        n.close()
      })
    })
    return unsubscribe
  }, [client, selfId, openCid])
}

// Follows the app's theme mode (set on <html data-mode>) so Stream's components flip with it.
const readDarkMode = () => document.documentElement.getAttribute('data-mode') === 'dark'

function useDarkMode(): boolean {
  const [dark, setDark] = useState(readDarkMode)
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(readDarkMode()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

function readStoredBool(key: string): boolean {
  try { return localStorage.getItem(key) === '1' } catch { return false }
}
function writeStoredBool(key: string, value: boolean) {
  try { localStorage.setItem(key, value ? '1' : '0') } catch { /* ignored */ }
}
