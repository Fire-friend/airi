import { describe, expect, it, vi } from 'vitest'

import { buildApp } from './app'

function createTestDeps() {
  const redisSubscriber = {
    on: vi.fn(),
    subscribe: vi.fn(async () => 1),
    unsubscribe: vi.fn(async () => 0),
  }

  const redis = {
    duplicate: vi.fn(() => redisSubscriber),
    ping: vi.fn(async () => 'PONG'),
    publish: vi.fn(async () => 0),
  }

  const deps = {
    db: {
      execute: vi.fn(async () => []),
    } as any,
    characterService: {
      findById: vi.fn(async () => undefined),
    } as any,
    requestLogService: {
      logRequest: vi.fn(async () => undefined),
    } as any,
    voicePackService: {
      listEnabled: vi.fn(async () => []),
      listEnabledForTtsModel: vi.fn(async () => []),
    } as any,
    productEventService: {
      track: vi.fn(async () => undefined),
      countDistinctUsersByFeature: vi.fn(async () => []),
    },
    adminRouterConfigService: {
      current: vi.fn(async () => ({ request: { mode: 'merge', slices: [], defaults: {} }, preview: {}, loadedAt: 'now', missingKeys: [] })),
      apply: vi.fn(async () => ({ applied: [], invalidatedKeys: [], preview: {} })),
    } as any,
    configKV: {
      getOrThrow: vi.fn(async () => 'chat-auto'),
      getOptional: vi.fn(async () => null),
    } as any,
    redis: redis as any,
    env: {
      ADDITIONAL_TRUSTED_ORIGINS: [],
      API_SERVER_URL: 'http://localhost:3000',
      HOST: '127.0.0.1',
      OTEL_SERVICE_NAME: 'server-test',
      PORT: 3000,
    } as any,
    otel: null,
    llmRouter: {
      route: vi.fn(async () => new Response('{}', { status: 200 })),
      routeTts: vi.fn(async () => new Response('audio', { status: 200 })),
      invalidateConfig: vi.fn(),
    } as any,
    envelopeCrypto: {
      encryptKey: vi.fn(),
      decryptKey: vi.fn(),
    } as any,
  }

  return { deps, redis }
}

describe('app thin proxy routes', () => {
  it('serves the API identity without auth metadata', async () => {
    const { deps } = createTestDeps()
    const { app } = await buildApp(deps)

    const res = await app.request('/')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      service: 'airi-api',
      mode: 'unauthenticated-proxy',
    })
  })

  it('checks readiness with database and redis only', async () => {
    const { deps, redis } = createTestDeps()
    const { app } = await buildApp(deps)

    const res = await app.request('/readyz')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      status: 'ready',
      checks: { db: 'ok', redis: 'ok' },
    })
    expect(deps.db.execute).toHaveBeenCalledWith('SELECT 1')
    expect(redis.ping).toHaveBeenCalledTimes(1)
  })
})
