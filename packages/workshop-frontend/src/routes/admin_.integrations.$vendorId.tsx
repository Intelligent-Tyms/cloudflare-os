import { createFileRoute } from '@tanstack/react-router'
import AdminIntegrationDetailPage from '../AdminIntegrationDetailPage'

// Detail page for one integration. `admin_` (trailing underscore) keeps the URL
// /admin/integrations/… without nesting inside the /admin hub component, mirroring admin_.$section.
export const Route = createFileRoute('/admin_/integrations/$vendorId')({
  component: AdminIntegrationRoute,
})

function AdminIntegrationRoute() {
  const { vendorId } = Route.useParams()
  return <AdminIntegrationDetailPage vendorId={vendorId} />
}
