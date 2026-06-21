/**
 * Fetch passthrough.
 *
 * This used to inject the OIDC Bearer token and transparently refresh it on
 * 401. Accounts and auth were removed, so it now just forwards to the global
 * `fetch` with no Authorization header. Kept as a named export so existing
 * call sites (the server RPC client, chat-sync) keep working unchanged.
 */
export async function authedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, { ...init, credentials: 'omit' })
}
