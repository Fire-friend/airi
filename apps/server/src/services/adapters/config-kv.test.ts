import { beforeEach, describe, expect, it, vi } from 'vitest'

import { configRedisKey } from '../../utils/redis-keys'
import { createConfigKVService } from './config-kv'

function createMockRedis() {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    _store: store,
  }
}

describe('configKVService', () => {
  let redis: ReturnType<typeof createMockRedis>
  let service: ReturnType<typeof createConfigKVService>

  beforeEach(() => {
    redis = createMockRedis()
    service = createConfigKVService(redis as any)
  })

  it('get should throw 503 when a required key is not set', async () => {
    await expect(service.getOrThrow('DEFAULT_CHAT_MODEL'))
      .rejects
      .toThrow('Service configuration is incomplete')
  })

  it('get should return a string value when key is set', async () => {
    redis._store.set(configRedisKey('DEFAULT_CHAT_MODEL'), JSON.stringify('local-vllm'))

    const value = await service.getOrThrow('DEFAULT_CHAT_MODEL')
    expect(value).toBe('local-vllm')
  })

  it('get should read from the prefixed key', async () => {
    redis._store.set(configRedisKey('DEFAULT_CHAT_MODEL'), JSON.stringify('local-vllm'))

    await service.getOrThrow('DEFAULT_CHAT_MODEL')
    expect(redis.get).toHaveBeenCalledWith(configRedisKey('DEFAULT_CHAT_MODEL'))
  })

  it('getOptional should return null when a required key is not set', async () => {
    const value = await service.getOptional('DEFAULT_CHAT_MODEL')
    expect(value).toBeNull()
  })

  it('getOptional should return schema default when key has one', async () => {
    const value = await service.getOptional('DEFAULT_TTS_VOICES')
    expect(value).toEqual({})
  })

  it('getOptional should throw CONFIG_INVALID when Redis contains malformed JSON', async () => {
    redis._store.set(configRedisKey('LLM_ROUTER_CONFIG'), '{"llm":{}')

    await expect(service.getOptional('LLM_ROUTER_CONFIG'))
      .rejects
      .toMatchObject({
        statusCode: 503,
        errorCode: 'CONFIG_INVALID',
      })
  })

  it('getOptional should throw CONFIG_INVALID when Redis contains schema-invalid JSON', async () => {
    redis._store.set(configRedisKey('DEFAULT_CHAT_MODEL'), JSON.stringify(123))

    await expect(service.getOptional('DEFAULT_CHAT_MODEL'))
      .rejects
      .toMatchObject({
        statusCode: 503,
        errorCode: 'CONFIG_INVALID',
      })
  })

  it('set should write value to Redis with prefix', async () => {
    await service.set('DEFAULT_CHAT_MODEL', 'local-vllm')

    expect(redis.set).toHaveBeenCalledWith(configRedisKey('DEFAULT_CHAT_MODEL'), JSON.stringify('local-vllm'))
    expect(redis._store.get(configRedisKey('DEFAULT_CHAT_MODEL'))).toBe(JSON.stringify('local-vllm'))
  })
})
