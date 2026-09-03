import { createFileRoute } from '@tanstack/react-router'
import BlueprintsPage, { type AppsTab } from '../BlueprintsPage'
import { useDocumentTitle } from '../useDocumentTitle'

type AppsSearch = { tab?: AppsTab }

/**
 * "Apps" — one page for everything you can start a workspace from. Two tabs: Featured (the
 * deployment-wide catalog, formerly Discover at /explore) and Your templates (the user's own +
 * saved templates, formerly Templates at /blueprints). Both old paths redirect here.
 */
export const Route = createFileRoute('/apps')({
  component: AppsPage,
  validateSearch: (search: Record<string, unknown>): AppsSearch => ({
    tab: search.tab === 'yours' ? 'yours' : undefined,
  }),
})

function AppsPage() {
  useDocumentTitle('Apps')
  const { tab } = Route.useSearch()
  return <BlueprintsPage tab={tab ?? 'featured'} />
}
