import type { GenAiMetrics } from '../../../otel'
import type { ConfigKVService } from '../../adapters/config-kv'
import type { LlmRouterService } from '../llm-router'
import type { startTtsGeneration, TtsGenerationTrace } from '../llm-tracing'
import type { ProductEventService } from '../product-events'
import type { RequestLogService } from '../request-log'
import type { VoicePackService } from '../voice-packs'

import { useLogger } from '@guiiai/logg'
import { context, SpanStatusCode, trace } from '@opentelemetry/api'

import { ApiError, createBadRequestError } from '../../../utils/error'
import { nanoid } from '../../../utils/id'
import {
  AIRI_ATTR_GEN_AI_OPERATION_KIND,
  GEN_AI_ATTR_REQUEST_MODEL,
} from '../../../utils/observability'

const tracer = trace.getTracer('v1-completions')

const SAFE_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'transfer-encoding',
  'cache-control',
])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value == null || Array.isArray(value))
    return undefined
  return value as Record<string, unknown>
}

function readOptionalNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

export interface OpenAiSpeechServiceDeps {
  configKV: ConfigKVService
  requestLogService: RequestLogService
  llmRouter: LlmRouterService
  voicePackService: VoicePackService
  productEventService: ProductEventService
  genAi?: GenAiMetrics | null
  llmTracing: {
    startTtsGeneration: (input: Parameters<typeof startTtsGeneration>[0]) => TtsGenerationTrace
  }
}

export interface OpenAiSpeechRequest {
  userId: string
  body: Record<string, unknown>
  sessionId?: string
  abortSignal?: AbortSignal
}

type TtsTrigger = 'auto' | 'manual'

interface TtsAnalyticsContext {
  trigger: TtsTrigger
  source: 'audio.speech' | 'chat_auto_tts' | 'manual_preview' | 'settings_test'
}

/**
 * Runs the OpenAI-shaped text-to-speech gateway flow.
 *
 * Use when:
 * - The HTTP route has parsed a `/audio/speech` request and needs domain
 *   orchestration for routing, tracing, and logging.
 *
 * Expects:
 * - `body` is the parsed JSON request body.
 * Returns:
 * - A gateway `Response` with safe upstream headers and audio body.
 */
