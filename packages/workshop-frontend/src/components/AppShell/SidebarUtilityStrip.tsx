import UserMenu from '../UserMenu'

// Bottom strip on the sidebar: the user profile row (avatar, name, email) that opens the account
// menu. Connectors and Theme live inside that menu as links to their own settings pages, so the
// strip itself carries no extra iconography.
export default function SidebarUtilityStrip({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div
      className={[
        // shrink-0 + solid base so the strip is visually pinned above the scrolling rail body
        // and content can't bleed through it. Flat treatment — no top shadow.
        'shrink-0 border-t border-kumo-line bg-kumo-elevated px-2 py-2',
        collapsed ? 'flex justify-center px-1.5' : '',
      ].join(' ')}
    >
      <UserMenu collapsed={collapsed} />
    </div>
  )
}
