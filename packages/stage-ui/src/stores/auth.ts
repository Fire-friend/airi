import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Auth store — reduced to a local-only identity stub.
 *
 * Login, OIDC token exchange, account, and paid "Flux" credits were removed:
 * the app no longer has accounts and talks only to user-configured model
 * providers (remote API keys and local OpenAI-compatible endpoints such as
 * vllm). This store is kept as a thin compatibility surface so the handful of
 * remaining consumers that read `userId` / `isAuthenticated` keep working in a
 * single-user, local context.
 *
 * Use when:
 * - A consumer needs the local user id to key persisted data (characters,
 *   chat sessions), or needs to branch on "is this a cloud/authenticated
 *   session" (which is now always false).
 *
 * Returns:
 * - A store whose `isAuthenticated` is always false, `userId` is always
 *   `'local'`, and whose former OIDC/credits actions are inert no-ops. It
 *   performs no network calls.
 */
export const useAuthStore = defineStore('auth', () => {
  // No accounts anymore — everything runs as a single local user.
  const user = ref<{ id: string, name?: string, image?: string } | null>(null)
  const session = ref<unknown | null>(null)
  const token = ref<string | null>(null)
  const refreshToken = ref<string | null>(null)
  const idToken = ref<string | null>(null)

  const isAuthenticated = computed(() => false)
  // Stable local id used to key locally-persisted data (characters, chat sessions).
  const userId = computed(() => 'local')

  const oidcClientId = ref<string | null>(null)
  const tokenExpiry = ref<number | null>(null)

  // Kept for interface compatibility; no paid credits exist anymore.
  const credits = ref<number>(0)

  // Never triggers a login flow — there is no login.
  const needsLogin = ref(false)

  // --- Lifecycle hooks (kept as no-ops so consumers can still register) ---
  type AuthHook = () => void | Promise<void>
  type TokenRefreshedHook = (accessToken: string) => void | Promise<void>

  // The app is never "authenticated", so these never fire. The unsubscribe
  // return keeps the call shape callers expect.
  function onAuthenticated(_hook: AuthHook) {
    return () => {}
  }
  function onLogout(_hook: AuthHook) {
    return () => {}
  }
  function onTokenRefreshed(_hook: TokenRefreshedHook) {
    return () => {}
  }

  // --- Inert OIDC/credits actions kept for interface compatibility ---
  function clearAllAuthState(): void {
    user.value = null
    session.value = null
    token.value = null
    refreshToken.value = null
    oidcClientId.value = null
    tokenExpiry.value = null
    idToken.value = null
  }
  function scheduleTokenRefresh(_expiresInSeconds: number): void {}
  async function restoreRefreshSchedule(): Promise<void> {}
  async function refreshTokenNow(): Promise<string | null> {
    return null
  }
  async function updateCredits(): Promise<void> {}

  return {
    user,
    userId,
    session,
    token,
    refreshToken,
    idToken,
    isAuthenticated,
    credits,
    updateCredits,
    needsLogin,
    onAuthenticated,
    onLogout,

    // OIDC token refresh (no-ops)
    oidcClientId,
    tokenExpiry,
    scheduleTokenRefresh,
    restoreRefreshSchedule,
    refreshTokenNow,
    clearAllAuthState,
    onTokenRefreshed,
  }
})
