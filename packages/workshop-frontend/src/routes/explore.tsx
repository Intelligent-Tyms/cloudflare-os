import { createFileRoute, redirect } from '@tanstack/react-router'
import BlueprintsPage from '../BlueprintsPage'
import { useDocumentTitle } from '../useDocumentTitle'

// Legacy path: Discover now lives on the Apps page (routes/apps.tsx, Featured tab). This route
// only redirects old links and bookmarks; the component stays so upstream merges remain cheap.
export const Route = createFileRoute('/explore')({
  beforeLoad: () => {
    throw redirect({ to: '/apps' })
  },
  component: ExplorePage,
})

function ExplorePage() {
  useDocumentTitle('Apps')

  return <BlueprintsPage tab="featured" />
}
