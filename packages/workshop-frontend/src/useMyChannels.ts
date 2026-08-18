import { useEffect, useState } from 'react'
import type { UserChannelsView } from '@gadgets/workshop-shared/api'
import { useOptionalAuthenticatedApi } from './AuthContext'

// Shared per-API-stub cache of the getMyChannels() request, so the user menu, the mobile nav,
// and the /channels page share a single RPC per session instead of each firing their own
// (same pattern as useGatekeeperApps). Keyed weakly by the stub, dropped when the session ends.
const channelsRequestByApi = new WeakMap<object, Promise<UserChannelsView | null>>()

// The caller's own messaging-channel connections. Returns undefined while loading and null when
// the deployment has no channels worker — callers hide the Channels entry/page in both cases,
// so most workspaces never show it. The cache means "last received" data can be a session old;
// the Channels page refetches on mount for freshness and only seeds from this.
export function useMyChannels(): UserChannelsView | null | undefined {
  const auth = useOptionalAuthenticatedApi()
  const [view, setView] = useState<UserChannelsView | null | undefined>(undefined)

  useEffect(() => {
    if (!auth) {
      setView(null)
      return
    }
    const api: object = auth.authenticatedApi
    let request = channelsRequestByApi.get(api)
    if (!request) {
      request = auth.authenticatedApi.getMyChannels()
      channelsRequestByApi.set(api, request)
      // Don't cache a failure permanently — drop it so a later mount can retry.
      request.catch(() => channelsRequestByApi.delete(api))
    }
    let cancelled = false
    request
      .then((v) => { if (!cancelled) setView(v) })
      .catch(() => { if (!cancelled) setView(null) })
    return () => { cancelled = true }
  }, [auth])

  return view
}
