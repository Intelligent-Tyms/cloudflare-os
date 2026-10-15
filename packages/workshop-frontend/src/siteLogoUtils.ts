let nextCacheBust = 0

export function cacheBustSiteLogoUrl(url: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}v=${Date.now().toString(36)}-${nextCacheBust++}`
}

/** Uses a successfully loaded custom PNG as the favicon. */
export function applySiteFavicon(logoUrl: string | undefined): () => void {
  const favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
  if (!favicon) return () => {}

  const controller = new AbortController()
  let objectUrl: string | undefined
  let disposed = false
  const useDefault = () => {
    favicon.href = '/favicon.svg'
    favicon.type = 'image/svg+xml'
  }
  useDefault()
  if (!logoUrl) return () => {}

  fetch(logoUrl, { cache: 'no-cache', signal: controller.signal })
    .then((response) => {
      if (!response.ok) throw new Error(`Logo request failed with status ${response.status}`)
      return response.blob()
    })
    .then((blob) => {
      if (disposed) return
      objectUrl = URL.createObjectURL(blob)
      favicon.href = objectUrl
      favicon.type = 'image/png'
    })
    .catch(() => {})

  return () => {
    disposed = true
    controller.abort()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}