export function createOpenAiSpeechService(deps: OpenAiSpeechServiceDeps) {
  const logger = useLogger('v1-completions').useGlobalConfig()

  async function handleSpeechRequest(input: OpenAiSpeechRequest): Promise<Response> {
    const requestId = nanoid()
    let requestModel = typeof input.body.model === 'string' ? input.body.model : 'auto'
    const inputText = typeof input.body.input === 'string' ? input.body.input : ''
    const analytics = ttsAnalyticsContext(input.body)

    if (requestModel === 'auto')
      requestModel = await deps.configKV.getOrThrow('DEFAULT_TTS_MODEL')

    const voicePackRequest = await voicePackRequestOptions(input.body, {
      model: requestModel,
      voice: typeof input.body.voice === 'string' ? input.body.voice : undefined,
      voicePackService: deps.voicePackService,
    })

    logger.withFields({
      requestId,
      userId: input.userId,
      model: requestModel,
      inputChars: inputText.length,
      voice: typeof input.body.voice === 'string' ? input.body.voice : undefined,
    }).log('tts speech request')

    void deps.productEventService.track({
      userId: input.userId,
      feature: 'tts',
      action: 'speech_requested',
      status: 'started',
      source: analytics.source,
      model: requestModel,
      metadata: {
        input_chars: inputText.length,
        trigger: analytics.trigger,
      },
    })

    const ttsInput = {
      text: inputText,
      voice: typeof input.body.voice === 'string' ? input.body.voice : undefined,
      speed: typeof input.body.speed === 'number' ? input.body.speed : undefined,
      responseFormat: typeof input.body.response_format === 'string' ? input.body.response_format : undefined,
      extraOptions: voicePackRequest.extraOptions,
    }

    const generationTrace = deps.llmTracing.startTtsGeneration({
      input: ttsInput,
      model: requestModel,
      requestId,
      userId: input.userId,
      sessionId: input.sessionId,
    })

    const span = tracer.startSpan('llm.gateway.tts', {
      attributes: {
        [GEN_AI_ATTR_REQUEST_MODEL]: requestModel,
        [AIRI_ATTR_GEN_AI_OPERATION_KIND]: 'text_to_speech',
      },
    })

    const startedAt = Date.now()
    const routeCtx = { provider: 'unknown', triedUpstreams: 0, triedKeys: 0, lastStatus: null }
    let response: Response
    try {
      response = await context.with(trace.setSpan(context.active(), span), () =>
        deps.llmRouter.routeTts({
          modelName: requestModel,
          input: ttsInput,
          abortSignal: input.abortSignal,
        }, routeCtx))
    }
    catch (err) {
      const failure = routerFailure(err)
      span.setStatus({ code: SpanStatusCode.ERROR, message: failure.message })
      span.end()
      generationTrace.fail(failure.message)
      recordMetrics({
        durationMs: Date.now() - startedAt,
        model: requestModel,
        provider: routeCtx.provider,
        status: failure.status,
      })
      void deps.productEventService.track({
        userId: input.userId,
        feature: 'tts',
        action: 'speech_failed',
        status: 'failed',
        source: analytics.source,
        model: requestModel,
        provider: routeCtx.provider,
        reason: failure.reason,
        metadata: {
          http_status: failure.status,
          duration_ms: Date.now() - startedAt,
          trigger: analytics.trigger,
        },
      })
      throw err
    }

    const durationMs = Date.now() - startedAt
    span.setAttribute('http.response.status_code', response.status)

    if (!response.ok) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `Gateway ${response.status}` })
      span.end()
      generationTrace.fail(`Gateway ${response.status}`)
      recordMetrics({ model: requestModel, status: response.status, provider: routeCtx.provider, durationMs })
      void deps.productEventService.track({
        userId: input.userId,
        feature: 'tts',
        action: 'speech_failed',
        status: 'failed',
        source: analytics.source,
        model: requestModel,
        provider: routeCtx.provider,
        reason: 'upstream_error',
        metadata: {
          http_status: response.status,
          duration_ms: durationMs,
          trigger: analytics.trigger,
        },
      })
      logger.withFields({ requestId, userId: input.userId, model: requestModel, status: response.status, durationMs })
        .warn('tts speech delivered with upstream error status')
      return new Response(response.body, {
        status: response.status,
        headers: buildSafeResponseHeaders(response),
      })
    }

    generationTrace.succeed({
      inputChars: inputText.length,
      fluxConsumed: 0,
      output: { contentType: response.headers.get('content-type') },
    })
    span.end()

    recordMetrics({ model: requestModel, status: response.status, provider: routeCtx.provider, durationMs })
    void deps.productEventService.track({
      userId: input.userId,
      feature: 'tts',
      action: 'speech_succeeded',
      status: 'succeeded',
      source: analytics.source,
      model: requestModel,
      provider: routeCtx.provider,
      metadata: {
        http_status: response.status,
        input_chars: inputText.length,
        cost_multiplier: voicePackRequest.costMultiplier,
        duration_ms: durationMs,
        trigger: analytics.trigger,
      },
    })
    deps.requestLogService.logRequest({
      userId: input.userId,
      model: requestModel,
      status: response.status,
      durationMs,
      fluxConsumed: 0,
    }).catch(err => logger.withError(err).warn('Failed to write llm_request_log row'))

    logger.withFields({
      requestId,
      userId: input.userId,
      model: requestModel,
      status: response.status,
      durationMs,
      inputChars: inputText.length,
    }).log('tts speech delivered')

    return new Response(response.body, {
      status: response.status,
      headers: buildSafeResponseHeaders(response),
    })
  }

  function recordMetrics(input: {
    model: string
    status: number
    provider: string
    durationMs: number
  }): void {
    const attrs = {
      [GEN_AI_ATTR_REQUEST_MODEL]: input.model,
      [AIRI_ATTR_GEN_AI_OPERATION_KIND]: 'tts',
      'http.response.status_code': input.status,
      'provider': input.provider,
    }
    deps.genAi?.operationCount.add(1, attrs)
    deps.genAi?.operationDuration.record(input.durationMs / 1000, attrs)
  }

  return { handleSpeechRequest }
}

