import type { Router } from 'vue-router'

/**
 * Install Capacitor deep-link handling.
 *
 * The only deep link this app handled was the OIDC `/auth/callback`. Accounts
 * and login were removed, so there is nothing to handle right now. The hook is
 * kept (taking the router) so future deep links can be wired here without
 * touching call sites.
 */
export function installDeepLinks(_router: Router): void {}
