import { createFileRoute } from '@tanstack/react-router'
import AdminConnectorDetailPage from '../AdminConnectorDetailPage'
import { useServerConfig } from '../ServerConfigContext'
import { centralConnectorsLink } from '../portalLinks'

/**
 * Detail page for one connector. `admin_` (trailing underscore) keeps the URL
 * /admin/connectors/… without nesting inside the /admin hub component, mirroring admin_.$section.
 */
export const Route = createFileRoute('/admin_/connectors/$vendorId')({
  component: AdminConnectorRoute,
})

function AdminConnectorRoute() {
  const { vendorId } = Route.useParams()
  // Managed on the admin portal: connectors are set up there, so old links forward.
  const portalUrl = centralConnectorsLink(useServerConfig(), vendorId)
  if (portalUrl) {
    window.location.replace(portalUrl)
    return null
  }
  return <AdminConnectorDetailPage vendorId={vendorId} />
}
