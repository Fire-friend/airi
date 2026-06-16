import type { VoicePackService } from '../../services/domain/voice-packs'
import type { HonoEnv } from '../../types/hono'

import { Hono } from 'hono'

/**
 * User-facing Voice Pack routes.
 *
 * Mounted at `/api/v1/voice-packs`. Only enabled packs are exposed; the route is
 * read-only and does not require an account.
 */
export function createVoicePackRoutes(service: VoicePackService) {
  return new Hono<HonoEnv>()
    .get('/', async (c) => {
      const packs = await service.listEnabled()
      return c.json(packs)
    })
}
