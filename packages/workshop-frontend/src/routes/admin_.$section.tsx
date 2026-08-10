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
  if (!isAdminSectionId(section)) return <Navigate to="/admin" replace />
  return <AdminPage section={section} />
}
