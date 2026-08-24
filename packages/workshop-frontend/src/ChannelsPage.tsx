import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { Check, Copy, ExternalLink, Mail, MessageSquare, Send, Slack } from 'lucide-react'
import type { UserChannelsView } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'
import { useMyChannels } from './useMyChannels'
import { PRIMARY_BTN, ICON_BTN, GHOST_BTN, SectionLabel, FieldLabel } from './components/settingsControls'
import { useDocumentTitle } from './useDocumentTitle'

// The user-facing side of messaging channels (/channels, from the user menu): where your own
// assistant can hear from you. Read-only — admins provision addresses and Telegram links from
// Admin → Channels; this page shows the caller their own connections and how to use them.
export default function ChannelsPage() {
  useDocumentTitle('Channels')

  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const cached = useMyChannels()
  // Seed from the session cache for an instant paint, then refetch on mount so
  // "last received" is current rather than a session old.
  const [view, setView] = useState<UserChannelsView | null | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      setView(await authenticatedApi.getMyChannels())
    } catch {
      setView(null)
    }
  }, [authenticatedApi])

  useEffect(() => {
    let cancelled = false
    authenticatedApi.getMyChannels()
      .then((v) => { if (!cancelled) setView(v) })
      .catch(() => { if (!cancelled) setView(null) })
    return () => { cancelled = true }
  }, [authenticatedApi])

  const channels = view === undefined ? cached : view

  if (channels === undefined) {
    return (
      <div className="flex min-h-[60vh] flex-1 items-center justify-center">
        <p className="text-[13px] tracking-[-0.25px] text-kumo-subtle">Loading channels…</p>
      </div>
    )
  }

  const anyConfigured =
    channels !== null &&
    (channels.telegram.configured || channels.slack.configured || channels.email.configured)

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-6 pb-16 sm:px-10">
      <header className="px-1 pb-2 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Channels</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          Where your assistant can hear from you outside the app.
        </p>
      </header>

      <div className="mt-6 flex flex-col gap-9">
        {!anyConfigured && (
          <div className="rounded-xl border border-dashed border-kumo-line p-6 text-sm text-kumo-subtle">
            Messaging channels aren't set up on this workspace yet. Ask your workspace admin
            about enabling them.
          </div>
        )}

        {channels?.email.configured && (
          <EmailSection email={channels.email} userEmail={currentUser?.id} />
        )}
        {channels?.telegram.configured && (
          <TelegramSection telegram={channels.telegram} onChanged={refresh} />
        )}
        {channels?.slack.configured && <SlackSection />}

        {anyConfigured && <WorkspaceCommandsSection />}
      </div>
    </div>
  )
}

// Every channel starts a conversation with the home assistant; these commands (answered by
// the backend, identically on every channel) move a conversation to another workspace.
function WorkspaceCommandsSection() {
  const commands: Array<[string, string]> = [
    ['/workspaces', 'list your workspaces'],
    ['/use <number or name>', 'talk to that workspace from this conversation'],
    ['/home', 'back to your home assistant'],
    ['/where', 'which workspace this conversation is in'],
  ]
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Switching workspaces</SectionLabel>
      <div className="rounded-xl border border-kumo-line bg-kumo-base px-5 py-4 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
        <p>
          Messages from any channel reach your home assistant. To work in another workspace
          from a chat, ask the assistant to switch, or send a command:
        </p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          {commands.map(([command, what]) => (
            <Fragment key={command}>
              <dt>
                <code className="rounded bg-kumo-tint px-1.5 py-0.5 text-[12px] text-kumo-default">
                  {command}
                </code>
              </dt>
              <dd>{what}</dd>
            </Fragment>
          ))}
        </dl>
        <p className="mt-3">
          Put your question on the line after <code>/use</code> to send it straight there. On
          Slack, type <code>!use</code> instead of <code>/use</code>. By email, address
          your assistant as <code>assistant+workspace-name@…</code> or start the subject
          with <code>[Workspace name]</code>.
        </p>
      </div>
    </section>
  )
}

function lastMessageLabel(lastMessageAt: number | undefined): string {
  return lastMessageAt
    ? `Last received a message ${new Date(lastMessageAt).toLocaleString()}`
    : 'No messages received yet'
}

function ChannelSection({
  label,
  icon,
  children,
}: {
  label: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>
        <span className="flex items-center gap-2">
          <span className="grid w-[15px] place-items-center text-kumo-inactive [&>svg]:h-[15px] [&>svg]:w-[15px]">
            {icon}
          </span>
          {label}
        </span>
      </SectionLabel>
      <div className="rounded-xl border border-kumo-line bg-kumo-base px-5 py-4">{children}</div>
    </section>
  )
}

