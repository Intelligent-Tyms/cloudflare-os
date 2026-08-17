import { createFileRoute } from '@tanstack/react-router'
import AssistantSettingsPage from '../AssistantSettingsPage'

export const Route = createFileRoute('/assistant')({
  component: AssistantSettingsPage,
})
