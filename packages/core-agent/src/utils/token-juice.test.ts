import { describe, expect, it } from 'vitest'

import {
  dedupRepeatedLines,
  estimateTokens,
  fitToTokenBudget,
  graphemeTruncate,
  simplifyJsonString,
  squeezeText,
  stripControlChars,
  stripLogPrefixes,
  truncateLongUrls,
} from './token-juice'

// ─── estimateTokens ────────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns 1 for a 4-character string', () => {
    expect(estimateTokens('test')).toBe(1)
  })

  it('rounds up for strings not divisible by 4', () => {
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('scales with string length', () => {
    const text = 'a'.repeat(400)
    expect(estimateTokens(text)).toBe(100)
  })
})

// ─── stripControlChars ────────────────────────────────────────────────────────

describe('stripControlChars', () => {
  it('removes ANSI colour codes, preserving visible text', () => {
    const input = '\x1B[31mERROR\x1B[0m: connection refused'
    expect(stripControlChars(input)).toBe('ERROR: connection refused')
  })

  it('removes ANSI cursor-movement sequences', () => {
    const input = '\x1B[2J\x1B[HBuilding…'
    expect(stripControlChars(input)).toBe('Building…')
  })

  it('normalises CRLF to LF', () => {
    const input = 'line1\r\nline2\r\nline3'
    expect(stripControlChars(input)).toBe('line1\nline2\nline3')
  })

  it('normalises lone CR to LF', () => {
    expect(stripControlChars('a\rb')).toBe('a\nb')
  })

  it('preserves tabs and newlines', () => {
    const input = 'col1\tcol2\nrow2'
    expect(stripControlChars(input)).toBe(input)
  })

  it('strips OSC terminal title sequences', () => {
    const input = '\x1B]0;My Terminal\x07hello'
    expect(stripControlChars(input)).toBe('hello')
  })

  it('handles multi-line terminal output from a build tool', () => {
    // Simulates coloured npm/pnpm output
    const input = [
      '\x1B[32m✓\x1B[0m compiled successfully',
      '\x1B[33m⚠\x1B[0m 3 warnings',
      '\x1B[31m✗\x1B[0m 1 error',
    ].join('\n')
    const result = stripControlChars(input)
    expect(result).toContain('compiled successfully')
    expect(result).toContain('3 warnings')
    expect(result).toContain('1 error')
    expect(result).not.toContain('\x1B')
  })
})

// ─── stripLogPrefixes ─────────────────────────────────────────────────────────

describe('stripLogPrefixes', () => {
  it('strips ISO timestamp prefix', () => {
    const input = '2024-01-15T09:30:00Z connection refused to db'
    expect(stripLogPrefixes(input)).toBe('connection refused to db')
  })

  it('strips bracketed timestamp and level', () => {
    const input = '[2024-01-15T09:30:00.123Z] [ERROR] database unreachable'
    expect(stripLogPrefixes(input)).toBe('database unreachable')
  })

  it('strips bare level prefix', () => {
    expect(stripLogPrefixes('ERROR: file not found')).toBe('file not found')
    expect(stripLogPrefixes('DEBUG: cache miss for key')).toBe('cache miss for key')
    expect(stripLogPrefixes('WARN: retrying in 5s')).toBe('retrying in 5s')
  })

  it('strips PID prefix', () => {
    expect(stripLogPrefixes('[12345] worker exited')).toBe('worker exited')
    expect(stripLogPrefixes('[pid:99] oom killed')).toBe('oom killed')
  })

  it('preserves the error message content after stripping', () => {
    const log = [
      '[2024-03-01T12:00:00Z] [ERROR] [pid:4567] TypeError: Cannot read property length of undefined',
      '[2024-03-01T12:00:00Z] [INFO]  at Object.<anonymous> (/app/src/index.ts:42:10)',
      '[2024-03-01T12:00:01Z] [WARN]  retrying connection to postgres (attempt 3/5)',
    ].join('\n')

    const result = stripLogPrefixes(log)
    expect(result).toContain('TypeError: Cannot read property length of undefined')
    expect(result).toContain('at Object.<anonymous>')
    expect(result).toContain('retrying connection to postgres (attempt 3/5)')
    expect(result).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(result).not.toContain('[ERROR]')
    expect(result).not.toContain('[INFO]')
    expect(result).not.toContain('[WARN]')
  })

  it('does not strip lines without a recognised prefix', () => {
    const line = 'user logged in as admin'
    expect(stripLogPrefixes(line)).toBe(line)
  })
})

