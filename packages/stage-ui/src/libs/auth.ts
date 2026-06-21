/**
 * Auth library — reduced to inert stubs.
 *
 * Accounts, OIDC sign-in, better-auth, and session handling were removed: the
 * app runs locally with no login and talks only to user-configured model
 * providers. These exports remain so the few call sites that still reference
 * them (e.g. legacy official-provider helpers) keep compiling; none of them
 * perform authentication or attach tokens anymore.
 */

export type OAuthProvider = 'google' | 'github'

/**
 * Always returns null — there is no auth token to attach.
 */
export function getAuthToken(): string | null {
  return null
}

/** No-op: there is no session to initialize. */
export async function initializeAuth(): Promise<void> {}

/** No-op: there is no session to fetch. Returns false (never authenticated). */
export async function fetchSession(): Promise<boolean> {
  return false
}

/** No-op: there is no login to trigger. */
export async function triggerSignIn(): Promise<void> {}

/** No-op: there is no session to sign out of. */
export async function signOut(): Promise<void> {}
