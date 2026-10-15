import { createFileRoute, Navigate } from '@tanstack/react-router'

/** Connectors were called integrations for a while; keep old links to a connector working. */
export const Route = createFileRoute('/admin_/integrations/$vendorId')({
  component: LegacyIntegrationRoute,
})

function LegacyIntegrationRoute() {
  const { vendorId } = Route.useParams()
  return <Navigate to="/admin/connectors/$vendorId" params={{ vendorId }} replace />
}
