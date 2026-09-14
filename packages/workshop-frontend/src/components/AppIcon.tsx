// Suite icons for the Tyms-owned app templates (packages/app-templates in the parent repo),
// keyed by blueprint id — the one identifier the README there promises never changes. The
// SVG masters and rasters live in packages/design-system/app-icons; src/app-icons/ holds
// metadata-stripped copies so Vite can inline or hash them. Blueprints not in the map (user
// templates, upstream formats) keep whatever generic glyph the caller renders as `fallback`.

import type { ReactNode } from 'react'
import amlCompliance from '../app-icons/aml-compliance.svg'
import crm from '../app-icons/crm.svg'
import projects from '../app-icons/projects.svg'
import reconciliation from '../app-icons/reconciliation.svg'
import tasks from '../app-icons/tasks.svg'

export type AppIcon = {
  /** Browser-loadable URL for the two-tone SVG (transparent background). */
  src: string
  /** The app's suite colour; tints the tile behind the glyph. */
  color: string
}

const APP_ICONS: Record<string, AppIcon> = {
  'tyms.tasks': { src: tasks, color: '#6342e0' },
  'tyms.crm': { src: crm, color: '#c2540a' },
  'tyms.recon': { src: reconciliation, color: '#0f766e' },
  // The suite has no Services icon yet; Projects is the nearest (engagements, milestones).
  'tyms.services': { src: projects, color: '#6342e0' },
  'tyms.goaml': { src: amlCompliance, color: '#1e40af' },
}

export function appIconFor(blueprintId: string): AppIcon | undefined {
  return APP_ICONS[blueprintId]
}

// The same icons keyed by the `output.id` each template declares (see packages/app-templates
// `output.id`), for outputs, which carry their format but not the blueprint they came from.
const OUTPUT_APP_ICONS: Record<string, AppIcon> = {
  tasks: APP_ICONS['tyms.tasks'],
  crm: APP_ICONS['tyms.crm'],
  recon: APP_ICONS['tyms.recon'],
  services: APP_ICONS['tyms.services'],
  goaml: APP_ICONS['tyms.goaml'],
}

export function appIconForOutput(outputId: string | undefined): AppIcon | undefined {
  return outputId === undefined ? undefined : OUTPUT_APP_ICONS[outputId]
}

// Tile dimensions and the glyph size that suits each, keyed together so they can't drift.
const TILE_SIZES = {
  sm: { box: 'h-8 w-8 rounded-lg', glyph: 'h-[18px] w-[18px]' },
  md: { box: 'h-9 w-9 rounded-lg', glyph: 'h-5 w-5' },
  lg: { box: 'h-12 w-12 rounded-xl', glyph: 'h-7 w-7' },
  // Store-style grid cards: the icon is the card.
  xl: { box: 'h-16 w-16 rounded-2xl', glyph: 'h-9 w-9' },
} as const

/**
 * The tile shown beside a blueprint's or output's title: the suite icon on a soft tint of its
 * colour when it is a Tyms app, otherwise `fallback` (a lucide glyph) on the neutral fill.
 * Pass `blueprintId` for a blueprint, `outputId` (its declared `output.id`) for an output.
 */
export function AppIconTile({
  blueprintId,
  outputId,
  size = 'md',
  fallback,
  className = '',
}: {
  blueprintId?: string
  outputId?: string
  size?: keyof typeof TILE_SIZES
  fallback: ReactNode
  className?: string
}) {
  const { box, glyph } = TILE_SIZES[size]
  const icon = blueprintId !== undefined ? appIconFor(blueprintId) : appIconForOutput(outputId)
  if (!icon) {
    return (
      <div className={`grid ${box} shrink-0 place-items-center bg-kumo-fill text-kumo-subtle ${className}`}>
        {fallback}
      </div>
    )
  }
  return (
    <div
      className={`grid ${box} shrink-0 place-items-center ${className}`}
      style={{ backgroundColor: `${icon.color}14` }}
    >
      <img src={icon.src} alt="" className={glyph} loading="lazy" />
    </div>
  )
}
