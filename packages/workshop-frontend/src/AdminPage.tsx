import { useState, useEffect, useRef, type ChangeEvent, type ReactNode } from 'react'
import { RpcStub } from 'capnweb'
import { Link } from '@tanstack/react-router'
import { Switch, Textarea, Input, Button, useKumoToastManager } from '@cloudflare/kumo'
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpenCheck,
  Bot,
  Building2,
  CreditCard,
  Database,
  FileText,
  Hexagon,
  Megaphone,
  MessagesSquare,
  Palette,
  Plug,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  UserPlus,
  Users,
  Workflow,
  Zap,
} from 'lucide-react'
import { useAuthenticatedApi } from './AuthContext'
import { useServerConfig } from './ServerConfigContext'
import { AdminApi, AdminFormat, AdminModel, AdminResourceVendor, AdminSkill, ChannelsDescription, MAX_INSTANCE_INSTRUCTIONS_LENGTH, MAX_ORGANIZATION_PROFILE_LENGTH, MAX_ANNOUNCEMENT_LENGTH, MAX_SITE_NAME_LENGTH, DEFAULT_SITE_NAME, BannerColor, BANNER_COLORS, DEFAULT_BANNER_COLOR } from '@gadgets/workshop-shared/api'
import AdminConnectorsGallery from './components/AdminConnectorsGallery'
import type { IntelligenceProductKind } from '@gadgets/workshop-shared/api'
import { applyAccentColor, DEFAULT_ACCENT_COLOR } from './theme'
import { cacheBustSiteLogoUrl, prepareSiteLogo } from './siteLogoUtils'
import SiteLogo from './components/SiteLogo'
import { useDocumentTitle } from './useDocumentTitle'
import { CENTRAL_SETTINGS_PATH, portalLink, type Portal } from './portalLinks'
import AdminChannelsPanel from './components/AdminChannelsPanel'
import AdminFormatsPanel from './components/format/AdminFormatsPanel'
import AdminIntelligencePanel, { AdminIntelligenceComingSoon } from './components/AdminIntelligencePanel'
import AdminProvidersPanel from './components/AdminProvidersPanel'
import AdminSkillsPanel from './components/AdminSkillsPanel'

