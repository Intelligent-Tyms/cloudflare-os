import { createContext, useContext } from 'react'
import type { RpcStub } from 'capnweb'
import type { StreamChat } from 'stream-chat'
import type { AuthenticatedApi, TeamChatSession, TeamChatTeammate } from '@gadgets/workshop-shared/api'

// The Discuss context is defined in this tiny module (type-only imports, no Stream code) so
// that always-loaded parts of the app — the workspace editor's "Send to Discuss" button, the
// /discuss route — can ask whether Discuss is available without pulling the Stream chunk in.
// The value is deliberately stable (it changes when the directory loads or a preference
// flips, not on every presence event) because it is provided above the whole app.

/** The team directory, indexed by Stream user id. */
export type TeammateIndex = {
  list: TeamChatTeammate[] | null
  byStreamId: Map<string, TeamChatTeammate>
  error: string | null
}

/** Per-viewer notification preferences (kept in localStorage). */
export type DiscussPrefs = {
  /** Pause notifications (no system notifications, toasts or sounds). */
  dnd: boolean
  /** Play a short sound for new messages. */
  sound: boolean
}

/** Something the full page has been asked to show (set by `open`/`openNew` while on /discuss). */
export type DiscussRequest = { kind: 'open'; cid: string } | { kind: 'new' }

export type DiscussContextValue = {
  api: RpcStub<AuthenticatedApi>
  client: StreamChat
  session: TeamChatSession
  /** The caller's app user id (their email) — the key the avatar store uses. */
  selfUserId: string
  teammates: TeammateIndex
  prefs: DiscussPrefs
  setPrefs: (patch: Partial<DiscussPrefs>) => void
  /** Open a conversation: in the dock (expanding it) or, on /discuss, on the page. */
  open: (cid: string) => void
  /** Start a new message, in whichever surface is showing. */
  openNew: () => void
  /** Collapse the dock (no-op on the page); used after navigating somewhere from a chat. */
  collapse: () => void
  /** Pending instruction for the page, consumed with `clearRequest`. */
  request: DiscussRequest | null
  clearRequest: () => void
}

export const DiscussContext = createContext<DiscussContextValue | null>(null)

/** Discuss, when this deployment has it and the client is connected; null otherwise. */
export function useDiscuss(): DiscussContextValue | null {
  return useContext(DiscussContext)
}

/** Whether Discuss is still being looked up, unavailable here, or ready. */
export type DiscussStatus = 'loading' | 'unavailable' | 'ready'
export const DiscussStatusContext = createContext<DiscussStatus>('unavailable')
export function useDiscussStatus(): DiscussStatus {
  return useContext(DiscussStatusContext)
}
