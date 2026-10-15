import { Navigate, createFileRoute } from '@tanstack/react-router'
import AdminChannelDetailPage, { isChannelId } from '../AdminChannelDetailPage'
import { useServerConfig } from '../ServerConfigContext'
import { portalLink } from '../portalLinks'

// Detail page for one messaging channel. `admin_` (trailing underscore) keeps the URL
// /admin/channels/… without nesting inside the /admin hub component, mirroring admin_.$section.
export const Route = createFileRoute('/admin_/channels/$channel')({
  component: AdminChannelRoute,
})

function AdminChannelRoute() {
  const { channel } = Route.useParams()
  const serverConfig = useServerConfig()
  // Managed on the admin portal: channels are set up there, so old links forward.
  const portalUrl = serverConfig?.settingsManagedCentrally ? portalLink(serverConfig, 'admin', '/channels') : undefined
  if (portalUrl) {
    window.location.replace(portalUrl)
    return null
  }
  if (!isChannelId(channel)) {
    return <Navigate to="/admin/$section" params={{ section: 'channels' }} replace />
  }
  return <AdminChannelDetailPage channel={channel} />
}
