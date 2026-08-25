import { useCallback, useEffect, useState } from 'react'
import { Chat, Channel, MessageList, MessageComposer, Thread, Window, WithComponents, useChatContext } from 'stream-chat-react'
import { MessageSquare, SquarePen } from 'lucide-react'
import 'stream-chat-react/dist/css/index.css'
import './team-chat.css'
import { useDiscuss, useDiscussStatus } from './discuss-context'
import type { DiscussContextValue } from './discuss-context'
import {
  ConversationDetails, ConversationHeader, ConversationList, DiscussAttachment, IconButton, NewConversation,
  PrefsMenu, streamTheme, useDarkMode, useLiveTick,
} from './discuss-shared'

// /discuss — the same conversations as the dock, full size: a list column on the left and the
// open conversation on the right (on phones, one or the other). The page runs its own <Chat>
// provider over the shared client so its active conversation is independent of the dock's.

export default function DiscussPage() {
  const status = useDiscussStatus()
  const discuss = useDiscuss()
  const dark = useDarkMode()

  if (status === 'unavailable') {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <div className="text-base font-semibold text-kumo-default">Discuss isn't set up here</div>
          <p className="mt-2 text-sm text-kumo-subtle">
            Team messaging needs to be enabled for this deployment. Ask your Tyms contact.
          </p>
        </div>
      </div>
    )
  }
  if (!discuss) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  return (
    <div className="team-chat-page h-full min-h-0">
      <Chat client={discuss.client} theme={streamTheme(dark)}>
        <PageBody discuss={discuss} />
      </Chat>
    </div>
  )
}

function PageBody({ discuss }: { discuss: DiscussContextValue }) {
  const { client, channel, setActiveChannel } = useChatContext()
  const tick = useLiveTick()
  const [composing, setComposing] = useState(false)
  const [details, setDetails] = useState(false)

  useEffect(() => { setDetails(false) }, [channel])
  useEffect(() => { if (channel) setComposing(false) }, [channel])

  const openCid = useCallback(async (cid: string) => {
    const [type, id] = cid.split(':')
    const target = client.channel(type, id)
    await target.watch()
    setActiveChannel(target)
    setComposing(false)
  }, [client, setActiveChannel])

  // Requests from elsewhere (a toast's Open, a notification, "Send to Discuss").
  const { request, clearRequest } = discuss
  useEffect(() => {
    if (!request) return
    if (request.kind === 'open') void openCid(request.cid)
    else { setActiveChannel(undefined); setComposing(true) }
    clearRequest()
  }, [request, clearRequest, openCid, setActiveChannel])

  // Leaving the page drops the active conversation so it does not linger in the shared client.
  useEffect(() => () => setActiveChannel(undefined), [setActiveChannel])

  const showingRight = composing || Boolean(channel)
  const backToList = () => { setActiveChannel(undefined); setComposing(false) }

  return (
    <div className="flex h-full min-h-0">
      <aside className={`${showingRight ? 'hidden md:flex' : 'flex'} w-full md:w-80 lg:w-96 shrink-0 flex-col border-r border-kumo-line`}>
        <div className="flex items-center h-12 pl-4 pr-2 border-b border-kumo-line shrink-0">
          <h1 className="flex-1 text-sm font-semibold text-kumo-default">Discuss</h1>
          <PrefsMenu discuss={discuss} />
          <IconButton label="New message" onClick={() => { setActiveChannel(undefined); setComposing(true) }}>
            <SquarePen size={16} />
          </IconButton>
        </div>
        <ConversationList discuss={discuss} tick={tick} activeCid={channel?.cid} onNew={() => setComposing(true)} />
      </aside>

      <section className={`${showingRight ? 'flex' : 'hidden md:flex'} team-chat-panel flex-1 min-w-0 flex-col`}>
        {composing ? (
          <div className="flex flex-col h-full max-w-xl w-full">
            <NewConversation discuss={discuss} showBack onBack={backToList} onCreated={openCid} />
          </div>
        ) : channel ? (
          <Channel channel={channel}>
                <WithComponents overrides={{ Attachment: DiscussAttachment }}>
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
                <div className="flex-1 min-h-0 flex">
                  <div className="w-full max-w-md">
                    <ConversationDetails channel={channel} discuss={discuss} tick={tick} onClose={() => setDetails(false)} onLeft={backToList} />
                  </div>
                </div>
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
        ) : (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="flex flex-col items-center text-center gap-3">
              <span className="w-14 h-14 rounded-full bg-kumo-tint text-kumo-subtle inline-flex items-center justify-center">
                <MessageSquare size={24} />
              </span>
              <div className="text-sm font-medium text-kumo-default">Pick a conversation</div>
              <div className="text-xs text-kumo-subtle">Or start a new one with a teammate or a group.</div>
              <button
                type="button"
                onClick={() => setComposing(true)}
                className="mt-1 h-9 px-3 rounded-md bg-kumo-brand text-white text-sm font-medium hover:bg-kumo-brand-hover"
              >
                New message
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
