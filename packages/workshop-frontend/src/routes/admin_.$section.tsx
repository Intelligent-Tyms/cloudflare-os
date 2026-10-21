import { createFileRoute, Navigate } from '@tanstack/react-router'
import AdminPage, { isAdminSectionId } from '../AdminPage'
import { useServerConfig } from '../ServerConfigContext'
import { billingLink, portalLink } from '../portalLinks'

// Teammates moved to the admin portal; the old page forwards there with the query intact.
// Plans and billing are gone from Jamaa: their old pages (bookmarks, emailed links) forward
// to the workspace's page on billing.tyms.ai, which has no plans.
const BILLING_SECTIONS = new Set(['plans', 'billing'])

// Detail page for one admin topic (organization, brand, announcements, ...). The file is
// `admin_.$section` (trailing underscore) so the URL is /admin/$section without nesting inside
// the /admin hub page's component.
export const Route = createFileRoute('/admin_/$section')({
  component: AdminSectionRoute,
})

function AdminSectionRoute() {
  const { section } = Route.useParams()
  const serverConfig = useServerConfig()
  if (BILLING_SECTIONS.has(section)) {
    if (!serverConfig) return null
    window.location.replace(billingLink(serverConfig))
    return null
  }
  if (section === 'teammates') {
    if (!serverConfig) return null
    const url = portalLink(serverConfig, 'admin', '/teammates')
    if (!url) return <Navigate to="/admin" replace />
    window.location.replace(`${url}${window.location.search}`)
    return null
  }
  // The connectors section was called "integrations" for a while; keep old links working.
  if (section === 'integrations') {
    return <Navigate to="/admin/$section" params={{ section: 'connectors' }} replace />
  }
  // Intelligence was one page with every product on it before the split into one card per
  // product; its old link lands on the first product.
  if (section === 'intelligence') {
    return <Navigate to="/admin/$section" params={{ section: 'organization-intelligence' }} replace />
  }
  if (!isAdminSectionId(section)) return <Navigate to="/admin" replace />
  return <AdminPage section={section} />
}
