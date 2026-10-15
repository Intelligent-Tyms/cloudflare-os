// The admin Connectors gallery (/admin/connectors): categories down the left, a searchable grid
// of connector cards on the right. A card leads to /admin/connectors/$vendorId, where the
// connector is set up, switched on, and its resources curated.
import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import type { AdminResourceVendor } from '@gadgets/workshop-shared/api'
import { INTEGRATION_DEPARTMENTS } from '@gadgets/workshop-shared/gatekeeper'
import {
  CREDENTIAL_SCOPE_GROUPS,
  connectorAction,
  connectorStatus,
  scopeMeta,
  vendorScopeGroup,
  type CredentialScopeGroup,
} from '../adminConnectorScope'

type Filter =
  | { kind: 'all' }
  | { kind: 'status'; value: 'attention' | 'on' | 'off' }
  | { kind: 'scope'; value: CredentialScopeGroup }
  | { kind: 'department'; value: string }

function filterKey(filter: Filter): string {
  return filter.kind === 'all' ? 'all' : `${filter.kind}:${filter.value}`
}

function matchesFilter(vendor: AdminResourceVendor, filter: Filter): boolean {
  switch (filter.kind) {
    case 'all':
      return true
    case 'status':
      return connectorStatus(vendor).tone === filter.value
    case 'scope':
      return vendorScopeGroup(vendor) === filter.value
    case 'department':
      return filter.value === 'general'
        ? !vendor.departments?.length
        : vendor.departments?.[0] === filter.value
  }
}

function matchesSearch(vendor: AdminResourceVendor, query: string): boolean {
  if (!query) return true
  const haystack = [vendor.displayName, vendor.tagline, vendor.description, vendor.vendorId]
    .join(' ')
    .toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((token) => haystack.includes(token))
}

const STATUS_PILL: Record<'on' | 'off' | 'attention', string> = {
  on: 'bg-kumo-success/10 text-kumo-success',
  off: 'bg-kumo-tint text-kumo-subtle',
  attention: 'bg-amber-500/10 text-amber-600',
}

/** The connector's status as a small pill, shared by the gallery card and the detail header. */
export function StatusPill({ vendor, className = '' }: { vendor: AdminResourceVendor; className?: string }) {
  const status = connectorStatus(vendor)
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] leading-4 font-medium ${STATUS_PILL[status.tone]} ${className}`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${
          status.tone === 'on' ? 'bg-kumo-success' : status.tone === 'attention' ? 'bg-amber-500' : 'bg-kumo-inactive'
        }`}
      />
      {status.label}
    </span>
  )
}

function ConnectorTile({ vendor, size = 24, className = 'h-11 w-11 rounded-xl' }: {
  vendor: Pick<AdminResourceVendor, 'logo' | 'color' | 'displayName'>
  size?: number
  className?: string
}) {
  return (
    <div
      className={`grid shrink-0 place-items-center border border-kumo-line/60 ${className}`}
      style={{ backgroundColor: vendor.color ?? 'var(--color-kumo-tint)' }}
    >
      {vendor.logo ? (
        <img src={vendor.logo.url} alt="" className="object-contain" style={{ width: size, height: size }} />
      ) : (
        <span className="text-[15px] font-semibold text-kumo-strong">
          {vendor.displayName[0]?.toUpperCase() ?? '?'}
        </span>
      )}
    </div>
  )
}

function ConnectorCard({ vendor }: { vendor: AdminResourceVendor }) {
  const status = connectorStatus(vendor)
  const action = connectorAction(vendor)
  return (
    <Link
      to="/admin/connectors/$vendorId"
      params={{ vendorId: vendor.vendorId }}
      className="themed-card-hover-shadow group flex flex-col rounded-2xl border border-kumo-line bg-kumo-base p-5 transition-[border-color,transform,box-shadow] duration-150 ease-out hover:-translate-y-px hover:border-kumo-fill focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-kumo-ring/30"
    >
      <div className="flex items-start gap-3">
        <ConnectorTile vendor={vendor} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <span className={`truncate text-[15px] leading-5 font-semibold tracking-[-0.25px] ${status.tone === 'off' ? 'text-kumo-subtle' : 'text-kumo-strong'}`}>
              {vendor.displayName}
            </span>
            <StatusPill vendor={vendor} />
          </div>
          <span className="mt-0.5 block text-[12px] leading-4 text-kumo-subtle">
            {scopeMeta(vendor).short}
          </span>
        </div>
      </div>
      {vendor.tagline && (
        <p className="mt-3 line-clamp-2 text-[13px] leading-[18px] tracking-[-0.2px] text-kumo-subtle">
          {vendor.tagline}
        </p>
      )}
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-kumo-line/70 pt-3">
        <span className="truncate text-[12px] leading-4 text-kumo-inactive">
          {vendor.departments?.length
            ? INTEGRATION_DEPARTMENTS.find((d) => d.id === vendor.departments![0])?.label
            : 'General'}
        </span>
        <span
          className={`inline-flex h-8 items-center rounded-full px-3 text-[12px] leading-4 font-medium transition-colors ${
            action === 'Add'
              ? 'bg-kumo-strong text-kumo-base group-hover:opacity-90'
              : 'border border-kumo-line bg-kumo-base text-kumo-default group-hover:bg-kumo-tint'
          }`}
        >
          {action}
        </span>
      </div>
    </Link>
  )
}

function RailGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 px-2 text-[11px] leading-4 font-semibold text-kumo-inactive">{label}</h3>
      <ul className="m-0 list-none p-0">{children}</ul>
    </div>
  )
}

function RailItem({ label, count, active, onClick }: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'true' : undefined}
        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] leading-[18px] tracking-[-0.2px] transition-colors ${
          active ? 'bg-kumo-tint font-medium text-kumo-strong' : 'text-kumo-default hover:bg-kumo-tint/60'
        }`}
      >
        <span className="truncate">{label}</span>
        <span className={`text-[11px] tabular-nums ${active ? 'text-kumo-subtle' : 'text-kumo-inactive'}`}>
          {count}
        </span>
      </button>
    </li>
  )
}

/** The category rail plus searchable card grid for /admin/connectors. */
export default function AdminConnectorsGallery({ vendors }: { vendors: AdminResourceVendor[] }) {
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const [query, setQuery] = useState('')

  const count = (candidate: Filter) => vendors.filter((v) => matchesFilter(v, candidate)).length
  const attention = count({ kind: 'status', value: 'attention' })

  const departments = useMemo(
    () =>
      [
        { id: 'general', label: 'General' },
        ...INTEGRATION_DEPARTMENTS,
      ].map((d) => ({ ...d, count: count({ kind: 'department', value: d.id }) }))
        .filter((d) => d.count > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vendors],
  )

  const visible = useMemo(() => {
    const q = query.trim()
    return vendors
      .filter((v) => matchesFilter(v, filter) && matchesSearch(v, q))
      .toSorted((a, b) => {
        // Anything needing attention first, then alphabetical.
        const ta = connectorStatus(a).tone === 'attention' ? 0 : 1
        const tb = connectorStatus(b).tone === 'attention' ? 0 : 1
        return ta - tb || a.displayName.localeCompare(b.displayName)
      })
  }, [vendors, filter, query])

  const active = filterKey(filter)
  const select = (next: Filter) => () => setFilter(next)

  if (vendors.length === 0) {
    return (
      <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
        <p className="text-sm text-kumo-subtle">No connectors are installed on this deployment.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
      <nav aria-label="Connector categories" className="flex shrink-0 flex-col gap-5 lg:sticky lg:top-6 lg:w-[200px]">
        <RailGroup label="Show">
          <RailItem label="All connectors" count={vendors.length} active={active === 'all'} onClick={select({ kind: 'all' })} />
          {attention > 0 && (
            <RailItem label="Needs setup" count={attention} active={active === 'status:attention'} onClick={select({ kind: 'status', value: 'attention' })} />
          )}
          <RailItem label="On" count={count({ kind: 'status', value: 'on' })} active={active === 'status:on'} onClick={select({ kind: 'status', value: 'on' })} />
          <RailItem label="Off" count={count({ kind: 'status', value: 'off' })} active={active === 'status:off'} onClick={select({ kind: 'status', value: 'off' })} />
        </RailGroup>
        <RailGroup label="Credential">
          {CREDENTIAL_SCOPE_GROUPS.map((g) => {
            const n = count({ kind: 'scope', value: g.key })
            if (n === 0) return null
            return (
              <RailItem key={g.key} label={g.label} count={n} active={active === `scope:${g.key}`} onClick={select({ kind: 'scope', value: g.key })} />
            )
          })}
        </RailGroup>
        {departments.length > 0 && (
          <RailGroup label="Department">
            {departments.map((d) => (
              <RailItem key={d.id} label={d.label} count={d.count} active={active === `department:${d.id}`} onClick={select({ kind: 'department', value: d.id })} />
            ))}
          </RailGroup>
        )}
      </nav>

      <div className="min-w-0 flex-1">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search connectors"
            aria-label="Search connectors"
            className="h-10 w-full rounded-lg border border-kumo-line bg-kumo-base pl-9 pr-4 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15"
          />
        </div>

        {filter.kind === 'scope' && (
          <p className="mt-3 text-[13px] leading-[18px] text-kumo-subtle">
            {CREDENTIAL_SCOPE_GROUPS.find((g) => g.key === filter.value)?.hint}
          </p>
        )}

        {visible.length === 0 ? (
          <div className="mt-6 rounded-xl border border-dashed border-kumo-line px-6 py-12 text-center">
            <p className="text-sm text-kumo-default">No connectors match.</p>
            <p className="mt-1 text-[13px] text-kumo-subtle">
              Try another category, or clear the search.
            </p>
          </div>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((vendor) => (
              <ConnectorCard key={vendor.vendorId} vendor={vendor} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
