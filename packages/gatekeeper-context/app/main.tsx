// Entrypoint for the sandboxed Context Library iframe. All data flows through the host-injected
// ContextApi RPC capability.

import { createRoot } from 'react-dom/client'
import { TooltipProvider, Toasty } from '@cloudflare/kumo'
import { RpcTarget, newMessagePortRpcSession } from 'capnweb'
import type { RpcStub } from 'capnweb'
import type { ContextApi } from '../src/context-types'
import ContextLibraryPage from './ContextLibraryPage'
import { ContextApiProvider, PresentationProvider, setAppLocation, type PresentAck } from './bridge'
import { applyThemeMode, type ResolvedThemeMode } from './theme'
import './styles.css'
import ErrorBoundary from './ErrorBoundary'
import { installErrorReporting, reportIssue } from './error-reporting'

installErrorReporting()

// The capability the iframe exposes back to the host: receivers for theme-mode and location pushes.
class AppIframe extends RpcTarget {
  setThemeMode(mode: ResolvedThemeMode): void {
    applyThemeMode(mode)
  }

  setLocation(location: string | null): void {
    setAppLocation(typeof location === 'string' ? location : null)
  }
}

interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<ContextApi>
  // Grow the iframe to a full-viewport overlay for app-level modals (`true`) or restore it (`false`).
  setPresenting(active: boolean): Promise<PresentAck>
  // Returns the current resolved theme mode and calls back on `receiver` whenever it changes.
  subscribeTheme(receiver: AppIframe): Promise<ResolvedThemeMode>
  // Returns the current in-app location (deep link) and calls back on `receiver` on changes.
  // Absent on older hosts; callers tolerate the missing-method rejection.
  subscribeLocation(receiver: AppIframe): Promise<string | null>
}

function main() {
  const root = document.getElementById('root')
  if (!root) throw new Error('missing #root')

  const { port1, port2 } = new MessageChannel()
  // Opaque-origin iframes can't name their parent origin. The parent accepts this handshake only from
  // this frame + null origin; the message only transfers a private port.
  window.parent.postMessage({ type: 'handshake' }, '*', [port2])
  const iframe = new AppIframe()
  const host = newMessagePortRpcSession<HostCapability>(port1, iframe)
  // The initial mode comes back from the call; later changes arrive via iframe.setThemeMode().
  host.subscribeTheme(iframe).then(applyThemeMode).catch(() => {})
  // Same shape for deep links; older hosts without the method reject, which is fine.
  host.subscribeLocation(iframe).then(setAppLocation).catch(() => {})

  createRoot(root, {
    onUncaughtError: (error) => reportIssue('context.react-root', error, {
      handled: false, severity: 'fatal', captureMechanism: 'react',
    }),
  }).render(
    <ErrorBoundary><ContextApiProvider value={host.ui}>
      <PresentationProvider setPresenting={(active) => host.setPresenting(active)}>
        <TooltipProvider>
          <Toasty>
            <ContextLibraryPage />
          </Toasty>
        </TooltipProvider>
      </PresentationProvider>
    </ContextApiProvider></ErrorBoundary>,
  )
}

main()
