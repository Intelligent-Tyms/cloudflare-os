import { Navigate } from '@tanstack/react-router'
import type { ServerConfig } from '@gadgets/workshop-shared/api'
import { useServerConfig } from './ServerConfigContext'

/**
 * The central portals a workspace's owners and admins manage it from: the admin portal
 * (teammates, products, settings, connectors, channels, formats) and the billing portal (the
 * organisation's one balance, top-ups, usage, invoices). The server config carries this workspace's page on each; a portal reached without a session
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
 * A page on one of the portals for this workspace (`path` like '/teammates' or '/connectors'),
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

/** Where billing is managed for every Tyms product. */
export const BILLING_HOME = 'https://billing.tyms.ai'

/**
 * This workspace's page on billing.tyms.ai, or the billing home when the deployment wasn't given
 * its own page. Billing has no other home: Jamaa shows no plans, prices or balances, only this link.
 */
export function billingLink(
  config: Pick<ServerConfig, 'adminPortalUrl' | 'billingPortalUrl'> | null | undefined,
): string {
  return portalLink(config, 'billing') ?? BILLING_HOME
}

// Where each page of the old in-app Admin (/admin/<section>[/<id>]) lives now.
const ADMIN_SECTIONS: Record<string, [Portal, string]> = {
  teammates: ['admin', '/teammates'],
  // Billing has no plans any more: both old pages land on the workspace's billing page.
  plans: ['billing', ''],
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
  const [portal, page] = Object.hasOwn(ADMIN_SECTIONS, section) ? ADMIN_SECTIONS[section] : ['admin' as const, '']
  // The old plan-picker and payment deep links (?intent=, ?plan=, ?tab=) mean nothing on the
  // billing page, so billing gets the bare page; teammates keep their query.
  return [portal, section === 'teammates' ? `${page}${search}` : page]
}

/** Sends an old in-app Admin link on to the portals, or home when there are none. */
export function LegacyAdminRedirect({ path }: { path: string }) {
  const serverConfig = useServerConfig()
  if (!serverConfig) return null
  const [portal, page] = legacyAdminTarget(path, window.location.search)
  const url = portal === 'billing' ? billingLink(serverConfig) : portalLink(serverConfig, portal, page)
  if (!url) return <Navigate to="/" replace />
  window.location.replace(url)
  return null
}
