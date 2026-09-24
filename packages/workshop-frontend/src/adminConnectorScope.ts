// Whose credential a connector runs on, and what state it is in, for the admin Connectors pages.
// Shared by the gallery (which filters and labels by it) and the detail page (which explains it).
import type { AdminResourceVendor } from '@gadgets/workshop-shared/api'

/**
 * Company credentials an administrator enters once, personal sign-ins each person completes,
 * and built-in capabilities with nothing to connect. Derived from VendorDescription.credentialScope,
 * falling back on the vendor's shape for vendors that don't declare one.
 */
export type CredentialScopeGroup = 'organization' | 'personal' | 'builtin'

/** The scope group a vendor is filed under. */
export function vendorScopeGroup(vendor: AdminResourceVendor): CredentialScopeGroup {
  if (vendor.credentialScope) return vendor.credentialScope
  return vendor.autoProvisions ? 'builtin' : 'personal'
}

/** The three groups, in display order, with the copy that explains each. */
export const CREDENTIAL_SCOPE_GROUPS: { key: CredentialScopeGroup; label: string; short: string; hint: string }[] = [
  {
    key: 'organization',
    label: 'Company credentials',
    short: 'Company credential',
    hint: 'Set up once by an administrator. Everyone on the team uses them without signing in.',
  },
  {
    key: 'personal',
    label: 'Personal sign-in',
    short: 'Personal sign-in',
    hint: 'Each person connects their own account. Recipients of a shared workspace connect theirs too.',
  },
  {
    key: 'builtin',
    label: 'Built in',
    short: 'Built in',
    hint: 'Provided by the platform. Nothing to connect.',
  },
]

/** The group entry for a vendor. */
export function scopeMeta(vendor: AdminResourceVendor) {
  const key = vendorScopeGroup(vendor)
  return CREDENTIAL_SCOPE_GROUPS.find((g) => g.key === key)!
}

/** A connector's state as the admin pages summarise it. */
export type ConnectorStatus = {
  label: string
  tone: 'on' | 'off' | 'attention'
  /** Whether the connector is usable by the team right now (on, and set up if it needs setup). */
  live: boolean
}

/** One-line status for a connector, on the gallery card and the detail page header. */
export function connectorStatus(vendor: AdminResourceVendor): ConnectorStatus {
  const needsSetup = vendor.setup?.status === 'unconfigured'
  if (vendor.autoProvisions) {
    const mode = vendor.ambientMode ?? 'enabled'
    if (mode === 'disabled') return { label: 'Off', tone: 'off', live: false }
    // An organization credential the admin hasn't entered yet: the vendor is on, but usable by
    // nobody until setup completes.
    if (needsSetup) return { label: 'Needs setup', tone: 'attention', live: false }
    return mode === 'enabled'
      ? { label: 'On for everyone', tone: 'on', live: true }
      : { label: 'Optional', tone: 'on', live: true }
  }
  if (needsSetup) return { label: 'Needs setup', tone: 'attention', live: false }
  return vendor.enabled
    ? { label: 'On', tone: 'on', live: true }
    : { label: 'Off', tone: 'off', live: false }
}

/**
 * The card's call to action: "Add" brings a connector into service (set it up, or turn it on),
 * "Manage" adjusts one that already works.
 */
export function connectorAction(vendor: AdminResourceVendor): 'Add' | 'Manage' {
  return connectorStatus(vendor).live ? 'Manage' : 'Add'
}
