// Whose credential an integration runs on, for the admin Integrations pages. Shared by the
// index (which groups by it) and the detail page (which explains it).
import type { AdminResourceVendor } from '@gadgets/workshop-shared/api'

// Company credentials an administrator enters once, personal sign-ins each person completes,
// and built-in capabilities with nothing to connect. Derived from VendorDescription.credentialScope,
// falling back on the vendor's shape for vendors that don't declare one.
export type CredentialScopeGroup = 'organization' | 'personal' | 'builtin'

export function vendorScopeGroup(vendor: AdminResourceVendor): CredentialScopeGroup {
  if (vendor.credentialScope) return vendor.credentialScope
  return vendor.autoProvisions ? 'builtin' : 'personal'
}

export const CREDENTIAL_SCOPE_GROUPS: { key: CredentialScopeGroup; label: string; hint: string }[] = [
  {
    key: 'organization',
    label: 'Company credentials',
    hint: 'Set up once by an administrator. Everyone on the team uses them without signing in.',
  },
  {
    key: 'personal',
    label: 'Personal sign-in',
    hint: 'Each person connects their own account. Recipients of a shared workspace connect theirs too.',
  },
  {
    key: 'builtin',
    label: 'Built in',
    hint: 'Provided by the platform. Nothing to connect.',
  },
]
