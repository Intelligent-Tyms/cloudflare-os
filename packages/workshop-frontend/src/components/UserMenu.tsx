import { useNavigate } from '@tanstack/react-router'
import { DropdownMenu } from '@cloudflare/kumo'
import { ChevronsUpDown } from 'lucide-react'
import { useAuthenticatedApi } from '../AuthContext'
import { useAvatar } from '../useAvatar'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from './menuStyles'

// Profile row pinned at the bottom of the sidebar: avatar, name, and email with a disclosure
// chevron (the Slack/Notion account-switcher pattern). The dropdown is the single home for
// account-level destinations — Profile, Connectors, Theme, Providers, Admin — each of which is a
// full page rather than inline controls. When the sidebar is collapsed the row shrinks to just
// the avatar.
export default function UserMenu({ collapsed = false }: { collapsed?: boolean }) {
  const { authenticatedApi, logout, currentUser, isAdmin } = useAuthenticatedApi()
  const navigate = useNavigate()

  const avatarUrl = useAvatar(authenticatedApi, currentUser?.id)

  const initials = currentUser?.name
    ? currentUser.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U'

  const avatar = (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-kumo-tint">
      {avatarUrl ? (
        <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="text-xs font-medium text-kumo-strong">{initials}</span>
      )}
    </span>
  )

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          collapsed ? (
            <button
              className="flex cursor-pointer items-center justify-center rounded-lg p-1 transition-colors hover:bg-kumo-tint"
              title="Open profile menu"
              aria-label="Open profile menu"
            >
              {avatar}
            </button>
          ) : (
            <button
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-kumo-tint"
              title="Open profile menu"
              aria-label="Open profile menu"
            >
              {avatar}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold leading-[17px] tracking-[-0.25px] text-kumo-default">
                  {currentUser?.name ?? 'Account'}
                </span>
                <span className="block truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
                  {currentUser?.id}
                </span>
              </span>
              <ChevronsUpDown size={14} className="shrink-0 text-kumo-inactive" />
            </button>
          )
        }
      />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/profile' })}
          className={MENU_ITEM}
        >
          Profile
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/gatekeepers' })}
          className={MENU_ITEM}
        >
          Connectors
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/theme' })}
          className={MENU_ITEM}
        >
          Theme
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/providers' })}
          className={MENU_ITEM}
        >
          Providers
        </DropdownMenu.Item>
        {isAdmin && (
          <DropdownMenu.Item
            onClick={() => navigate({ to: '/admin' })}
            className={MENU_ITEM}
          >
            Admin
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          variant="danger"
          onClick={logout}
          className={MENU_ITEM_DANGER}
        >
          Sign out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
