import { createFileRoute } from '@tanstack/react-router'
import { ConnectorsPage } from './gatekeepers'

// Canonical path for the Integrations page. The page component lives in routes/gatekeepers.tsx
// (the legacy path, which redirects here) so upstream merges stay cheap.
export const Route = createFileRoute('/integrations')({
  component: ConnectorsPage,
})
