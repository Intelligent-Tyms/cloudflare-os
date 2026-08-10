import { useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from './AuthContext'
import { useState, useEffect, useRef } from 'react'
import { AiChatAuthorInfo, AssistantProfile, MAX_ASSISTANT_FIELD_LENGTH, MAX_ASSISTANT_NAME_LENGTH, MAX_ASSISTANT_PERSONA_LENGTH } from '@gadgets/workshop-shared/api'
import { useAssistantProfile } from './AssistantProfileContext'
import { hashPassword } from './passwordHash'
import { CF_ACCESS_MODE } from './useAuth'
import { User, Pencil, Check, X, Lock, Camera, Copy, Eye, EyeOff } from 'lucide-react'
import { useAvatar, invalidateAvatarCache } from './useAvatar'
import { compressAvatar, avatarBlobUrl } from './avatarUtils'
import UsageSettings from './components/billing/UsageSettings'
import { useDocumentTitle } from './useDocumentTitle'

// Shared, on-language control classes (match the rest of the app: Workspaces/Blueprints headers,
// the gatekeepers toolbar, the command palette). Kept here so the profile page reads as part of the
// system rather than a stack of default Kumo cards.
const PRIMARY_BTN =
  'press inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-[13px] font-medium tracking-[-0.25px] text-white transition-colors hover:bg-kumo-brand-hover disabled:cursor-not-allowed disabled:opacity-60'
const ICON_BTN =
  'press grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default'
const INPUT =
  'h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-[14px] tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15'
const TEXTAREA =
  'w-full resize-y rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-[14px] leading-[20px] tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15'
const GHOST_BTN =
  'press inline-flex h-9 cursor-pointer items-center justify-center rounded-lg px-3 text-[13px] font-medium tracking-[-0.25px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default'

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
      {children}
    </h2>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[12px] font-medium tracking-[-0.1px] text-kumo-subtle">{children}</p>
  )
}

const EMPTY_ASSISTANT_PROFILE: AssistantProfile = {
  assistantName: '', persona: '', role: '', targets: '', goals: '', timeZone: '',
}

// IANA zones from the browser's own database; empty on engines without supportedValuesOf, in
// which case the time-zone field falls back to a plain input.
const TIME_ZONES: string[] = (() => {
  try { return Intl.supportedValuesOf('timeZone') } catch { return [] }
})()

function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '' } catch { return '' }
}

// One assistant-profile field: label, input or textarea, and a character counter that turns into
// an over-limit error past the budget (the same treatment as the admin instructions editor).
function ProfileField({ label, value, onChange, max, placeholder, multiline, description }: {
  label: string
  value: string
  onChange: (v: string) => void
  max: number
  placeholder?: string
  multiline?: boolean
  description?: string
}) {
  const over = value.length - max
  const control = `mt-1.5 ${multiline ? TEXTAREA : INPUT} ${over > 0 ? 'border-kumo-danger focus:border-kumo-danger' : ''}`
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <FieldLabel>{label}</FieldLabel>
        <span className={`text-[11px] tabular-nums tracking-[-0.1px] ${over > 0 ? 'text-kumo-danger' : 'text-kumo-inactive'}`}>
          {over > 0
            ? `Too long by ${over.toLocaleString()} characters`
            : `${value.length.toLocaleString()} / ${max.toLocaleString()}`}
        </span>
      </div>
      {multiline ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={3} className={control} />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={control} />
      )}
      {description && (
        <p className="mt-1 text-[12px] tracking-[-0.1px] text-kumo-subtle">{description}</p>
      )}
    </div>
  )
}

// On-language password field: same input/focus treatment as the rest of the app, with an inline
// show/hide toggle (replacing Kumo's SensitiveInput, which read as dated against the new look).
function PasswordField({
  label,
  value,
  onChange,
  placeholder,
  description,
  error,
  autoComplete,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  description?: string
  error?: string | null
  autoComplete?: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="relative mt-1.5">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className={`${INPUT} pr-10 ${error ? 'border-kumo-danger focus:border-kumo-danger' : ''}`}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? 'Hide password' : 'Show password'}
          className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-kumo-inactive transition-colors hover:text-kumo-default"
        >
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
      {error ? (
        <p className="mt-1 text-[12px] tracking-[-0.1px] text-kumo-danger">{error}</p>
      ) : description ? (
        <p className="mt-1 text-[12px] tracking-[-0.1px] text-kumo-subtle">{description}</p>
      ) : null}
    </div>
  )
}

