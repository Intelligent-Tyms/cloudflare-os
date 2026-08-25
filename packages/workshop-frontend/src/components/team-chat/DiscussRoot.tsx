import { lazy, Suspense, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { TeamChatSession } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { logRpcFailure } from '../../rpcErrors'
import { DiscussContext, DiscussStatusContext } from './discuss-context'
import type { DiscussContextValue, DiscussStatus } from './discuss-context'

// The gate in front of Discuss. The Stream Chat SDK is heavy, so the provider (client, dock,
// notifications) is lazy-loaded only once the server confirms Discuss is configured here;
// deployments without Stream credentials never load a byte of it. The provider is rendered as
// a sibling of the app and publishes its context value up here, so the app tree itself never
// remounts when the chunk arrives or the client connects.
const DiscussProvider = lazy(() => import('./DiscussProvider'))

export default function DiscussRoot({ children }: { children: ReactNode }) {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const [session, setSession] = useState<TeamChatSession | null | undefined>(undefined)
  const [value, setValue] = useState<DiscussContextValue | null>(null)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.getTeamChatSession().then((s) => {
      if (!cancelled) setSession(s)
    }).catch((err) => {
      logRpcFailure('Failed to start Discuss:', err)
      if (!cancelled) setSession(null)
    })
    return () => { cancelled = true }
  }, [authenticatedApi])

  const status: DiscussStatus = session === undefined ? 'loading' : session === null ? 'unavailable' : 'ready'

  return (
    <DiscussStatusContext.Provider value={status}>
      <DiscussContext.Provider value={value}>
        {children}
      </DiscussContext.Provider>
      {session && currentUser && (
        <Suspense fallback={null}>
          <DiscussProvider api={authenticatedApi} initialSession={session} selfUserId={currentUser.id} onValue={setValue} />
        </Suspense>
      )}
    </DiscussStatusContext.Provider>
  )
}
