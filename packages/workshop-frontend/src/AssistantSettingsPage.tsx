import { useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from './AuthContext'
import { useState, useEffect } from 'react'
import { AssistantProfile, MAX_ASSISTANT_FIELD_LENGTH, MAX_ASSISTANT_NAME_LENGTH, MAX_ASSISTANT_PERSONA_LENGTH } from '@gadgets/workshop-shared/api'
import { useAssistantProfile } from './AssistantProfileContext'
import { Check } from 'lucide-react'
import { PRIMARY_BTN, GHOST_BTN, INPUT, TEXTAREA, FieldLabel } from './components/settingsControls'
import { useDocumentTitle } from './useDocumentTitle'

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

export default function AssistantSettingsPage() {
  useDocumentTitle('Assistant')

  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()

  // Assistant profile: last-saved value + current editor draft (the admin instructions editor's
  // saved/draft pattern). Not rendered until the stored profile has loaded.
  const { refresh: refreshAssistantProfile } = useAssistantProfile()
  const [savedProfile, setSavedProfile] = useState<AssistantProfile>(EMPTY_ASSISTANT_PROFILE)
  const [profileDraft, setProfileDraft] = useState<AssistantProfile>(EMPTY_ASSISTANT_PROFILE)
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)

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
      if (!cancelled) toasts.add({ title: 'Failed to load assistant settings', variant: 'error' })
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

  if (!profileLoaded) {
    return (
      <div className="flex min-h-[60vh] flex-1 items-center justify-center">
        <p className="text-[13px] tracking-[-0.25px] text-kumo-subtle">Loading assistant settings…</p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-6 pb-16 sm:px-10">
      <header className="px-1 pb-2 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Assistant</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          Give your assistant a name and a voice, and tell it about your work. It uses this in
          every chat to tailor how it communicates and what it prioritizes.
        </p>
      </header>

      <div className="mt-6 flex flex-col gap-9">
        <section className="flex flex-col gap-3">
          <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
            <div className="flex flex-col gap-4">
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
      </div>
    </div>
  )
}
