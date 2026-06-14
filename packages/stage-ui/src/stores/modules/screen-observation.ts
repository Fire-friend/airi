import type { InputContextUpdate } from '@proj-airi/server-sdk'
import type {
  DailySummaryPayload,
  ScreenObservationSettings,
  ScreenObservationSnapshot,
  ScreenObserverPrivacyState,
  ScreenObserverSummary,
  Task,
  TaskWorkingState,
  TouchEventPayload,
  TouchLevel,
} from '@proj-airi/server-sdk-shared'

import { estimateTokens, fitToTokenBudget } from '@proj-airi/core-agent'
import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { DEFAULT_DAILY_SUMMARY_LOCAL_TIME, DEFAULT_TOUCH_LEVEL } from '@proj-airi/server-sdk-shared'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** Inputs for the renderer-side provisional privacy-state fallback. */
export interface ProvisionalPrivacyStateInput {
  enabled: boolean
  allowedApps: readonly string[]
  pauseUntil?: string
  now: Date
}

/**
 * Derives a provisional privacy state for display before the desktop
 * runtime has pushed an authoritative snapshot.
 *
 * Use when:
 * - Rendering observation status (settings, dashboard, tray-adjacent UI)
 *   while no `ScreenObservationSnapshot` has arrived yet.
 *
 * Expects:
 * - Renderer-persisted settings only; fullscreen/meeting suppression is an
 *   OS signal the renderer cannot see, so it is never produced here.
 *
 * Returns:
 * - The same precedence the server domain applies for the states the
 *   renderer can know: disabled > empty whitelist (the explicit
 *   "not observing" dead-state) > paused-until-future > observing.
 */
export function provisionalPrivacyState(input: ProvisionalPrivacyStateInput): ScreenObserverPrivacyState {
  if (!input.enabled)
    return 'disabled'
  if (input.allowedApps.length === 0)
    return 'not_observing_empty_whitelist'
  if (input.pauseUntil && new Date(input.pauseUntil).getTime() > input.now.getTime())
    return 'paused'
  return 'observing'
}

/**
 * Maps a privacy state to its i18n key under
 * `settings.pages.modules.screen-observation.status.*`.
 *
 * Use when:
 * - Any surface needs the localized status sentence; keeping the mapping
 *   here guarantees every surface shows the same wording, including the
 *   mandated "no app selected, currently not observing" dead-state copy.
 *
 * Returns:
 * - A full i18n key string, never a raw enum value.
 */
export function privacyStateLabelKey(state: ScreenObserverPrivacyState): string {
  return `settings.pages.modules.screen-observation.status.${state.replaceAll('_', '-')}`
}

/**
 * MineContext connection and polling config as returned by the desktop runtime.
 *
 * The renderer uses these values to populate the settings UI; edits are pushed
 * back via the `updateMineContextConfig` IPC invoke.
 */
export interface RuntimeMineContextConfig {
  baseUrl?: string
  screenshotCaptureEnabled?: boolean
  longMemoryPollIntervalMs?: number
  currentStatePollIntervalMs?: number
}

/**
 * Authoritative observation state pushed by the platform runtime (the
 * Electron main process today). Field types come from the shared contract;
 * the shape is intentionally a subset so stage-ui never depends on
 * app-internal eventa modules.
 */
export interface RuntimeObservationState {
  settings: ScreenObservationSettings
  /** Resolved by the runtime from settings + pause + OS suppression. */
  privacyState: ScreenObserverPrivacyState
  /** ISO timestamp until which observation is manually paused, if any. */
  pauseUntil?: string
  /** Whether the local observation source (MineContext) responded to the last health check. */
  observationSourceAvailable?: boolean
  /** Tasks registered with the runtime's decide loop; omitted payloads keep the current list. */
  tasks?: Task[]
  /** Per-task companion state from the runtime; evidence is task-local and provisional. */
  taskWorkingStates?: Record<string, TaskWorkingState>
  /** MineContext connection and polling configuration from the desktop runtime. */
  minecontextConfig?: RuntimeMineContextConfig
}