function ttsAnalyticsContext(body: Record<string, unknown>): TtsAnalyticsContext {
  const extraBody = asRecord(body.extra_body)
  const analytics = asRecord(extraBody?.airi_analytics)
  const trigger = analytics?.trigger === 'auto' ? 'auto' : 'manual'
  const rawSource = analytics?.source
  const source = rawSource === 'chat_auto_tts'
    || rawSource === 'manual_preview'
    || rawSource === 'settings_test'
    ? rawSource
    : 'audio.speech'

  return { trigger, source }
}

async function voicePackRequestOptions(
  body: Record<string, unknown>,
  context: {
    model: string
    voice?: string
    voicePackService: VoicePackService
  },
): Promise<{ extraOptions: Record<string, unknown> | undefined, costMultiplier: number }> {
  const extraBody = asRecord(body.extra_body)
  const voicePackOptions = asRecord(extraBody?.voice_pack)
  const pitch = readOptionalNumber(voicePackOptions, 'pitch')
  const volume = readOptionalNumber(voicePackOptions, 'volume')
  const costMultiplier = await resolveVoicePackCostMultiplier(voicePackOptions, context)
  const extraOptions: Record<string, unknown> = {}
  if (pitch != null)
    extraOptions.pitch = pitch
  if (volume != null)
    extraOptions.volume = volume

  return {
    extraOptions: Object.keys(extraOptions).length > 0 ? extraOptions : undefined,
    costMultiplier,
  }
}

async function resolveVoicePackCostMultiplier(
  voicePackOptions: Record<string, unknown> | undefined,
  context: {
    model: string
    voice?: string
    voicePackService: VoicePackService
  },
): Promise<number> {
  const packId = voicePackOptions?.pack_id
  const value = voicePackOptions?.cost_multiplier
  if (packId == null && value == null)
    return 1
  if (typeof packId !== 'string' || !packId.trim())
    throw createBadRequestError('voice_pack.pack_id is required when Voice Pack metadata is provided', 'INVALID_VOICE_PACK')

  const pack = await context.voicePackService.findById(packId)
  if (!pack)
    throw createBadRequestError('Voice Pack not found', 'INVALID_VOICE_PACK', { packId })
  if (pack.ttsModelId !== context.model || pack.voiceId !== context.voice) {
    throw createBadRequestError('Voice Pack does not match requested model and voice', 'INVALID_VOICE_PACK', {
      packId,
      expectedModel: pack.ttsModelId,
      actualModel: context.model,
      expectedVoice: pack.voiceId,
      actualVoice: context.voice,
    })
  }

  return pack.costMultiplier
}

function routerFailure(error: unknown): { status: number, reason: string, message: string } {
  if (error instanceof ApiError) {
    return {
      status: error.statusCode,
      reason: error.errorCode,
      message: error.message,
    }
  }

  return {
    status: 502,
    reason: 'router_exhausted',
    message: 'TTS router exhausted or unknown model',
  }
}

function buildSafeResponseHeaders(response: Response): Headers {
  const headers = new Headers()
  response.headers.forEach((value, key) => {
    if (SAFE_RESPONSE_HEADERS.has(key.toLowerCase()))
      headers.set(key, value)
  })
  return headers
}
