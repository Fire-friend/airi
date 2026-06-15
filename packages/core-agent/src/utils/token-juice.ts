/**
 * TokenJuice — noise-stripping utilities for LLM context compression.
 *
 * Ported from the OpenHuman TokenJuice design; no external package boundary
 * exists there so we implement the rules directly in TypeScript.
 *
 * All functions are pure: they return a new string and never mutate input.
 * Compose with `squeezeText` (full pipeline) or `fitToTokenBudget` (pipeline
 * + hard truncation to a token target).
 */

// ─── Token counting ────────────────────────────────────────────────────────────

/**
 * Heuristic: 1 token ≈ 4 characters for mixed English / code content.
 *
 * Good enough for budget checks without importing a full tokenizer (which
 * would add a heavy dependency just to squeeze context). Callers that need
 * exact counts should count at the LLM call site using the model's own API.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ─── Control character stripping ──────────────────────────────────────────────

/**
 * Strips ANSI/VT100 escape sequences and other non-printable characters.
 *
 * Preserves newlines and tabs. Normalises CRLF → LF so downstream line-based
 * rules see a consistent line separator.
 */
export function stripControlChars(text: string): string {
  return text
    .replace(/\x1B\[[0-9;]*[A-Z]/gi, '') // CSI sequences (colors, cursor)
    .replace(/\x1B\][^\x07]*\x07/g, '') // OSC sequences (terminal title, etc.)
    .replace(/\x1B[PX^_][^\x1B]*\x1B\\/g, '') // DCS / SOS / PM / APC
    .replace(/\x1B./gs, '') // remaining ESC + any char
    .replace(/\r\n/g, '\n') // CRLF → LF
    .replace(/\r/g, '\n') // lone CR → LF
    .replace(/[^\t\n\x20-\x7E\u0080-\uFFFF]/g, '') // non-printable except \t \n
}

// ─── Log prefix stripping ─────────────────────────────────────────────────────

// Matches: 2024-01-01T00:00:00Z, 2024-01-01 00:00:00.123, [2024-01-01T00:00:00Z]
const ISO_TS_RE = /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*/
const LOG_LEVEL_BRACKET_RE = /^\[(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\]\s*/i
const LOG_LEVEL_BARE_RE = /^(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL):\s*/i
const PID_PREFIX_RE = /^\[(?:pid:)?\d+\]\s*/i

/**
 * Strips structured log prefixes (timestamps, log levels, PID tags) from each
 * line. The meaningful content after the prefix is preserved verbatim.
 *
 * Before: `[2024-01-01T00:00:00Z] [ERROR] [pid:12345] connection refused`
 * After:  `connection refused`
 */
export function stripLogPrefixes(text: string): string {
  return text
    .split('\n')
    .map(line =>
      line
        .replace(ISO_TS_RE, '')
        .replace(LOG_LEVEL_BRACKET_RE, '')
        .replace(LOG_LEVEL_BARE_RE, '')
        .replace(PID_PREFIX_RE, ''),
    )
    .join('\n')
}

// ─── URL truncation ───────────────────────────────────────────────────────────

/** Default max display length for a URL before truncation. */
export const DEFAULT_URL_MAX_LEN = 80

/**
 * Truncates long URLs to a readable prefix with an optional query-param count
 * note appended. Short URLs (≤ maxLen) are returned unchanged.
 *
 * Before: `https://example.com/path?a=1&b=2&c=3&d=4` (very long)
 * After:  `https://example.com/path?[4 params]`
 */
export function truncateLongUrls(text: string, maxLen: number = DEFAULT_URL_MAX_LEN): string {
  return text.replace(/https?:\/\/[^\s"'<>)]+/g, (url) => {
    if (url.length <= maxLen)
      return url
    const qIdx = url.indexOf('?')
    const base = qIdx >= 0 ? url.slice(0, qIdx) : url
    const paramCount = qIdx >= 0 ? url.slice(qIdx + 1).split('&').length : 0
    const truncBase = base.length > maxLen - 12
      ? `${base.slice(0, maxLen - 12)}…`
      : base
    return paramCount > 0 ? `${truncBase}?[${paramCount} params]` : truncBase
  })
}

// ─── Repeated-line deduplication ─────────────────────────────────────────────

/**
 * Collapses consecutive runs of identical lines longer than `maxRun`.
 *
 * Useful for terminal output that repeats the same error or progress bar line
 * hundreds of times. Keeps the first `maxRun` occurrences and appends a
 * count note.
 *
 * Before: `[ENOENT] file not found\n` × 100
 * After:  `[ENOENT] file not found\n[ENOENT] file not found\n… [repeated 98 more times]`
 */
export function dedupRepeatedLines(text: string, maxRun: number = 2): string {
  const lines = text.split('\n')
  const result: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    let runLen = 1
    while (i + runLen < lines.length && lines[i + runLen] === line)
      runLen++

    for (let j = 0; j < Math.min(runLen, maxRun); j++)
      result.push(line)

    if (runLen > maxRun)
      result.push(`… [repeated ${runLen - maxRun} more time${runLen - maxRun > 1 ? 's' : ''}]`)

    i += runLen
  }
  return result.join('\n')
}

// ─── JSON structure simplification ───────────────────────────────────────────

/**
 * Recursively simplifies a parsed JSON value by:
 * - Capping arrays at `maxItems` entries (appending a count note)
 * - Stopping recursion at `maxDepth` (replacing deeper values with `"[…]"`)
 */
