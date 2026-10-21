import type { ServerConfig } from '@gadgets/workshop-shared/api'

/**
 * The central portals a workspace's owners and admins manage it from: the admin portal
 * (teammates, products) and the billing portal (balance, top-ups, usage, invoices). The
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
 * A page on one of the portals for this workspace (`path` like '/teammates' or '?tab=invoices'),
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
 * This workspace's page on billing.tyms.ai (balance and top-ups), or the billing home when the
 * deployment wasn't given its own page. Billing has no other home: products only link here.
 */
export function billingLink(
  config: Pick<ServerConfig, 'adminPortalUrl' | 'billingPortalUrl'> | null | undefined,
): string {
  return portalLink(config, 'billing') ?? BILLING_HOME
}
