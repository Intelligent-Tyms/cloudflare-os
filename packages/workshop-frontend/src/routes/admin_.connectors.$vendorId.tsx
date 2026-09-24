import { createFileRoute } from '@tanstack/react-router'
import AdminConnectorDetailPage from '../AdminConnectorDetailPage'

/**
 * Detail page for one connector. `admin_` (trailing underscore) keeps the URL
 * /admin/connectors/… without nesting inside the /admin hub component, mirroring admin_.$section.
 */
export const Route = createFileRoute('/admin_/connectors/$vendorId')({
  component: AdminConnectorRoute,
})

function AdminConnectorRoute() {
  const { vendorId } = Route.useParams()
  return <AdminConnectorDetailPage vendorId={vendorId} />
}