function deepSimplify(value: unknown, depth: number, maxItems: number): unknown {
  if (depth === 0)
    return typeof value === 'object' && value !== null ? '[…]' : value

  if (Array.isArray(value)) {
    const slice = value.slice(0, maxItems).map(item => deepSimplify(item, depth - 1, maxItems))
    if (value.length > maxItems)
      slice.push(`… (${value.length - maxItems} more)`)
    return slice
  }

  if (typeof value === 'object' && value !== null) {
    const obj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      obj[k] = deepSimplify(v, depth - 1, maxItems)
    return obj
  }

  return value
}

export interface SimplifyJsonOptions {
  /** Maximum array length to keep before truncating. Default: 5 */
  maxItems?: number
  /** Maximum object nesting depth. Deeper values become `"[…]"`. Default: 3 */
  maxDepth?: number
}

/**
 * Parses `text` as JSON and returns a simplified representation. Returns the
 * original text unchanged if it is not valid JSON.
 */
export function simplifyJsonString(text: string, opts: SimplifyJsonOptions = {}): string {
  const { maxItems = 5, maxDepth = 3 } = opts
  try {
    const parsed: unknown = JSON.parse(text)
    return JSON.stringify(deepSimplify(parsed, maxDepth, maxItems), null, 2)
  }
  catch {
    return text
  }
}

// ─── Grapheme-safe truncation ─────────────────────────────────────────────────

/**
 * Truncates `text` to at most `maxChars` grapheme clusters, appending `…`.
 *
 * Uses `Intl.Segmenter` when available to avoid splitting multi-codepoint
 * characters (emoji, combining marks, CJK). Falls back to a surrogate-pair
 * safe slice when the runtime does not support the Segmenter API.
 *
 * Returns `text` unchanged if it already fits within `maxChars`.
 */
export function graphemeTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars)
    return text

  // Reserve 1 slot for the appended '…' so the result is exactly ≤ maxChars.
  const cutAt = Math.max(0, maxChars - 1)

  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter()
    let count = 0
    let cutIdx = 0
    for (const seg of segmenter.segment(text)) {
      if (count >= cutAt)
        break
      cutIdx = seg.index + seg.segment.length
      count++
    }
    return `${text.slice(0, cutIdx)}…`
  }

  // Fallback: don't split surrogate pairs
  let end = cutAt
  while (end > 0 && (text.charCodeAt(end) >= 0xDC00 && text.charCodeAt(end) <= 0xDFFF))
    end--

  return `${text.slice(0, end)}…`
}

// ─── Full squeeze pipeline ────────────────────────────────────────────────────

export interface TokenJuiceOptions {
  /** Strip ANSI/VT100 escape sequences and non-printable characters. Default: true */
  stripControl?: boolean
  /** Strip log-level and timestamp prefixes from lines. Default: true */
  stripLogs?: boolean
  /** Truncate long URLs. Default: true */
  truncateUrls?: boolean
  /** Max URL display length. Default: 80 */
  urlMaxLen?: number
  /** Deduplicate consecutive repeated lines. Default: true */
  dedupLines?: boolean
  /** Max repeated-line run length before collapsing. Default: 2 */
  dedupMaxRun?: number
  /** Simplify JSON inside fenced ```json blocks. Default: true */
  simplifyFencedJson?: boolean
  /** Options passed to the JSON simplifier. */
  jsonOpts?: SimplifyJsonOptions
}

/**
 * Applies the full noise-stripping pipeline to `text`.
 *
 * Each step is opt-out via options. The order is designed so that stripping
 * control chars and log prefixes first reduces noise before the heavier
 * JSON and dedup passes run.
 */
export function squeezeText(text: string, opts: TokenJuiceOptions = {}): string {
  const {
    stripControl = true,
    stripLogs = true,
    truncateUrls = true,
    urlMaxLen = DEFAULT_URL_MAX_LEN,
    dedupLines = true,
    dedupMaxRun = 2,
    simplifyFencedJson = true,
    jsonOpts,
  } = opts

  let result = text

  if (stripControl)
    result = stripControlChars(result)

  if (stripLogs)
    result = stripLogPrefixes(result)

  if (truncateUrls)
    result = truncateLongUrls(result, urlMaxLen)

  if (simplifyFencedJson) {
    result = result.replace(/```json\n([\s\S]*?)```/g, (_, body: string) =>
      `\`\`\`json\n${simplifyJsonString(body.trim(), jsonOpts)}\n\`\`\``)
  }

  if (dedupLines)
    result = dedupRepeatedLines(result, dedupMaxRun)

  return result.trim()
}

// ─── Token budgeter ───────────────────────────────────────────────────────────

/**
 * Compresses `text` to fit within `budgetTokens` estimated tokens.
 *
 * Runs the full squeeze pipeline first. If the result still exceeds the
 * budget, grapheme-truncates to `budgetTokens * 4` characters (the inverse
 * of the 1-token-≈-4-chars heuristic) and appends `…`.
 *
 * The returned string is guaranteed to have `estimateTokens(result) <=
 * budgetTokens` when the input was not already within budget.
 */
export function fitToTokenBudget(
  text: string,
  budgetTokens: number,
  opts: TokenJuiceOptions = {},
): string {
  const squeezed = squeezeText(text, opts)
  if (estimateTokens(squeezed) <= budgetTokens)
    return squeezed

  const maxChars = budgetTokens * 4
  return graphemeTruncate(squeezed, maxChars)
}
