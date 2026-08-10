import { useNavigate } from '@tanstack/react-router'
import { DropdownMenu } from '@cloudflare/kumo'
import { ChevronsUpDown, LogOut, Plug, ShieldCheck, SunMoon, User, Zap } from 'lucide-react'
import { useAuthenticatedApi } from '../AuthContext'
import { useAvatar } from '../useAvatar'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from './menuStyles'

// Menu rows follow the standard leading-icon pattern: a fixed-size 15px icon in the muted color
// (label stays the readable one), consistent gap, so labels left-align on a shared axis. The
// sign-out icon inherits the danger variant's text color via currentColor.
function ItemContent({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="grid w-[15px] shrink-0 place-items-center text-kumo-inactive [&>svg]:h-[15px] [&>svg]:w-[15px]">
        {icon}
      </span>
      {children}
    </span>
  )
}

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
      {/* w-[244px] ≈ the expanded trigger row's width (260px sidebar minus its padding), so the
          menu reads as an extension of the profile row rather than a floating strip. */}
      <DropdownMenu.Content className={`${MENU_CONTENT} w-[244px]`} style={MENU_POSITIONER_STYLE}>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/profile' })}
          className={MENU_ITEM}
        >
          <ItemContent icon={<User />}>Profile</ItemContent>
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/gatekeepers' })}
          className={MENU_ITEM}
        >
          <ItemContent icon={<Plug />}>Connectors</ItemContent>
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/theme' })}
          className={MENU_ITEM}
        >
          <ItemContent icon={<SunMoon />}>Theme</ItemContent>
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/providers' })}
          className={MENU_ITEM}
        >
          <ItemContent icon={<Zap />}>Providers</ItemContent>
        </DropdownMenu.Item>
        {isAdmin && (
          <DropdownMenu.Item
            onClick={() => navigate({ to: '/admin' })}
            className={MENU_ITEM}
          >
            <ItemContent icon={<ShieldCheck />}>Admin</ItemContent>
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          variant="danger"
          onClick={logout}
          className={MENU_ITEM_DANGER}
        >
          <span className="flex items-center gap-2.5">
            <LogOut size={15} className="shrink-0" />
            Sign out
          </span>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
