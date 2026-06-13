import type { ScreenObserverAppSummary } from '@proj-airi/server-sdk-shared'

/**
 * Minimal HTTP client for a locally running MineContext service.
 *
 * MineContext captures the screen 24/7 as a daemon and uses a VLM to process
 * screenshots into structured activity contexts. It exposes a localhost REST
 * API at port 1733. This client polls the activity_context endpoint and maps
 * the results into the screen-observer's existing summary contract so
 * downstream vision processing never sees a data-source change.
 *
 * MineContext deployment: `opencontext start --host localhost --port 1733`
 * Minimum activity generation interval: 10 minutes (configurable).
 */

export interface MineContextClientOptions {
  /** @default 'http://127.0.0.1:1733' */
  baseUrl?: string
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Per-request timeout. @default 5000 */
  requestTimeoutMs?: number
}

/** A raw context entry from the MineContext vector search response. */
export interface MineContextRawContext {
  object_id: string
  content_format: 'text' | 'image' | 'file'
  source: 'screenshot' | 'vault' | 'local_file' | 'web_link' | 'input'
  create_time: string
  content_path?: string
  content_text?: string
  additional_info?: {
    app?: string
    window?: string
    [key: string]: unknown
  }
}

/** A processed activity context entry as returned by MineContext. */
export interface MineContextActivityContext {
  id: string
  title?: string
  summary?: string
  keywords: string[]
  entities: string[]
  context_type: string
  confidence: number
  importance: number
  /** ISO or "YYYY-MM-DD HH:MM:SS" formatted creation time. */
  create_time: string
  /** ISO or "YYYY-MM-DD HH:MM:SS" formatted event time. */
  event_time: string
  raw_contexts?: MineContextRawContext[]
}

/** One search result entry from POST /api/vector_search. */
interface SearchResultEntry {
  context: {
    id: string
    extracted_data?: {
      title?: string
      summary?: string
      context_type?: string
      keywords?: string[]
      entities?: string[]
      confidence?: number
      importance?: number
    }
    properties?: {
      create_time?: string
      event_time?: string
    }
    raw_contexts?: MineContextRawContext[]
  }
  score: number
}

interface VectorSearchResponse {
  code?: number
  status?: number
  message?: string
  data?: {
    results?: SearchResultEntry[]
    total?: number
  }
}

interface HealthResponse {
  code?: number
  data?: {
    status?: string
    service?: string
  }
}

export interface MineContextClient {
  /** True when the local MineContext service answers its health endpoint. */
  health: () => Promise<boolean>
  /**
   * Returns activity contexts created on or after `since`.
   * Uses vector search scoped to `activity_context` type; filters client-side
   * by create_time because the API does not expose a time-range query param.
   */
  getActivities: (params: { since: Date, limit?: number }) => Promise<MineContextActivityContext[]>
  /**
   * App name and window title inferred from the most recent activity context's
   * raw screenshot data. Returns undefined when no recent activity is found.
   * Used for meeting-surface heuristics.
   */
  getFocusedApp: () => Promise<{ appName?: string, windowTitle?: string } | undefined>
}

/**
 * MineContext's API uses either ISO timestamps or "YYYY-MM-DD HH:MM:SS" strings.
 * Both parse correctly via `new Date()`, but the space-separated variant needs
 * explicit handling on strict runtimes.
 *
 * NOTICE:
 * Root cause: MineContext stores datetimes as SQLite TEXT without timezone suffix.
 * Source: review of MineContext SQLite schema in volcengine/MineContext.
 * Removal condition: if MineContext normalizes to ISO 8601 in a future release.
 */
function parseContextTime(raw: string | undefined): Date {
  if (!raw)
    return new Date(0)
  // Replace space separator with T so Node's Date constructor parses it as UTC.
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const d = new Date(normalized)
  return Number.isNaN(d.getTime()) ? new Date(0) : d
}

function toActivityContext(entry: SearchResultEntry): MineContextActivityContext {
  const { context } = entry
  return {
    id: context.id,
    title: context.extracted_data?.title,
    summary: context.extracted_data?.summary,
    keywords: context.extracted_data?.keywords ?? [],
    entities: context.extracted_data?.entities ?? [],
    context_type: context.extracted_data?.context_type ?? 'activity_context',
    confidence: context.extracted_data?.confidence ?? 0,
    importance: context.extracted_data?.importance ?? 0,
    create_time: context.properties?.create_time ?? context.extracted_data?.title ?? '',
    event_time: context.properties?.event_time ?? context.properties?.create_time ?? '',
    raw_contexts: context.raw_contexts,
  }
}

/**
 * Creates a MineContext REST client bound to one base URL.
 *
 * Use when:
 * - The screen observer needs to poll for recent screen activity contexts
 *   from the local MineContext daemon.
 *
 * Expects:
 * - MineContext is reachable on localhost. Every call resolves (never throws)
 *   so the poll loop degrades to "minecontext unavailable" without try/catch
 *   at each call site.
 *
 * Returns:
 * - `health()` false and empty results on any network/parse failure.
 */
