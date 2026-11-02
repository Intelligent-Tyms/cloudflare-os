/**
 * Marks the user's workspace for a first-party app (GadgetMetadataWithTimestamps.app): the
 * conversations they had with their assistant from inside that app. The workspace is titled after
 * the app, so the badge says what kind of workspace it is and the tooltip names the app.
 */
export default function AppBadge({ name }: { name: string }) {
  return (
    <span
      title={`Conversations from ${name}`}
      aria-label={`App workspace: ${name}`}
      className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-[14px] bg-kumo-fill text-kumo-subtle"
    >
      App
    </span>
  )
}