// Preset accent colors offered in the Theme section ('' = default brand).
const ACCENT_PRESETS: { label: string; value: string }[] = [
  { label: 'Default', value: '' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Green', value: '#16a34a' },
  { label: 'Purple', value: '#7c3aed' },
  { label: 'Pink', value: '#db2777' },
  { label: 'Teal', value: '#0d9488' },
]

// The admin area is a hub of cards (grouped below) where each card opens its own detail page at
// /admin/$section. `blurb` is the short card copy on the hub; `description` is the fuller intro
// on the detail page. Sections whose detail page has a single control put the explanatory copy
// here (in `description`) instead of repeating it inside the card.
export type AdminSectionId =
  | 'organization'
  | 'brand'
  | 'announcements'
  | 'access'
  | 'instructions'
  | 'formats'
  | 'skills'
  | 'channels'
  | 'connectors'
  | 'providers'
  | 'organization-intelligence'
  | 'data-intelligence'
  | 'market-intelligence'
  | 'process-intelligence'

// Cards for what is managed on the central portals (admin.tyms.ai, billing.tyms.ai) rather
// than here. They open the portal page for this workspace and have no detail page of their own.
type PortalSectionId = 'teammates' | 'billing' | 'assistant-settings' | 'intelligence-products' | 'channels-portal'

type AdminSection = {
  id: AdminSectionId | PortalSectionId
  title: string
  blurb: string
  description: string
  icon: ReactNode
  /** Not built yet: the hub card says so, and the detail page is a placeholder. */
  comingSoon?: boolean
  /** Managed on a central portal: the card links to this page of it instead. */
  portal?: { portal: Portal; path: string }
  /**
   * Edited on the admin portal once the deployment takes its settings from there
   * (ServerConfig.settingsManagedCentrally): the card is hidden and the page points there.
   * A portal card with this set is the opposite: shown only then.
   */
  central?: boolean
  /** Meaningless with central sign-in (accounts are created centrally): hidden then. */
  localSignInOnly?: boolean
}


const ADMIN_GROUPS: { label: string; sections: AdminSection[] }[] = [
  {
    label: 'Workspace',
    sections: [
      {
        id: 'assistant-settings',
        title: 'Organization, brand & offerings',
        blurb: 'What every assistant is told, the brand, notices, and which skills and AI models are offered. Opens the admin portal.',
        description: '',
        icon: <Building2 size={18} />,
        portal: { portal: 'admin', path: CENTRAL_SETTINGS_PATH },
        central: true,
      },
      {
        id: 'organization',
        central: true,
        title: 'Organization',
        blurb: 'Tell your assistants what your organization does, your terminology, and key facts.',
        description:
          'Context about your organization added to every assistant’s system prompt: what you do, your terminology, key facts. Keep it short and put deeper reference material in shared Knowledge folders instead; the assistant will read it when it’s relevant.',
        icon: <Building2 size={18} />,
      },
      {
        id: 'teammates',
        title: 'Teammates',
        blurb: 'Invite people to this workspace and manage who has access. Opens the admin portal.',
        description: '',
        icon: <Users size={18} />,
        portal: { portal: 'admin', path: '/teammates' },
      },
      {
        id: 'billing',
        title: 'Plans & billing',
        blurb: 'Your plan, credits, invoices, and payment details. Opens the billing portal.',
        description: '',
        icon: <CreditCard size={18} />,
        portal: { portal: 'billing', path: '' },
      },
      {
        id: 'brand',
        central: true,
        title: 'Brand',
        blurb: 'Site name, logo, and accent color shown across the app.',
        description: 'Site name, logo, and accent color shown across the app. Changes apply to everyone on their next connection.',
        icon: <Palette size={18} />,
      },
      {
        id: 'announcements',
        central: true,
        title: 'Announcements',
        blurb: 'Banner and top-bar notices shown to everyone.',
        description: 'The full-width banner and the top-bar notice shown to everyone using this deployment.',
        icon: <Megaphone size={18} />,
      },
      {
        id: 'access',
        localSignInOnly: true,
        title: 'Access',
        blurb: 'Control whether new accounts can be created.',
        description: 'Control who can create an account on this deployment.',
        icon: <UserPlus size={18} />,
      },
    ],
  },
  {
    label: 'Assistant',
    sections: [
      {
        id: 'instructions',
        central: true,
        title: 'Assistant instructions',
        blurb: 'Deployment-wide instructions added to every assistant.',
        description:
          'Extra instructions added to every assistant’s system prompt on this deployment. Use this for instance-specific context, conventions, or guardrails.',
        icon: <Bot size={18} />,
      },
      {
        id: 'formats',
        title: 'Formats',
        blurb: 'Standard file formats offered across the app.',
        description: 'The standard file formats promoted to everyone across the app.',
        icon: <FileText size={18} />,
      },
      {
        id: 'skills',
        title: 'Skills',
        blurb: 'Turn the skills your assistants can use on or off.',
        description:
          'Skills teach assistants how to perform specific tasks, step by step. A skill is a SKILL.md file in a shared Knowledge folder (including folders synced from git); this page controls which ones are offered to everyone.',
        icon: <Sparkles size={18} />,
      },
      {
        id: 'channels',
        central: true,
        title: 'Channels',
        blurb: 'Chat with your assistant in Telegram and Slack.',
        description:
          'Bring your assistant into the chat apps your team already uses. Telegram and Slack are available today; WhatsApp and Microsoft Teams are coming soon.',
        icon: <MessagesSquare size={18} />,
      },
      {
        id: 'channels-portal',
        title: 'Channels',
        blurb: 'Telegram, email and Slack for your assistant. Opens the admin portal.',
        description: '',
        icon: <MessagesSquare size={18} />,
        portal: { portal: 'admin', path: '/channels' },
        central: true,
      },
      {
        id: 'connectors',
        title: 'Connectors',
        blurb: 'The services assistants can reach: set up company credentials and choose what people can connect.',
        description:
          'Everything assistants can reach outside this deployment. Company connectors run on a credential you enter once; personal ones are signed in to by each person. Open a connector to set it up, turn it on or off, or choose which of its resources are offered. Changes are soft: they don’t revoke access an app already holds.',
        icon: <Plug size={18} />,
      },
      {
        id: 'providers',
        central: true,
        title: 'AI models',
        blurb: 'Choose which AI models everyone on this deployment can use.',
        description:
          'The AI models offered to everyone on this deployment. Turn models on or off to choose what users can pick.',
        icon: <Zap size={18} />,
      },
    ],
  },
  {
    label: 'Intelligence',
    sections: [
      {
        id: 'intelligence-products',
        title: 'Intelligence products',
        blurb: 'Set up, reconnect and open Organization and Data Intelligence. Opens the admin portal.',
        description: '',
        icon: <BookOpenCheck size={18} />,
        portal: { portal: 'admin', path: '/products' },
        central: true,
      },
      {
        id: 'organization-intelligence',
        central: true,
        title: 'Organization intelligence',
        blurb: 'Your own documents, synthesized into a reviewed wiki the assistant answers from and cites.',
        description:
          'Organization Intelligence turns your own documents into a reviewed wiki of your organization’s knowledge. Verified pages become precedents the assistant answers from and cites. The wiki is set up the first time you open this page and connects the assistant automatically; from here you open it signed in and manage it.',
        icon: <BookOpenCheck size={18} />,
      },
      {
        id: 'data-intelligence',
        central: true,
        title: 'Data intelligence',
        blurb: 'Connect your databases read-only for analysts and the assistant.',
        description:
          'Data Intelligence connects your own databases and warehouses, read-only. Analysts work in the data workbench; the assistant answers from the same connections and cites every query it ran. The workbench is set up the first time you open this page and connects the assistant automatically; from here you open it signed in and manage connections.',
        icon: <Database size={18} />,
      },
      {
        id: 'market-intelligence',
        central: true,
        title: 'Market intelligence',
        blurb: 'Competitive insight and industry trends for the market you operate in.',
        description:
          'Market Intelligence keeps your assistants informed about the market you operate in: competitors, industry trends, and the outward-looking context that pairs with your organization’s own knowledge.',
        icon: <TrendingUp size={18} />,
        comingSoon: true,
      },
      {
        id: 'process-intelligence',
        central: true,
        title: 'Process intelligence',
        blurb: 'Process metrics, workflows, and performance across the business.',
        description:
          'Process Intelligence gives your assistants a view of how work actually flows: process metrics, workflows, and performance, so they can answer about what is happening and where it stalls.',
        icon: <Workflow size={18} />,
        comingSoon: true,
      },
    ],
  },
]

// The Intelligence cards, keyed by section: which product each one manages. Market and Process
// have no cell yet, so their pages are placeholders (no product to provision).
const INTELLIGENCE_SECTION_PRODUCT: Partial<Record<AdminSectionId, IntelligenceProductKind>> = {
  'organization-intelligence': 'organization',
  'data-intelligence': 'data',
}
const INTELLIGENCE_SECTION_IDS: readonly AdminSectionId[] = [
  'organization-intelligence',
  'data-intelligence',
  'market-intelligence',
  'process-intelligence',
]

const ADMIN_SECTIONS = ADMIN_GROUPS.flatMap((g) => g.sections)

export function isAdminSectionId(value: string): value is AdminSectionId {
  return ADMIN_SECTIONS.some((s) => s.id === value && !s.portal)
}

// Swatch background per banner color, matching AnnouncementBanner's accent styles.
const BANNER_SWATCH: Record<BannerColor, string> = {
  neutral: 'var(--color-kumo-tint)',
  info: 'var(--color-kumo-info)',
  success: 'var(--color-kumo-success)',
  warning: 'var(--color-kumo-warning)',
  danger: 'var(--color-kumo-danger)',
  brand: 'var(--color-accent-100)',
}

export default function AdminPage({ section }: { section?: AdminSectionId }) {
  const { authenticatedApi, isAdmin } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  // Intelligence lives in the central directory; the hub hides its cards when central login
  // isn't configured. Teammates and billing are on the portals; their cards need the links.
  const serverConfig = useServerConfig()
  const centralLoginUrl = serverConfig?.centralLoginUrl
  const managed = Boolean(serverConfig?.settingsManagedCentrally)
  const centralSettingsUrl = portalLink(serverConfig, 'admin', CENTRAL_SETTINGS_PATH)
  const sectionMeta = section ? ADMIN_SECTIONS.find((s) => s.id === section) : undefined
  useDocumentTitle(sectionMeta ? `${sectionMeta.title} · Admin` : 'Admin')

  // The admin capability (minted once via getAdminApi; null until loaded / for non-admins). Wrapped
  // in an object so useState doesn't treat the (callable) RPC stub as a state updater function.
  const [admin, setAdmin] = useState<{ api: RpcStub<AdminApi> } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  // System-prompt instructions: last-saved value + current editor draft.
  const [savedInstructions, setSavedInstructions] = useState('')
  const [instructionsDraft, setInstructionsDraft] = useState('')
  const [savingInstructions, setSavingInstructions] = useState(false)

  // Organization profile: same saved/draft pattern.
  const [savedOrgProfile, setSavedOrgProfile] = useState('')
  const [orgProfileDraft, setOrgProfileDraft] = useState('')
  const [savingOrgProfile, setSavingOrgProfile] = useState(false)

  // Top-bar notice: last-saved value + current editor draft.
  const [savedAnnouncement, setSavedAnnouncement] = useState('')
  const [announcementDraft, setAnnouncementDraft] = useState('')
  const [savingAnnouncement, setSavingAnnouncement] = useState(false)

  // Full-width banner: last-saved value + current editor draft (text + accent color).
  const [savedBanner, setSavedBanner] = useState<{ text: string; color: BannerColor }>({ text: '', color: DEFAULT_BANNER_COLOR })
  const [bannerTextDraft, setBannerTextDraft] = useState('')
  const [bannerColorDraft, setBannerColorDraft] = useState<BannerColor>(DEFAULT_BANNER_COLOR)
  const [savingBanner, setSavingBanner] = useState(false)

  // Accent (brand) color: '' means the default theme. Live-previewed while editing.
  const [savedAccent, setSavedAccent] = useState('')
  const [accentDraft, setAccentDraft] = useState('')
  const [savingAccent, setSavingAccent] = useState(false)

  // Site name (shown next to the top-bar logo): last-saved value + current editor draft.
  const [savedSiteName, setSavedSiteName] = useState('')
  const [siteNameDraft, setSiteNameDraft] = useState('')
  const [savingSiteName, setSavingSiteName] = useState(false)

  // Current custom logo URL. Uploads are normalized to PNG before crossing the RPC boundary.
  const [siteLogoUrl, setSiteLogoUrl] = useState<string | null>(null)
  const [savingSiteLogo, setSavingSiteLogo] = useState(false)
  const siteLogoInputRef = useRef<HTMLInputElement>(null)

  // Whether new account signups are allowed.
  const [signupsEnabled, setSignupsEnabled] = useState(true)
  const [savingSignups, setSavingSignups] = useState(false)

  // Gatekeeper resource config; per-connector controls live on /admin/connectors/$vendorId.
  const [resourceVendors, setResourceVendors] = useState<AdminResourceVendor[]>([])

  // Promoted output formats, in menu order (see AdminFormatsPanel).
  const [formats, setFormats] = useState<AdminFormat[]>([])

  // Deployment agent skills with enabled state (see AdminSkillsPanel).
  const [skills, setSkills] = useState<AdminSkill[]>([])

  // Platform AI Gateway model catalog with enabled state, or null outside gateway mode
  // (AdminProvidersPanel then shows the BYOK provider management UI instead).
  const [curatedModels, setCuratedModels] = useState<AdminModel[] | null>(null)

  // Messaging channels (see AdminChannelsPanel); null when no channels worker is bound.
  const [channels, setChannels] = useState<ChannelsDescription | null>(null)

  // Populate all editor state from a freshly-fetched settings view.
  // Settings are re-fetched whenever the API session reconnects, which can happen mid-edit. A draft
  // the admin has changed since the last load is kept; an untouched one follows the server.
  const lastSettingsRef = useRef<Awaited<ReturnType<RpcStub<AdminApi>['getSettings']>> | null>(null)
  const applySettings = (view: Awaited<ReturnType<RpcStub<AdminApi>['getSettings']>>) => {
    const prev = lastSettingsRef.current
    lastSettingsRef.current = view
    const draftOf = <T,>(prevSaved: T | undefined, next: T) => (draft: T): T =>
      prev && draft !== prevSaved ? draft : next
    setSignupsEnabled(view.signupsEnabled)
    setSavedSiteName(view.siteName)
    setSiteNameDraft(draftOf(prev?.siteName, view.siteName))
    setSiteLogoUrl(view.siteLogo?.url ?? null)
    setResourceVendors(view.resourceVendors)
    setSavedInstructions(view.instanceInstructions)
    setInstructionsDraft(draftOf(prev?.instanceInstructions, view.instanceInstructions))
    setSavedOrgProfile(view.organizationProfile)
    setOrgProfileDraft(draftOf(prev?.organizationProfile, view.organizationProfile))
    setSavedAnnouncement(view.announcement)
    setAnnouncementDraft(draftOf(prev?.announcement, view.announcement))
    setSavedBanner(view.banner)
    setBannerTextDraft(draftOf(prev?.banner.text, view.banner.text))
    setBannerColorDraft(draftOf(prev?.banner.color, view.banner.color))
    setSavedAccent(view.accentColor)
    setAccentDraft(draftOf(prev?.accentColor, view.accentColor))
    setFormats(view.formats)
    setSkills(view.skills)
    setCuratedModels(view.models)
    setChannels(view.channels)
  }

  // Mint the admin capability once (the access check happens server-side) and load settings.
  useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    let cancelled = false
    let stub: RpcStub<AdminApi> | null = null
    ;(async () => {
      try {
        const api = await authenticatedApi.getAdminApi()
        if (cancelled) {
          api?.[Symbol.dispose]?.()
          return
        }
        if (!api) {
          setLoadError(true)
          return
        }
        stub = api
        setAdmin({ api })
        applySettings(await api.getSettings())
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load admin settings:', err)
          setLoadError(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      stub?.[Symbol.dispose]?.()
    }
  }, [isAdmin, authenticatedApi])

  // Live-preview the draft accent color across the whole app while the admin page is open. On leave
  // (or before each change) revert to the last-saved value so an unsaved preview doesn't stick.
  useEffect(() => {
    applyAccentColor(accentDraft)
    return () => { applyAccentColor(savedAccent) }
  }, [accentDraft, savedAccent])

  const handleSaveAnnouncement = async () => {
    if (!admin) return
    setSavingAnnouncement(true)
    try {
      await admin.api.setAnnouncement(announcementDraft)
      setSavedAnnouncement(announcementDraft)
      toasts.add({ title: 'Announcement saved', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save announcement'
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingAnnouncement(false)
    }
  }

  const bannerDirty =
    bannerTextDraft !== savedBanner.text || bannerColorDraft !== savedBanner.color

  const handleSaveBanner = async () => {
    if (!admin) return
    setSavingBanner(true)
    try {
      await admin.api.setBanner(bannerTextDraft, bannerColorDraft)
      setSavedBanner({ text: bannerTextDraft, color: bannerColorDraft })
      toasts.add({ title: 'Banner saved', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save banner'
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingBanner(false)
    }
  }

  const accentDirty = accentDraft !== savedAccent

  const handleSaveAccent = async () => {
    if (!admin) return
    setSavingAccent(true)
    try {
      await admin.api.setAccentColor(accentDraft)
      setSavedAccent(accentDraft)
      toasts.add({ title: 'Accent color saved', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save accent color'
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingAccent(false)
    }
  }

  const handleSignupsToggle = async (enabled: boolean) => {
    if (!admin) return
    setSavingSignups(true)
    setSignupsEnabled(enabled) // optimistic
    try {
      await admin.api.setSignupsEnabled(enabled)
    } catch (err) {
      setSignupsEnabled(!enabled) // revert
      const message = err instanceof Error ? err.message : 'Update failed'
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingSignups(false)
    }
  }

  const handleSaveSiteName = async () => {
    if (!admin) return
    setSavingSiteName(true)
    try {
      await admin.api.setSiteName(siteNameDraft)
      setSavedSiteName(siteNameDraft)
      toasts.add({ title: 'Site name saved', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save site name'
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingSiteName(false)
    }
  }

  const handleSiteLogoChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !admin) return

    setSavingSiteLogo(true)
    try {
      const data = await prepareSiteLogo(file)
      const logo = await admin.api.setSiteLogo(data)
      setSiteLogoUrl(logo ? cacheBustSiteLogoUrl(logo.url) : null)
      toasts.add({ title: 'Logo saved', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save logo'
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingSiteLogo(false)
    }
  }

  const handleRemoveSiteLogo = async () => {
    if (!admin) return
    setSavingSiteLogo(true)
    try {
      await admin.api.setSiteLogo(null)
      setSiteLogoUrl(null)
      toasts.add({ title: 'Default logo restored', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove logo'
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingSiteLogo(false)
    }
  }

  const handleSaveInstructions = async () => {
    if (!admin) return
    setSavingInstructions(true)
    try {
      await admin.api.setInstanceInstructions(instructionsDraft)
      setSavedInstructions(instructionsDraft)
      toasts.add({ title: 'System prompt instructions saved', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save instructions'
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingInstructions(false)
    }
  }

  const handleSaveOrgProfile = async () => {
    if (!admin) return
    setSavingOrgProfile(true)
    try {
      await admin.api.setOrganizationProfile(orgProfileDraft)
      setSavedOrgProfile(orgProfileDraft)
      toasts.add({ title: 'Organization profile saved', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save organization profile'
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingOrgProfile(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 text-center">
        <ShieldAlert size={32} className="mx-auto text-kumo-subtle mb-3" />
        <p className="text-sm text-kumo-default">You don't have access to this page.</p>
      </div>
    )
  }

  // The hub is a static directory of cards; it renders instantly without waiting on settings.
  if (!section || !sectionMeta) {
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-8">
        <div>
          <h1 className="text-2xl font-semibold text-kumo-default">Admin</h1>
          <p className="text-sm text-kumo-subtle mt-1">
            Deployment-wide settings. Changes apply to all users on their next connection.
          </p>
        </div>

        <div className="mt-8 flex flex-col gap-9">
          {ADMIN_GROUPS.map((group) => ({
            ...group,
            // Intelligence lives in the central directory and portal cards need their portal;
            // without them there is nothing behind a card, so it (and an emptied group) is hidden.
            // Centrally managed settings swap their cards for the one portal card.
            sections: group.sections.filter((s) =>
              (s.portal ? Boolean(portalLink(serverConfig, s.portal.portal, s.portal.path))
                : !INTELLIGENCE_SECTION_IDS.includes(s.id as AdminSectionId) || Boolean(centralLoginUrl))
              && (!s.central || (s.portal ? managed : !managed))
              && !(s.localSignInOnly && centralLoginUrl)),
          })).filter((group) => group.sections.length > 0).map((group) => (
            <section key={group.label} className="flex flex-col gap-3">
              <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
                {group.label}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {group.sections.map((s) => {
                  const cardClass = 'group flex items-start gap-4 rounded-xl border border-kumo-line bg-kumo-elevated p-5 transition-colors hover:bg-kumo-tint'
                  const body = (
                    <>
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-kumo-tint text-kumo-default transition-colors group-hover:bg-kumo-fill">
                        {s.icon}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.25px] text-kumo-strong">
                          {s.title}
                          {s.portal && <ArrowUpRight size={14} className="text-kumo-subtle" aria-hidden />}
                          {s.comingSoon && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-kumo-tint text-kumo-subtle border border-kumo-line">
                              Coming later
                            </span>
                          )}
                        </span>
                        <span className="mt-1 block text-[13px] leading-[18px] tracking-[-0.2px] text-kumo-subtle">
                          {s.blurb}
                        </span>
                      </span>
                    </>
                  )
                  return s.portal ? (
                    <a key={s.id} href={portalLink(serverConfig, s.portal.portal, s.portal.path)} className={cardClass}>
                      {body}
                    </a>
                  ) : (
                    <Link key={s.id} to="/admin/$section" params={{ section: s.id as AdminSectionId }} className={cardClass}>
                      {body}
                    </Link>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    )
  }

  // A bookmark or old link onto a page the admin portal now owns.
  if (managed && sectionMeta.central) {
    const portalPageUrl = INTELLIGENCE_SECTION_IDS.includes(sectionMeta.id as AdminSectionId)
      ? portalLink(serverConfig, 'admin', '/products')
      : sectionMeta.id === 'channels' ? portalLink(serverConfig, 'admin', '/channels')
      : centralSettingsUrl
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-16 text-center">
        <p className="text-sm text-kumo-default">{sectionMeta.title} is now managed on the admin portal.</p>
        {portalPageUrl && (
          <a href={portalPageUrl} className="text-kumo-brand mt-2 inline-block text-sm underline">
            Open the admin portal
          </a>
        )}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh]">
        <p className="text-kumo-subtle">Loading admin settings...</p>
      </div>
    )
  }

  if (loadError || !admin) {
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-16 text-center">
        <p className="text-sm text-kumo-danger">Something went wrong loading admin settings.</p>
        <button onClick={() => window.location.reload()} className="text-kumo-brand mt-2 text-sm underline">
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className={`mx-auto w-full ${section === 'connectors' ? 'max-w-[1240px]' : 'max-w-[1040px]'} px-4 sm:px-8 py-8 space-y-6`}>
      <div>
        <Link
          to="/admin"
          className="inline-flex items-center gap-1.5 text-[13px] font-medium tracking-[-0.25px] text-kumo-subtle transition-colors hover:text-kumo-default"
        >
          <ArrowLeft size={14} />
          Admin
        </Link>
        <h1 className="mt-3 text-2xl font-semibold text-kumo-default">{sectionMeta.title}</h1>
        <p className="text-sm text-kumo-subtle mt-1 max-w-2xl">{sectionMeta.description}</p>
      </div>

      {/* Standard output formats */}
      {section === 'formats' && admin && (
        <AdminFormatsPanel
          admin={admin.api}
          formats={formats}
          onChanged={async () => { setFormats((await admin.api.getSettings()).formats) }}
        />
      )}

      {/* Agent skills */}
      {section === 'skills' && admin && (
        <AdminSkillsPanel
          admin={admin.api}
          skills={skills}
          onChanged={async () => { setSkills((await admin.api.getSettings()).skills) }}
        />
      )}

      {/* Messaging channels */}
      {section === 'channels' && <AdminChannelsPanel channels={channels} />}

      {/* Sign-ups */}
      {section === 'access' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <div className="flex items-center gap-4">
            <div className="w-9 h-9 rounded-lg flex-shrink-0 flex items-center justify-center bg-kumo-tint">
              <UserPlus size={18} className="text-kumo-subtle" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold text-kumo-strong">Allow new sign-ups</h2>
              <p className="text-sm text-kumo-subtle mt-0.5">
                When off, existing users can still log in but no new accounts can be created.
              </p>
            </div>
            <Switch
              checked={signupsEnabled}
              disabled={savingSignups}
              onCheckedChange={handleSignupsToggle}
            />
          </div>
        </div>
      )}

      {/* Site name */}
      {section === 'brand' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">Site name</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            Shown next to the logo in the top bar. Leave empty to use the default
            (&ldquo;{DEFAULT_SITE_NAME}&rdquo;). Applies on each user&rsquo;s next connection.
          </p>

          <Input
            value={siteNameDraft}
            onChange={(e) => setSiteNameDraft(e.target.value)}
            placeholder={DEFAULT_SITE_NAME}
            maxLength={MAX_SITE_NAME_LENGTH}
          />

          <div className="flex items-center justify-end mt-4 gap-2">
            {siteNameDraft !== savedSiteName && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSiteNameDraft(savedSiteName)}
                disabled={savingSiteName}
              >
                Reset
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveSiteName}
              loading={savingSiteName}
              disabled={siteNameDraft === savedSiteName}
            >
              Save
            </Button>
          </div>
        </div>
      )}

      {/* Site logo */}
      {section === 'brand' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">Logo</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            Shown in the app chrome, sign-in screens, and browser tab. Images are scaled without
            cropping and converted to a static PNG. Square images work best. Applies on each
            user&rsquo;s next connection.
          </p>

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-kumo-line bg-kumo-base p-2">
              <SiteLogo size={40} srcOverride={siteLogoUrl}>
                <Hexagon size={32} strokeWidth={2.5} className="text-kumo-brand" />
              </SiteLogo>
            </div>
            <input
              ref={siteLogoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              disabled={savingSiteLogo}
              onChange={handleSiteLogoChange}
            />
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => siteLogoInputRef.current?.click()}
                loading={savingSiteLogo}
                disabled={savingSiteLogo}
              >
                {siteLogoUrl ? 'Change logo' : 'Upload logo'}
              </Button>
              {siteLogoUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRemoveSiteLogo}
                  disabled={savingSiteLogo}
                >
                  Restore default
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Theme / accent color */}
      {section === 'brand' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">Theme</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            Accent color used for buttons, links, and highlights. Changes preview live here; click
            Save to apply for everyone (on their next connection). Backgrounds keep the default
            warm theme.
          </p>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            {ACCENT_PRESETS.map((preset) => {
              const selected = accentDraft === preset.value
              const swatch = preset.value || DEFAULT_ACCENT_COLOR
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setAccentDraft(preset.value)}
                  className={`flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                    selected
                      ? 'border-kumo-default text-kumo-default bg-kumo-tint'
                      : 'border-kumo-line text-kumo-subtle hover:bg-kumo-tint'
                  }`}
                >
                  <span
                    className="w-4 h-4 rounded-full border border-kumo-line"
                    style={{ background: swatch }}
                  />
                  {preset.label}
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-kumo-default cursor-pointer">
              <input
                type="color"
                value={accentDraft || DEFAULT_ACCENT_COLOR}
                onChange={(e) => setAccentDraft(e.target.value)}
                className="w-9 h-9 rounded-md border border-kumo-line bg-transparent cursor-pointer p-0.5"
              />
              Custom
            </label>
            <span className="text-xs font-mono text-kumo-subtle">
              {accentDraft || `${DEFAULT_ACCENT_COLOR} (default)`}
            </span>
            <div className="flex-1" />
            {accentDirty && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAccentDraft(savedAccent)}
                disabled={savingAccent}
              >
                Reset
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveAccent}
              loading={savingAccent}
              disabled={!accentDirty}
            >
              Save
            </Button>
          </div>
        </div>
      )}

      {/* Full-width banner */}
      {section === 'announcements' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">Banner</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            A dismissible bar across the very top of the app (logged in or not). Markdown is
            supported, so you can include links. Leave empty to hide it. Applies on each
            user&rsquo;s next connection.
          </p>

          <Textarea
            className="w-full"
            value={bannerTextDraft}
            onValueChange={setBannerTextDraft}
            rows={1}
            placeholder={'e.g. \uD83C\uDF89 New: templates now support imports \u2014 [learn more](https://example.com).'}
            maxLength={MAX_ANNOUNCEMENT_LENGTH}
            error={
              bannerTextDraft.length > MAX_ANNOUNCEMENT_LENGTH
                ? `Too long by ${bannerTextDraft.length - MAX_ANNOUNCEMENT_LENGTH} characters`
                : undefined
            }
          />

          <div className="mt-4 flex items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium text-kumo-subtle mb-2">Type</p>
              <div className="flex flex-wrap items-center gap-2">
                {BANNER_COLORS.map((c) => {
                  const selected = bannerColorDraft === c
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setBannerColorDraft(c)}
                      className={`flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                        selected
                          ? 'border-kumo-default text-kumo-default bg-kumo-tint'
                          : 'border-kumo-line text-kumo-subtle hover:bg-kumo-tint'
                      }`}
                    >
                      <span
                        className="w-4 h-4 rounded-full border border-kumo-line"
                        style={{ background: BANNER_SWATCH[c] }}
                      />
                      {c.charAt(0).toUpperCase() + c.slice(1)}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {bannerDirty && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setBannerTextDraft(savedBanner.text)
                    setBannerColorDraft(savedBanner.color)
                  }}
                  disabled={savingBanner}
                >
                  Reset
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveBanner}
                loading={savingBanner}
                disabled={!bannerDirty || bannerTextDraft.length > MAX_ANNOUNCEMENT_LENGTH}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Top-bar notice */}
      {section === 'announcements' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">Top-bar notice</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            Shown centered in the top navigation bar. Markdown is supported, so you can include
            links. Keep it short — it renders on a single line. On the free plan, an upgrade
            notice shows here until you set your own. Applies on each user&rsquo;s next connection.
          </p>

          <Textarea
            className="w-full"
            value={announcementDraft}
            onValueChange={setAnnouncementDraft}
            rows={1}
            placeholder={'e.g. Heads up: scheduled maintenance Saturday \u2014 see [status](https://status.example.com).'}
            maxLength={MAX_ANNOUNCEMENT_LENGTH}
            error={
              announcementDraft.length > MAX_ANNOUNCEMENT_LENGTH
                ? `Too long by ${announcementDraft.length - MAX_ANNOUNCEMENT_LENGTH} characters`
                : undefined
            }
          />

          <div className="flex items-center justify-between mt-3">
            <span className="text-xs text-kumo-subtle">
              {announcementDraft.length.toLocaleString()} / {MAX_ANNOUNCEMENT_LENGTH.toLocaleString()} characters
            </span>
            <div className="flex items-center gap-2">
              {announcementDraft !== savedAnnouncement && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAnnouncementDraft(savedAnnouncement)}
                  disabled={savingAnnouncement}
                >
                  Reset
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveAnnouncement}
                loading={savingAnnouncement}
                disabled={
                  announcementDraft === savedAnnouncement ||
                  announcementDraft.length > MAX_ANNOUNCEMENT_LENGTH
                }
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Agent system prompt additions */}
      {section === 'instructions' && (
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <Textarea
          className="w-full"
          value={instructionsDraft}
          onValueChange={setInstructionsDraft}
          rows={6}
          placeholder={'e.g. ACME Corp is a logistics company that helps small businesses ship\ninternationally. Our team builds internal tools and dashboards to track shipments.'}
          maxLength={MAX_INSTANCE_INSTRUCTIONS_LENGTH}
          error={
            instructionsDraft.length > MAX_INSTANCE_INSTRUCTIONS_LENGTH
              ? `Too long by ${instructionsDraft.length - MAX_INSTANCE_INSTRUCTIONS_LENGTH} characters`
              : undefined
          }
        />

        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-kumo-subtle">
            {instructionsDraft.length.toLocaleString()} / {MAX_INSTANCE_INSTRUCTIONS_LENGTH.toLocaleString()} characters
          </span>
          <div className="flex items-center gap-2">
            {instructionsDraft !== savedInstructions && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setInstructionsDraft(savedInstructions)}
                disabled={savingInstructions}
              >
                Reset
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveInstructions}
              loading={savingInstructions}
              disabled={
                instructionsDraft === savedInstructions ||
                instructionsDraft.length > MAX_INSTANCE_INSTRUCTIONS_LENGTH
              }
            >
              Save
            </Button>
          </div>
        </div>
      </div>
      )}

      {/* Organization profile */}
      {section === 'organization' && (
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <Textarea
          className="w-full"
          value={orgProfileDraft}
          onValueChange={setOrgProfileDraft}
          rows={6}
          placeholder={'e.g. Tyms is an accounting platform for African SMEs. We call customer\nworkspaces "books". Our fiscal year starts in July.'}
          maxLength={MAX_ORGANIZATION_PROFILE_LENGTH}
          error={
            orgProfileDraft.length > MAX_ORGANIZATION_PROFILE_LENGTH
              ? `Too long by ${orgProfileDraft.length - MAX_ORGANIZATION_PROFILE_LENGTH} characters`
              : undefined
          }
        />

        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-kumo-subtle">
            {orgProfileDraft.length.toLocaleString()} / {MAX_ORGANIZATION_PROFILE_LENGTH.toLocaleString()} characters
          </span>
          <div className="flex items-center gap-2">
            {orgProfileDraft !== savedOrgProfile && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOrgProfileDraft(savedOrgProfile)}
                disabled={savingOrgProfile}
              >
                Reset
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveOrgProfile}
              loading={savingOrgProfile}
              disabled={
                orgProfileDraft === savedOrgProfile ||
                orgProfileDraft.length > MAX_ORGANIZATION_PROFILE_LENGTH
              }
            >
              Save
            </Button>
          </div>
        </div>
      </div>
      )}

      {/* Teammates: full management, proxied to the central team directory. */}

      {/* Intelligence: one page per product. Organization and Data provision here (proxied to
          the control plane); Market and Process are placeholders until their cells exist. */}
      {INTELLIGENCE_SECTION_PRODUCT[section] && admin && (
        <AdminIntelligencePanel admin={admin.api} kind={INTELLIGENCE_SECTION_PRODUCT[section]} />
      )}
      {section === 'market-intelligence' && <AdminIntelligenceComingSoon kind="market" />}
      {section === 'process-intelligence' && <AdminIntelligenceComingSoon kind="process" />}

      {/* Connectors: a category-filtered gallery. Everything per-connector (setup, on/off,
          resource toggles) lives on /admin/connectors/$vendorId. */}
      {section === 'connectors' && <AdminConnectorsGallery vendors={resourceVendors} />}

      {/* AI models */}
      {section === 'providers' && admin && (
        <AdminProvidersPanel
          admin={admin.api}
          models={curatedModels}
          onModelsChanged={async () => { setCuratedModels((await admin.api.getSettings()).models) }}
        />
      )}
    </div>
  )
}
