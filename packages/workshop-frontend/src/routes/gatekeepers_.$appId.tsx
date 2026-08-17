import { createFileRoute, redirect } from '@tanstack/react-router'
import GatekeeperAppPage from '../GatekeeperAppPage'
import { useDocumentTitle } from '../useDocumentTitle'
import { useGatekeeperApps } from '../useGatekeeperApps'

// Generic host for any gatekeeper-served management app (VendorDescription.providesUi). The set of
// apps and their nav entries come from the backend (useGatekeeperApps); nothing about a specific
// gatekeeper is hardcoded here. GatekeeperAppPage renders "not available" if the id isn't bound.
//
// The file is `gatekeepers_.$appId` (trailing underscore) so the URL is /gatekeepers/$appId without
// nesting inside the /gatekeepers integrations page's component.
// Opaque in-app location the host forwards to the app unparsed (e.g. a Knowledge doc id from a
// chat citation link). Bounded; the app decides what it means.
type GatekeeperAppSearch = { p?: string }

// Legacy path: gatekeeper-served apps now live at /integrations/$appId (see
// routes/integrations_.$appId.tsx). This route only redirects old links, citations, and
// bookmarks, carrying the appId param and the opaque `p` location through.
export const Route = createFileRoute('/gatekeepers_/$appId')({
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: '/integrations/$appId', params, search })
  },
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
