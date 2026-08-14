import { createFileRoute } from '@tanstack/react-router'
import GatekeeperAppPage from '../GatekeeperAppPage'
import { useDocumentTitle } from '../useDocumentTitle'
import { useGatekeeperApps } from '../useGatekeeperApps'

// Generic host for any gatekeeper-served management app (VendorDescription.providesUi). The set of
// apps and their nav entries come from the backend (useGatekeeperApps); nothing about a specific
// gatekeeper is hardcoded here. GatekeeperAppPage renders "not available" if the id isn't bound.
//
// The file is `gatekeepers_.$appId` (trailing underscore) so the URL is /gatekeepers/$appId without
// nesting inside the /gatekeepers connectors page's component.
// Opaque in-app location the host forwards to the app unparsed (e.g. a Knowledge doc id from a
// chat citation link). Bounded; the app decides what it means.
type GatekeeperAppSearch = { p?: string }

export const Route = createFileRoute('/gatekeepers_/$appId')({
  component: GatekeeperApp,
  validateSearch: (search: Record<string, unknown>): GatekeeperAppSearch => {
    const p = typeof search.p === 'string' ? search.p.slice(0, 512) : ''
    return p ? { p } : {}
  },
})

function GatekeeperApp() {
  const { appId } = Route.useParams()
  const { p } = Route.useSearch()
  const app = useGatekeeperApps().find((a) => a.id === appId)
  useDocumentTitle(app?.title ?? 'App')
  return <GatekeeperAppPage appId={appId} appLocation={p ?? null} />
}
