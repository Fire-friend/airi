import type Redis from 'ioredis'

import type { Database } from './libs/db'
import type { Env } from './libs/env'
import type { OtelInstance } from './otel'
import type { AudioSpeechSessionAnalytics, StreamingTtsSource } from './routes/audio-speech-ws/session'
import type { ConfigKVService } from './services/adapters/config-kv'
import type { AdminRouterConfigService } from './services/domain/admin/router-config'
import type { CharacterService } from './services/domain/characters'
import type { LlmRouterService } from './services/domain/llm-router'
import type { ProductEventService } from './services/domain/product-events'
import type { RequestLogService } from './services/domain/request-log'
import type { VoicePackService } from './services/domain/voice-packs'
import type { HonoEnv } from './types/hono'
import type { EnvelopeCrypto } from './utils/envelope-crypto'

import process from 'node:process'

import { initLogger, LoggerFormat, LoggerLevel, setGlobalHookPostLog, useLogger } from '@guiiai/logg'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { httpInstrumentationMiddleware } from '@hono/otel'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { createLoggLogger, injeca, lifecycle } from 'injeca'

import { createDrizzle, migrateDatabase } from './libs/db'
import { parsedEnv } from './libs/env'
import { initializeExternalDependency } from './libs/external-dependency'
import { createRedis } from './libs/redis'
import { emitOtelLog, initOtel } from './otel'
import { registerTtsPoolGauge } from './otel/gauges/tts-pool'
import { createAdminRouterConfigRoutes } from './routes/admin/config/router'
import { createAudioSpeechWsHandlers } from './routes/audio-speech-ws'
import { createV1Routes } from './routes/openai/v1'
import { createVoicePackRoutes } from './routes/voice-packs'
import { createConfigKVService } from './services/adapters/config-kv'
import { createAdminRouterConfigService } from './services/domain/admin/router-config'
import { createCharacterService } from './services/domain/characters'
import { createConcurrencyLedger, createConfigSyncSubscriber, createLlmRouterService } from './services/domain/llm-router'
import { createProductEventService } from './services/domain/product-events'
import { createRequestLogService } from './services/domain/request-log'
import { createVoicePackService } from './services/domain/voice-packs'
import { createEnvelopeCrypto } from './utils/envelope-crypto'
import { ApiError, createInternalError } from './utils/error'
import { nanoid } from './utils/id'
import { getTrustedOrigin } from './utils/origin'

const ANONYMOUS_USER_ID = 'anonymous'

interface AppDeps {
  db: Database
  characterService: CharacterService
  requestLogService: RequestLogService
  voicePackService: VoicePackService
  productEventService: ProductEventService
  adminRouterConfigService: AdminRouterConfigService
  configKV: ConfigKVService
  envelopeCrypto: EnvelopeCrypto
  redis: Redis
  env: Env
  otel: OtelInstance | null
  llmRouter: LlmRouterService
}

function parseTtsSource(raw: string | undefined, fallback: StreamingTtsSource): AudioSpeechSessionAnalytics['source'] {
  switch (raw) {
    case 'chat_auto_tts':
    case 'manual_preview':
    case 'settings_test':
    case 'audio.speech.ws':
      return raw
    default:
      return fallback
  }
}

