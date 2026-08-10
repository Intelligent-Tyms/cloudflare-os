import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { AssistantProfile, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'

// The signed-in user's assistant profile, fetched once when the authenticated shell mounts so
// any component can read it (e.g. the composer placeholder) without extra RPCs. `profile` is
// null while loading and when the user has never saved one; `refresh()` refetches — the
// settings page calls it after a save so the rest of the UI picks the change up immediately.
type AssistantProfileState = {
  profile: AssistantProfile | null
  refresh: () => void
}

const AssistantProfileContext = createContext<AssistantProfileState>({
  profile: null,
  refresh: () => {},
})

export function AssistantProfileProvider({ authenticatedApi, children }: {
  authenticatedApi: RpcStub<AuthenticatedApi>
  children: React.ReactNode
}) {
  const [profile, setProfile] = useState<AssistantProfile | null>(null)
  const [refreshCount, setRefreshCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.getAssistantProfile().then((p) => {
      if (!cancelled) setProfile(p)
    }).catch((err) => {
      // Personalization is progressive enhancement: fail quiet and keep the defaults.
      console.error('Failed to load assistant profile:', err)
    })
    return () => { cancelled = true }
  }, [authenticatedApi, refreshCount])

  const refresh = useCallback(() => setRefreshCount((n) => n + 1), [])
  const value = useMemo(() => ({ profile, refresh }), [profile, refresh])

  return (
    <AssistantProfileContext.Provider value={value}>
      {children}
    </AssistantProfileContext.Provider>
  )
}

export function useAssistantProfile(): AssistantProfileState {
  return useContext(AssistantProfileContext)
}

// Convenience: the user's chosen assistant name, or "" when unset or still loading.
export function useAssistantName(): string {
  return useContext(AssistantProfileContext).profile?.assistantName ?? ''
}
