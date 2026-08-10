import { createFileRoute } from '@tanstack/react-router'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from '../ThemeContext'
import type { ThemeMode } from '../theme'
import { useDocumentTitle } from '../useDocumentTitle'

export const Route = createFileRoute('/theme')({
  component: ThemePage,
})

const THEME_OPTIONS: Array<{
  mode: ThemeMode
  label: string
  description: string
  icon: React.ReactNode
}> = [
  {
    mode: 'system',
    label: 'System',
    description: 'Follow your device appearance setting.',
    icon: <Monitor size={16} />,
  },
  {
    mode: 'light',
    label: 'Light',
    description: 'Bright background with dark text.',
    icon: <Sun size={16} />,
  },
  {
    mode: 'dark',
    label: 'Dark',
    description: 'Dimmed background, easier at night.',
    icon: <Moon size={16} />,
  },
]

function ThemePage() {
  useDocumentTitle('Theme')
  const { themeMode, resolvedThemeMode, setThemeMode } = useTheme()

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-6 pb-16 sm:px-10">
      <header className="px-1 pb-2 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Theme</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          Choose how the app looks on this device.
        </p>
      </header>

      <div className="mt-6">
        <div className="divide-y divide-kumo-line overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
          {THEME_OPTIONS.map(({ mode, label, description, icon }) => {
            const selected = themeMode === mode
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setThemeMode(mode)}
                aria-pressed={selected}
                className="flex w-full cursor-pointer items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-kumo-tint"
              >
                <span
                  className={[
                    'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                    selected ? 'bg-kumo-fill text-kumo-brand' : 'bg-kumo-tint text-kumo-subtle',
                  ].join(' ')}
                >
                  {icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium tracking-[-0.25px] text-kumo-default">
                    {label}
                    {mode === 'system' && (
                      <span className="ml-1.5 font-normal text-kumo-inactive">
                        (currently {resolvedThemeMode})
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
                    {description}
                  </span>
                </span>
                {selected && <Check size={16} className="shrink-0 text-kumo-brand" />}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
