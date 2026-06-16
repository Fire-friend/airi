import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

import { createV1Routes } from '.'
import type { HonoEnv } from '../../../types/hono'

function createMockConfigKV(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    DEFAULT_CHAT_MODEL: 'local-vllm',
    DEFAULT_TTS_MODEL: 'local-tts',
    ...overrides,
  }
  return {
    getOrThrow: vi.fn(async (key: string) => {
      if (!(key in values))
        throw new Error(`Unexpected config key: ${key}`)
      return values[key]
    }),
    getOptional: vi.fn(async (key: string) => values[key] ?? null),
  }
}

function createMockLlmTracing() {
  const chatTrace = {
    appendStreamChunk: vi.fn(),
    fail: vi.fn(),
    succeed: vi.fn(),
  }
  const ttsTrace = {
    fail: vi.fn(),
    succeed: vi.fn(),
  }
  return {
    chatTrace,
    ttsTrace,
    deps: {
      startChatGeneration: vi.fn(() => chatTrace),
      startTtsGeneration: vi.fn(() => ttsTrace),
    },
  }
}

function createTestApp(input: {
  characterService?: any
  configKV?: any
  llmRouter?: any
  llmTracing?: ReturnType<typeof createMockLlmTracing>
  requestLogService?: any
} = {}) {
  const llmTracing = input.llmTracing ?? createMockLlmTracing()
  const llmRouter = input.llmRouter ?? {
    route: vi.fn(async () => Response.json({
      id: 'chatcmpl-test',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    })),
    routeTts: vi.fn(async () => new Response('audio', { status: 200 })),
  }
  const requestLogService = input.requestLogService ?? {
    logRequest: vi.fn(async () => undefined),
  }
  const deps = {
    characterService: input.characterService ?? {
      findById: vi.fn(async () => undefined),
    },
    configKV: input.configKV ?? createMockConfigKV(),
    requestLogService,
    productEventService: {
      track: vi.fn(async () => undefined),
    },
    llmRouter,
    voicePackService: {
      listEnabledForTtsModel: vi.fn(async () => []),
    },
    llmTracing: llmTracing.deps,
  }
  const { openaiRoutes, audioRoutes } = createV1Routes(deps as any)
  const app = new Hono<HonoEnv>()
    .route('/api/v1/openai', openaiRoutes)
    .route('/api/v1/audio', audioRoutes)

  return { app, deps, llmRouter, llmTracing, requestLogService }
}

describe('v1 OpenAI routes', () => {
  it('routes chat completions without requiring an authenticated user or credit dependency', async () => {
    const { app, llmRouter, requestLogService } = createTestApp()

    const res = await app.request('/api/v1/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(llmRouter.route).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: 'local-vllm',
        body: expect.objectContaining({
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
      expect.any(Object),
    )
    expect(requestLogService.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'anonymous',
      fluxConsumed: 0,
      promptTokens: 2,
      completionTokens: 3,
    }))
  })

  it('prepends character prompt context and strips AIRI-only fields before routing', async () => {
    const characterService = {
      findById: vi.fn(async () => ({
        id: 'char-1',
        i18n: [
          { language: 'en', name: 'Aster', tagline: 'Pocket guide', description: 'Keeps answers crisp.', tags: ['guide'] },
        ],
        prompts: [
          { language: 'en', type: 'system', content: 'Never break character.' },
          { language: 'en', type: 'personality', content: 'Patient, precise, and direct.' },
          { language: 'en', type: 'memory', content: 'The user likes terse backend summaries.' },
        ],
      })),
    }
    const { app, llmRouter } = createTestApp({ characterService })

    const res = await app.request('/api/v1/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'auto',
        characterId: 'char-1',
        characterLanguage: 'en',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(characterService.findById).toHaveBeenCalledWith('char-1')
    const [{ body }] = llmRouter.route.mock.calls[0]
    expect(body.characterId).toBeUndefined()
    expect(body.characterLanguage).toBeUndefined()
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: expect.stringContaining('Never break character.'),
    })
    expect(body.messages[0].content).toContain('Patient, precise, and direct.')
    expect(body.messages[0].content).toContain('The user likes terse backend summaries.')
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })
})
