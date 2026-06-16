import type { GatewayCallback } from '../../gateway'
import type { V1RouteDeps } from '../../types'

import { useLogger } from '@guiiai/logg'

import { createBadRequestError, createNotFoundError } from '../../../../../utils/error'
import { nanoid } from '../../../../../utils/id'
import { buildSafeResponseHeaders } from '../../http/response'
import { createRouteTelemetry, newRouteContext } from '../../middlewares/telemetry'

interface UsageInfo {
  promptTokens?: number
  completionTokens?: number
}

type RouteTelemetry = ReturnType<typeof createRouteTelemetry>
type CharacterForPrompt = NonNullable<Awaited<ReturnType<V1RouteDeps['characterService']['findById']>>>
type CharacterI18nForPrompt = CharacterForPrompt['i18n'][number]
type CharacterPromptForPrompt = CharacterForPrompt['prompts'][number]

export interface ChatCompletionsOperationRequest {
  userId: string
  body: Record<string, unknown>
  sessionId?: string
  abortSignal?: AbortSignal
}

function extractUsageFromBody(body: unknown): UsageInfo {
  if (typeof body !== 'object' || body == null)
    return {}

  const usage = (body as { usage?: Record<string, unknown> }).usage
  if (!usage)
    return {}

  const promptTokens = usage.prompt_tokens
  const completionTokens = usage.completion_tokens
  return {
    promptTokens: typeof promptTokens === 'number' ? promptTokens : undefined,
    completionTokens: typeof completionTokens === 'number' ? completionTokens : undefined,
  }
}

function readOptionalRequestString(body: Record<string, unknown>, ...fieldNames: string[]): string | undefined {
  const fieldName = fieldNames.find(name => body[name] != null)
  if (!fieldName)
    return undefined

  const value = body[fieldName]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createBadRequestError(`Invalid ${fieldName}`, 'INVALID_REQUEST', {
      field: fieldName,
      expected: 'non-empty string',
    })
  }

  return value.trim()
}

function selectLocalizedRows<T extends { language: string }>(rows: T[], language?: string): T[] {
  if (!language)
    return rows

  const exact = rows.filter(row => row.language === language)
  return exact.length > 0 ? exact : rows
}

function selectPrimaryI18n(character: CharacterForPrompt, requestedLanguage?: string): CharacterI18nForPrompt | undefined {
  return selectLocalizedRows(character.i18n, requestedLanguage)[0]
}

function appendPromptSection(parts: string[], title: string, prompts: CharacterPromptForPrompt[]) {
  const content = prompts
    .map(prompt => prompt.content.trim())
    .filter(Boolean)

  if (content.length === 0)
    return

  parts.push(`${title}:\n${content.join('\n\n')}`)
}

function buildCharacterSystemMessage(character: CharacterForPrompt, requestedLanguage?: string): string | null {
  const i18n = selectPrimaryI18n(character, requestedLanguage)
  const promptLanguage = requestedLanguage ?? i18n?.language ?? character.prompts[0]?.language
  const prompts = selectLocalizedRows(character.prompts, promptLanguage)
  const parts: string[] = []

  if (i18n) {
    const profile = [
      `Name: ${i18n.name}`,
      i18n.tagline ? `Tagline: ${i18n.tagline}` : undefined,
      `Description: ${i18n.description}`,
      i18n.tags.length > 0 ? `Tags: ${i18n.tags.join(', ')}` : undefined,
    ].filter(Boolean)

    parts.push(`Character profile:\n${profile.join('\n')}`)
  }

  appendPromptSection(parts, 'System prompt', prompts.filter(prompt => prompt.type === 'system'))
  appendPromptSection(parts, 'Personality', prompts.filter(prompt => prompt.type === 'personality'))
  appendPromptSection(parts, 'Memories', prompts.filter(prompt => prompt.type === 'memory' || prompt.type === 'memories'))

  if (parts.length === 0)
    return null

  return parts.join('\n\n')
}