export interface ScreenObservationCurrentState {
  capturedAt: string
  privacyState: ScreenObserverPrivacyState
  focusedApp?: {
    appName: string
    windowTitle?: string
  }
}

export interface ScreenObservationPrivacyDenylist {
  appPatterns: string[]
  domainPatterns: string[]
  windowTitlePatterns: string[]
}

export interface LongMemoryCandidate {
  hash: string
  summaryId: string
  capturedAt: string
  windowStartedAt: string
  windowEndedAt: string
  apps: string[]
  summary: string
  facetKeys: string[]
}

export interface HabitFacet {
  key: string
  kind: 'focus_app'
  label: string
  status: 'provisional' | 'stable'
  evidenceCount: number
  distinctDayCount: number
  decayedEvidenceCount: number
  halfLifeDays: number
  firstSeenAt: string
  lastSeenAt: string
  evidenceHashes: string[]
  pinned?: boolean
}

export type ScreenObservationContextUpdate = InputContextUpdate

export interface LongMemoryIngestionResult {
  candidate?: LongMemoryCandidate
  contextUpdate?: ScreenObservationContextUpdate
  duplicate: boolean
  promotedFacets: HabitFacet[]
  provisionalFacets: HabitFacet[]
}

// Renderer-side display caps. The runtime owns durable history; these only
// bound what one window keeps in memory for the log/touch surfaces.
const OBSERVATION_LOG_DISPLAY_CAP = 200
const TOUCH_DISPLAY_CAP = 50
const LONG_MEMORY_CANDIDATE_CAP = 200
const STABLE_FACET_MIN_EVIDENCE = 3
const STABLE_FACET_MIN_DAYS = 2
const STABLE_FACET_MIN_DECAYED_EVIDENCE = 2.5
const FACET_HALF_LIFE_DAYS = 14
export const LONG_MEMORY_CONTEXT_BUDGET_TOKENS = 1_500
export const TASK_STATE_CONTEXT_BUDGET_TOKENS = 1_200

function defaultPrivacyDenylist(): ScreenObservationPrivacyDenylist {
  return {
    appPatterns: [
      '1password',
      'bitwarden',
      'keychain',
      'lastpass',
      'password',
    ],
    domainPatterns: [
      'accounts.google.com',
      'bank',
      'github.com/settings/tokens',
      'mail.google.com',
      'paypal.com',
    ],
    windowTitlePatterns: [
      'incognito',
      'inprivate',
      'private browsing',
      'private window',
      'token',
      'secret',
      'password',
    ],
  }
}

function normalizePrivacyText(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function matchesAnyPattern(value: string | undefined, patterns: readonly string[]): boolean {
  const normalized = normalizePrivacyText(value)
  if (!normalized)
    return false

  return patterns.some((pattern) => {
    const normalizedPattern = normalizePrivacyText(pattern)
    return normalizedPattern.length > 0 && normalized.includes(normalizedPattern)
  })
}

function isAllowedFocusedApp(appName: string, allowedAppNames: readonly string[]): boolean {
  const normalized = normalizePrivacyText(appName)
  if (!normalized)
    return false

  return allowedAppNames.some(allowedAppName => normalizePrivacyText(allowedAppName) === normalized)
}

function isDeniedObservationText(input: {
  appName?: string
  windowTitle?: string
  summary?: string
}, denylist: ScreenObservationPrivacyDenylist): boolean {
  if (matchesAnyPattern(input.appName, denylist.appPatterns))
    return true

  const titleAndSummary = [input.windowTitle, input.summary].filter(Boolean).join(' ')
  if (matchesAnyPattern(titleAndSummary, denylist.windowTitlePatterns))
    return true
  if (matchesAnyPattern(titleAndSummary, denylist.domainPatterns))
    return true

  return false
}

function filterSummaryForPrivacy(summary: ScreenObserverSummary, denylist: ScreenObservationPrivacyDenylist): ScreenObserverSummary | undefined {
  if (summary.privacyState !== 'observing')
    return undefined
  if (isDeniedObservationText({ summary: summary.summary }, denylist))
    return undefined

  const apps = summary.apps.filter(app => !isDeniedObservationText({
    appName: app.appName,
    windowTitle: app.windowTitle,
    summary: app.summary,
  }, denylist))

  if (apps.length === 0)
    return undefined

  return { ...summary, apps, rawReference: undefined }
}

function stableFacetKey(appName: string): string {
  return `focus_app:${normalizePrivacyText(appName).replaceAll(/\s+/g, '-')}`
}

function contentAddress(input: string): string {
  let hash = 0x811C9DC5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }

  return `fnv1a:${(hash >>> 0).toString(36)}`
}

