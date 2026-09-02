import { createContext, useContext } from 'react'
import { ServerConfig, AuthVendorInfo, resolveSiteName } from '@gadgets/workshop-shared/api'

/**
 * Deployment-level configuration fetched once at boot via PublicApi.getServerConfig().
 * `null` while still loading.
 */
export const ServerConfigContext = createContext<ServerConfig | null>(null)
export const ServerConfigErrorContext = createContext(false)

/** Returns the server config, or null while it is still loading. */
export function useServerConfig(): ServerConfig | null {
  return useContext(ServerConfigContext)
}

/** Returns whether the latest deployment-config request failed. */
export function useServerConfigError(): boolean {
  return useContext(ServerConfigErrorContext)
}

/**
 * Convenience: the admin-configured site name, falling back to the default while config is still
 * loading or when the admin hasn't set one.
 */
export function useSiteName(): string {
  return resolveSiteName(useContext(ServerConfigContext)?.siteName)
}

/** Convenience: the gatekeeper vendors offered as sign-in methods (empty until config loads / none). */
export function useAuthVendors(): AuthVendorInfo[] {
  return useContext(ServerConfigContext)?.authVendors ?? []
}

/**
 * Convenience: whether this deployment is a free pool (chat only; see ServerConfig.poolMode).
 * False while config is still loading, so pool-only chrome never flashes on company tenants.
 */
export function usePoolMode(): boolean {
  return useContext(ServerConfigContext)?.poolMode ?? false
}

/**
 * Where a pool member goes to upgrade: the central account's upgrade page, derived from the
 * central login URL (same origin). Null off-pool or before config loads.
 */
export function usePoolUpgradeUrl(): string | null {
  const config = useContext(ServerConfigContext)
  if (!config?.poolMode || !config.centralLoginUrl) return null
  try {
    return new URL('/upgrade', config.centralLoginUrl).toString()
  } catch {
    return null
  }
}

/** Convenience: whether the Cloudflare limits / top-up flow is enabled. */
export function useCloudflareLimitsEnabled(): boolean {
  return useContext(ServerConfigContext)?.cloudflareLimitsEnabled ?? false
}
