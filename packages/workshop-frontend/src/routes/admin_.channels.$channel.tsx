import { Navigate, createFileRoute } from '@tanstack/react-router'
import AdminChannelDetailPage, { isChannelId } from '../AdminChannelDetailPage'

// Detail page for one messaging channel. `admin_` (trailing underscore) keeps the URL
// /admin/channels/… without nesting inside the /admin hub component, mirroring admin_.$section.
export const Route = createFileRoute('/admin_/channels/$channel')({
  component: AdminChannelRoute,
})

function AdminChannelRoute() {
  const { channel } = Route.useParams()
  if (!isChannelId(channel)) {
    return <Navigate to="/admin/$section" params={{ section: 'channels' }} replace />
  }
  return <AdminChannelDetailPage channel={channel} />
}