export async function buildApp(deps: AppDeps) {
  const logger = useLogger('app').useGlobalConfig()

  const app = new Hono<HonoEnv>()
    .use('*', async (c, next) => {
      await next()

      c.res.headers.set('Cache-Control', 'no-store, no-cache, private, max-age=0')
      c.res.headers.set('Pragma', 'no-cache')
      c.res.headers.set('Expires', '0')
    })
    .use(
      '/api/*',
      cors({
        origin: origin => getTrustedOrigin(origin, deps.env.ADDITIONAL_TRUSTED_ORIGINS),
        credentials: false,
      }),
    )
    .use(honoLogger())

  if (deps.otel) {
    const otelMw = httpInstrumentationMiddleware({
      serviceName: deps.env.OTEL_SERVICE_NAME,
      serviceVersion: process.env.npm_package_version || '0.0.0',
    })
    app.use('*', async (c, next) => {
      if (c.req.path === '/livez' || c.req.path === '/readyz')
        return next()
      return otelMw(c, next)
    })
  }

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  const audioSpeechWsSetup = createAudioSpeechWsHandlers({
    configKV: deps.configKV,
    envelopeCrypto: deps.envelopeCrypto,
    requestLogService: deps.requestLogService,
    productEventService: deps.productEventService,
  })
  app.get('/api/v1/audio/speech/ws', upgradeWebSocket((c) => {
    return audioSpeechWsSetup(ANONYMOUS_USER_ID, {
      trigger: c.req.query('tts_trigger') === 'auto' ? 'auto' : 'manual',
      source: parseTtsSource(c.req.query('tts_source'), 'audio.speech.ws'),
    })
  }))

  createConfigSyncSubscriber({
    redis: deps.redis,
    llmRouter: deps.llmRouter,
    gatewayMetrics: deps.otel?.gateway ?? null,
    instanceId: deps.env.OTEL_SERVICE_NAME || nanoid(),
    logger: useLogger('config-sync').useGlobalConfig(),
  })

  const v1Routes = createV1Routes({
    characterService: deps.characterService,
    configKV: deps.configKV,
    requestLogService: deps.requestLogService,
    productEventService: deps.productEventService,
    llmRouter: deps.llmRouter,
    voicePackService: deps.voicePackService,
    genAi: deps.otel?.genAi,
    rateLimitMetrics: deps.otel?.rateLimit,
  })

  const builtApp = app
    .use('*', bodyLimit({ maxSize: 1024 * 1024 }))
    .onError((err, c) => {
      if (err instanceof ApiError) {
        const logFields = { details: err.details, cause: (err as { cause?: unknown }).cause }

        if (err.statusCode >= 500) {
          logger.withError(err).withFields(logFields).error('API error occurred')
        }
        else if (err.statusCode !== 401) {
          logger.withError(err).withFields(logFields).warn('API error occurred')
        }

        return c.json({
          error: err.errorCode,
          message: err.message,
          details: err.details,
        }, err.statusCode)
      }

      logger.withError(err).error('Unhandled error')
      const internalError = createInternalError()
      return c.json({
        error: internalError.errorCode,
        message: internalError.message,
      }, internalError.statusCode)
    })
    .on('GET', '/livez', c => c.json({ status: 'live' }))
    .on('GET', '/readyz', async (c) => {
      const [dbResult, redisResult] = await Promise.allSettled([
        deps.db.execute('SELECT 1'),
        deps.redis.ping(),
      ])

      const dbReady = dbResult.status === 'fulfilled'
      const redisReady = redisResult.status === 'fulfilled'
      const ready = dbReady && redisReady

      return c.json(
        {
          status: ready ? 'ready' : 'not_ready',
          checks: { db: dbReady ? 'ok' : 'fail', redis: redisReady ? 'ok' : 'fail' },
        },
        ready ? 200 : 503,
      )
    })
    .on('GET', '/', c => c.json({
      service: 'airi-api',
      mode: 'unauthenticated-proxy',
      message: 'Project AIRI API server. Configure a remote OpenAI-compatible API or local vLLM endpoint, then call /api/v1/openai.',
      docs: 'https://airi.moeru.ai/docs',
    }))
    .route('/api/v1/config/router', createAdminRouterConfigRoutes(deps.adminRouterConfigService))
    .route('/api/v1/voice-packs', createVoicePackRoutes(deps.voicePackService))
    .route('/api/v1/openai', v1Routes.openaiRoutes)
    .route('/api/v1/audio', v1Routes.audioRoutes)
    .notFound(c => c.json({
      error: 'NOT_FOUND',
      message: `No route matched ${c.req.method} ${new URL(c.req.url).pathname}. This server exposes the account-free AIRI API proxy under /api/v1/openai.`,
    }, 404))

  return { app: builtApp, injectWebSocket }
}

