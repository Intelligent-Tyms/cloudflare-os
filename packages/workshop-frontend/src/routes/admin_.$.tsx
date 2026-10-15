import { createFileRoute } from '@tanstack/react-router'
import { LegacyAdminRedirect } from '../portalLinks'

// Any old /admin/... page forwards to its counterpart on the portals (see routes/admin.tsx).
export const Route = createFileRoute('/admin_/$')({
  component: AdminPageRedirect,
})

function AdminPageRedirect() {
  const { _splat } = Route.useParams()
  return <LegacyAdminRedirect path={_splat ?? ''} />
}
