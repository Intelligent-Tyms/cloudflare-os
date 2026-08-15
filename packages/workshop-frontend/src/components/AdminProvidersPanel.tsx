// Admin panel for AI models, rendered on the /admin/providers detail page. The page chrome
// (title, description, back link) comes from AdminPage, so this panel is just the toolbar,
// notices, and model list.
//
// Two modes, decided by the `models` prop (AdminSettingsView.models):
// - Platform AI Gateway mode (models != null): the platform holds the provider keys and usage
//   draws on plan credits, so the panel is pure curation -- a toggle per catalog model, no key
//   entry anywhere. Mirrors the skills panel's opt-out pattern.
// - BYOK mode (models == null, self-hosted deployments): the original provider management --
//   add models with your own API tokens, pick a quick model, delete.

import { useState, useEffect } from 'react'
import { DropdownMenu, Switch, useKumoToastManager } from '@cloudflare/kumo'
import { RpcStub } from 'capnweb'
import { useAuthenticatedApi } from '../AuthContext'
import {
  AdminApi,
  AdminModel,
  AiChatAuthorInfo,
  AiGatewayInfo,
  AiModelProvider,
  SUGGESTED_MODELS,
} from '@gadgets/workshop-shared/api'
import {
  Plus,
  Trash2,
  TriangleAlert,
  Zap,
  Search,
  EllipsisVertical,
} from 'lucide-react'
import AddModelModal from '../AddModelModal'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER } from './menuStyles'

const PROVIDER_ORDER = Object.keys(SUGGESTED_MODELS) as AiModelProvider[]

// Section labels for the curated catalog, grouped by provider. "" is the synthetic group for
// disabled ids that have since left the catalog (AdminModel.missing).
const PROVIDER_LABELS: Record<AdminModel['provider'], string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  cloudflare: 'Workers AI',
  ollama: 'Ollama',
  '': 'No longer in the catalog',
}

const PRIMARY_BTN =
  'press inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-[13px] font-medium tracking-[-0.25px] text-white transition-colors hover:bg-kumo-brand-hover'

// ─── model row ─────────────────────────────────────────────────────────────────

// Rows mirror the Blueprints list: a clickable row (here, clicking sets/clears the quick model)
// plus a kebab for the rest. The whole row is the primary affordance, so it shows a pointer.
function ModelRow({
  model,
  isQuick,
  isBuiltIn,
  onDelete,
  onSetQuick,
}: {
  model: AiChatAuthorInfo
  isQuick: boolean
  isBuiltIn: boolean
  onDelete: () => void
  onSetQuick: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSetQuick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSetQuick()
        }
      }}
      title={isQuick ? 'Quick model. Click to clear' : 'Click to set as quick model'}
      className="group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-kumo-tint"
    >
      {/* Neutral monogram — matches the sidebar/workspaces treatment */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-[12px] font-medium text-kumo-subtle">
        {model.name[0]?.toUpperCase()}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">
            {model.name}
          </span>
          {isBuiltIn && (
            <span className="shrink-0 rounded-full bg-kumo-tint px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.4px] text-kumo-subtle">
              built-in
            </span>
          )}
          {isQuick && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-kumo-brand/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.4px] text-kumo-brand">
              <Zap size={9} fill="currentColor" strokeWidth={0} />
              quick
            </span>
          )}
        </div>
        <span className="mt-0.5 block truncate font-mono text-[12px] tracking-[-0.1px] text-kumo-inactive">
          {model.id}
        </span>
      </div>

      {/* Actions */}
      <div onClick={(e) => { e.stopPropagation() }}>
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <button
                aria-label="Provider actions"
                className="cursor-pointer rounded-md p-1.5 text-kumo-subtle transition-colors hover:bg-kumo-fill hover:text-kumo-default focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              >
                <EllipsisVertical size={16} />
              </button>
            }
          />
          <DropdownMenu.Content className={MENU_CONTENT}>
            <DropdownMenu.Item onClick={onSetQuick} className={MENU_ITEM}>
              <Zap size={13} className="mr-2" fill={isQuick ? 'currentColor' : 'none'} />
              {isQuick ? 'Clear quick model' : 'Set as quick model'}
            </DropdownMenu.Item>
            {!isBuiltIn && (
              <DropdownMenu.Item variant="danger" onClick={onDelete} className={MENU_ITEM_DANGER}>
                <Trash2 size={13} className="mr-2" />
                Delete provider
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
    </div>
  )
}

// ─── curated catalog (platform AI Gateway mode) ────────────────────────────────

