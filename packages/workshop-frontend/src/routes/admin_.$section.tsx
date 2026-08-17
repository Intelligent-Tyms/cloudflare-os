import { createFileRoute, Navigate } from '@tanstack/react-router'
import AdminPage, { isAdminSectionId } from '../AdminPage'

// Detail page for one admin topic (organization, brand, announcements, ...). The file is
// `admin_.$section` (trailing underscore) so the URL is /admin/$section without nesting inside
// the /admin hub page's component.
export const Route = createFileRoute('/admin_/$section')({
  component: AdminSectionRoute,
})

function AdminSectionRoute() {
  const { section } = Route.useParams()
  // The integrations section was previously called "connectors"; keep old links working.
  if (section === 'connectors') {
    return <Navigate to="/admin/$section" params={{ section: 'integrations' }} replace />
  }
  if (!isAdminSectionId(section)) return <Navigate to="/admin" replace />
  return <AdminPage section={section} />
}
