import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RpcStub } from 'capnweb'
import type { TeamChatSession, TeamChatTeammate, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { Event, OwnUserResponse, UserResponse } from 'stream-chat'
import {
  Chat,
  Channel,
  ChannelHeader,
  ChannelList,
  MessageList,
  MessageComposer,
  Thread,
  Window,
  useChatContext,
  useCreateChatClient,
} from 'stream-chat-react'
import { ArrowLeft, Check, MessageCircle, Plus, Search, X } from 'lucide-react'
import 'stream-chat-react/dist/css/index.css'
import './team-chat.css'
import { initials } from '../PersonAvatar'
import { logRpcFailure } from '../../rpcErrors'

// The floating team-chat widget: a stack of online teammates plus a toggle in the bottom-right
// corner; clicking opens a panel with the caller's conversations (people and groups), a
// conversation view, and a "new" view to start a DM or a group. Everything chat-shaped
// (presence, unread counts, typing, attachments, threads) comes from Stream.

type View = 'list' | 'channel' | 'new'

const MAX_VISIBLE_ONLINE = 3

export default function TeamChatWidget({
  api,
  initialSession,
}: {
  api: RpcStub<AuthenticatedApi>
  initialSession: TeamChatSession
}) {
  // The token is handed to Stream as a provider so it refreshes itself on expiry.
  const sessionRef = useRef(initialSession)
  const tokenProvider = useCallback(async () => {
    if (sessionRef.current.expiresAt - Date.now() > 60_000) return sessionRef.current.token
    const fresh = await api.getTeamChatSession()
    if (!fresh) throw new Error('Team chat is no longer available.')
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
      <TeamChatShell api={api} session={initialSession} />
    </Chat>
  )
}

function TeamChatShell({
  api,
  session,
}: {
  api: RpcStub<AuthenticatedApi>
  session: TeamChatSession
}) {
  const { client, channel, setActiveChannel } = useChatContext()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('list')
  const unread = useUnreadCount()
  const online = useOnlineTeammates(session)

  // Selecting a conversation in the list (ChannelList sets the active channel) moves the
  // panel to the conversation view.
  useEffect(() => {
    if (channel) setView('channel')
  }, [channel])

  const backToList = () => {
    setActiveChannel(undefined)
    setView('list')
  }

  const openCreated = async (cid: string) => {
    const [type, id] = cid.split(':')
    const created = client.channel(type, id)
    await created.watch()
    setActiveChannel(created)
    setView('channel')
  }

  const filters = useMemo(
    () => ({ type: 'messaging', team: session.team, members: { $in: [session.userId] } }),
    [session.team, session.userId],
  )

  return (
    <div className="team-chat fixed right-4 z-40 flex flex-col items-end gap-3" style={{ bottom: 'calc(var(--app-bottom, 0px) + 1rem)' }}>
      {open && (
        <div className="team-chat-panel w-[min(22.5rem,calc(100vw-2rem))] h-[min(32.5rem,calc(var(--app-height,100vh)-6rem))] rounded-xl border border-kumo-line bg-kumo-base shadow-lg overflow-hidden flex flex-col animate-slide-in">
          {view === 'list' && (
            <>
              <PanelHeader title="Team chat">
                <button
                  type="button"
                  onClick={() => setView('new')}
                  className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-xs font-medium border border-kumo-line hover:bg-kumo-tint text-kumo-default"
                >
                  <Plus size={14} /> New
                </button>
              </PanelHeader>
              <div className="flex-1 min-h-0 overflow-y-auto">
                <ChannelList
                  filters={filters}
                  sort={{ last_message_at: -1 }}
                  options={{ presence: true, state: true, limit: 30 }}
                  setActiveChannelOnMount={false}
                  EmptyStateIndicator={EmptyList}
                />
              </div>
            </>
          )}
          {view === 'channel' && channel && (
            <Channel channel={channel}>
              {/* Stream lays out .str-chat__channel as a row (main panel | thread), so the header
                  must live inside <Window>, which is the column. */}
              <Window>
                <div className="flex items-center gap-1 pl-2 border-b border-kumo-line shrink-0">
                  <button
                    type="button"
                    onClick={backToList}
                    aria-label="Back to conversations"
                    className="w-8 h-8 inline-flex items-center justify-center rounded-md hover:bg-kumo-tint text-kumo-default"
                  >
                    <ArrowLeft size={16} />
                  </button>
                  <div className="flex-1 min-w-0">
                    <ChannelHeader />
                  </div>
                </div>
                <MessageList />
                <MessageComposer />
              </Window>
              <Thread />
            </Channel>
          )}
          {view === 'new' && (
            <NewConversation
              api={api}
              onBack={() => setView('list')}
              onCreated={openCreated}
            />
          )}
        </div>
      )}

      <div className="flex items-center">
        {!open && online.map((user, i) => (
          <button
            key={user.id}
            type="button"
            title={`${user.name ?? user.id} is online`}
            onClick={() => setOpen(true)}
            className="team-chat-avatar relative -mr-3 w-10 h-10 rounded-full border-2 border-kumo-base bg-kumo-tint text-kumo-default text-xs font-semibold inline-flex items-center justify-center shadow-sm"
            style={{ zIndex: MAX_VISIBLE_ONLINE - i }}
          >
            {initials(user.name ?? user.id)}
            <span className="absolute -right-0.5 -bottom-0.5 w-3 h-3 rounded-full bg-kumo-success border-2 border-kumo-base" />
          </button>
        ))}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? 'Close team chat' : 'Open team chat'}
          className="relative w-12 h-12 rounded-full bg-kumo-brand text-white shadow-lg inline-flex items-center justify-center hover:opacity-90"
          style={{ zIndex: MAX_VISIBLE_ONLINE + 1 }}
        >
          {open ? <X size={20} /> : <MessageCircle size={22} />}
          {!open && unread > 0 && (
            <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-kumo-danger text-white text-[11px] font-semibold inline-flex items-center justify-center">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </div>
    </div>
  )
}

function PanelHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 h-12 border-b border-kumo-line shrink-0">
      <div className="flex-1 text-sm font-semibold text-kumo-default">{title}</div>
      {children}
    </div>
  )
}

function EmptyList() {
  return (
    <div className="px-4 py-10 text-center text-sm text-kumo-subtle">
      No conversations yet. Start one with <strong>New</strong>.
    </div>
  )
}

function NewConversation({
  api,
  onBack,
  onCreated,
}: {
  api: RpcStub<AuthenticatedApi>
  onBack: () => void
  onCreated: (cid: string) => Promise<void>
}) {
  const [teammates, setTeammates] = useState<TeamChatTeammate[] | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.listTeamChatTeammates().then((list) => {
      if (!cancelled) setTeammates(list)
    }).catch((err) => {
      logRpcFailure('Failed to list teammates:', err)
      if (!cancelled) setError('Could not load your teammates.')
    })
    return () => { cancelled = true }
  }, [api])

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
  const visible = (teammates ?? []).filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.email.toLowerCase().includes(q),
  )

  return (
    <>
      <PanelHeader title="New conversation">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="w-8 h-8 inline-flex items-center justify-center rounded-md hover:bg-kumo-tint text-kumo-default"
        >
          <X size={16} />
        </button>
      </PanelHeader>
      <div className="p-3 flex flex-col gap-2 shrink-0">
        <label className="flex items-center gap-2 h-9 px-2.5 rounded-md border border-kumo-line bg-kumo-base">
          <Search size={14} className="text-kumo-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search teammates"
            className="flex-1 bg-transparent text-sm text-kumo-default outline-none"
          />
        </label>
        {isGroup && (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Group name"
            maxLength={80}
            className="h-9 px-2.5 rounded-md border border-kumo-line bg-kumo-base text-sm text-kumo-default outline-none"
          />
        )}
        {selected.size === 1 && !isGroup && (
          <div className="text-xs text-kumo-subtle">Pick more people, or add a name, to make a group.</div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2">
        {teammates === null && !error && (
          <div className="px-2 py-6 text-sm text-kumo-subtle">Loading teammates…</div>
        )}
        {teammates !== null && visible.length === 0 && (
          <div className="px-2 py-6 text-sm text-kumo-subtle">
            {teammates.length === 0 ? 'No teammates yet. Invite people from Admin → Teammates.' : 'No matches.'}
          </div>
        )}
        {visible.map((t) => {
          const on = selected.has(t.streamId)
          return (
            <button
              key={t.streamId}
              type="button"
              onClick={() => toggle(t.streamId)}
              className="w-full flex items-center gap-3 px-2 py-2 rounded-md hover:bg-kumo-tint text-left"
            >
              <span className="w-9 h-9 rounded-full bg-kumo-tint text-kumo-default text-xs font-semibold inline-flex items-center justify-center shrink-0">
                {initials(t.name)}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-kumo-default truncate">{t.name}</span>
                <span className="block text-xs text-kumo-subtle truncate">{t.email}</span>
              </span>
              <span
                className={`w-5 h-5 rounded border inline-flex items-center justify-center shrink-0 ${
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
          className="h-10 rounded-md bg-kumo-brand text-white text-sm font-medium disabled:opacity-50"
        >
          {busy
            ? 'Starting…'
            : isGroup
              ? `Create group (${selected.size} selected)`
              : selected.size === 1
                ? 'Start chat'
                : 'Pick someone to message'}
        </button>
      </div>
    </>
  )
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

// Up to MAX_VISIBLE_ONLINE teammates currently online, refreshed on presence changes. Stream's
// multi-tenant mode scopes the query to the caller's team on its own.
function useOnlineTeammates(session: TeamChatSession): UserResponse[] {
  const { client } = useChatContext()
  const [online, setOnline] = useState<UserResponse[]>([])
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const { users } = await client.queryUsers(
          { teams: { $in: [session.team] } },
          { last_active: -1 },
          { presence: true, limit: 30 },
        )
        if (!cancelled) setOnline(users.filter((u) => u.online && u.id !== session.userId).slice(0, MAX_VISIBLE_ONLINE))
      } catch (err) {
        console.warn('Team chat: presence query failed', err)
      }
    }
    void refresh()
    const { unsubscribe } = client.on('user.presence.changed', () => { void refresh() })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [client, session.team, session.userId])
  return online
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
