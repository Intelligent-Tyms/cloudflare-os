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
  // The connectors section was called "integrations" for a while; keep old links working.
  if (section === 'integrations') {
    return <Navigate to="/admin/$section" params={{ section: 'connectors' }} replace />
  }
  // Intelligence was one page with every product on it before the split into one card per
  // product; its old link lands on the first product.
  if (section === 'intelligence') {
    return <Navigate to="/admin/$section" params={{ section: 'organization-intelligence' }} replace />
  }
  // The plan picker lived on the billing page before the Plans split; forward its deep
  // links (pricing-page ?intent=, in-flight ?plan= checkout returns) with the query intact.
  if (section === 'billing' && /[?&](intent|plan)=/.test(window.location.search)) {
    window.location.replace(`/admin/plans${window.location.search}`)
    return null
  }
  if (!isAdminSectionId(section)) return <Navigate to="/admin" replace />
  return <AdminPage section={section} />
}