export default function SettingsPage() {
  useDocumentTitle('Profile')

  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [userInfo, setUserInfo] = useState<AiChatAuthorInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [isEditingName, setIsEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')

  // Avatar state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [localAvatarPreview, setLocalAvatarPreview] = useState<string | null>(null)

  // Revoke preview blob URL on unmount to prevent memory leak
  useEffect(() => {
    return () => {
      if (localAvatarPreview) URL.revokeObjectURL(localAvatarPreview)
    }
  }, [localAvatarPreview])

  // Assistant profile: last-saved value + current editor draft (the admin instructions editor's
  // saved/draft pattern). Not rendered until the stored profile has loaded.
  const { refresh: refreshAssistantProfile } = useAssistantProfile()
  const [savedProfile, setSavedProfile] = useState<AssistantProfile>(EMPTY_ASSISTANT_PROFILE)
  const [profileDraft, setProfileDraft] = useState<AssistantProfile>(EMPTY_ASSISTANT_PROFILE)
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordLoading, setPasswordLoading] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  // Whether this account has a password (false for OAuth-created accounts). Null while loading.
  const [hasPassword, setHasPassword] = useState<boolean | null>(null)

  const avatarUrl = useAvatar(authenticatedApi, userInfo?.id)

  // Determine whether to show the change-password section.
  useEffect(() => {
    let cancelled = false
    authenticatedApi.hasPasswordLogin()
      .then((v: boolean) => { if (!cancelled) setHasPassword(v) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  // Fetch user info
  useEffect(() => {
    let cancelled = false
    const fetchUserInfo = async () => {
      try {
        const info = await authenticatedApi.whoami()
        if (cancelled) return
        setUserInfo(info)
        setNameInput(info.name)
      } catch (error) {
        console.error('Failed to fetch user info:', error)
        if (!cancelled) toasts.add({ title: 'Failed to load user information', variant: 'error' })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchUserInfo()
    return () => { cancelled = true }
  }, [authenticatedApi])

  // Fetch the assistant profile. On a first visit (nothing saved yet) the draft's time zone is
  // defaulted from the browser, so most users never have to pick it — saving then persists it.
  useEffect(() => {
    let cancelled = false
    authenticatedApi.getAssistantProfile().then((p) => {
      if (cancelled) return
      setSavedProfile(p ?? EMPTY_ASSISTANT_PROFILE)
      setProfileDraft(p ?? { ...EMPTY_ASSISTANT_PROFILE, timeZone: browserTimeZone() })
      setProfileLoaded(true)
    }).catch((err) => {
      console.error('Failed to load assistant profile:', err)
    })
    return () => { cancelled = true }
  }, [authenticatedApi])

  const profileDirty = JSON.stringify(profileDraft) !== JSON.stringify(savedProfile)
  const profileOverLimit =
    profileDraft.assistantName.length > MAX_ASSISTANT_NAME_LENGTH ||
    profileDraft.persona.length > MAX_ASSISTANT_PERSONA_LENGTH ||
    profileDraft.role.length > MAX_ASSISTANT_FIELD_LENGTH ||
    profileDraft.targets.length > MAX_ASSISTANT_FIELD_LENGTH ||
    profileDraft.goals.length > MAX_ASSISTANT_FIELD_LENGTH

  const setProfileField = (patch: Partial<AssistantProfile>) =>
    setProfileDraft((d) => ({ ...d, ...patch }))

  const handleSaveProfile = async () => {
    setSavingProfile(true)
    try {
      await authenticatedApi.setAssistantProfile(profileDraft)
      // Re-read so the editor shows the canonical (trimmed) form the server stored.
      const stored = (await authenticatedApi.getAssistantProfile()) ?? profileDraft
      setSavedProfile(stored)
      setProfileDraft(stored)
      refreshAssistantProfile()
      toasts.add({ title: 'Assistant settings saved', variant: 'success' })
    } catch (err) {
      console.error('Failed to save assistant profile:', err)
      toasts.add({
        title: err instanceof Error ? err.message : 'Failed to save assistant settings',
        variant: 'error',
      })
    } finally {
      setSavingProfile(false)
    }
  }

  const handleSaveName = async () => {
    if (!nameInput.trim()) {
      toasts.add({ title: 'Display name cannot be empty', variant: 'error' })
      return
    }

    try {
      await authenticatedApi.setOwnDisplayName(nameInput.trim())
      setUserInfo(prev => prev ? { ...prev, name: nameInput.trim() } : null)
      setIsEditingName(false)
      toasts.add({ title: 'Display name updated', variant: 'success' })
    } catch (err) {
      console.error('Failed to update display name:', err)
      toasts.add({ title: 'Failed to update display name', variant: 'error' })
    }
  }

  const handleCancelEdit = () => {
    setNameInput(userInfo?.name || '')
    setIsEditingName(false)
  }

  const handleCopyId = async () => {
    if (!userInfo?.id) return
    try {
      await navigator.clipboard.writeText(userInfo.id)
      toasts.add({ title: 'User ID copied', variant: 'success' })
    } catch {
      toasts.add({ title: 'Failed to copy', variant: 'error' })
    }
  }

  const handleAvatarUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toasts.add({ title: 'Please select an image file', variant: 'error' })
      return
    }
    setAvatarUploading(true)
    try {
      const compressed = await compressAvatar(file)
      // Show preview immediately
      if (localAvatarPreview) URL.revokeObjectURL(localAvatarPreview)
      setLocalAvatarPreview(avatarBlobUrl(compressed))
      // Upload
      await authenticatedApi.setAvatar(compressed)
      // Invalidate cache so the hook refetches
      if (userInfo?.id) invalidateAvatarCache(userInfo.id)
      toasts.add({ title: 'Avatar updated', variant: 'success' })
    } catch (err) {
      console.error('Failed to upload avatar:', err)
      setLocalAvatarPreview(null)
      toasts.add({ title: 'Failed to upload avatar', variant: 'error' })
    } finally {
      setAvatarUploading(false)
    }
  }

  const handleChangePassword = async () => {
    if (!userInfo) return
    if (!currentPassword || !newPassword || !confirmPassword) return
    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match')
      return
    }

    setPasswordLoading(true)
    setPasswordError(null)

    try {
      const oldHash = await hashPassword(userInfo.id, currentPassword)
      const newHash = await hashPassword(userInfo.id, newPassword)
      await authenticatedApi.changePassword(oldHash, newHash)
      toasts.add({ title: 'Password changed successfully', variant: 'success' })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to change password'
      setPasswordError(errorMessage)
    } finally {
      setPasswordLoading(false)
    }
  }

  const displayAvatarUrl = localAvatarPreview || avatarUrl

  if (loading) {
    return (
      <div className="flex min-h-[60vh] flex-1 items-center justify-center">
        <p className="text-[13px] tracking-[-0.25px] text-kumo-subtle">Loading profile…</p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-6 pb-16 sm:px-10">
      <header className="px-1 pb-2 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Profile</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          Manage your account, your assistant, and security.
        </p>
      </header>

      <div className="mt-6 flex flex-col gap-9">
        {/* Account */}
        <section className="flex flex-col gap-3">
          <SectionLabel>Account</SectionLabel>
          <div className="divide-y divide-kumo-line overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
            {/* Avatar */}
            <div className="flex items-center gap-4 px-5 py-4">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={avatarUploading}
                className="press group relative flex h-16 w-16 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-kumo-fill disabled:cursor-wait"
              >
                {displayAvatarUrl ? (
                  <img src={displayAvatarUrl} alt="Avatar" className="h-full w-full object-cover" />
                ) : (
                  <User size={28} className="text-kumo-subtle" />
                )}
                <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                  <Camera size={18} className="text-white" />
                </div>
                {avatarUploading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-kumo-base/80">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
                  </div>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleAvatarUpload(file)
                  e.target.value = ''
                }}
              />
              <div className="min-w-0">
                <p className="truncate text-[15px] font-medium tracking-[-0.25px] text-kumo-default">
                  {userInfo?.name}
                </p>
                <p className="mt-0.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
                  Click the avatar to upload a new photo
                </p>
              </div>
            </div>

            {/* Display name */}
            <div className="flex items-end gap-2 px-5 py-4">
              <div className="min-w-0 flex-1">
                <FieldLabel>Display name</FieldLabel>
                {isEditingName ? (
                  <input
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveName()
                      if (e.key === 'Escape') handleCancelEdit()
                    }}
                    placeholder="Enter display name"
                    autoFocus
                    className={`mt-1.5 ${INPUT}`}
                  />
                ) : (
                  <p className="mt-1 text-[14px] tracking-[-0.25px] text-kumo-default">
                    {userInfo?.name}
                  </p>
                )}
              </div>
              {isEditingName ? (
                <>
                  <button
                    type="button"
                    onClick={handleSaveName}
                    disabled={!nameInput.trim()}
                    aria-label="Save display name"
                    className={PRIMARY_BTN}
                  >
                    <Check size={15} strokeWidth={2.5} />
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    aria-label="Cancel"
                    className={ICON_BTN}
                  >
                    <X size={15} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsEditingName(true)}
                  aria-label="Edit display name"
                  className={ICON_BTN}
                >
                  <Pencil size={14} />
                </button>
              )}
            </div>

            {/* User ID */}
            <div className="flex items-center gap-2 px-5 py-4">
              <div className="min-w-0 flex-1">
                <FieldLabel>User ID</FieldLabel>
                <p className="mt-1 truncate font-mono text-[12px] tracking-[-0.1px] text-kumo-subtle">
                  {userInfo?.id}
                </p>
              </div>
              <button
                type="button"
                onClick={handleCopyId}
                aria-label="Copy user ID"
                className={ICON_BTN}
              >
                <Copy size={14} />
              </button>
            </div>
          </div>
        </section>

        {/* Assistant — per-user personalization rendered into the agent's system prompt */}
        {profileLoaded && (
          <section className="flex flex-col gap-3">
            <SectionLabel>Assistant</SectionLabel>
            <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
              <p className="text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
                Give your assistant a name and a voice, and tell it about your work. It uses this
                in every chat to tailor how it communicates and what it prioritizes.
              </p>
              <div className="mt-4 flex flex-col gap-4">
                <ProfileField
                  label="Assistant name"
                  value={profileDraft.assistantName}
                  onChange={(v) => setProfileField({ assistantName: v })}
                  max={MAX_ASSISTANT_NAME_LENGTH}
                  placeholder="e.g. Zuri"
                  description="What your assistant calls itself in chats."
                />
                <ProfileField
                  label="Personality"
                  value={profileDraft.persona}
                  onChange={(v) => setProfileField({ persona: v })}
                  max={MAX_ASSISTANT_PERSONA_LENGTH}
                  multiline
                  placeholder="How should your assistant sound? e.g. Direct and concise, with light humor."
                />
                <ProfileField
                  label="Your role"
                  value={profileDraft.role}
                  onChange={(v) => setProfileField({ role: v })}
                  max={MAX_ASSISTANT_FIELD_LENGTH}
                  placeholder="e.g. Head of Growth at a 12-person fintech"
                />
                <ProfileField
                  label="Targets"
                  value={profileDraft.targets}
                  onChange={(v) => setProfileField({ targets: v })}
                  max={MAX_ASSISTANT_FIELD_LENGTH}
                  multiline
                  placeholder="Concrete things you're working toward right now."
                />
                <ProfileField
                  label="Goals"
                  value={profileDraft.goals}
                  onChange={(v) => setProfileField({ goals: v })}
                  max={MAX_ASSISTANT_FIELD_LENGTH}
                  multiline
                  placeholder="Broader priorities your assistant should keep in mind."
                />
                <div>
                  <FieldLabel>Time zone</FieldLabel>
                  {TIME_ZONES.length > 0 ? (
                    <select
                      value={profileDraft.timeZone}
                      onChange={(e) => setProfileField({ timeZone: e.target.value })}
                      className={`mt-1.5 ${INPUT} cursor-pointer`}
                    >
                      <option value="">Not set</option>
                      {TIME_ZONES.map((tz) => (
                        <option key={tz} value={tz}>{tz}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={profileDraft.timeZone}
                      onChange={(e) => setProfileField({ timeZone: e.target.value })}
                      placeholder="e.g. Africa/Kampala"
                      className={`mt-1.5 ${INPUT}`}
                    />
                  )}
                  <p className="mt-1 text-[12px] tracking-[-0.1px] text-kumo-subtle">
                    Used when your assistant works with dates and times.
                  </p>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleSaveProfile}
                    disabled={savingProfile || !profileDirty || profileOverLimit}
                    className={PRIMARY_BTN}
                  >
                    <Check size={15} strokeWidth={2.5} />
                    {savingProfile ? 'Saving…' : 'Save assistant settings'}
                  </button>
                  {profileDirty && !savingProfile && (
                    <button
                      type="button"
                      onClick={() => setProfileDraft(savedProfile)}
                      className={GHOST_BTN}
                    >
                      Revert
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Usage & billing — only when the Cloudflare limits flow is enabled server-side */}
        <UsageSettings />

        {/* Security — only for password accounts (hidden under CF Access or gatekeeper sign-in) */}
        {!CF_ACCESS_MODE && hasPassword === true && (
          <section className="flex flex-col gap-3">
            <SectionLabel>Security</SectionLabel>
            <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
              <div className="flex max-w-sm flex-col gap-4">
                <PasswordField
                  label="Current password"
                  value={currentPassword}
                  onChange={setCurrentPassword}
                  placeholder="Enter current password"
                  autoComplete="current-password"
                />

                <PasswordField
                  label="New password"
                  value={newPassword}
                  onChange={setNewPassword}
                  placeholder="Enter new password"
                  description="Must be at least 8 characters"
                  autoComplete="new-password"
                />

                <PasswordField
                  label="Confirm new password"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  placeholder="Confirm new password"
                  autoComplete="new-password"
                  error={passwordError}
                />

                <div className="pt-1">
                  <button
                    type="button"
                    onClick={handleChangePassword}
                    disabled={passwordLoading || !currentPassword || !newPassword || !confirmPassword}
                    className={PRIMARY_BTN}
                  >
                    <Lock size={14} strokeWidth={2.5} />
                    {passwordLoading ? 'Changing…' : 'Change password'}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
