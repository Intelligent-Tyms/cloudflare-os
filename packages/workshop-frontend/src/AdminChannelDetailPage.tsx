// Detail page for one messaging channel (/admin/channels/$channel): status plus the
// channel's management surface. Telegram manages per-teammate links, Email manages
// assistant inboxes; the list at /admin/channels stays a bare index of cards.

import { useEffect, useState } from 'react'
import { RpcStub } from 'capnweb'
import { Link } from '@tanstack/react-router'
import { Button, Input, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowLeft, Check, Copy } from 'lucide-react'
import { useAuthenticatedApi } from './AuthContext'
import {
  AdminApi,
  ChannelsDescription,
  EmailInbox,
  TelegramBinding,
} from '@gadgets/workshop-shared/api'
import { useDocumentTitle } from './useDocumentTitle'

export const CHANNEL_IDS = ['telegram', 'slack', 'email', 'whatsapp', 'teams'] as const
export type ChannelId = (typeof CHANNEL_IDS)[number]

export function isChannelId(value: string): value is ChannelId {
  return (CHANNEL_IDS as readonly string[]).includes(value)
}

const CHANNEL_META: Record<ChannelId, { title: string; blurb: string }> = {
  telegram: {
    title: 'Telegram',
    blurb: 'Chat with your assistant from Telegram, on your phone or desktop.',
  },
  slack: {
    title: 'Slack',
    blurb: 'Message your assistant in Slack, in a DM or by mentioning it in a channel.',
  },
  email: {
    title: 'Email',
    blurb: 'Give each teammate an assistant email address they can write to from anywhere.',
  },
  whatsapp: { title: 'WhatsApp', blurb: 'Reach your assistant on WhatsApp.' },
  teams: { title: 'Microsoft Teams', blurb: 'Chat with your assistant in Teams.' },
}

export default function AdminChannelDetailPage({ channel }: { channel: ChannelId }) {
  const { authenticatedApi, isAdmin } = useAuthenticatedApi()
  const meta = CHANNEL_META[channel]
  useDocumentTitle(`${meta.title} · Channels · Admin`)

  // The admin capability (minted once, like AdminPage). Wrapped in an object so useState
  // doesn't treat the (callable) RPC stub as a state updater function.
  const [admin, setAdmin] = useState<{ api: RpcStub<AdminApi> } | null>(null)
  const [channels, setChannels] = useState<ChannelsDescription | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    let cancelled = false
    let stub: RpcStub<AdminApi> | null = null
    ;(async () => {
      try {
        const api = await authenticatedApi.getAdminApi()
        if (cancelled) {
          api?.[Symbol.dispose]?.()
          return
        }
        if (!api) {
          setLoadError(true)
          return
        }
        stub = api
        setAdmin({ api })
        const view = await api.getSettings()
        if (!cancelled) setChannels(view.channels)
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load channel:', err)
          setLoadError(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      stub?.[Symbol.dispose]?.()
    }
  }, [isAdmin, authenticatedApi])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh]">
        <p className="text-kumo-subtle">Loading channel...</p>
      </div>
    )
  }

  if (loadError || !isAdmin) {
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-16 text-center">
        <p className="text-sm text-kumo-danger">Something went wrong loading this channel.</p>
        <button onClick={() => window.location.reload()} className="text-kumo-brand mt-2 text-sm underline">
          Try again
        </button>
      </div>
    )
  }

  const configured =
    channel === 'telegram' ? channels?.telegram.configured === true
    : channel === 'slack' ? channels?.slack.configured === true
    : channel === 'email' ? channels?.email.configured === true
    : false

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-8 space-y-6">
      <div>
        <Link
          to="/admin/$section"
          params={{ section: 'channels' }}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium tracking-[-0.25px] text-kumo-subtle transition-colors hover:text-kumo-default"
        >
          <ArrowLeft size={14} />
          Channels
        </Link>
        <div className="mt-3 flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-kumo-default">{meta.title}</h1>
          {configured ? (
            <span className="inline-flex items-center gap-1 text-[13px] font-medium text-kumo-success">
              <Check size={14} />
              Connected
            </span>
          ) : (
            <span className="rounded-full bg-kumo-tint px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.04em] text-kumo-subtle">
              {channel === 'whatsapp' || channel === 'teams' ? 'Coming soon' : 'Not set up'}
            </span>
          )}
        </div>
        <p className="text-sm text-kumo-subtle mt-2 max-w-2xl">{meta.blurb}</p>
      </div>

      {channel === 'telegram' && (
        configured && admin ? (
          <>
            <InfoCard title={`Connected as @${channels?.telegram.botUserName}`}>
              Teammates message this bot on Telegram. Each teammate links once with a personal
              link from below.
            </InfoCard>
            <TelegramLinksCard admin={admin.api} />
          </>
        ) : (
          <NotSetUpCard />
        )
      )}

      {channel === 'slack' && (
        configured ? (
          <InfoCard title="Connected">
            Teammates DM the assistant's Slack app or mention it in a channel. They are
            recognized by the email on their Slack profile, so there is nothing to link.
          </InfoCard>
        ) : (
          <NotSetUpCard />
        )
      )}

      {channel === 'email' && (
        configured && admin ? (
          <>
            <InfoCard title={`Addresses on ${channels?.email.domain}`}>
              Each teammate gets their own assistant address below. They write to it from their
              own email account and the assistant replies in the same thread; mail from anyone
              else is ignored.
            </InfoCard>
            <EmailInboxesCard admin={admin.api} />
          </>
        ) : (
          <NotSetUpCard />
        )
      )}

      {(channel === 'whatsapp' || channel === 'teams') && (
        <InfoCard title="Coming soon">
          {meta.title} support is on the way. Telegram, Slack, and Email are available today.
        </InfoCard>
      )}
    </div>
  )
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
      <h2 className="text-lg font-semibold text-kumo-strong">{title}</h2>
      <p className="mt-0.5 text-sm text-kumo-subtle">{children}</p>
    </div>
  )
}

