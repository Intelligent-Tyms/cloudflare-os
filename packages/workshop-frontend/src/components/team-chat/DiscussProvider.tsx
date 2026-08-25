import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RpcStub } from 'capnweb'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { TeamChatSession, TeamChatTeammate, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { Event } from 'stream-chat'
import {
  Chat,
  Channel,
  MessageList,
  MessageComposer,
  Thread,
  Window,
  WithComponents,
  useChatContext,
  useCreateChatClient,
} from 'stream-chat-react'
import { ChevronDown, ChevronUp, Maximize2, SquarePen } from 'lucide-react'
import 'stream-chat-react/dist/css/index.css'
import './team-chat.css'
import { PersonAvatar } from '../PersonAvatar'
import { logRpcFailure } from '../../rpcErrors'
import type { DiscussContextValue, DiscussPrefs, DiscussRequest, TeammateIndex } from './discuss-context'
import {
  ConversationDetails, ConversationHeader, ConversationList, DISCUSS_ICONS, DiscussAttachment, IconButton, NewConversation,
  PrefsMenu, UnreadPill, describeConversation, previewText, streamTheme, useDarkMode, useLiveTick, useUnreadCount,
} from './discuss-shared'

// Discuss: human-to-human messaging between the members of this deployment. This component
// owns the Stream client and everything that must run on every page — notifications, the
// tab-title badge, sounds — and renders the dock (a bar docked bottom-right, the way LinkedIn
// docks "Messaging") on every page except /discuss, which shows the same conversations full
// size. It is rendered as a sibling of the app (never around it) and publishes its context
// value through `onValue`, so the rest of the app never remounts because of it. Everything
// chat-shaped (presence, unread counts, typing, receipts, reactions, attachments, threads,
// @mentions) comes from Stream; this is the Tyms-styled shell around it.

const EXPANDED_KEY = 'tyms.discuss.expanded'
const PREFS_KEY = 'tyms.discuss.prefs'

type View = 'list' | 'channel' | 'new'

export default function DiscussProvider({
  api,
  initialSession,
  selfUserId,
  onValue,
}: {
  api: RpcStub<AuthenticatedApi>
  initialSession: TeamChatSession
  selfUserId: string
  onValue: (value: DiscussContextValue | null) => void
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
  useEffect(() => () => onValue(null), [onValue])
  if (!client) return null

  return (
    <Chat client={client} theme={streamTheme(dark)}>
      <DiscussController api={api} session={initialSession} selfUserId={selfUserId} onValue={onValue} />
    </Chat>
  )
}

// ---------------------------------------------------------------------------------------------
// Controller: app-wide context value + the dock

function DiscussController({
  api, session, selfUserId, onValue,
}: {
  api: RpcStub<AuthenticatedApi>
  session: TeamChatSession
  selfUserId: string
  onValue: (value: DiscussContextValue | null) => void
}) {
  const { client, channel, setActiveChannel } = useChatContext()
  const [expanded, setExpandedState] = useState<boolean>(() => readStored(EXPANDED_KEY) === '1')
  const [view, setView] = useState<View>('list')
  const [prefs, setPrefsState] = useState<DiscussPrefs>(readPrefs)
  const [request, setRequest] = useState<DiscussRequest | null>(null)
  const teammates = useTeammates(api)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const onPage = pathname === '/discuss' || pathname.startsWith('/discuss/')
  const onPageRef = useRef(onPage)
  onPageRef.current = onPage

  const setExpanded = useCallback((next: boolean) => {
    if (next) void requestNotificationPermission()
    setExpandedState(next)
    writeStored(EXPANDED_KEY, next ? '1' : '0')
  }, [])
  const setPrefs = useCallback((patch: Partial<DiscussPrefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...patch }
      writeStored(PREFS_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  // Selecting a conversation (ChannelList sets the active channel) moves the dock to it.
  useEffect(() => {
    if (channel) setView('channel')
  }, [channel])

  const backToList = useCallback(() => {
    setActiveChannel(undefined)
    setView('list')
  }, [setActiveChannel])

  const openInDock = useCallback(async (cid: string) => {
    const [type, id] = cid.split(':')
    const target = client.channel(type, id)
    await target.watch()
    setActiveChannel(target)
    setView('channel')
    setExpanded(true)
  }, [client, setActiveChannel, setExpanded])

  const open = useCallback((cid: string) => {
    if (onPageRef.current) setRequest({ kind: 'open', cid })
    else void openInDock(cid)
  }, [openInDock])
  const openNew = useCallback(() => {
    if (onPageRef.current) {
      setRequest({ kind: 'new' })
    } else {
      setActiveChannel(undefined)
      setView('new')
      setExpanded(true)
    }
  }, [setActiveChannel, setExpanded])
  const collapse = useCallback(() => setExpanded(false), [setExpanded])
  const clearRequest = useCallback(() => setRequest(null), [])

  const value = useMemo<DiscussContextValue>(() => ({
    api, client, session, selfUserId, teammates, prefs, setPrefs, open, openNew, collapse, request, clearRequest,
  }), [api, client, session, selfUserId, teammates, prefs, setPrefs, open, openNew, collapse, request, clearRequest])
  useEffect(() => { onValue(value) }, [onValue, value])

  const unread = useUnreadCount()
  useDocumentTitleBadge(unread)
  useNewMessageAlerts(value, { expanded, onPage, activeCid: channel?.cid, openInDock })

  // The page owns its own active conversation; when it is showing, the dock stays out of the
  // way and drops whatever it had open so it comes back on the list.
  useEffect(() => {
    if (onPage && channel) backToList()
  }, [onPage, channel, backToList])

  if (onPage) return null
  return (
    <DiscussDock
      discuss={value}
      unread={unread}
      expanded={expanded}
      setExpanded={setExpanded}
      view={view}
      setView={setView}
      backToList={backToList}
      openInDock={openInDock}
    />
  )
}

// ---------------------------------------------------------------------------------------------
// The dock

function DiscussDock({
  discuss, unread, expanded, setExpanded, view, setView, backToList, openInDock,
}: {
  discuss: DiscussContextValue
  unread: number
  expanded: boolean
  setExpanded: (next: boolean) => void
  view: View
  setView: (view: View) => void
  backToList: () => void
  openInDock: (cid: string) => Promise<void>
}) {
  const { channel } = useChatContext()
  const { api, session, selfUserId, teammates } = discuss
  const tick = useLiveTick()
  const [details, setDetails] = useState(false)
  const navigate = useNavigate()

  useEffect(() => { setDetails(false) }, [channel])

  // Esc walks back: details → conversation → list → collapsed.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    if (details) setDetails(false)
    else if (view === 'list') setExpanded(false)
    else backToList()
  }

  const title = view === 'new' ? 'New message' : view === 'channel' && channel
    ? describeConversation(channel, session.userId, teammates).title
    : 'Discuss'

  return (
    <div
      className="team-chat fixed z-40 right-0 sm:right-6 w-full sm:w-[22rem]"
      style={{ bottom: 'var(--app-bottom, 0px)' }}
      onKeyDown={onKeyDown}
    >
      <div className="team-chat-dock flex flex-col rounded-t-xl border border-b-0 border-kumo-line bg-kumo-base shadow-[0_-4px_24px_rgba(0,0,0,0.08)] dark:shadow-[0_-4px_24px_rgba(0,0,0,0.5)] overflow-hidden">
        <div className="flex items-center h-12 pl-3 pr-1.5 gap-1 shrink-0 select-none">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse Discuss' : 'Expand Discuss'}
            className="flex-1 min-w-0 flex items-center gap-2.5 h-full text-left"
          >
            <span className="relative shrink-0">
              <PersonAvatar api={api} userId={selfUserId} name={session.name} size={28} />
              <span
                title={discuss.prefs.dnd ? 'Notifications paused' : 'Online'}
                className={`absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-kumo-base ${discuss.prefs.dnd ? 'bg-kumo-danger' : 'bg-kumo-success'}`}
              />
            </span>
            <span className="text-sm font-semibold text-kumo-default truncate">{title}</span>
            {!expanded && unread > 0 && <UnreadPill count={unread} />}
          </button>
          {expanded && (
            <>
              <PrefsMenu discuss={discuss} />
              {view !== 'new' && (
                <IconButton label="New message" onClick={() => { backToList(); setView('new') }}>
                  <SquarePen size={16} />
                </IconButton>
              )}
              <IconButton label="Open Discuss in full" onClick={() => { setExpanded(false); void navigate({ to: '/discuss' }) }}>
                <Maximize2 size={15} />
              </IconButton>
            </>
          )}
          <IconButton label={expanded ? 'Collapse' : 'Expand'} onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
          </IconButton>
        </div>

        {expanded && (
          <div className="team-chat-panel flex flex-col border-t border-kumo-line h-[min(30rem,calc(var(--app-height,100vh)-7rem))]">
            {view === 'list' && <ConversationList discuss={discuss} tick={tick} onNew={() => setView('new')} />}
            {view === 'channel' && channel && (
              <Channel channel={channel}>
                <WithComponents overrides={{ Attachment: DiscussAttachment, icons: DISCUSS_ICONS }}>
                {/* Stream lays out .str-chat__channel as a row (main panel | thread), so the
                    header must live inside <Window>, which is the column. */}
                <Window>
                  <ConversationHeader
                    channel={channel}
                    discuss={discuss}
                    tick={tick}
                    onBack={backToList}
                    showBack
                    infoOpen={details}
                    onToggleInfo={() => setDetails((d) => !d)}
                  />
                  {details ? (
                    <ConversationDetails channel={channel} discuss={discuss} tick={tick} onClose={() => setDetails(false)} onLeft={backToList} />
                  ) : (
                    <>
                      <MessageList />
                      <MessageComposer />
                    </>
                  )}
                </Window>
                <Thread />
                </WithComponents>
              </Channel>
            )}
            {view === 'new' && (
              <NewConversation discuss={discuss} showBack onBack={() => setView('list')} onCreated={openInDock} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Hooks

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

// Alerts for a teammate's message the person is not already looking at: a system notification
// when the tab is hidden, otherwise a toast; plus a short sound. Muted conversations and
// "pause notifications" silence all of it.
function useNewMessageAlerts(
  discuss: DiscussContextValue,
  live: { expanded: boolean; onPage: boolean; activeCid: string | undefined; openInDock: (cid: string) => Promise<void> },
) {
  const { client, session, prefs, open } = discuss
  const toasts = useKumoToastManager()
  const state = useRef({ ...live, prefs })
  state.current = { ...live, prefs }

  useEffect(() => {
    const { unsubscribe } = client.on('message.new', (event: Event) => {
      const message = event.message
      const cid = event.cid
      if (!message || !cid || event.user?.id === session.userId) return
      const { expanded, onPage, activeCid, prefs: current } = state.current
      if (current.dnd) return
      if (client.activeChannels[cid]?.muteStatus().muted) return
      // On the page the page's own active conversation is what matters; it marks messages read
      // itself, so a message that is already read by the time we look is one they are seeing.
      const looking = !document.hidden && (onPage
        ? (client.activeChannels[cid]?.countUnread() ?? 0) === 0
        : expanded && cid === activeCid)
      if (looking) return

      const who = event.user?.name ?? 'Teammate'
      const body = previewText(message)
      if (current.sound) playBlip()
      if (document.hidden) {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const n = new Notification(who, { body, tag: cid })
          n.addEventListener('click', () => {
            window.focus()
            open(cid)
            n.close()
          })
        }
        return
      }
      toasts.add({
        title: who,
        description: body,
        actionProps: { children: 'Open', onClick: () => open(cid) },
      })
    })
    return unsubscribe
  }, [client, session.userId, open, toasts])
}

// A short, quiet two-tone blip. Browsers only allow audio after a user gesture, so this fails
// silently until the person has interacted with the page.
function playBlip() {
  try {
    const ctx = new AudioContext()
    const gain = ctx.createGain()
    gain.gain.value = 0.04
    gain.connect(ctx.destination)
    const tone = (freq: number, start: number) => {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      osc.connect(gain)
      osc.start(ctx.currentTime + start)
      osc.stop(ctx.currentTime + start + 0.09)
    }
    tone(660, 0)
    tone(880, 0.1)
    setTimeout(() => { void ctx.close() }, 400)
  } catch { /* ignored */ }
}

function readStored(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function writeStored(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* ignored */ }
}
function readPrefs(): DiscussPrefs {
  const defaults: DiscussPrefs = { dnd: false, sound: true }
  try {
    const raw = readStored(PREFS_KEY)
    return raw ? { ...defaults, ...(JSON.parse(raw) as Partial<DiscussPrefs>) } : defaults
  } catch {
    return defaults
  }
}
