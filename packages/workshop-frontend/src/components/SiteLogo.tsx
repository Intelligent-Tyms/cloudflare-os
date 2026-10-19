import { useEffect, useState, type ReactNode } from 'react'
import { useServerConfig } from '../ServerConfigContext'
import JamaaMark from './JamaaMark'

export default function SiteLogo({
  size,
  className,
  srcOverride,
  children,
}: {
  size: number
  className?: string
  srcOverride?: string | null
  children: ReactNode
}) {
  const serverConfig = useServerConfig()
  const configuredUrl = serverConfig?.siteLogo?.url
  // The Jamaa mark is the built-in default; an admin-uploaded logo still wins.
  const src = srcOverride === undefined ? configuredUrl : srcOverride
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [src, serverConfig])

  if (!src) return <JamaaMark size={size} className={`text-kumo-default ${className ?? ''}`} />
  if (failed) return children
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={`object-contain ${className ?? ''}`}
      onError={() => setFailed(true)}
    />
  )
}