// The assistant's email address: copy it, see when it last heard from you, try it out.
function EmailSection({
  email,
  userEmail,
}: {
  email: UserChannelsView['email']
  userEmail: string | undefined
}) {
  const toasts = useKumoToastManager()
  const [copied, setCopied] = useState(false)

  const copyAddress = async () => {
    if (!email.address) return
    try {
      await navigator.clipboard.writeText(email.address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toasts.add({ title: 'Failed to copy', variant: 'error' })
    }
  }

  if (!email.address) {
    return (
      <ChannelSection label="Email" icon={<Mail />}>
        <p className="text-sm text-kumo-subtle">
          Your assistant doesn't have an email address yet. Ask your workspace admin to create
          one from Admin → Channels.
        </p>
      </ChannelSection>
    )
  }

  const testMailto =
    `mailto:${email.address}` +
    `?subject=${encodeURIComponent('A quick hello')}` +
    `&body=${encodeURIComponent('Hi! Just checking you can hear me. What can you help me with over email?')}`

  return (
    <ChannelSection label="Email" icon={<Mail />}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <FieldLabel>Your assistant's address</FieldLabel>
          <p className="mt-1 truncate font-mono text-[13px] tracking-[-0.1px] text-kumo-strong">
            {email.address}
          </p>
        </div>
        <button type="button" onClick={() => void copyAddress()} aria-label="Copy address" className={ICON_BTN}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <p className="mt-2 text-[12px] tracking-[-0.1px] text-kumo-subtle">
        {lastMessageLabel(email.lastMessageAt)}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <a href={testMailto} className={PRIMARY_BTN}>
          <Send size={14} strokeWidth={2.5} />
          Send a test email
        </a>
        <p className="text-[12px] tracking-[-0.1px] text-kumo-subtle">
          {userEmail ? `Send from ${userEmail} — ` : 'Send from your workspace email — '}
          your assistant only answers mail from you.
        </p>
      </div>
    </ChannelSection>
  )
}

// Telegram link state: linked account details with self-unlink, or self-service linking —
// mint a personal deep link (it can only bind the caller's own account) and poll while the
// user taps it in Telegram so the section flips to linked on its own.
function TelegramSection({
  telegram,
  onChanged,
}: {
  telegram: UserChannelsView['telegram']
  onChanged: () => Promise<void>
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [minted, setMinted] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const wasLinked = useRef(telegram.linked)

  // While a minted link is outstanding, poll so tapping it in Telegram flips this section
  // to linked without a manual reload.
  useEffect(() => {
    if (!minted || telegram.linked) return
    const timer = setInterval(() => { void onChanged() }, 4000)
    return () => clearInterval(timer)
  }, [minted, telegram.linked, onChanged])

  useEffect(() => {
    if (telegram.linked && !wasLinked.current) {
      setMinted(null)
      toasts.add({ title: 'Telegram linked', variant: 'success' })
    }
    wasLinked.current = telegram.linked
  }, [telegram.linked, toasts])

  const mint = async () => {
    if (busy) return
    setBusy(true)
    try {
      const { link } = await authenticatedApi.linkMyTelegram()
      setMinted(link)
      setCopied(false)
    } catch (err) {
      console.error('Failed to create a Telegram link:', err)
      toasts.add({
        title: err instanceof Error ? err.message : "Couldn't create the link",
        variant: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  const unlink = async () => {
    if (busy) return
    setBusy(true)
    try {
      await authenticatedApi.unlinkMyTelegram()
      await onChanged()
      toasts.add({ title: 'Telegram unlinked', variant: 'success' })
    } catch (err) {
      console.error('Failed to unlink Telegram:', err)
      toasts.add({
        title: err instanceof Error ? err.message : "Couldn't unlink",
        variant: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  const copyMinted = async () => {
    if (!minted) return
    try {
      await navigator.clipboard.writeText(minted)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toasts.add({ title: 'Failed to copy', variant: 'error' })
    }
  }

  return (
    <ChannelSection label="Telegram" icon={<MessageSquare />}>
      {telegram.linked ? (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-kumo-default">
              {telegram.telegramUserName ? `@${telegram.telegramUserName} is linked` : 'Your Telegram account is linked'}
              {telegram.botUserName ? (
                <> — message <span className="font-mono text-[13px]">@{telegram.botUserName}</span> any time.</>
              ) : '.'}
            </p>
            <p className="mt-2 text-[12px] tracking-[-0.1px] text-kumo-subtle">
              {lastMessageLabel(telegram.lastMessageAt)}
              {telegram.linkedAt ? ` · linked ${new Date(telegram.linkedAt).toLocaleDateString()}` : ''}
            </p>
          </div>
          <button type="button" onClick={() => void unlink()} disabled={busy} className={`${GHOST_BTN} shrink-0`}>
            Unlink
          </button>
        </div>
      ) : (
        <>
          <p className="text-sm text-kumo-subtle">
            Chat with your assistant
            {telegram.botUserName ? (
              <> (<span className="font-mono text-[13px]">@{telegram.botUserName}</span>)</>
            ) : null}{' '}
            from Telegram. Linking takes one tap and only connects your own account.
          </p>
          {minted ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <a href={minted} target="_blank" rel="noreferrer" className={PRIMARY_BTN}>
                <ExternalLink size={14} strokeWidth={2.5} />
                Open in Telegram
              </a>
              <button type="button" onClick={() => void copyMinted()} aria-label="Copy link" className={ICON_BTN}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
              <p className="w-full text-[12px] tracking-[-0.1px] text-kumo-subtle sm:w-auto">
                On your phone? Copy the link and open it there. It works once and expires in a week.
              </p>
            </div>
          ) : (
            <div className="mt-4">
              <button type="button" onClick={() => void mint()} disabled={busy} className={PRIMARY_BTN}>
                <MessageSquare size={14} strokeWidth={2.5} />
                {busy ? 'Creating link…' : 'Link your Telegram'}
              </button>
            </div>
          )}
        </>
      )}
    </ChannelSection>
  )
}

// Slack needs no linking: the workspace recognizes users by their Slack profile email.
function SlackSection() {
  return (
    <ChannelSection label="Slack" icon={<Slack />}>
      <p className="text-sm text-kumo-subtle">
        Message the assistant's Slack app in a DM, or mention it in a channel. You're
        recognized by the email on your Slack profile, so there's nothing to set up.
      </p>
    </ChannelSection>
  )
}
