import { createFileRoute } from '@tanstack/react-router'
import GatekeeperAppPage from '../GatekeeperAppPage'
import { useDocumentTitle } from '../useDocumentTitle'
import { useGatekeeperApps } from '../useGatekeeperApps'

// Canonical host path for gatekeeper-served management apps: /integrations/$appId. The legacy
// /gatekeepers/$appId route redirects here. Mirrors routes/gatekeepers_.$appId.tsx, which keeps
// its own copy of this small component because Route.useParams/useSearch bind to the file's route.
//
// The file is `integrations_.$appId` (trailing underscore) so the URL is /integrations/$appId
// without nesting inside the /integrations page's component.

// Opaque in-app location the host forwards to the app unparsed (e.g. a Knowledge doc id from a
// chat citation link). Bounded; the app decides what it means.
type GatekeeperAppSearch = { p?: string }

export const Route = createFileRoute('/integrations_/$appId')({
  component: IntegrationApp,
  validateSearch: (search: Record<string, unknown>): GatekeeperAppSearch => {
    const p = typeof search.p === 'string' ? search.p.slice(0, 512) : ''
    return p ? { p } : {}
  },
})

function IntegrationApp() {
  const { appId } = Route.useParams()
  const { p } = Route.useSearch()
  const app = useGatekeeperApps().find((a) => a.id === appId)
  useDocumentTitle(app?.title ?? 'App')
  return <GatekeeperAppPage appId={appId} appLocation={p ?? null} />
}