async function applyCharacterContext(body: Record<string, unknown>, characterService: V1RouteDeps['characterService']): Promise<Record<string, unknown>> {
  const characterId = readOptionalRequestString(body, 'characterId', 'character_id')
  if (!characterId)
    return body

  const language = readOptionalRequestString(body, 'characterLanguage', 'character_language')
  const messages = body.messages
  if (!Array.isArray(messages)) {
    throw createBadRequestError('characterId requires messages to be an array', 'INVALID_REQUEST', {
      field: 'messages',
    })
  }

  const character = await characterService.findById(characterId)
  if (!character)
    throw createNotFoundError('Character not found', { characterId })

  const systemMessage = buildCharacterSystemMessage(character, language)
  const upstreamBody = { ...body }
  delete upstreamBody.characterId
  delete upstreamBody.character_id
  delete upstreamBody.characterLanguage
  delete upstreamBody.character_language

  if (!systemMessage)
    return upstreamBody

  return {
    ...upstreamBody,
    messages: [
      { role: 'system', content: systemMessage },
      ...messages,
    ],
  }
}

export function chatCompletions(deps: V1RouteDeps): GatewayCallback<'chat.completions'> {
  const logger = useLogger('v1-completions').useGlobalConfig()
  const telemetry = createRouteTelemetry({
    genAi: deps.genAi,
    requestLogService: deps.requestLogService,
  })

  return async (context) => {
    const input = context.input
    const requestId = nanoid()

    const body = await applyCharacterContext(input.body, deps.characterService)
    let requestModel = typeof body.model === 'string' && body.model.length > 0 ? body.model : 'auto'

    if (requestModel === 'auto')
      requestModel = await deps.configKV.getOrThrow('DEFAULT_CHAT_MODEL')

    const stream = !!body.stream
    logger.withFields({
      requestId,
      userId: input.userId,
      model: requestModel,
      stream,
      messageCount: Array.isArray(body.messages) ? body.messages.length : undefined,
    }).log('chat completion request')
    void deps.productEventService.track({
      userId: input.userId,
      feature: 'gen_ai_chat',
      action: 'completion_requested',
      status: 'started',
      source: 'openai.chat.completions',
      model: requestModel,
      metadata: {
        stream,
        message_count: Array.isArray(body.messages) ? body.messages.length : null,
      },
    })

    const span = telemetry.startChatSpan({ model: requestModel, stream })
    const startedAt = Date.now()
    const clientAbort = input.abortSignal
    const routeCtx = newRouteContext()
    let response: Response
    try {
      response = await telemetry.runWithSpan(span, () =>
        deps.llmRouter.route({ modelName: requestModel, body, headers: {}, abortSignal: clientAbort }, routeCtx))
    }
    catch (err) {
      telemetry.failSpan(span, 'Router exhausted or unknown model')
      deps.llmTracing.startChatGeneration({
        input: body.messages,
        model: routeCtx.upstreamModel ?? requestModel,
        requestId,
        stream,
        userId: input.userId,
        sessionId: input.sessionId,
      }).fail('Router exhausted or unknown model')
      telemetry.recordMetrics({ model: requestModel, status: 502, type: 'chat', provider: routeCtx.provider, durationMs: Date.now() - startedAt, fluxConsumed: 0 })
      void deps.productEventService.track({
        userId: input.userId,
        feature: 'gen_ai_chat',
        action: 'completion_failed',
        status: 'failed',
        source: 'openai.chat.completions',
        model: requestModel,
        provider: routeCtx.provider,
        reason: 'router_exhausted',
        metadata: {
          duration_ms: Date.now() - startedAt,
          stream,
        },
      })
      throw err
    }

    const durationMs = Date.now() - startedAt
    telemetry.setHttpStatus(span, response.status)
    const langfuseModel = routeCtx.upstreamModel ?? requestModel
    const generationTrace = deps.llmTracing.startChatGeneration({
      input: body.messages,
      model: langfuseModel,
      requestId,
      stream,
      userId: input.userId,
      sessionId: input.sessionId,
    })

    if (!response.ok) {
      telemetry.failSpan(span, `Gateway ${response.status}`)
      generationTrace.fail(`Gateway ${response.status}`)
      telemetry.recordMetrics({ model: requestModel, status: response.status, type: 'chat', provider: routeCtx.provider, durationMs, fluxConsumed: 0 })
      void deps.productEventService.track({
        userId: input.userId,
        feature: 'gen_ai_chat',
        action: 'completion_failed',
        status: 'failed',
        source: 'openai.chat.completions',
        model: requestModel,
        provider: routeCtx.provider,
        reason: 'upstream_error',
        metadata: {
          http_status: response.status,
          duration_ms: durationMs,
          stream,
        },
      })
      logger.withFields({ requestId, userId: input.userId, model: requestModel, status: response.status, durationMs })
        .warn('chat completion delivered with upstream error status')

      return new Response(response.body, {
        status: response.status,
        headers: buildSafeResponseHeaders(response),
      })
    }

    if (stream) {
      return streamChatCompletion({
        deps,
        response,
        generationTrace,
        span,
        startedAt,
        durationMs,
        requestId,
        userId: input.userId,
        requestModel,
        routeCtxProvider: routeCtx.provider,
        telemetry,
        logger,
      })
    }

    return completeNonStreamingChat({
      deps,
      response,
      generationTrace,
      span,
      durationMs,
      requestId,
      userId: input.userId,
      requestModel,
      routeCtxProvider: routeCtx.provider,
      telemetry,
      logger,
    })
  }
}

