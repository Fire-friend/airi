import type { GenAiMetrics, RateLimitMetrics } from '../../../otel'
import type { ConfigKVService } from '../../../services/adapters/config-kv'
import type { CharacterService } from '../../../services/domain/characters'
import type { LlmRouterService } from '../../../services/domain/llm-router'
import type { ChatGenerationTrace, TtsGenerationTrace } from '../../../services/domain/llm-tracing'
import type { ProductEventService } from '../../../services/domain/product-events'
import type { RequestLogService } from '../../../services/domain/request-log'
import type { VoicePackService } from '../../../services/domain/voice-packs'

import { startChatGeneration, startTtsGeneration } from '../../../services/domain/llm-tracing'

export interface LlmTracingDeps {
  startChatGeneration: (input: Parameters<typeof startChatGeneration>[0]) => ChatGenerationTrace
  startTtsGeneration: (input: Parameters<typeof startTtsGeneration>[0]) => TtsGenerationTrace
}

export interface V1RouteDeps {
  characterService: CharacterService
  configKV: ConfigKVService
  requestLogService: RequestLogService
  productEventService: ProductEventService
  llmRouter: LlmRouterService
  voicePackService: VoicePackService
  genAi?: GenAiMetrics | null
  rateLimitMetrics?: RateLimitMetrics | null
  llmTracing: LlmTracingDeps
}

export const defaultLlmTracing: LlmTracingDeps = {
  startChatGeneration,
  startTtsGeneration,
}
