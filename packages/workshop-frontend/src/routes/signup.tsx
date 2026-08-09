import { createFileRoute } from '@tanstack/react-router'
import { useRpcStub } from '../RpcContext'
import { CF_ACCESS_MODE } from '../useAuth'
import { Navigate } from '@tanstack/react-router'
import { useServerConfig } from '../ServerConfigContext'
import SignupPage from '../SignupPage'

export const Route = createFileRoute('/signup')({
  component: SignupRoute,
})

function SignupRoute() {
  const rpcStub = useRpcStub()
  const serverConfig = useServerConfig()
  // Signup is not available in CF Access mode — identity is managed by Access.
  if (CF_ACCESS_MODE) {
    return <Navigate to="/" replace />
  }
  // With central login, accounts are created on the central identity service.
  if (serverConfig?.centralLoginUrl) {
    window.location.replace(serverConfig.centralLoginUrl)
    return null
  }
  return <SignupPage rpcStub={rpcStub} />
}