function streamChatCompletion(input: {
  deps: V1RouteDeps
  response: Response
  generationTrace: ReturnType<V1RouteDeps['llmTracing']['startChatGeneration']>
  span: Parameters<RouteTelemetry['endSpan']>[0]
  startedAt: number
  durationMs: number
  requestId: string
  userId: string
  requestModel: string
  routeCtxProvider: string
  telemetry: RouteTelemetry
  logger: ReturnType<typeof useLogger>
}) {
  const { readable, writable } = new TransformStream()
  const reader = input.response.body!.getReader()
  const writer = writable.getWriter()
  const decoder = new TextDecoder()
  let tailBuffer = ''
  let streamCompleted = false
  let streamInterrupted = false
  let firstChunkAt = Number.NaN

  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          streamCompleted = true
          break
        }
        if (!Number.isFinite(firstChunkAt)) {
          firstChunkAt = Date.now()
          input.telemetry.recordFirstToken({
            firstChunkAt,
            model: input.requestModel,
            provider: input.routeCtxProvider,
            startedAt: input.startedAt,
          })
        }
        await writer.write(value)
        const text = decoder.decode(value, { stream: true })
        tailBuffer = (tailBuffer + text).slice(-2048)
        input.generationTrace.appendStreamChunk(text)
      }
    }
    catch (err) {
      streamInterrupted = true
      input.telemetry.recordStreamInterrupted({
        model: input.requestModel,
        span: input.span,
        stage: Number.isFinite(firstChunkAt) ? 'mid_stream' : 'before_first_chunk',
      })

      try {
        await writer.abort(err)
      }
      catch (abortErr) {
        input.logger.withError(abortErr).warn('Failed to abort stream writer after upstream interruption')
      }

      input.logger.withError(err).warn('Upstream stream interrupted before completion')
      return
    }
    finally {
      if (streamInterrupted) {
        input.telemetry.endSpan(input.span)
        input.generationTrace.fail('Gateway stream interrupted')
        input.telemetry.recordMetrics({ model: input.requestModel, status: input.response.status, type: 'chat', provider: input.routeCtxProvider, durationMs: input.durationMs, fluxConsumed: 0 })
        void input.deps.productEventService.track({
          userId: input.userId,
          feature: 'gen_ai_chat',
          action: 'completion_failed',
          status: 'failed',
          source: 'openai.chat.completions',
          model: input.requestModel,
          provider: input.routeCtxProvider,
          reason: 'stream_interrupted',
          metadata: {
            http_status: input.response.status,
            duration_ms: input.durationMs,
            stream: true,
          },
        })
      }
      else if (streamCompleted) {
        try {
          await writer.close()
        }
        catch (err) {
          input.logger.withError(err).warn('Failed to close stream writer')
        }

        let usage: UsageInfo = {}
        try {
          const lines = tailBuffer.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'))
          const lastDataLine = lines.at(-1)
          if (lastDataLine) {
            const json = JSON.parse(lastDataLine.slice(6))
            usage = extractUsageFromBody(json)
          }
        }
        catch (err) { input.logger.withError(err).warn('Failed to extract usage from stream') }

        input.telemetry.recordUsageOnSpan(input.span, usage)
        input.telemetry.endSpan(input.span)
        input.generationTrace.succeed({
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          fluxConsumed: 0,
        })
        input.telemetry.recordMetrics({ model: input.requestModel, status: input.response.status, type: 'chat', provider: input.routeCtxProvider, durationMs: input.durationMs, fluxConsumed: 0, ...usage })

        input.telemetry.recordRequestLog({
          userId: input.userId,
          model: input.requestModel,
          status: input.response.status,
          durationMs: input.durationMs,
          fluxConsumed: 0,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        })
        void input.deps.productEventService.track({
          userId: input.userId,
          feature: 'gen_ai_chat',
          action: 'completion_succeeded',
          status: 'succeeded',
          source: 'openai.chat.completions',
          model: input.requestModel,
          provider: input.routeCtxProvider,
          metadata: {
            http_status: input.response.status,
            duration_ms: input.durationMs,
            prompt_tokens: usage.promptTokens ?? 0,
            completion_tokens: usage.completionTokens ?? 0,
            stream: true,
          },
        })

        input.logger.withFields({
          requestId: input.requestId,
          userId: input.userId,
          model: input.requestModel,
          status: input.response.status,
          durationMs: input.durationMs,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          stream: true,
        }).log('chat completion delivered')
      }
    }
  })()

  return new Response(readable, {
    status: input.response.status,
    headers: buildSafeResponseHeaders(input.response),
  })
}

