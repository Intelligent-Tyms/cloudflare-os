import type { ServerConfig } from '@gadgets/workshop-shared/api'

/**
 * The central portals a workspace's owners and admins manage it from: the admin portal
 * (teammates, products) and the billing portal (plan, credits, invoices, payment). The
 * server config carries this workspace's page on each; a portal reached without a session
 * signs the person in through central login and lands on the same page.
 */
export type Portal = 'admin' | 'billing'

/**
 * The admin portal's page for this deployment's centrally managed settings (organization
 * profile, instructions, brand, notices, and the skills and AI models offered).
 */
export const CENTRAL_SETTINGS_PATH = '/jamaa'

/**
 * Where an administrator manages connectors (one of them, given its id) when the admin portal
 * does, or undefined when they are managed here in /admin.
 */
export function centralConnectorsLink(
  config: Pick<ServerConfig, 'adminPortalUrl' | 'settingsManagedCentrally'> | null | undefined,
  vendorId?: string,
): string | undefined {
  if (!config?.settingsManagedCentrally) return undefined
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