function NotSetUpCard() {
  return (
    <div className="rounded-xl border border-dashed border-kumo-line p-6 text-sm text-kumo-subtle">
      This channel isn't set up on this workspace yet. Whoever operates your deployment can
      enable it; the setup steps live in the deployment guide.
    </div>
  )
}

// Telegram link management: mint one-time deep links and see or remove existing links.
function TelegramLinksCard({ admin }: { admin: RpcStub<AdminApi> }) {
  const toasts = useKumoToastManager()
  const [bindings, setBindings] = useState<TelegramBinding[]>([])
  const [email, setEmail] = useState('')
  const [minted, setMinted] = useState<{ email: string; link: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const refresh = async () => {
    try {
      setBindings(await admin.listTelegramBindings())
    } catch (err) {
      console.error('Failed to load Telegram links:', err)
    }
  }
  useEffect(() => { void refresh() }, [admin]) // eslint-disable-line react-hooks/exhaustive-deps

  const mint = async () => {
    const target = email.trim()
    if (!target || busy) return
    setBusy(true)
    try {
      const { link } = await admin.mintTelegramLinkCode(target)
      setMinted({ email: target, link })
      setCopied(false)
      setEmail('')
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

  const copyMinted = async () => {
    if (!minted) return
    await navigator.clipboard.writeText(minted.link)
    setCopied(true)
  }

  const unlink = async (target: string) => {
    if (busy) return
    setBusy(true)
    try {
      await admin.unlinkTelegram(target)
      toasts.add({ title: `Unlinked ${target}`, variant: 'success' })
      await refresh()
    } catch (err) {
      console.error('Failed to unlink Telegram:', err)
      toasts.add({
        title: err instanceof Error ? err.message : "Couldn't unlink the account",
        variant: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
      <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Links</h2>
      <p className="mb-5 text-sm text-kumo-subtle">
        Each teammate links once: create a personal link for their workspace email and send it
        to them. Tapping it opens the bot and connects their Telegram account. Links expire
        after a week and work once.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-72 max-w-full">
          <Input
            type="email"
            placeholder="teammate@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void mint() }}
          />
        </div>
        <Button variant="primary" disabled={busy || !email.trim()} onClick={() => void mint()}>
          Create link
        </Button>
      </div>

      {minted && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-[12px] text-kumo-subtle">Send this to {minted.email}:</div>
            <div className="truncate font-mono text-[13px] text-kumo-strong">{minted.link}</div>
          </div>
          <Button variant="secondary" onClick={() => void copyMinted()}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}

      <h3 className="mb-2 mt-6 text-sm font-semibold text-kumo-strong">Linked accounts</h3>
      {bindings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-kumo-line p-5 text-center text-sm text-kumo-subtle">
          No linked Telegram accounts yet.
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-kumo-line rounded-lg border border-kumo-line">
          {bindings.map((binding) => (
            <div
              key={binding.email}
              className="flex items-center gap-3 bg-kumo-base px-4 py-3 first:rounded-t-lg last:rounded-b-lg"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-kumo-strong">
                  {binding.email}
                </div>
                <div className="text-[12px] text-kumo-subtle">
                  {binding.telegramUserName ? `@${binding.telegramUserName} · ` : ''}
                  linked {new Date(binding.linkedAt).toLocaleDateString()}
                </div>
              </div>
              <Button variant="secondary" disabled={busy} onClick={() => void unlink(binding.email)}>
                Unlink
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Email inbox management: give each teammate an assistant address, list and remove them.
function EmailInboxesCard({ admin }: { admin: RpcStub<AdminApi> }) {
  const toasts = useKumoToastManager()
  const [inboxes, setInboxes] = useState<EmailInbox[]>([])
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      setInboxes(await admin.listEmailInboxes())
    } catch (err) {
      console.error('Failed to load assistant inboxes:', err)
    }
  }
  useEffect(() => { void refresh() }, [admin]) // eslint-disable-line react-hooks/exhaustive-deps

  const provision = async () => {
    const target = email.trim()
    if (!target || busy) return
    setBusy(true)
    try {
      const inbox = await admin.provisionEmailInbox(target)
      toasts.add({ title: `Created ${inbox.address}`, variant: 'success' })
      setEmail('')
      await refresh()
    } catch (err) {
      console.error('Failed to create the assistant inbox:', err)
      toasts.add({
        title: err instanceof Error ? err.message : "Couldn't create the inbox",
        variant: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (target: string) => {
    if (busy) return
    setBusy(true)
    try {
      await admin.deleteEmailInbox(target)
      toasts.add({ title: `Removed the inbox for ${target}`, variant: 'success' })
      await refresh()
    } catch (err) {
      console.error('Failed to remove the assistant inbox:', err)
      toasts.add({
        title: err instanceof Error ? err.message : "Couldn't remove the inbox",
        variant: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
      <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Assistant addresses</h2>
      <p className="mb-5 text-sm text-kumo-subtle">
        Create an address for a teammate's workspace email. Their assistant only answers mail
        sent from that teammate's own address.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-72 max-w-full">
          <Input
            type="email"
            placeholder="teammate@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void provision() }}
          />
        </div>
        <Button variant="primary" disabled={busy || !email.trim()} onClick={() => void provision()}>
          Create address
        </Button>
      </div>

      <h3 className="mb-2 mt-6 text-sm font-semibold text-kumo-strong">Addresses</h3>
      {inboxes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-kumo-line p-5 text-center text-sm text-kumo-subtle">
          No assistant addresses yet.
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-kumo-line rounded-lg border border-kumo-line">
          {inboxes.map((inbox) => (
            <div
              key={inbox.userEmail}
              className="flex items-center gap-3 bg-kumo-base px-4 py-3 first:rounded-t-lg last:rounded-b-lg"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px] font-medium text-kumo-strong">
                  {inbox.address}
                </div>
                <div className="text-[12px] text-kumo-subtle">
                  for {inbox.userEmail} · created {new Date(inbox.createdAt).toLocaleDateString()}
                </div>
              </div>
              <Button variant="secondary" disabled={busy} onClick={() => void remove(inbox.userEmail)}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
