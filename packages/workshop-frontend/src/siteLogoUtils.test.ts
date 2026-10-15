// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applySiteFavicon,
  cacheBustSiteLogoUrl,
} from './siteLogoUtils'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('site favicon', () => {
  it('fetches the custom PNG once before assigning a blob favicon', async () => {
    document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg">'
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' })
    const fetchLogo = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(blob),
    } as Response)
    const createUrl = vi.fn<(blob: Blob) => string>().mockReturnValue('blob:favicon')
    const revokeUrl = vi.fn<(url: string) => void>()
    vi.stubGlobal('fetch', fetchLogo)
    vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: revokeUrl })

    const cleanup = applySiteFavicon('/api/site-logo?v=revision')
    const favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')!
    expect(favicon.getAttribute('href')).toBe('/favicon.svg')

    await vi.waitFor(() => expect(favicon.getAttribute('href')).toBe('blob:favicon'))
    expect(favicon.type).toBe('image/png')
    expect(fetchLogo).toHaveBeenCalledOnce()

    cleanup()
    expect(revokeUrl).toHaveBeenCalledWith('blob:favicon')
  })
})

describe('site logo cache busting', () => {
  it('adds a client-only token to canonical URLs', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const first = cacheBustSiteLogoUrl('/api/site-logo')
    const second = cacheBustSiteLogoUrl('/api/site-logo')
    expect(first).toMatch(/^\/api\/site-logo\?v=rs-\d+$/)
    expect(second).not.toBe(first)
  })
})
