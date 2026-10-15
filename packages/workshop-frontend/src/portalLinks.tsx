import { Navigate } from '@tanstack/react-router'
import type { ServerConfig } from '@gadgets/workshop-shared/api'
import { useServerConfig } from './ServerConfigContext'

/**
 * The central portals a workspace's owners and admins manage it from: the admin portal
 * (teammates, products, settings, connectors, channels, formats) and the billing portal (plan, credits, invoices, payment). The
 * server config carries this workspace's page on each; a portal reached without a session
 * signs the person in through central login and lands on the same page.
 */
export type Portal = 'admin' | 'billing'

/** Where an administrator manages connectors (one of them, given its id), on the admin portal. */
export function centralConnectorsLink(
  config: Pick<ServerConfig, 'adminPortalUrl'> | null | undefined,
  vendorId?: string,
): string | undefined {
  return portalLink(config, 'admin', vendorId ? `/connectors/${encodeURIComponent(vendorId)}` : '/connectors')
}

/**
 * A page on one of the portals for this workspace (`path` like '/plans' or '?tab=payment'),
 * or undefined when the deployment has no such portal.
 */
export function portalLink(
  config: Pick<ServerConfig, 'adminPortalUrl' | 'billingPortalUrl'> | null | undefined,
  portal: Portal,
  path = '',
): string | undefined {
  const base = portal === 'admin' ? config?.adminPortalUrl : config?.billingPortalUrl
  return base ? `${base}${path}` : undefined
}

// Where each page of the old in-app Admin (/admin/<section>[/<id>]) lives now.
const ADMIN_SECTIONS: Record<string, [Portal, string]> = {
  teammates: ['admin', '/teammates'],
  plans: ['billing', '/plans'],
  billing: ['billing', ''],
  channels: ['admin', '/channels'],
  formats: ['admin', '/formats'],
  intelligence: ['admin', '/products'],
  'organization-intelligence': ['admin', '/products'],
  'data-intelligence': ['admin', '/products'],
  'market-intelligence': ['admin', '/products'],
  'process-intelligence': ['admin', '/products'],
  organization: ['admin', '/jamaa'],
  brand: ['admin', '/jamaa'],
  announcements: ['admin', '/jamaa'],
  instructions: ['admin', '/jamaa'],
  skills: ['admin', '/jamaa'],
  providers: ['admin', '/jamaa'],
}

/** The portal page for an old in-app Admin path (`connectors/github`, `plans`, ``). */
export function legacyAdminTarget(path: string, search: string): [Portal, string] {
  const [section = '', id] = path.split('/').filter(Boolean)
  if (section === 'connectors' || section === 'integrations') {
    return ['admin', id ? `/connectors/${encodeURIComponent(decodeURIComponent(id))}` : '/connectors']
  }
  // The plan picker lived on the billing page before the Plans split; its deep links
  // (?intent=, ?plan=) still name it. Those and ?tab= keep their query.
  if (section === 'billing' && /[?&](intent|plan)=/.test(search)) return ['billing', `/plans${search}`]
  const [portal, page] = Object.hasOwn(ADMIN_SECTIONS, section) ? ADMIN_SECTIONS[section] : ['admin' as const, '']
  return [portal, portal === 'billing' || section === 'teammates' ? `${page}${search}` : page]
}

/** Sends an old in-app Admin link on to the portals, or home when there are none. */
export function LegacyAdminRedirect({ path }: { path: string }) {
  const serverConfig = useServerConfig()
  if (!serverConfig) return null
  const [portal, page] = legacyAdminTarget(path, window.location.search)
  const url = portalLink(serverConfig, portal, page)
  if (!url) return <Navigate to="/" replace />
  window.location.replace(url)
  return null
}