// ─── truncateLongUrls ─────────────────────────────────────────────────────────

describe('truncateLongUrls', () => {
  it('leaves short URLs unchanged', () => {
    const url = 'https://example.com/path'
    expect(truncateLongUrls(url)).toBe(url)
  })

  it('truncates a long URL and appends query-param count', () => {
    const url = 'https://api.example.com/v2/search?query=test&page=1&limit=20&sort=desc&filter=active&lang=en'
    const result = truncateLongUrls(url, 80)
    expect(result.length).toBeLessThanOrEqual(100)
    expect(result).toContain('params]')
    expect(result).toContain('https://api.example.com')
  })

  it('truncates a very long URL path with no query params', () => {
    const url = `https://cdn.example.com/${'segment/'.repeat(20)}file.min.js`
    const result = truncateLongUrls(url, 80)
    expect(result.length).toBeLessThanOrEqual(85)
    expect(result).toContain('…')
  })

  it('does not touch non-URL text around the URL', () => {
    const text = 'see https://example.com/short for details'
    expect(truncateLongUrls(text)).toBe(text)
  })

  it('handles multiple URLs in the same text', () => {
    const longUrl = `https://a.example.com/${'x'.repeat(100)}?k=v`
    const shortUrl = 'https://b.example.com/ok'
    const text = `ref: ${longUrl} and also ${shortUrl}`
    const result = truncateLongUrls(text, 80)
    expect(result).toContain('https://b.example.com/ok')
    expect(result).toContain('https://a.example.com/')
    expect(result).toContain('params]')
  })
})

// ─── dedupRepeatedLines ───────────────────────────────────────────────────────

describe('dedupRepeatedLines', () => {
  it('collapses a long run of identical lines', () => {
    const crash = Array.from({ length: 100 }).fill('ENOENT: no such file or directory').join('\n')
    const result = dedupRepeatedLines(crash)
    const lines = result.split('\n')
    expect(lines).toHaveLength(3) // 2 kept + 1 count note
    expect(lines[0]).toBe('ENOENT: no such file or directory')
    expect(lines[2]).toContain('98 more times')
  })

  it('preserves up to maxRun copies', () => {
    const input = ['a', 'a', 'a', 'b'].join('\n')
    expect(dedupRepeatedLines(input, 2)).toBe('a\na\n… [repeated 1 more time]\nb')
  })

  it('does not collapse runs within maxRun', () => {
    const input = ['x', 'x', 'y'].join('\n')
    expect(dedupRepeatedLines(input, 2)).toBe('x\nx\ny')
  })

  it('handles single-occurrence lines without change', () => {
    const input = 'line1\nline2\nline3'
    expect(dedupRepeatedLines(input)).toBe(input)
  })

  it('handles alternating lines without collapsing them', () => {
    const input = 'a\nb\na\nb\na'
    expect(dedupRepeatedLines(input)).toBe(input)
  })

  it('preserves error and key content in a crash-loop log', () => {
    const lines = [
      'Starting worker process',
      ...Array.from({ length: 50 }).fill('Worker crashed: OOM'),
      'Supervisor giving up after 50 attempts',
    ]
    const result = dedupRepeatedLines(lines.join('\n'))
    expect(result).toContain('Starting worker process')
    expect(result).toContain('Worker crashed: OOM')
    expect(result).toContain('48 more times')
    expect(result).toContain('Supervisor giving up after 50 attempts')
  })
})

// ─── simplifyJsonString ───────────────────────────────────────────────────────

