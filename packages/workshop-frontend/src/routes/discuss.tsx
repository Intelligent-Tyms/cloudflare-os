import { lazy, Suspense } from 'react'
import { createFileRoute } from '@tanstack/react-router'

// Discuss full size. The page shares the Stream chunk with the dock, so it is lazy too.
const DiscussPage = lazy(() => import('../components/team-chat/DiscussPage'))

export const Route = createFileRoute('/discuss')({
  component: () => (
    <Suspense fallback={null}>
      <DiscussPage />
    </Suspense>
  ),
})