function candidateFromSummary(summary: ScreenObserverSummary): LongMemoryCandidate {
  const apps = uniqueValues(summary.apps.map(app => app.appName))
  const facetKeys = uniqueValues(apps.map(stableFacetKey))
  const canonical = JSON.stringify({
    source: summary.source,
    windowStartedAt: summary.windowStartedAt,
    windowEndedAt: summary.windowEndedAt,
    apps,
    appSummaries: summary.apps.map(app => [app.appName, app.windowTitle ?? '', app.summary]).sort(),
    summary: summary.summary,
  })

  return {
    hash: contentAddress(canonical),
    summaryId: summary.id,
    capturedAt: summary.capturedAt,
    windowStartedAt: summary.windowStartedAt,
    windowEndedAt: summary.windowEndedAt,
    apps,
    summary: summary.summary,
    facetKeys,
  }
}

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

function decayedEvidenceCount(candidates: readonly LongMemoryCandidate[], now: Date): number {
  const halfLifeMs = FACET_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000
  const score = candidates.reduce((total, candidate) => {
    const ageMs = Math.max(0, now.getTime() - new Date(candidate.capturedAt).getTime())
    return total + 0.5 ** (ageMs / halfLifeMs)
  }, 0)

  return Math.round(score * 100) / 100
}

function buildCurrentStateContextUpdate(state: ScreenObservationCurrentState): ScreenObservationContextUpdate | undefined {
  if (state.privacyState !== 'observing' || !state.focusedApp)
    return undefined

  const windowText = state.focusedApp.windowTitle ? `, window "${state.focusedApp.windowTitle}"` : ''
  const text = `Current State (short-lived, do not store as long-term memory): focused app is ${state.focusedApp.appName}${windowText}. Treat this as what the user is doing now, not as a stable preference.`

  return {
    strategy: ContextUpdateStrategy.ReplaceSelf,
    contextId: 'screen-observation:current-state',
    text,
    metadata: {
      module: 'screen-observation',
      lane: 'current-state',
      retention: 'ephemeral',
      capturedAt: state.capturedAt,
      privacyState: state.privacyState,
      longMemory: false,
    },
  }
}