export function createMineContextClient(options?: MineContextClientOptions): MineContextClient {
  const baseUrl = (options?.baseUrl ?? 'http://127.0.0.1:1733').replace(/\/$/, '')
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch
  const requestTimeoutMs = options?.requestTimeoutMs ?? 5000

  async function request(path: string, init?: RequestInit): Promise<unknown | undefined> {
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      if (!response.ok)
        return undefined
      return await response.json()
    }
    catch {
      return undefined
    }
  }

  async function searchActivityContexts(limit: number): Promise<SearchResultEntry[]> {
    const payload = await request('/api/vector_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'screen activity application',
        top_k: limit,
        context_types: ['activity_context'],
      }),
    }) as VectorSearchResponse | undefined

    return payload?.data?.results ?? []
  }

  return {
    health: async () => {
      const payload = await request('/health') as HealthResponse | undefined
      return payload?.data?.status === 'healthy'
    },

    getActivities: async ({ since, limit = 50 }) => {
      const results = await searchActivityContexts(limit)
      return results
        .map(toActivityContext)
        .filter(ctx => parseContextTime(ctx.create_time).getTime() >= since.getTime())
    },

    getFocusedApp: async () => {
      const results = await searchActivityContexts(5)
      if (results.length === 0)
        return undefined

      // Pick the most recently created entry.
      const sorted = [...results].sort((a, b) => {
        const ta = parseContextTime(a.context.properties?.create_time).getTime()
        const tb = parseContextTime(b.context.properties?.create_time).getTime()
        return tb - ta
      })

      const latest = sorted[0]
      if (!latest)
        return undefined

      // App/window metadata lives in the raw screenshot context's additional_info.
      const screenCapture = latest.context.raw_contexts?.find(rc => rc.source === 'screenshot')
      if (screenCapture?.additional_info) {
        return {
          appName: screenCapture.additional_info.app,
          windowTitle: screenCapture.additional_info.window,
        }
      }

      return undefined
    },
  }
}

/** Text budget per context summary before truncation. */
const CONTEXT_SUMMARY_LIMIT = 160

/**
 * Maps MineContext activity contexts into per-app observation summaries.
 *
 * Before:
 * - 3 activity contexts; two reference app "Code" via raw_context additional_info,
 *   one has no app metadata.
 *
 * After:
 * - one entry: { appId: 'code', appName: 'Code', windowTitle: 'main.ts — airi',
 *   observedSeconds: 2, summary: 'windows: main.ts — airi · …', matchedWhitelist: true }
 * - The context without app metadata maps to a synthetic "Screen" entry.
 *
 * When app info is absent from raw_contexts, a single synthetic "Screen" app
 * summary is produced from the activity's title/summary text.
 *
 * NOTICE:
 * MineContext does not expose per-app capture durations. `observedSeconds` is
 * approximated from the number of unique activity contexts referencing each app,
 * which reflects capture events rather than real elapsed time.
 * Root cause: MineContext stores VLM-processed activities, not raw frame metadata.
 * Removal condition: if MineContext exposes duration_count per raw context.
 */
export function aggregateContextActivities(
  contexts: MineContextActivityContext[],
  allowedApps: string[],
): ScreenObserverAppSummary[] {
  const allowed = new Set(allowedApps.map(a => a.toLowerCase()))

  interface AppBucket {
    appName: string
    windowTitles: Map<string, number>
    summaryTexts: string[]
    contextCount: number
  }

  const byApp = new Map<string, AppBucket>()

  for (const ctx of contexts) {
    // Try to get app name from the first screenshot raw context.
    const screenshotRc = ctx.raw_contexts?.find(rc => rc.source === 'screenshot')
    const rawAppName = screenshotRc?.additional_info?.app
    const rawWindowTitle = screenshotRc?.additional_info?.window

    // Use app from raw context if available and in whitelist; otherwise "Screen".
    const appName = (rawAppName && (allowed.size === 0 || allowed.has(rawAppName.toLowerCase())))
      ? rawAppName
      : (allowed.size === 0 ? 'Screen' : undefined)

    if (!appName)
      continue

    const key = appName.toLowerCase()

    let bucket = byApp.get(key)
    if (!bucket) {
      bucket = { appName, windowTitles: new Map(), summaryTexts: [], contextCount: 0 }
      byApp.set(key, bucket)
    }

    bucket.contextCount++

    if (rawWindowTitle) {
      const count = bucket.windowTitles.get(rawWindowTitle) ?? 0
      bucket.windowTitles.set(rawWindowTitle, count + 1)
    }

    const text = ctx.summary ?? ctx.title ?? ''
    if (text.trim().length > 0)
      bucket.summaryTexts.push(text.trim())
  }

  // If no whitelist-matched apps found and we have contexts, emit a "Screen" summary.
  if (byApp.size === 0 && contexts.length > 0) {
    const screenBucket: AppBucket = {
      appName: 'Screen',
      windowTitles: new Map(),
      summaryTexts: [],
      contextCount: contexts.length,
    }
    for (const ctx of contexts) {
      const text = ctx.summary ?? ctx.title ?? ''
      if (text.trim().length > 0)
        screenBucket.summaryTexts.push(text.trim())
    }
    byApp.set('screen', screenBucket)
  }

  return Array.from(byApp.values(), (bucket) => {
    const windowTitle = [...bucket.windowTitles.entries()]
      .sort((a, b) => b[1] - a[1])[0]?.[0]

    const latestText = bucket.summaryTexts.at(-1) ?? ''
    const snippet = latestText.length > CONTEXT_SUMMARY_LIMIT
      ? `${latestText.slice(0, CONTEXT_SUMMARY_LIMIT)}…`
      : latestText

    const titles = [...bucket.windowTitles.keys()].slice(0, 3).join(', ')
    const summary = [titles && `windows: ${titles}`, snippet].filter(Boolean).join(' · ')

    const isAllowed = allowed.size === 0 || allowed.has(bucket.appName.toLowerCase())

    return {
      appId: bucket.appName.toLowerCase(),
      appName: bucket.appName,
      windowTitle,
      // Each activity context represents one MineContext capture event.
      observedSeconds: bucket.contextCount,
      summary,
      matchedWhitelist: isAllowed,
    }
  })
}
