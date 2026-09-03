import { Link, useRouterState, type LinkProps } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { safeExternalUrl } from '../../utils/safeExternalUrl'

/**
 * A single nav row in the sidebar. Renders as a TanStack <Link>. Active state is computed from the
 * current router pathname so we can also tint the icon (TanStack's activeProps only swaps top-level
 * className, not child styles). When `collapsed` is true the label is hidden but kept in the DOM for
 * screen readers / hover-tooltips.
 */
export type SidebarItemProps = {
  icon: ReactNode
  label: string
  to: LinkProps['to']
  params?: LinkProps['params']
  trailing?: ReactNode
  collapsed?: boolean
  /** When true, match this item active when the current path starts with `to`. */
  matchPrefix?: boolean
  /**
   * When set, the row is a plain anchor opening this URL in a new tab (an app hosted elsewhere,
   * e.g. the organization wiki) and `to` is ignored. Never active.
   */
  href?: string
}

export default function SidebarItem({
  icon,
  label,
  to,
  params,
  trailing,
  collapsed = false,
  matchPrefix = false,
  href,
}: SidebarItemProps) {
  const externalHref = href ? safeExternalUrl(href) : undefined
  if (href) {
    // External app: a real anchor (the app iframe sandbox cannot open windows, so the link
    // must live here in the shell). An unsafe URL renders nothing rather than a broken row.
    if (!externalHref) return null
    return (
      <a
        href={externalHref}
        target="_blank"
        rel="noopener noreferrer"
        title={collapsed ? label : undefined}
        className="group relative flex h-11 items-center gap-2.5 rounded-lg px-2.5 text-[14px] leading-5 font-normal text-kumo-default transition-colors hover:bg-kumo-tint md:h-8 md:text-[13px] md:leading-[18px]"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-kumo-subtle transition-colors group-hover:text-kumo-default">
          {icon}
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {trailing && <span className="shrink-0 text-kumo-inactive">{trailing}</span>}
          </>
        )}
      </a>
    )
  }

  // Resolve the active path manually so we can style the icon as well as the row. For parameterized
  // routes (e.g. "/gatekeepers/$appId"), substitute the params so the resolved path can match.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  let target = typeof to === 'string' ? to : ''
  if (params) {
    for (const [key, value] of Object.entries(params as Record<string, string>)) {
      target = target.replaceAll(`$${key}`, String(value))
    }
  }
  const isActive = matchPrefix
    ? pathname === target || pathname.startsWith(target + '/')
    : pathname === target

  // Kept loose: the generated route-tree union is stricter than is convenient for a generic row.
  const linkProps = { to, params } as unknown as LinkProps

  return (
    <Link
      {...linkProps}
      title={collapsed ? label : undefined}
      className={[
        'group relative flex h-11 items-center gap-2.5 rounded-lg px-2.5 text-[14px] leading-5 transition-colors md:h-8 md:text-[13px] md:leading-[18px]',
        isActive
          ? 'bg-kumo-fill font-medium text-kumo-strong'
          : 'font-normal text-kumo-default hover:bg-kumo-tint',
      ].join(' ')}
    >
      <span
        className={[
          'flex h-5 w-5 shrink-0 items-center justify-center transition-colors',
          isActive ? 'text-kumo-brand' : 'text-kumo-subtle group-hover:text-kumo-default',
        ].join(' ')}
      >
        {icon}
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {trailing && <span className="shrink-0 text-kumo-inactive">{trailing}</span>}
        </>
      )}
    </Link>
  )
}