function buildLongMemoryContextUpdate(
  candidate: LongMemoryCandidate,
  promotedFacets: readonly HabitFacet[],
  provisionalFacets: readonly HabitFacet[],
): ScreenObservationContextUpdate {
  const stableText = promotedFacets.length > 0
    ? promotedFacets.map(facet => `${facet.label} (evidence=${facet.evidenceCount}, days=${facet.distinctDayCount}, decayed=${facet.decayedEvidenceCount})`).join('; ')
    : 'none yet'
  const provisionalText = provisionalFacets.length > 0
    ? provisionalFacets.map(facet => `${facet.label} (evidence=${facet.evidenceCount}/${STABLE_FACET_MIN_EVIDENCE}, days=${facet.distinctDayCount}/${STABLE_FACET_MIN_DAYS})`).join('; ')
    : 'none'
  const text = fitToTokenBudget([
    `Long Memory Candidate (privacy-filtered): ${candidate.summary}`,
    `Apps: ${candidate.apps.join(', ')}`,
    `Window: ${candidate.windowStartedAt} to ${candidate.windowEndedAt}`,
    `Stable facets: ${stableText}`,
    `Provisional facets: ${provisionalText}`,
    'Only stable facets are durable user/device habits; provisional facets are hypotheses and must not be treated as personality.',
  ].join('\n'), LONG_MEMORY_CONTEXT_BUDGET_TOKENS)

  return {
    strategy: ContextUpdateStrategy.ReplaceSelf,
    contextId: 'screen-observation:long-memory-candidates',
    text,
    metadata: {
      module: 'screen-observation',
      lane: 'long-memory-candidate',
      retention: 'local-memory-queue',
      tokenJuice: true,
      tokenBudget: LONG_MEMORY_CONTEXT_BUDGET_TOKENS,
      estimatedTokens: estimateTokens(text),
      candidateHash: candidate.hash,
      summaryId: candidate.summaryId,
      capturedAt: candidate.capturedAt,
      windowStartedAt: candidate.windowStartedAt,
      windowEndedAt: candidate.windowEndedAt,
      stableFacetCount: promotedFacets.length,
      provisionalFacetCount: provisionalFacets.length,
      privacyFiltered: true,
    },
  }
}

function taskStateEvidenceLine(evidence: TaskWorkingState['evidenceChain'][number]): string {
  const fingerprint = evidence.fingerprint ? ` [${evidence.fingerprint}]` : ''
  const capturedAt = evidence.capturedAt ? ` @ ${evidence.capturedAt}` : ''
  return `- ${evidence.kind}${fingerprint}${capturedAt}: ${evidence.description}`
}

function activeTaskStateEntries(
  tasks: readonly Task[],
  taskWorkingStates: Record<string, TaskWorkingState>,
): Array<{ task: Task, state: TaskWorkingState }> {
  return Object.values(taskWorkingStates)
    .map((state) => {
      const task = tasks.find(candidate => candidate.id === state.taskId)
      return task && task.status === 'active' ? { task, state } : undefined
    })
    .filter((entry): entry is { task: Task, state: TaskWorkingState } => Boolean(entry))
}

function taskStateContextKey(tasks: readonly Task[], taskWorkingStates: Record<string, TaskWorkingState>): string {
  return JSON.stringify(activeTaskStateEntries(tasks, taskWorkingStates).map(({ task, state }) => ({
    taskId: task.id,
    title: task.title,
    goal: task.goal,
    state,
  })))
}

function buildTaskStateContextUpdate(task: Task, state: TaskWorkingState): ScreenObservationContextUpdate {
  const evidenceLines = state.evidenceChain.length > 0
    ? state.evidenceChain.slice(-8).map(taskStateEvidenceLine).join('\n')
    : 'none; evidence was cleared or no task-local evidence has accumulated yet'
  const text = fitToTokenBudget([
    `Current Task State (privacy-filtered, provisional, do not store as personality): ${task.title}`,
    `Task: ${task.title}`,
    `Goal: ${task.goal}`,
    `State: ${state.state}`,
    `Scores: progress=${state.progressScore}, stuck=${state.stuckScore}`,
    `Last progress: ${state.lastProgressAt ?? 'unknown'}`,
    `Stuck started: ${state.stuckStartedAt ?? 'not currently stuck'}`,
    `Episode: ${state.episodeId ?? 'none'}`,
    'Recent task-local evidence:',
    evidenceLines,
    'Use this only to understand the current task and whether the user is stuck. Do not promote this evidence into durable personality or habit memory unless the separate stable facet pipeline promotes it.',
  ].join('\n'), TASK_STATE_CONTEXT_BUDGET_TOKENS)

  return {
    strategy: ContextUpdateStrategy.ReplaceSelf,
    contextId: `screen-observation:task-state:${task.id}`,
    text,
    metadata: {
      module: 'screen-observation',
      lane: 'task-state',
      retention: 'ephemeral-task-state',
      taskId: task.id,
      taskTitle: task.title,
      state: state.state,
      progressScore: state.progressScore,
      stuckScore: state.stuckScore,
      evidenceCount: state.evidenceChain.length,
      tokenJuice: true,
      tokenBudget: TASK_STATE_CONTEXT_BUDGET_TOKENS,
      estimatedTokens: estimateTokens(text),
      privacyFiltered: true,
      longMemory: false,
      personality: false,
      forgettable: true,
    },
  }
}