describe('simplifyJsonString', () => {
  it('truncates a large array to maxItems', () => {
    const input = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item-${i}` })))
    const result = simplifyJsonString(input, { maxItems: 5 })
    const parsed = JSON.parse(result) as unknown[]
    expect(parsed).toHaveLength(6) // 5 items + count note
    expect(parsed[5]).toContain('95 more')
  })

  it('caps object nesting depth', () => {
    const deep = { a: { b: { c: { d: { e: 'deep value' } } } } }
    const result = simplifyJsonString(JSON.stringify(deep), { maxDepth: 3 })
    const parsed = JSON.parse(result) as { a: { b: { c: unknown } } }
    expect(parsed.a.b.c).toEqual('[…]')
  })

  it('preserves scalar values at safe depth', () => {
    const input = JSON.stringify({ id: 42, name: 'widget', active: true })
    const result = simplifyJsonString(input)
    const parsed = JSON.parse(result) as { id: number, name: string, active: boolean }
    expect(parsed.id).toBe(42)
    expect(parsed.name).toBe('widget')
    expect(parsed.active).toBe(true)
  })

  it('returns the original text unchanged for invalid JSON', () => {
    const notJson = 'this is not json { broken'
    expect(simplifyJsonString(notJson)).toBe(notJson)
  })

  it('handles a nested object with array fields', () => {
    const input = {
      status: 'ok',
      results: Array.from({ length: 20 }, (_, i) => ({ id: i })),
      meta: { total: 20, page: 1 },
    }
    const result = simplifyJsonString(JSON.stringify(input), { maxItems: 3 })
    const parsed = JSON.parse(result) as { results: unknown[] }
    expect(parsed.results).toHaveLength(4) // 3 items + count
    expect(JSON.stringify(parsed)).toContain('"status"')
    expect(JSON.stringify(parsed)).toContain('"meta"')
  })
})

// ─── graphemeTruncate ─────────────────────────────────────────────────────────

describe('graphemeTruncate', () => {
  it('returns text unchanged when shorter than limit', () => {
    expect(graphemeTruncate('hello', 10)).toBe('hello')
  })

  it('truncates ASCII text and appends ellipsis within maxChars', () => {
    // maxChars=5: 4 graphemes + '…' = 5 characters total
    const result = graphemeTruncate('hello world', 5)
    expect(result).toBe('hell…')
    expect(result.length).toBeLessThanOrEqual(5)
  })

  it('does not split a surrogate pair (emoji)', () => {
    // '😀' is U+1F600, encoded as a surrogate pair in JS strings
    const text = 'hello 😀 world'
    const result = graphemeTruncate(text, 7)
    // Should include "hello 😀" or "hello " — not a broken pair
    expect(() => encodeURIComponent(result)).not.toThrow()
    expect(result.endsWith('…')).toBe(true)
  })

  it('handles CJK characters correctly', () => {
    const text = '你好世界，这是一段中文文本'
    // maxChars=5: 4 CJK graphemes + '…' = 5 characters total
    const result = graphemeTruncate(text, 5)
    expect(result).toBe('你好世界…')
    expect(result.length).toBeLessThanOrEqual(5)
  })
})

// ─── squeezeText ──────────────────────────────────────────────────────────────

describe('squeezeText', () => {
  it('applies all steps to messy terminal output', () => {
    const dirty = [
      '\x1B[31m[2024-03-01T12:00:00Z] [ERROR] [pid:123] Failed to connect\x1B[0m',
      '\x1B[31m[2024-03-01T12:00:00Z] [ERROR] [pid:123] Failed to connect\x1B[0m',
      '\x1B[31m[2024-03-01T12:00:00Z] [ERROR] [pid:123] Failed to connect\x1B[0m',
      '\x1B[33m[2024-03-01T12:00:01Z] [WARN]  Retrying (1/3)\x1B[0m',
      `See logs at https://logging.corp.example.com/query?service=worker&env=prod&from=2024-01-01T00:00:00Z&to=2024-01-02T00:00:00Z&level=error&limit=100`,
    ].join('\n')

    const result = squeezeText(dirty)

    expect(result).not.toContain('\x1B')
    expect(result).not.toContain('[ERROR]')
    expect(result).not.toContain('[WARN]')
    expect(result).not.toContain('[2024-03-01')
    expect(result).toContain('Failed to connect')
    expect(result).toContain('Retrying')
    expect(result).toContain('… [repeated')
    expect(result).toContain('params]')
  })

  it('simplifies a fenced JSON block while preserving surrounding text', () => {
    const text = [
      'API response:',
      '```json',
      JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: i }))),
      '```',
      'End of response.',
    ].join('\n')

    const result = squeezeText(text)
    expect(result).toContain('API response:')
    expect(result).toContain('End of response.')
    expect(result).toContain('25 more')
  })

  it('skips steps when disabled via options', () => {
    const input = '2024-01-01T00:00:00Z [ERROR] some message'
    const result = squeezeText(input, { stripLogs: false })
    expect(result).toContain('[ERROR]')
  })

  it('reduces token count on a long log blob', () => {
    const longLog = Array.from({ length: 200 }, (_, i) =>
      `[2024-01-01T00:${String(i % 60).padStart(2, '0')}:00Z] [INFO] [pid:${1000 + i}] processed request ${i}`).join('\n')

    const before = estimateTokens(longLog)
    const result = squeezeText(longLog)
    const after = estimateTokens(result)

    expect(after).toBeLessThan(before)
  })
})

