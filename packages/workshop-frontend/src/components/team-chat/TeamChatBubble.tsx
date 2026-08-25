import { lazy, Suspense, useEffect, useState } from 'react'
import type { TeamChatSession } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { logRpcFailure } from '../../rpcErrors'

// Team chat: human-to-human messaging between the members of this deployment, as a floating
// bubble in the bottom-right corner. The Stream Chat SDK is heavy, so the real widget is
// lazy-loaded only once the server confirms team chat is configured here; deployments without
// Stream credentials never load a byte of it.
const TeamChatWidget = lazy(() => import('./TeamChatWidget'))

export default function TeamChatBubble() {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const [session, setSession] = useState<TeamChatSession | null>(null)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.getTeamChatSession().then((s) => {
      if (!cancelled) setSession(s)
    }).catch((err) => {
      logRpcFailure('Failed to start team chat:', err)
    })
    return () => { cancelled = true }
  }, [authenticatedApi])

  if (!session || !currentUser) return null
  return (
    <Suspense fallback={null}>
      <TeamChatWidget api={authenticatedApi} initialSession={session} />
    </Suspense>
  )
}
