import { useEffect, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { Check, Copy, Mail, MessageSquare, Send, Slack } from 'lucide-react'
import type { UserChannelsView } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'
import { useMyChannels } from './useMyChannels'
import { PRIMARY_BTN, ICON_BTN, SectionLabel, FieldLabel } from './components/settingsControls'
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
        {channels?.telegram.configured && <TelegramSection telegram={channels.telegram} />}
        {channels?.slack.configured && <SlackSection />}
      </div>
    </div>
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

// Telegram link state: linked account details, or where to get a personal link.
function TelegramSection({ telegram }: { telegram: UserChannelsView['telegram'] }) {
  return (
    <ChannelSection label="Telegram" icon={<MessageSquare />}>
      {telegram.linked ? (
        <>
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
        </>
      ) : (
        <p className="text-sm text-kumo-subtle">
          Your Telegram account isn't linked yet. Ask your workspace admin for a personal link
          — tapping it connects your account
          {telegram.botUserName ? (
            <> to <span className="font-mono text-[13px]">@{telegram.botUserName}</span></>
          ) : null}
          .
        </p>
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