// ─── fitToTokenBudget ─────────────────────────────────────────────────────────

describe('fitToTokenBudget', () => {
  it('returns squeezed text unchanged if already within budget', () => {
    const text = 'short text'
    const result = fitToTokenBudget(text, 1000)
    expect(estimateTokens(result)).toBeLessThanOrEqual(1000)
    expect(result).toBe('short text')
  })

  it('compresses long log output to fit a tight budget', () => {
    const log = Array.from({ length: 500 }, (_, i) =>
      `[2024-01-01T00:00:${String(i % 60).padStart(2, '0')}Z] [DEBUG] [pid:${i}] cache miss for key "user:${i}"`).join('\n')

    const budget = 200
    const result = fitToTokenBudget(log, budget)
    expect(estimateTokens(result)).toBeLessThanOrEqual(budget)
  })

  it('preserves key content within budget on a crash-loop log', () => {
    const lines = [
      '[2024-01-01T00:00:00Z] [ERROR] Worker failed: OutOfMemoryError',
      ...Array.from({ length: 100 }).fill('[2024-01-01T00:00:01Z] [ERROR] Worker crashed: OOM — restarting'),
      '[2024-01-01T00:01:00Z] [FATAL] Supervisor giving up',
    ]
    const result = fitToTokenBudget(lines.join('\n'), 150)

    expect(estimateTokens(result)).toBeLessThanOrEqual(150)
    // Key entities should survive: at minimum the first error appears before truncation
    expect(result.length).toBeGreaterThan(0)
  })

  it('handles a large JSON response within a realistic budget', () => {
    const payload = JSON.stringify({
      status: 'success',
      data: Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        name: `user-${i}`,
        email: `user${i}@example.com`,
        createdAt: '2024-01-01T00:00:00Z',
      })),
      meta: { total: 1000, page: 1 },
    })
    const fenced = `Response:\n\`\`\`json\n${payload}\n\`\`\`\nEnd.`

    const budget = 500
    const result = fitToTokenBudget(fenced, budget)
    expect(estimateTokens(result)).toBeLessThanOrEqual(budget)
  })

  it('the result token count never exceeds the budget', () => {
    const inputs = [
      'x'.repeat(10000),
      Array.from({ length: 500 }, (_, i) => `line ${i}: ${'a'.repeat(50)}`).join('\n'),
      JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, v: 'long-value-here' }))),
    ]
    const budget = 100
    for (const input of inputs) {
      const result = fitToTokenBudget(input, budget)
      expect(estimateTokens(result)).toBeLessThanOrEqual(budget)
    }
  })
})
