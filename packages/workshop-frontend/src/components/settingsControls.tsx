// Shared, on-language control classes for the settings pages (Profile, Assistant). They match
// the rest of the app: Workspaces/Blueprints headers, the gatekeepers toolbar, the command
// palette. Kept here so both pages read as part of the system rather than stacks of default
// Kumo cards.
export const PRIMARY_BTN =
  'press inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-[13px] font-medium tracking-[-0.25px] text-white transition-colors hover:bg-kumo-brand-hover disabled:cursor-not-allowed disabled:opacity-60'
export const ICON_BTN =
  'press grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default'
export const INPUT =
  'h-10 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-[16px] tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15 sm:h-9 sm:text-[14px]'
export const TEXTAREA =
  'w-full resize-y rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-[14px] leading-[20px] tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15'
export const GHOST_BTN =
  'press inline-flex h-9 cursor-pointer items-center justify-center rounded-lg px-3 text-[13px] font-medium tracking-[-0.25px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default'

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
      {children}
    </h2>
  )
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[12px] font-medium tracking-[-0.1px] text-kumo-subtle">{children}</p>
  )
}