function buildTaskStateContextUpdates(
  tasks: readonly Task[],
  taskWorkingStates: Record<string, TaskWorkingState>,
): ScreenObservationContextUpdate[] {
  return activeTaskStateEntries(tasks, taskWorkingStates)
    .map(({ task, state }) => buildTaskStateContextUpdate(task, state))
}

export const useScreenObservationStore = defineStore('screen-observation', () => {
  // Privacy-first defaults frozen in the product decision (issue AIR-5):
  // master switch off, whitelist empty, daily summary on at 18:00, L1 touch.
  const enabled = useLocalStorageManualReset<boolean>('settings/screen-observation/enabled', false)
  const allowedApps = useLocalStorageManualReset<string[]>('settings/screen-observation/allowed-apps', [])
  const dailySummaryEnabled = useLocalStorageManualReset<boolean>('settings/screen-observation/daily-summary-enabled', true)
  const dailySummaryAtLocalTime = useLocalStorageManualReset<string>('settings/screen-observation/daily-summary-at', DEFAULT_DAILY_SUMMARY_LOCAL_TIME)
  const defaultTouchLevel = useLocalStorageManualReset<TouchLevel>('settings/screen-observation/default-touch-level', DEFAULT_TOUCH_LEVEL)
  const autoPauseOnFocus = useLocalStorageManualReset<boolean>('settings/screen-observation/auto-pause-on-focus', true)
  const onboardingCompleted = useLocalStorageManualReset<boolean>('settings/screen-observation/onboarding-completed', false)
  const privacyDenylist = useLocalStorageManualReset<ScreenObservationPrivacyDenylist>('settings/screen-observation/privacy-denylist', defaultPrivacyDenylist())
  const longMemoryCandidates = useLocalStorageManualReset<LongMemoryCandidate[]>('settings/screen-observation/long-memory-candidates', [])
  const habitFacets = useLocalStorageManualReset<HabitFacet[]>('settings/screen-observation/habit-facets', [])
  const forgottenFacetKeys = useLocalStorageManualReset<string[]>('settings/screen-observation/forgotten-facet-keys', [])

  // MineContext config — persisted locally so the UI reflects last-known values
  // before the runtime responds to get-state. The runtime's values win on hydration.
  const minecontextBaseUrl = useLocalStorageManualReset<string>('settings/screen-observation/minecontext-base-url', '')
  const screenshotCaptureEnabled = useLocalStorageManualReset<boolean>('settings/screen-observation/screenshot-capture-enabled', false)
  const longMemoryPollIntervalMs = useLocalStorageManualReset<number>('settings/screen-observation/long-memory-poll-interval-ms', 30_000)
  const currentStatePollIntervalMs = useLocalStorageManualReset<number>('settings/screen-observation/current-state-poll-interval-ms', 15_000)

  // Runtime state. Hydrated by applySnapshot once the desktop runtime
  // (Electron main process ScreenObserver) pushes the authoritative
  // ScreenObservationSnapshot over Eventa; provisional before that.
  const tasks = ref<Task[]>([])
  const observationLog = ref<ScreenObserverSummary[]>([])
  const latestTouches = ref<TouchEventPayload[]>([])
  const latestDailySummary = ref<DailySummaryPayload>()
  const pauseUntil = ref<string>()
  const snapshotPrivacyState = ref<ScreenObserverPrivacyState>()
  const observationSourceAvailable = ref<boolean>()
  const latestCurrentState = ref<ScreenObservationCurrentState>()
  const taskWorkingStates = ref<Record<string, TaskWorkingState>>({})

  const privacyState = computed<ScreenObserverPrivacyState>(() =>
    snapshotPrivacyState.value ?? provisionalPrivacyState({
      enabled: enabled.value,
      allowedApps: allowedApps.value,
      pauseUntil: pauseUntil.value,
      now: new Date(),
    }))

  const isEffectivelyObserving = computed(() => privacyState.value === 'observing')
  const statusLabelKey = computed(() => privacyStateLabelKey(privacyState.value))

  const activeTasks = computed(() => tasks.value.filter(task => task.status === 'active' || task.status === 'paused'))
  const stableHabitFacets = computed(() => habitFacets.value.filter(facet => facet.status === 'stable'))
  const provisionalHabitFacets = computed(() => habitFacets.value.filter(facet => facet.status === 'provisional'))

  function applySettings(settings: ScreenObservationSettings) {
    enabled.value = settings.enabled
    allowedApps.value = [...settings.allowedApps]
    dailySummaryEnabled.value = settings.dailySummaryEnabled
    dailySummaryAtLocalTime.value = settings.dailySummaryAtLocalTime
  }

  function applySnapshot(snapshot: ScreenObservationSnapshot) {
    applySettings(snapshot.settings)
    tasks.value = snapshot.tasks
    observationLog.value = snapshot.latestSummaries
      .map(summary => filterSummaryForPrivacy(summary, privacyDenylist.value))
      .filter((summary): summary is ScreenObserverSummary => Boolean(summary))
    latestTouches.value = snapshot.latestTouches
    snapshotPrivacyState.value = snapshot.privacyState
  }

  /**
   * Applies the runtime's authoritative state (settings + resolved privacy
   * state). The runtime wins over renderer-persisted settings: it is the
   * component that actually gates capture, so the UI must never claim a
   * different observation state than the poller is in.
   */
  function applyRuntimeState(state: RuntimeObservationState): ScreenObservationContextUpdate[] {
    const previousTaskStateKey = taskStateContextKey(tasks.value, taskWorkingStates.value)
    applySettings(state.settings)
    pauseUntil.value = state.pauseUntil
    snapshotPrivacyState.value = state.privacyState
    observationSourceAvailable.value = state.observationSourceAvailable
    if (state.tasks)
      tasks.value = state.tasks
    if (state.taskWorkingStates)
      taskWorkingStates.value = state.taskWorkingStates
    if (state.minecontextConfig) {
      minecontextBaseUrl.value = state.minecontextConfig.baseUrl ?? ''
      screenshotCaptureEnabled.value = state.minecontextConfig.screenshotCaptureEnabled ?? false
      longMemoryPollIntervalMs.value = state.minecontextConfig.longMemoryPollIntervalMs ?? 30_000
      currentStatePollIntervalMs.value = state.minecontextConfig.currentStatePollIntervalMs ?? 15_000
    }
    return taskStateContextKey(tasks.value, taskWorkingStates.value) === previousTaskStateKey
      ? []
      : buildTaskStateContextUpdates(tasks.value, taskWorkingStates.value)
  }

  /** Inserts a captured summary at the head of the log, replacing any redelivered duplicate by id. */
  function applySummary(summary: ScreenObserverSummary): LongMemoryIngestionResult | undefined {
    const filtered = filterSummaryForPrivacy(summary, privacyDenylist.value)
    if (!filtered)
      return undefined

    const rest = observationLog.value.filter(entry => entry.id !== filtered.id)
    observationLog.value = [filtered, ...rest].slice(0, OBSERVATION_LOG_DISPLAY_CAP)

    return ingestLongMemorySummary(filtered)
  }

  function applyCurrentState(state: ScreenObservationCurrentState): ScreenObservationContextUpdate | undefined {
    if (!state.focusedApp || state.privacyState !== 'observing') {
      latestCurrentState.value = undefined
      return undefined
    }
    if (!isAllowedFocusedApp(state.focusedApp.appName, allowedApps.value)) {
      latestCurrentState.value = undefined
      return undefined
    }
    if (isDeniedObservationText({
      appName: state.focusedApp.appName,
      windowTitle: state.focusedApp.windowTitle,
    }, privacyDenylist.value)) {
      latestCurrentState.value = undefined
      return undefined
    }

    latestCurrentState.value = state
    return buildCurrentStateContextUpdate(state)
  }

  function ingestLongMemorySummary(summary: ScreenObserverSummary): LongMemoryIngestionResult | undefined {
    const candidate = candidateFromSummary(summary)
    if (candidate.facetKeys.length === 0)
      return undefined

    const duplicate = longMemoryCandidates.value.some(entry => entry.hash === candidate.hash)
    if (!duplicate)
      longMemoryCandidates.value = [candidate, ...longMemoryCandidates.value].slice(0, LONG_MEMORY_CANDIDATE_CAP)

    const { promotedFacets, provisionalFacets } = updateHabitFacets(candidate, new Date(candidate.capturedAt))
    const contextUpdate = duplicate ? undefined : buildLongMemoryContextUpdate(candidate, promotedFacets, provisionalFacets)

    return {
      candidate,
      contextUpdate,
      duplicate,
      promotedFacets,
      provisionalFacets,
    }
  }

  function updateHabitFacets(candidate: LongMemoryCandidate, now: Date) {
    const promotedFacets: HabitFacet[] = []
    const provisionalFacets: HabitFacet[] = []
    const nextFacets = [...habitFacets.value]

    for (const key of candidate.facetKeys) {
      if (forgottenFacetKeys.value.includes(key))
        continue

      const existingIndex = nextFacets.findIndex(facet => facet.key === key)
      const existing = existingIndex >= 0 ? nextFacets[existingIndex] : undefined
      const evidenceHashes = uniqueValues([...(existing?.evidenceHashes ?? []), candidate.hash])
      const evidenceCandidates = longMemoryCandidates.value.filter(entry => evidenceHashes.includes(entry.hash))
      const distinctDayCount = new Set(evidenceCandidates.map(entry => dayKey(entry.capturedAt))).size
      const evidenceCount = evidenceHashes.length
      const decayedCount = decayedEvidenceCount(evidenceCandidates, now)
      const stable = Boolean(existing?.pinned)
        || (evidenceCount >= STABLE_FACET_MIN_EVIDENCE
          && distinctDayCount >= STABLE_FACET_MIN_DAYS
          && decayedCount >= STABLE_FACET_MIN_DECAYED_EVIDENCE)
      const firstSeenAt = evidenceCandidates
        .map(entry => entry.capturedAt)
        .sort()[0] ?? candidate.capturedAt
      const lastSeenAt = evidenceCandidates
        .map(entry => entry.capturedAt)
        .sort()
        .at(-1) ?? candidate.capturedAt
      const appName = candidate.apps.find(app => stableFacetKey(app) === key) ?? existing?.label.replace('Recurring focus app: ', '') ?? 'Unknown app'
      const facet: HabitFacet = {
        key,
        kind: 'focus_app',
        label: `Recurring focus app: ${appName}`,
        status: stable ? 'stable' : 'provisional',
        evidenceCount,
        distinctDayCount,
        decayedEvidenceCount: decayedCount,
        halfLifeDays: FACET_HALF_LIFE_DAYS,
        firstSeenAt,
        lastSeenAt,
        evidenceHashes,
        pinned: existing?.pinned,
      }

      if (existingIndex >= 0)
        nextFacets[existingIndex] = facet
      else
        nextFacets.push(facet)

      if (facet.status === 'stable')
        promotedFacets.push(facet)
      else
        provisionalFacets.push(facet)
    }

    habitFacets.value = nextFacets
    return { promotedFacets, provisionalFacets }
  }

  /** Inserts a delivered touch at the head of the list, replacing any redelivered duplicate by id. */
  function applyTouch(touch: TouchEventPayload) {
    const rest = latestTouches.value.filter(entry => entry.id !== touch.id)
    latestTouches.value = [touch, ...rest].slice(0, TOUCH_DISPLAY_CAP)
  }

  function applyDailySummary(payload: DailySummaryPayload) {
    latestDailySummary.value = payload
  }

  function pinFacet(key: string) {
    habitFacets.value = habitFacets.value.map(facet => facet.key === key
      ? { ...facet, pinned: true, status: 'stable' }
      : facet)
  }

  function forgetFacet(key: string) {
    if (!forgottenFacetKeys.value.includes(key))
      forgottenFacetKeys.value = [...forgottenFacetKeys.value, key]

    habitFacets.value = habitFacets.value.filter(facet => facet.key !== key)
    longMemoryCandidates.value = longMemoryCandidates.value
      .map(candidate => ({ ...candidate, facetKeys: candidate.facetKeys.filter(facetKey => facetKey !== key) }))
      .filter(candidate => candidate.facetKeys.length > 0)
  }

  function clearLongMemoryEvidence() {
    longMemoryCandidates.value = []
    habitFacets.value = []
  }

  function forgetTaskStateEvidence(taskId?: string): ScreenObservationContextUpdate[] {
    const clearState = (state: TaskWorkingState): TaskWorkingState => ({
      ...state,
      evidenceChain: [],
      lastEvidenceAt: undefined,
    })

    taskWorkingStates.value = Object.fromEntries(
      Object.entries(taskWorkingStates.value).map(([id, state]) => [
        id,
        taskId && id !== taskId ? state : clearState(state),
      ]),
    )
    return buildTaskStateContextUpdates(tasks.value, taskWorkingStates.value)
  }

  function resetPrivacyDenylist() {
    privacyDenylist.value = defaultPrivacyDenylist()
  }

  function resetState() {
    enabled.reset()
    allowedApps.reset()
    dailySummaryEnabled.reset()
    dailySummaryAtLocalTime.reset()
    defaultTouchLevel.reset()
    autoPauseOnFocus.reset()
    onboardingCompleted.reset()
    privacyDenylist.reset()
    longMemoryCandidates.reset()
    habitFacets.reset()
    forgottenFacetKeys.reset()
    minecontextBaseUrl.reset()
    screenshotCaptureEnabled.reset()
    longMemoryPollIntervalMs.reset()
    currentStatePollIntervalMs.reset()
    tasks.value = []
    observationLog.value = []
    latestTouches.value = []
    latestDailySummary.value = undefined
    pauseUntil.value = undefined
    snapshotPrivacyState.value = undefined
    observationSourceAvailable.value = undefined
    latestCurrentState.value = undefined
    taskWorkingStates.value = {}
  }

  return {
    enabled,
    allowedApps,
    dailySummaryEnabled,
    dailySummaryAtLocalTime,
    defaultTouchLevel,
    autoPauseOnFocus,
    onboardingCompleted,
    privacyDenylist,
    longMemoryCandidates,
    habitFacets,
    stableHabitFacets,
    provisionalHabitFacets,
    forgottenFacetKeys,
    minecontextBaseUrl,
    screenshotCaptureEnabled,
    longMemoryPollIntervalMs,
    currentStatePollIntervalMs,
    tasks,
    activeTasks,
    observationLog,
    latestTouches,
    latestDailySummary,
    latestCurrentState,
    taskWorkingStates,
    pauseUntil,
    privacyState,
    isEffectivelyObserving,
    statusLabelKey,
    observationSourceAvailable,
    applySnapshot,
    applyRuntimeState,
    applySummary,
    applyCurrentState,
    applyTouch,
    applyDailySummary,
    pinFacet,
    forgetFacet,
    clearLongMemoryEvidence,
    forgetTaskStateEvidence,
    resetPrivacyDenylist,
    resetState,
  }
})
