import { createFileRoute } from '@tanstack/react-router'
import { LegacyAdminRedirect } from '../portalLinks'

// Workspace administration is on the admin and billing portals. /admin and its old pages
// (bookmarks, emailed links, the central picker's deep links) forward there.
export const Route = createFileRoute('/admin')({
  component: () => <LegacyAdminRedirect path="" />,
})