export async function createApp() {
  initLogger(LoggerLevel.Debug, LoggerFormat.Pretty)
  injeca.setLogger(createLoggLogger(useLogger('injeca').useGlobalConfig()))
  const logger = useLogger('app').useGlobalConfig()

  setGlobalHookPostLog((log) => {
    emitOtelLog(log.level, log.context, log.message, log.fields as Record<string, string | number | boolean>)
  })

  const otel = injeca.provide('libs:otel', {
    dependsOn: { env: parsedEnv },
    build: ({ dependsOn }) => initOtel(dependsOn.env),
  })

  const db = injeca.provide('datastore:db', {
    dependsOn: { env: parsedEnv, lifecycle },
    build: async ({ dependsOn }) => {
      const { db: dbInstance, pool } = await initializeExternalDependency(
        'Database',
        logger,
        async (attempt) => {
          const connection = createDrizzle(dependsOn.env)

          try {
            await connection.db.execute('SELECT 1')
            logger.log(`Connected to database on attempt ${attempt}`)
            await migrateDatabase(connection.db)
            logger.log(`Applied schema on attempt ${attempt}`)
            return connection
          }
          catch (error) {
            await connection.pool.end()
            throw error
          }
        },
      )

      dependsOn.lifecycle.appHooks.onStop(() => pool.end())
      return dbInstance
    },
  })

  const redis = injeca.provide('datastore:redis', {
    dependsOn: { env: parsedEnv, lifecycle },
    build: async ({ dependsOn }) => {
      const redisInstance = await initializeExternalDependency(
        'Redis',
        logger,
        async (attempt) => {
          const instance = createRedis(dependsOn.env.REDIS_URL)

          try {
            await instance.connect()
            logger.log(`Connected to Redis on attempt ${attempt}`)
            return instance
          }
          catch (error) {
            instance.disconnect()
            throw error
          }
        },
      )

      dependsOn.lifecycle.appHooks.onStop(async () => {
        await redisInstance.quit()
      })
      return redisInstance
    },
  })

  const configKV = injeca.provide('datastore:configKV', {
    dependsOn: { redis },
    build: ({ dependsOn }) => createConfigKVService(dependsOn.redis),
  })

  const productEventService = injeca.provide('services:productEvents', {
    dependsOn: { db, otel },
    build: ({ dependsOn }) => createProductEventService(dependsOn.db, dependsOn.otel?.product),
  })

  const characterService = injeca.provide('services:characters', {
    dependsOn: { db, otel },
    build: ({ dependsOn }) => createCharacterService(dependsOn.db, dependsOn.otel?.engagement),
  })

  const requestLogService = injeca.provide('services:requestLog', {
    dependsOn: { db },
    build: ({ dependsOn }) => createRequestLogService(dependsOn.db),
  })

  const voicePackService = injeca.provide('services:voicePack', {
    dependsOn: { db },
    build: ({ dependsOn }) => createVoicePackService(dependsOn.db),
  })

  const envelopeCrypto = injeca.provide('libs:envelopeCrypto', {
    dependsOn: { env: parsedEnv },
    build: ({ dependsOn }) => createEnvelopeCrypto({
      masterKey: dependsOn.env.LLM_ROUTER_MASTER_KEY,
      previousMasterKey: dependsOn.env.LLM_ROUTER_MASTER_KEY_PREVIOUS,
    }),
  })

  const adminRouterConfigService = injeca.provide('services:adminRouterConfig', {
    dependsOn: { configKV, envelopeCrypto, redis },
    build: ({ dependsOn }) => createAdminRouterConfigService({
      configKV: dependsOn.configKV,
      envelope: dependsOn.envelopeCrypto,
      redis: dependsOn.redis,
    }),
  })

  const ttsConcurrencyLedger = injeca.provide('services:ttsConcurrencyLedger', {
    dependsOn: { redis },
    build: ({ dependsOn }) => createConcurrencyLedger(dependsOn.redis),
  })

  const llmRouter = injeca.provide('services:llmRouter', {
    dependsOn: { configKV, envelopeCrypto, otel, redis, ttsConcurrencyLedger },
    build: ({ dependsOn }) => createLlmRouterService({
      configKV: dependsOn.configKV,
      envelopeCrypto: dependsOn.envelopeCrypto,
      gatewayMetrics: dependsOn.otel?.gateway ?? null,
      redis: dependsOn.redis,
      concurrencyLedger: dependsOn.ttsConcurrencyLedger,
    }),
  })

  await injeca.start()
  const resolved = await injeca.resolve({
    db,
    characterService,
    requestLogService,
    voicePackService,
    productEventService,
    adminRouterConfigService,
    configKV,
    envelopeCrypto,
    redis,
    env: parsedEnv,
    otel,
    llmRouter,
    ttsConcurrencyLedger,
  })

  if (resolved.otel)
    registerTtsPoolGauge(resolved.otel.gateway.poolInflight, resolved.ttsConcurrencyLedger, resolved.otel.observability.metricReadErrors)

  const { app, injectWebSocket } = await buildApp({
    db: resolved.db,
    characterService: resolved.characterService,
    requestLogService: resolved.requestLogService,
    voicePackService: resolved.voicePackService,
    productEventService: resolved.productEventService,
    adminRouterConfigService: resolved.adminRouterConfigService,
    configKV: resolved.configKV,
    envelopeCrypto: resolved.envelopeCrypto,
    redis: resolved.redis,
    env: resolved.env,
    otel: resolved.otel,
    llmRouter: resolved.llmRouter,
  })

  logger.withFields({ hostname: resolved.env.HOST, port: resolved.env.PORT }).log('Server started')

  return {
    app,
    injectWebSocket,
    port: resolved.env.PORT,
    hostname: resolved.env.HOST,
  }
}

function handleProcessError(error: unknown, type: string) {
  useLogger().withError(error).error(type)
}

export async function runApiServer(): Promise<void> {
  const { app: honoApp, injectWebSocket, port, hostname } = await createApp()
  const server = serve({ fetch: honoApp.fetch, port, hostname })
  injectWebSocket(server)

  process.on('uncaughtException', error => handleProcessError(error, 'Uncaught exception'))
  process.on('unhandledRejection', error => handleProcessError(error, 'Unhandled rejection'))

  await new Promise<void>((resolve, reject) => {
    server.once('close', () => resolve())
    server.once('error', error => reject(error))
  })
}
