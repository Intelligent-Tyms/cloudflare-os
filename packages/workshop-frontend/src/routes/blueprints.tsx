import { createFileRoute, redirect } from '@tanstack/react-router'
import BlueprintList from '../components/BlueprintList'
import { useDocumentTitle } from '../useDocumentTitle'

/**
 * Legacy path: the user's own + saved templates now live on the Apps page (routes/apps.tsx,
 * "Your templates" tab). This route only redirects old links and bookmarks; the page component
 * stays in this file so upstream merges remain cheap.
 */
export const Route = createFileRoute('/blueprints')({
  beforeLoad: () => {
    throw redirect({ to: '/apps', search: { tab: 'yours' } })
  },
  component: BlueprintsRoutePage,
})

function BlueprintsRoutePage() {
  useDocumentTitle('Templates')
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-3 sm:px-10">
      {/* Title only — Explore and Upload sit together in the list's toolbar so they share a width. */}
      <header className="min-w-0 px-3 pb-3 pt-6 sm:pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Templates</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          Reusable starting points you've published or saved. Spin up a workspace from any of them.
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <BlueprintList />
      </div>
    </div>
  )
}