function CuratedModelRow({
  model,
  busy,
  onToggle,
}: {
  model: AdminModel
  busy: boolean
  onToggle: (enabled: boolean) => void
}) {
  return (
    <div className="flex items-center gap-3 bg-kumo-base px-4 py-3 first:rounded-t-lg last:rounded-b-lg">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">
            {model.missing ? model.id : model.name}
          </span>
          {model.freePlan && (
            <span className="shrink-0 rounded-full bg-kumo-tint px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.4px] text-kumo-subtle">
              free plan
            </span>
          )}
          {model.missing && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-kumo-warning">
              <TriangleAlert size={13} />
              Missing
            </span>
          )}
        </div>
        {!model.missing && (
          <span className="mt-0.5 block truncate font-mono text-[12px] tracking-[-0.1px] text-kumo-inactive">
            {model.id}
          </span>
        )}
      </div>
      <Switch
        checked={model.enabled}
        disabled={busy}
        onCheckedChange={onToggle}
        aria-label={model.missing
          ? `Clear stale entry for ${model.id}`
          : `${model.enabled ? 'Disable' : 'Enable'} ${model.name}`}
      />
    </div>
  )
}

// The curation list: every catalog model with an on/off switch, grouped by provider. Optimistic
// toggles with revert-and-toast on failure, matching the skills panel. A `missing` row is a
// disabled id that has since left the catalog; enabling it clears the stale entry.
function ModelCurationList({
  admin,
  models,
  onChanged,
}: {
  admin: RpcStub<AdminApi>
  models: AdminModel[]
  onChanged: () => Promise<void>
}) {
  const toasts = useKumoToastManager()
  // Local optimistic copy; re-seeded whenever the parent re-fetches.
  const [rows, setRows] = useState(models)
  const [busyId, setBusyId] = useState<string | null>(null)
  useEffect(() => { setRows(models) }, [models])

  const toggle = async (model: AdminModel, enabled: boolean) => {
    if (busyId) return
    // Refuse to disable the last enabled model client-side: an empty picker helps nobody, and
    // "turn everything off" is far more likely a misclick than an intent.
    if (!enabled && rows.filter((m) => m.enabled).length <= 1) {
      toasts.add({ title: 'At least one model must stay enabled', variant: 'error' })
      return
    }
    setBusyId(model.id)
    setRows(rows.map((m) => (m.id === model.id ? { ...m, enabled } : m)))
    try {
      await admin.setModelEnabled(model.id, enabled)
      // Sync with the server view (clears `missing` rows that were just re-enabled away).
      await onChanged()
    } catch (err) {
      console.error('Failed to update model:', err)
      setRows(rows)
      toasts.add({ title: "Couldn't update the model", variant: 'error' })
    } finally {
      setBusyId(null)
    }
  }

  const groups = (Object.keys(PROVIDER_LABELS) as AdminModel['provider'][])
    .map((provider) => ({ provider, models: rows.filter((m) => m.provider === provider) }))
    .filter((group) => group.models.length > 0)

  return (
    <div className="flex flex-col gap-5">
      <Notice>
        <Zap size={15} className="mt-px shrink-0 text-kumo-brand" />
        <span>
          Models run on platform keys and usage draws on your plan&rsquo;s AI credits. No API
          tokens needed. New models we add appear here automatically, enabled.
        </span>
      </Notice>

      {groups.map(({ provider, models: groupModels }) => (
        <div key={provider}>
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.4px] text-kumo-subtle">
            {PROVIDER_LABELS[provider]}
          </h3>
          {provider === '' && (
            <p className="mb-2 text-[13px] leading-[18px] text-kumo-subtle">
              These were disabled and have since left the catalog. Turn one on to clear the stale
              entry.
            </p>
          )}
          <div className="flex flex-col divide-y divide-kumo-line rounded-lg border border-kumo-line">
            {groupModels.map((model) => (
              <CuratedModelRow
                key={model.id}
                model={model}
                busy={busyId !== null}
                onToggle={(enabled) => toggle(model, enabled)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── notice ────────────────────────────────────────────────────────────────────

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-kumo-line bg-kumo-tint px-4 py-3 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
      {children}
    </div>
  )
}

// ─── panel ─────────────────────────────────────────────────────────────────────

export default function AdminProvidersPanel({
  admin,
  models: curatedModels,
  onModelsChanged,
}: {
  admin: RpcStub<AdminApi>
  // The platform gateway catalog with curation state, or null outside gateway mode (the panel
  // then shows the BYOK provider management below).
  models: AdminModel[] | null
  onModelsChanged: () => Promise<void>
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const curated = curatedModels !== null
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [quickModel, setQuickModel] = useState<string | null>(null)
  const [aiConfig, setAiConfig] = useState<AiGatewayInfo | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const fetchAll = async () => {
    setLoadError(false)
    try {
      const [modelList, qm, cfg] = await Promise.all([
        authenticatedApi.listModels(),
        authenticatedApi.getQuickModel(),
        authenticatedApi.getAiConfig(),
      ])
      setModels(modelList)
      setQuickModel(qm)
      setAiConfig(cfg)
    } catch (err) {
      console.error('Failed to load providers:', err)
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!curated) fetchAll()
  }, [authenticatedApi, curated])

  // Platform AI Gateway mode: pure curation, no key entry, no add/delete/quick-model management.
  if (curated) {
    return <ModelCurationList admin={admin} models={curatedModels} onChanged={onModelsChanged} />
  }

  const gatewayMode = aiConfig?.enabled === true

  const isBuiltIn = (modelId: string): boolean => {
    if (!aiConfig?.enabled) return false
    const enabled = new Set((aiConfig as Extract<AiGatewayInfo, { enabled: true }>).enabledProviders)
    return PROVIDER_ORDER.some((p) => enabled.has(p) && modelId in SUGGESTED_MODELS[p])
  }

  const handleDelete = async (model: AiChatAuthorInfo) => {
    if (!confirm(`Delete "${model.name}"? This cannot be undone.`)) return
    setDeletingId(model.id)
    try {
      await admin.deleteModel(model.id)
      await fetchAll()
    } catch (err) {
      console.error('Failed to delete model:', err)
      toasts.add({ title: 'Failed to delete provider', variant: 'error' })
    } finally {
      setDeletingId(null)
    }
  }

  const handleSetQuick = async (modelId: string) => {
    const next = quickModel === modelId ? null : modelId
    setQuickModel(next)
    try {
      await admin.setQuickModel(next)
    } catch (err) {
      console.error('Failed to set quick model:', err)
      setQuickModel(quickModel) // revert
      toasts.add({ title: 'Failed to update default model', variant: 'error' })
    }
  }

  const filtered = models.filter((m) => {
    if (!search) return true
    const q = search.toLowerCase()
    return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
  })

  return (
    <div className="flex flex-col">
      {/* Toolbar — search (hidden when there are no models) + add */}
      <div className="mb-3 flex items-center gap-3">
        {!loading && !loadError && models.length > 0 && (
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search providers…"
              className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base pl-9 pr-4 text-[13px] tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] duration-150 ease-out focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15"
            />
          </div>
        )}
        {!loading && !loadError && models.length > 0 && (
          <button type="button" onClick={() => setSheetOpen(true)} className={`${PRIMARY_BTN} ml-auto`}>
            <Plus size={14} strokeWidth={2.5} />
            Add provider
          </button>
        )}
      </div>

      <div className="flex flex-col gap-0.5">
        {/* Notices */}
        {(gatewayMode || (!gatewayMode && models.length > 0)) && !loading && !loadError && (
          <div className="flex flex-col gap-2.5 pb-2">
            {gatewayMode && (
              <Notice>
                <Zap size={15} className="mt-px shrink-0 text-kumo-brand" />
                <span>
                  <strong className="font-medium text-kumo-default">AI Gateway mode:</strong> built-in
                  models are managed by your deployment. You can still add custom models with your own
                  API tokens.
                </span>
              </Notice>
            )}

            {!gatewayMode && models.length > 0 && (
              <Notice>
                <Zap size={15} className="mt-px shrink-0 text-kumo-brand" />
                <span>
                  <strong className="font-medium text-kumo-default">Quick model:</strong>{' '}
                  {quickModel
                    ? `${models.find((m) => m.id === quickModel)?.name ?? quickModel}.`
                    : 'none set.'}{' '}
                  Used for fast tasks like generating chat titles. Click a model to set it.
                </span>
              </Notice>
            )}
          </div>
        )}

        {/* Model list */}
        {loading ? (
          <div className="flex flex-col gap-0.5">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-[56px] animate-pulse rounded-xl bg-kumo-elevated" />
            ))}
          </div>
        ) : loadError ? (
          <div className="py-12 text-center text-sm">
            <p className="text-kumo-danger">Something went wrong loading your providers.</p>
            <button type="button" onClick={fetchAll} className="mt-1 cursor-pointer text-kumo-brand underline">
              Try again
            </button>
          </div>
        ) : models.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-kumo-fill text-kumo-subtle">
              <Zap size={18} />
            </div>
            <div>
              <p className="text-sm font-medium text-kumo-default">No AI providers yet</p>
              <p className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">
                Add a provider to start building workspaces with AI.
              </p>
            </div>
            <button type="button" onClick={() => setSheetOpen(true)} className={PRIMARY_BTN}>
              <Plus size={14} strokeWidth={2.5} />
              Add your first provider
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-kumo-inactive">No providers found</div>
        ) : (
          filtered.map((model) => (
            <div
              key={model.id}
              className={deletingId === model.id ? 'pointer-events-none opacity-50' : ''}
            >
              <ModelRow
                model={model}
                isQuick={quickModel === model.id}
                isBuiltIn={isBuiltIn(model.id)}
                onDelete={() => handleDelete(model)}
                onSetQuick={() => handleSetQuick(model.id)}
              />
            </div>
          ))
        )}
      </div>

      {/* Add model dialog */}
      <AddModelModal
        visible={sheetOpen}
        onCancel={() => setSheetOpen(false)}
        onSuccess={() => {
          setSheetOpen(false)
          fetchAll()
        }}
        addModel={(profile, config) => admin.addModel(profile, config)}
        aiConfig={aiConfig}
      />
    </div>
  )
}