async function completeNonStreamingChat(input: {
  deps: V1RouteDeps
  response: Response
  generationTrace: ReturnType<V1RouteDeps['llmTracing']['startChatGeneration']>
  span: Parameters<RouteTelemetry['endSpan']>[0]
  durationMs: number
  requestId: string
  userId: string
  requestModel: string
  routeCtxProvider: string
  telemetry: RouteTelemetry
  logger: ReturnType<typeof useLogger>
}) {
  let responseBody
  try {
    responseBody = await input.response.json()
  }
  catch (err) {
    input.telemetry.failSpan(input.span, 'Failed to parse upstream response body')
    input.generationTrace.fail('Failed to parse upstream response body')
    input.telemetry.recordMetrics({ model: input.requestModel, status: input.response.status, type: 'chat', provider: input.routeCtxProvider, durationMs: input.durationMs, fluxConsumed: 0 })
    void input.deps.productEventService.track({
      userId: input.userId,
      feature: 'gen_ai_chat',
      action: 'completion_failed',
      status: 'failed',
      source: 'openai.chat.completions',
      model: input.requestModel,
      provider: input.routeCtxProvider,
      reason: 'malformed_upstream_response',
      metadata: {
        http_status: input.response.status,
        duration_ms: input.durationMs,
        stream: false,
      },
    })
    throw err
  }
  const usage = extractUsageFromBody(responseBody)

  input.telemetry.recordUsageOnSpan(input.span, usage)
  input.telemetry.endSpan(input.span)
  input.generationTrace.succeed({
    output: responseBody,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    fluxConsumed: 0,
  })
  input.telemetry.recordMetrics({ model: input.requestModel, status: input.response.status, type: 'chat', provider: input.routeCtxProvider, durationMs: input.durationMs, fluxConsumed: 0, ...usage })

  input.telemetry.recordRequestLog({
    userId: input.userId,
    model: input.requestModel,
    status: input.response.status,
    durationMs: input.durationMs,
    fluxConsumed: 0,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  })
  void input.deps.productEventService.track({
    userId: input.userId,
    feature: 'gen_ai_chat',
    action: 'completion_succeeded',
    status: 'succeeded',
    source: 'openai.chat.completions',
    model: input.requestModel,
    provider: input.routeCtxProvider,
    metadata: {
      http_status: input.response.status,
      duration_ms: input.durationMs,
      prompt_tokens: usage.promptTokens ?? 0,
      completion_tokens: usage.completionTokens ?? 0,
      stream: false,
    },
  })

  input.logger.withFields({
    requestId: input.requestId,
    userId: input.userId,
    model: input.requestModel,
    status: input.response.status,
    durationMs: input.durationMs,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    stream: false,
  }).log('chat completion delivered')

  return Response.json(responseBody)
}
