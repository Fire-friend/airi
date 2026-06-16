import { describe, expect, it } from 'vitest'

import {
  configRedisKey,
  lockRedisKey,
  redisKeyFrom,
  userChatBroadcastRedisKey,
} from '../redis-keys'

describe('redis key utils', () => {
  it('builds colon-separated keys from normalized segments', () => {
    expect(redisKeyFrom('user', '123', 'chat')).toBe('user:123:chat')
    expect(redisKeyFrom(' lock ', 42, ' job ')).toBe('lock:42:job')
  })

  it('rejects empty key definitions', () => {
    expect(() => redisKeyFrom()).toThrow('Redis keys must contain at least one segment')
    expect(() => redisKeyFrom('user', '   ', 'chat')).toThrow('Redis key segments must not be empty')
  })

  it('exposes stable helpers for config, user, and lock namespaces', () => {
    expect(configRedisKey('DEFAULT_CHAT_MODEL')).toBe('config:DEFAULT_CHAT_MODEL')
    expect(userChatBroadcastRedisKey('user-1')).toBe('user:user-1:chat:broadcast')
    expect(lockRedisKey('config', 'LLM_ROUTER_CONFIG')).toBe('lock:config:LLM_ROUTER_CONFIG')
  })
})
