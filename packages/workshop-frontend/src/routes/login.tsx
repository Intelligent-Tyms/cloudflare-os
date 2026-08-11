import { useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Loader } from '@cloudflare/kumo'
import { useRpcStub } from '../RpcContext'
import { useServerConfig } from '../ServerConfigContext'
import { useDocumentTitle } from '../useDocumentTitle'

// Central-login landing: the central sign-in page redirects here with `?handoff=<jwt>`, which we
// redeem for a local session. Without a token this route just bounces to the central sign-in page.
// Post-sign-in destination must be a same-origin path (e.g. "/admin/teammates" from the
// central picker's teammates shortcut) — never a full URL, so the handoff can't redirect
// off-site.
function safeNextPath(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : undefined
}

export const Route = createFileRoute('/login')({
  component: LoginHandoffRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    handoff: typeof search.handoff === 'string' ? search.handoff : undefined,
    prompt: typeof search.prompt === 'string' ? search.prompt : undefined,
    next: safeNextPath(search.next),
  }),
})

function withParam(url: string, param: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${param}`
}

function LoginHandoffRoute() {
  const rpcStub = useRpcStub()
  const serverConfig = useServerConfig()
  const { handoff, prompt, next } = Route.useSearch()
  const [status, setStatus] = useState<'working' | 'signups-disabled' | 'failed'>('working')
  // Redemption must run exactly once: tokens are single-use, so a StrictMode re-invoke or a
  // dependency change would otherwise burn the token against itself.
  const attempted = useRef(false)
  useDocumentTitle('Signing in')

  const centralLoginUrl = serverConfig?.centralLoginUrl

  useEffect(() => {
    if (!handoff || attempted.current) return
    attempted.current = true
    // Strip the token from the address bar before redeeming so refresh/back doesn't resubmit it.
    window.history.replaceState(null, '', '/login')
    rpcStub.loginWithHandoffToken(handoff).then((token) => {
      if (token === null) {
        setStatus('signups-disabled')
        return
      }
      localStorage.setItem('authToken', token)
      window.location.replace(prompt ? `/?prompt=${encodeURIComponent(prompt)}` : next ?? '/')
    }).catch(() => setStatus('failed'))
  }, [handoff, rpcStub, prompt, next])

  // Arrived without a token (or the token failed): send the visitor to central sign-in once we
  // know its URL. Waits for serverConfig; never fires while a redemption is in flight.
  useEffect(() => {
    if (!serverConfig) return
    if (!attempted.current && !handoff) {
      window.location.replace(centralLoginUrl ?? '/')
    } else if (status === 'failed') {
      if (centralLoginUrl) window.location.replace(withParam(centralLoginUrl, 'error=handoff'))
    }
  }, [serverConfig, centralLoginUrl, handoff, status])

  if (status === 'signups-disabled') {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-kumo-base px-4">
        <p className="text-sm text-kumo-danger text-center">
          New sign-ups are currently disabled on this workspace. Ask your administrator for an
          invitation.
        </p>
      </div>
    )
  }

  if (status === 'failed' && serverConfig && !centralLoginUrl) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-kumo-base px-4">
        <p className="text-sm text-kumo-danger text-center">That sign-in link expired.</p>
        <Button variant="secondary" onClick={() => window.location.replace('/')}>Back to sign in</Button>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-kumo-base">
      <Loader size="lg" />
      <p className="text-sm text-kumo-subtle">Signing you in…</p>
    </div>
  )
}
