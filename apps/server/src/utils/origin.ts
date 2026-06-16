const TRUSTED_EXACT_ORIGINS = [
  'capacitor://localhost', // Capacitor mobile (iOS)
  'ai.moeru.airi-pocket://links', // Android deep link
  'https://airi.moeru.ai', // Production
]

// Private LAN / CGNAT-style dev hosts (for example https://10.x:5273 from
// cap-vite) are intentionally not regex-matched. List them explicitly via
// ADDITIONAL_TRUSTED_ORIGINS.
const TRUSTED_ORIGIN_PATTERNS = [
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/localhost(:\d+)?$/,
  /^https:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/.*\.kwaa\.workers\.dev$/,
]

/**
 * Returns `origin` when it matches built-in trust rules or
 * `additionalTrustedOrigins`.
 */
export function getTrustedOrigin(origin: string, additionalTrustedOrigins: readonly string[] = []): string {
  if (!origin)
    return origin
  if (TRUSTED_EXACT_ORIGINS.includes(origin))
    return origin
  if (additionalTrustedOrigins.includes(origin))
    return origin
  if (TRUSTED_ORIGIN_PATTERNS.some(pattern => pattern.test(origin)))
    return origin
  return ''
}
