import { createFileRoute } from '@tanstack/react-router'
import ChannelsPage from '../ChannelsPage'

export const Route = createFileRoute('/channels')({
  component: ChannelsPage,
})
