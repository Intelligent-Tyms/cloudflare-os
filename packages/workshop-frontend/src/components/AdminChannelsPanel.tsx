// Admin panel for messaging channels: where the assistant meets your team's chat apps.
// One card per channel (Telegram, Slack, WhatsApp, Teams); the unshipped ones say so.
// Telegram needs per-user links (a one-time deep link binds a Telegram account to a
// workspace email); Slack identifies users by their Slack profile email, so it has no
// link management. All channel plumbing lives in the deployment's channels worker; this
// panel talks to it through the AdminApi proxies and shows setup guidance when the
// deployment has no channels worker bound.

import { useEffect, useState } from 'react'
import { Button, Input, useKumoToastManager } from '@cloudflare/kumo'
import { Check, Copy } from 'lucide-react'
import type { AdminApi, ChannelsDescription, TelegramBinding } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

export default function AdminChannelsPanel({
  admin,
  channels,
}: {
  admin: RpcStub<AdminApi>
  // Which channels the deployment's channels worker has configured; null when none is bound.
  channels: ChannelsDescription | null
}) {
  const telegramConfigured = channels?.telegram.configured === true

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <ChannelCard
          name="Telegram"
          status={telegramConfigured ? 'connected' : 'off'}
          detail={
            telegramConfigured
              ? `Connected as @${channels?.telegram.botUserName}. Create a personal link below for each teammate.`
              : 'Chat with your assistant from Telegram, on your phone or desktop.'
          }
        />
        <ChannelCard
          name="Slack"
          status={channels?.slack.configured ? 'connected' : 'off'}
          detail={
            channels?.slack.configured
              ? 'Connected. Teammates are recognized by the email on their Slack profile, so there is nothing to link.'
              : 'Message your assistant in Slack, in a DM or by mentioning it in a channel.'
          }
        />
        <ChannelCard
          name="WhatsApp"
          status="soon"
          detail="Reach your assistant on WhatsApp."
        />
        <ChannelCard
          name="Microsoft Teams"
          status="soon"
          detail="Chat with your assistant in Teams."
        />
      </div>

      {channels === null && (
        <div className="rounded-xl border border-dashed border-kumo-line p-6 text-sm text-kumo-subtle">
          Channels aren't set up on this workspace yet. Whoever operates your deployment can
          enable Telegram and Slack; the setup steps live in the deployment guide.
        </div>
      )}

      {telegramConfigured && <TelegramLinksCard admin={admin} />}
    </>
  )
}

function ChannelCard({
  name,
  status,
  detail,
}: {
  name: string
  status: 'connected' | 'off' | 'soon'
  detail: string
}) {
  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-5">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-base font-semibold text-kumo-strong">{name}</h2>
        {status === 'connected' ? (
          <span className="inline-flex items-center gap-1 text-[13px] font-medium text-kumo-success">
            <Check size={14} />
            Connected
          </span>
        ) : (
          <span className="rounded-full bg-kumo-tint px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.04em] text-kumo-subtle">
            {status === 'soon' ? 'Coming soon' : 'Not set up'}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-sm text-kumo-subtle">{detail}</p>
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
      <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Telegram links</h2>
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
