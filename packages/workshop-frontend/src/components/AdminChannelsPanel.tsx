// Admin panel for messaging channels: an index of cards, one per channel, each linking to
// its detail page (/admin/channels/$channel) where status and management live. Unshipped
// channels say so on their card; the whole surface shows setup guidance when the deployment
// has no channels worker bound.

import { Link } from '@tanstack/react-router'
import { Check, ChevronRight } from 'lucide-react'
import type { ChannelsDescription } from '@gadgets/workshop-shared/api'
import { CHANNEL_IDS, type ChannelId } from '../AdminChannelDetailPage'

const CHANNEL_CARDS: Record<ChannelId, { name: string; blurb: string }> = {
  telegram: {
    name: 'Telegram',
    blurb: 'Chat with your assistant from Telegram, on your phone or desktop.',
  },
  slack: {
    name: 'Slack',
    blurb: 'Message your assistant in Slack, in a DM or by mentioning it in a channel.',
  },
  email: {
    name: 'Email',
    blurb: 'Give each teammate an assistant email address they can write to from anywhere.',
  },
  whatsapp: { name: 'WhatsApp', blurb: 'Reach your assistant on WhatsApp.' },
  teams: { name: 'Microsoft Teams', blurb: 'Chat with your assistant in Teams.' },
}

export default function AdminChannelsPanel({
  channels,
}: {
  // Which channels the deployment's channels worker has configured; null when none is bound.
  channels: ChannelsDescription | null
}) {
  const status = (id: ChannelId): 'connected' | 'off' | 'soon' => {
    if (id === 'whatsapp' || id === 'teams') return 'soon'
    if (id === 'telegram' && channels?.telegram.configured) return 'connected'
    if (id === 'slack' && channels?.slack.configured) return 'connected'
    if (id === 'email' && channels?.email.configured) return 'connected'
    return 'off'
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        {CHANNEL_IDS.map((id) => {
          const card = CHANNEL_CARDS[id]
          const state = status(id)
          return (
            <Link
              key={id}
              to="/admin/channels/$channel"
              params={{ channel: id }}
              className="group rounded-xl border border-kumo-line bg-kumo-elevated p-5 transition-colors hover:bg-kumo-tint"
            >
              <div className="flex items-center gap-2">
                <h2 className="flex-1 text-base font-semibold text-kumo-strong">{card.name}</h2>
                {state === 'connected' ? (
                  <span className="inline-flex items-center gap-1 text-[13px] font-medium text-kumo-success">
                    <Check size={14} />
                    Connected
                  </span>
                ) : (
                  <span className="rounded-full bg-kumo-tint px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.04em] text-kumo-subtle">
                    {state === 'soon' ? 'Coming soon' : 'Not set up'}
                  </span>
                )}
                <ChevronRight
                  size={16}
                  className="shrink-0 text-kumo-inactive transition-colors group-hover:text-kumo-default"
                />
              </div>
              <p className="mt-1.5 text-sm text-kumo-subtle">{card.blurb}</p>
            </Link>
          )
        })}
      </div>

      {channels === null && (
        <div className="rounded-xl border border-dashed border-kumo-line p-6 text-sm text-kumo-subtle">
          Channels aren't set up on this workspace yet. Whoever operates your deployment can
          enable them; the setup steps live in the deployment guide.
        </div>
      )}
    </>
  )
}
