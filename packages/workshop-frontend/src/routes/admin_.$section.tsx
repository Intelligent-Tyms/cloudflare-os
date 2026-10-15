import { createFileRoute, Navigate } from '@tanstack/react-router'
import AdminPage, { isAdminSectionId } from '../AdminPage'
import { useServerConfig } from '../ServerConfigContext'
import { portalLink, type Portal } from '../portalLinks'

// Teammates, plans and billing moved to the central portals; their old pages forward there
// with the query intact (a pricing-page ?intent=, a ?tab= deep link, an emailed link).
const PORTAL_PAGES: Record<string, [Portal, string]> = {
  teammates: ['admin', '/teammates'],
  plans: ['billing', '/plans'],
  billing: ['billing', ''],
}

// Detail page for one admin topic (organization, brand, announcements, ...). The file is
// `admin_.$section` (trailing underscore) so the URL is /admin/$section without nesting inside
// the /admin hub page's component.
export const Route = createFileRoute('/admin_/$section')({
  component: AdminSectionRoute,
})

function AdminSectionRoute() {
  const { section } = Route.useParams()
  const serverConfig = useServerConfig()
  const portalPage = Object.hasOwn(PORTAL_PAGES, section) ? PORTAL_PAGES[section] : undefined
  if (portalPage) {
    if (!serverConfig) return null
    // The plan picker lived on the billing page before the Plans split; its deep links
    // (?intent=, ?plan=) still name it.
    const [portal, path] = section === 'billing' && /[?&](intent|plan)=/.test(window.location.search)
      ? PORTAL_PAGES.plans
      : portalPage
    const url = portalLink(serverConfig, portal, path)
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
