import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type {
  PauseObservationRequest,
  ScreenObservationSettings,
  ScreenObserverSummary,
  Task,
  TaskCompanionSignal,
  TaskObservationFrame,
  TaskWorkingState,
  TouchEventPayload,
} from '@proj-airi/server-sdk-shared'
import type { BrowserWindow } from 'electron'
import type { BaseIssue, BaseSchema, InferOutput } from 'valibot'

import type { ScreenObservationRuntimeState, ScreenObserverCurrentState } from '../../../../shared/eventa/screen-observation'
import type { I18n } from '../../../libs/i18n'
import type { NoticeWindowManager } from '../../../windows/notice'
import type { MineContextClient } from './minecontext'
import type { TouchInteractionLedgerEntry, TouchOutcome } from './runtime'

import { randomUUID } from 'node:crypto'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import {
  decideScreenObservationTouch,
  DEFAULT_DAILY_SUMMARY_LOCAL_TIME,
  DEFAULT_TASK_COMPANION_THRESHOLDS,
  resolveObservationPrivacyState,
  TOUCH_THROTTLE_WINDOW_MS,
  transitionTaskWorkingState,
} from '@proj-airi/server-sdk-shared'
import { globalShortcut, Notification } from 'electron'
import { array, boolean, check, maxLength, minLength, minValue, number, object, optional, picklist, pipe, record, regex, safeParse, string, summarize, trim } from 'valibot'

import {
  electronScreenObservationCurrentStateCaptured,
  electronScreenObservationForgetTaskStateEvidence,
  electronScreenObservationGetState,
  electronScreenObservationOpenTaskDetails,
  electronScreenObservationPause,
  electronScreenObservationResume,
  electronScreenObservationStateChanged,
  electronScreenObservationSummaryCaptured,
  electronScreenObservationTouchDelivered,
  electronScreenObservationUpdateMineContextConfig,
  electronScreenObservationUpdateSettings,
  electronScreenObservationUpsertTask,
} from '../../../../shared/eventa/screen-observation'
import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'
import { createConfig } from '../../../libs/electron/persistence'
import { aggregateContextActivities, createMineContextClient } from './minecontext'
import {
  applyTouchOutcome,
  computePauseUntil,
  emptyLedgerEntry,
  formatTouchNotification,
  isDeniedByPrivacyDenylist,
  isMeetingSurface,
  recordTouchPresented,
  shouldCaptureScreen,
} from './runtime'

type EventaContext = ReturnType<typeof createContext>['context']

/**
 * Default long-memory poll: how often the observer queries MineContext for
 * new activity_context entries (VLM-synthesized, 10-minute cadence minimum).
 * 30 s keeps the loop responsive without hammering the API.
 */
const DEFAULT_LONG_MEMORY_POLL_MS = 30_000

/**
 * Default current-state poll: how often the observer queries MineContext for
 * new raw_context entries (individual screenshots, ~5 s capture cadence when
 * MineContext capture is enabled). 15 s gives near-realtime app/window updates.
 *
 * Requires MineContext to be started with screenshot capture enabled:
 *   capture_interval: 5  # in MineContext config/config.yaml
 * Without this, raw_context results are empty and no current-state events fire.
 */
const DEFAULT_CURRENT_STATE_POLL_MS = 15_000

/** Default accelerator for the global "pause observation" shortcut; users can override or clear it in settings. */
const DEFAULT_PAUSE_SHORTCUT = 'CommandOrControl+Alt+P'

/** `HH:mm`, 24-hour clock — the only time-of-day format the contract accepts. */
const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/

const isoTimestampSchema = pipe(string(), check(value => Number.isFinite(new Date(value).getTime()), 'expected a parseable ISO timestamp'))

/**
 * One whitelisted app name as accepted over IPC: trimmed, non-empty, capped.
 * Renderer payloads are untrusted input — TypeScript types do not survive
 * the IPC boundary, so every field is re-validated at runtime here.
 */
const appNameSchema = pipe(string(), trim(), minLength(1), maxLength(128))

const settingsPatchSchema = object({
  enabled: optional(boolean()),
  mode: optional(picklist(['whitelist'])),
  allowedApps: optional(pipe(array(appNameSchema), maxLength(64))),
  dailySummaryEnabled: optional(boolean()),
  dailySummaryAtLocalTime: optional(pipe(string(), regex(LOCAL_TIME_PATTERN, 'expected HH:mm'))),
})

const minecontextConfigPatchSchema = object({
  baseUrl: optional(pipe(string(), trim(), minLength(1), maxLength(256))),
  screenshotCaptureEnabled: optional(boolean()),
  longMemoryPollIntervalMs: optional(pipe(number(), minValue(10_000))),
  currentStatePollIntervalMs: optional(pipe(number(), minValue(5_000))),
})

const pauseRequestSchema = object({
  reason: picklist(['manual_15m', 'manual_1h', 'manual_today', 'fullscreen', 'meeting']),
  pauseUntil: optional(isoTimestampSchema),
})

const taskSentenceSchema = pipe(string(), trim(), maxLength(500))

const taskSchema = object({
  id: pipe(string(), trim(), minLength(1), maxLength(64)),
  userId: pipe(string(), maxLength(128)),
  title: pipe(string(), trim(), minLength(1), maxLength(200)),
  status: picklist(['draft', 'active', 'paused', 'completed', 'cancelled', 'archived']),
  priority: picklist(['low', 'normal', 'high', 'urgent']),
  goal: pipe(string(), trim(), maxLength(500)),
  progressNarrative: optional(object({
    remainingWork: taskSentenceSchema,
    etaAt: optional(isoTimestampSchema),
    pace: optional(taskSentenceSchema),
    isOffTrack: boolean(),
  })),
  schedule: object({
    startsAt: optional(isoTimestampSchema),
    dueAt: optional(isoTimestampSchema),
    timezone: pipe(string(), maxLength(64)),
    workWindow: optional(object({
      startLocalTime: pipe(string(), regex(LOCAL_TIME_PATTERN, 'expected HH:mm')),
      endLocalTime: pipe(string(), regex(LOCAL_TIME_PATTERN, 'expected HH:mm')),
    })),
    dailySummaryAtLocalTime: pipe(string(), regex(LOCAL_TIME_PATTERN, 'expected HH:mm')),
  }),
  observation: object({
    enabled: boolean(),
    mode: picklist(['whitelist']),
    allowedApps: pipe(array(appNameSchema), maxLength(64)),
    pauseUntil: optional(isoTimestampSchema),
    privacyState: picklist(['observing', 'paused', 'not_observing_empty_whitelist', 'suppressed_fullscreen', 'suppressed_meeting', 'disabled']),
    isEffectivelyObserving: boolean(),
  }),
  touchPolicy: object({
    level: picklist(['L0', 'L1', 'L2', 'L3']),
    firstTaskFirstProgressUsesL2: boolean(),
    dailySummaryEnabled: boolean(),
  }),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
})

const upsertTaskRequestSchema = object({ task: taskSchema })
const forgetTaskStateEvidenceRequestSchema = object({ taskId: optional(pipe(string(), trim(), minLength(1), maxLength(64))) })

const taskObservationEvidenceSchema = object({
  kind: picklist(['semantic_progress', 'subgoal_progress', 'new_task_artifact', 'repeated_error', 'search_doc_loop', 'no_progress', 'semantic_blocker', 'off_task']),
  description: string(),
  fingerprint: optional(string()),
  weight: optional(number()),
  capturedAt: optional(string()),
  summaryId: optional(string()),
})

const taskWorkingStateSchema = object({
  taskId: string(),
  state: picklist(['idle', 'progressing', 'possibly_stuck', 'stuck', 'off_task']),
  progressScore: number(),
  stuckScore: number(),
  evidenceChain: array(taskObservationEvidenceSchema),
  lastProgressAt: optional(string()),
  lastEvidenceAt: optional(string()),
  stuckStartedAt: optional(string()),
  lastNudgeAt: optional(string()),
  mutedUntil: optional(string()),
  episodeId: optional(string()),
})

const screenObservationConfigSchema = object({
  enabled: optional(boolean()),
  allowedApps: optional(array(string())),
  pauseUntil: optional(string()),
  dailySummaryEnabled: optional(boolean()),
  dailySummaryAtLocalTime: optional(string()),
  pauseShortcutAccelerator: optional(string()),
  /**
   * Base URL of the local MineContext service.
   * @default 'http://127.0.0.1:1733'
   */
  minecontextBaseUrl: optional(pipe(string(), trim(), minLength(1), maxLength(256))),
  /**
   * Whether the near-realtime current-state track is active.
   * Requires MineContext screenshot capture to be configured.
   * @default false
   */
  screenshotCaptureEnabled: optional(boolean()),
  /**
   * Long-memory poll interval in ms (activity_context track).
   * Must be ≥ 10 000. Defaults to 30 000 (30 s).
   */
  longMemoryPollIntervalMs: optional(pipe(number(), minValue(10_000))),
  /**
   * Near-realtime current-state poll interval in ms (raw_context track).
   * Must be ≥ 5 000. Defaults to 15 000 (15 s).
   * Meaningful only when MineContext screenshot capture is enabled.
   */
  currentStatePollIntervalMs: optional(pipe(number(), minValue(5_000))),
  // Tasks registered with the desktop runtime; the decide loop runs against these.
  tasks: optional(record(string(), taskSchema)),
  // Set once the very first progress touch was ever delivered; drives the
  // cold-start "first task's first progress goes L2" rule.
  firstTaskProgressDelivered: optional(boolean()),
  // Per-task touch reaction ledger; persisted so the frozen "ignored twice
  // at the same level -> downgrade" rule survives restarts.
  touchLedger: optional(record(string(), object({
    ignoredLevel: optional(picklist(['L0', 'L1', 'L2', 'L3'])),
    ignoredCount: number(),
    mutedAt: optional(string()),
    lastL2PlusTouchAt: optional(string()),
    lastDecidedAt: optional(string()),
    firstProgressDeliveredAt: optional(string()),
  }))),
  // The task currently in "active companion" mode (MVP: one at a time).
  activeTaskId: optional(string()),
  // Per-task companion working state; survives restarts so stuck-score
  // accumulates across sessions.
  taskWorkingStates: optional(record(string(), taskWorkingStateSchema)),
})

type ScreenObservationConfig = InferOutput<typeof screenObservationConfigSchema>

/**
 * Parses an untrusted IPC payload, throwing a TypeError that surfaces to the
 * invoking renderer when the payload does not match the runtime schema.
 */
function parseIpcPayload<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema, payload: unknown, what: string): InferOutput<TSchema> {
  const result = safeParse(schema, payload)
  if (!result.success)
    throw new TypeError(`Invalid ${what} payload: ${summarize(result.issues)}`)
  return result.output
}

export interface ScreenObserverService {
  /**
   * Register a per-window eventa context, mirroring the global-shortcut
   * service pattern: invoke handlers are installed on the context, outbound
   * events broadcast to every registered context. Auto-removes on close.
   */
  registerWindow: (params: { context: EventaContext, window: BrowserWindow }) => void
  getState: () => ScreenObservationRuntimeState
  pause: (request: PauseObservationRequest) => ScreenObservationRuntimeState
  resume: () => ScreenObservationRuntimeState
  updateSettings: (patch: Partial<ScreenObservationSettings>) => ScreenObservationRuntimeState
  /**
   * Registers (or replaces) a task in the runtime's persisted registry; the
   * per-tick decide loop runs against active tasks from here.
   */
  upsertTask: (task: Task) => ScreenObservationRuntimeState
  /** Clears task-companion evidence chains from persisted runtime state. */
  forgetTaskStateEvidence: (request?: { taskId?: string }) => ScreenObservationRuntimeState
  /**
   * Presents a decided touch on the desktop. The touch DECISION is shared
   * pure logic (`decideScreenObservationTouch`); this only routes by level:
   * L0-L2 broadcast to renderers (role gesture / notice window), L3
   * additionally raises a system notification that never steals focus and
   * never opens a modal.
   */
  deliverTouch: (touch: TouchEventPayload) => void
  /** External OS signals (e.g. a future native fullscreen probe) feed suppression here. */
  setSuppressionSignals: (signals: { isFullscreen?: boolean, isMeeting?: boolean }) => void
  /**
   * Reads a task's touch reaction state for the shared decide call: fields
   * map onto `DecideTouchInput.lastL2PlusTouchAt` / `ignoredTouchesAtSameLevel`,
   * and `muted` means the user asked to stop reminders for this task.
   */
  getTouchInteraction: (taskId: string) => TouchInteractionLedgerEntry & { muted: boolean }
  /** Subscribe to resolved state changes; the tray uses this to rebuild its menu. */
  onStateChanged: (callback: (state: ScreenObservationRuntimeState) => void) => () => void
  /** Subscribe to L3 notification clicks; the composition root brings a window to front. */
  onOpenTaskDetails: (callback: (taskId: string) => void) => () => void
  dispose: () => void
}

export interface SetupScreenObserverOptions {
  i18n: I18n
  /** Presents L2 task-touch toasts and reports the chosen action (frozen renderer seam). */
  noticeWindow: Pick<NoticeWindowManager, 'openTaskTouch'>
  /** Injected for tests; defaults to a localhost MineContext client. */
  minecontext?: MineContextClient
}

/**
 * Boots the desktop screen-observation runtime in the Electron main process.
 *
 * Use when:
 * - Composing the main process (injeca provider); exactly one instance should
 *   exist per app.
 *
 * Expects:
 * - MineContext may be absent; the runtime degrades to `observationSourceAvailable:
 *   false` and keeps re-checking on each poll tick.
 *
 * Returns:
 * - A {@link ScreenObserverService} owning the poll loop, pause state, the
 *   global pause shortcut, and L3 notification presentation.
 *
 * Call stack:
 *
 * setupScreenObserver (main composition root)
 *   -> {@link createMineContextClient}
 *   -> poll tick
 *     -> resolveObservationPrivacyState (@proj-airi/server-sdk-shared) / {@link shouldCaptureScreen}
 *     -> {@link aggregateContextActivities}
 *     -> broadcast {@link electronScreenObservationSummaryCaptured}
 */
export function setupScreenObserver(options: SetupScreenObserverOptions): ScreenObserverService {
  const log = useLogg('screen-observer').useGlobalConfig()

  const config = createConfig('screen-observation', 'options.json', screenObservationConfigSchema, {
    default: {},
    autoHeal: true,
  })
  config.setup()

  const contexts = new Set<EventaContext>()
  const stateListeners = new Set<(state: ScreenObservationRuntimeState) => void>()
  const openTaskDetailsListeners = new Set<(taskId: string) => void>()

  const suppression = { isFullscreen: false, isMeeting: false }
  // In-memory frame buffer: last evidenceChainCap frames per task, not persisted.
  // Feeds the companion's repeated-fingerprint and search-loop detectors.
  const recentFrames = new Map<string, TaskObservationFrame[]>()
  let observationSourceAvailable = false
  let latestSummaryAt: string | undefined
  let latestCurrentStateAt: string | undefined
  let lastCaptureEndedAt: Date | undefined
  let lastCurrentStateEndedAt: Date | undefined
  let registeredAccelerator: string | undefined
  let longMemoryPollTimer: ReturnType<typeof setInterval> | undefined
  let currentStatePollTimer: ReturnType<typeof setInterval> | undefined
  let ticking = false
  let currentStateTicking = false

  // When no injected client is provided (the normal production path), read the
  // base URL from persisted config at each call so users can change it in settings
  // without restarting the app. A test-injected client bypasses this lookup.
  function getMineContextClient(): MineContextClient {
    if (options.minecontext)
      return options.minecontext
    return createMineContextClient({ baseUrl: getConfig().minecontextBaseUrl })
  }

  function getConfig(): ScreenObservationConfig {
    return config.get() ?? {}
  }

  function settingsFromConfig(stored: ScreenObservationConfig): ScreenObservationSettings {
    return {
      // Privacy first: the master switch defaults to OFF until the user
      // explicitly enables observation in settings (frozen product decision).
      enabled: stored.enabled ?? false,
      mode: 'whitelist',
      allowedApps: stored.allowedApps ?? [],
      dailySummaryEnabled: stored.dailySummaryEnabled ?? true,
      dailySummaryAtLocalTime: stored.dailySummaryAtLocalTime ?? DEFAULT_DAILY_SUMMARY_LOCAL_TIME,
    }
  }

  function resolveState(now = new Date()): ScreenObservationRuntimeState {
    const stored = getConfig()
    const settings = settingsFromConfig(stored)
    const privacyState = resolveObservationPrivacyState({
      enabled: settings.enabled,
      allowedApps: settings.allowedApps,
      pauseUntil: stored.pauseUntil,
      now,
      isFullscreen: suppression.isFullscreen,
      isMeeting: suppression.isMeeting,
    })

    return {
      settings,
      privacyState,
      pauseUntil: privacyState === 'paused' ? stored.pauseUntil : undefined,
      suppression: { ...suppression },
      observationSourceAvailable,
      latestSummaryAt,
      latestCurrentStateAt,
      tasks: Object.values(stored.tasks ?? {}),
      taskWorkingStates: stored.taskWorkingStates ?? {},
      minecontextConfig: {
        baseUrl: stored.minecontextBaseUrl,
        screenshotCaptureEnabled: stored.screenshotCaptureEnabled ?? false,
        longMemoryPollIntervalMs: stored.longMemoryPollIntervalMs ?? DEFAULT_LONG_MEMORY_POLL_MS,
        currentStatePollIntervalMs: stored.currentStatePollIntervalMs ?? DEFAULT_CURRENT_STATE_POLL_MS,
      },
    }
  }

  let lastBroadcastState: ScreenObservationRuntimeState = resolveState()

  function broadcast(emit: (context: EventaContext) => void) {
    for (const context of contexts) {
      try {
        emit(context)
      }
      catch (error) {
        log.withError(error).warn('Failed to broadcast screen observation event')
      }
    }
  }

  function publishStateIfChanged() {
    const next = resolveState()
    const changed = JSON.stringify(next) !== JSON.stringify(lastBroadcastState)
    lastBroadcastState = next
    if (!changed)
      return next

    broadcast(context => context.emit(electronScreenObservationStateChanged, next))
    for (const listener of stateListeners) {
      try {
        listener(next)
      }
      catch (error) {
        log.withError(error).warn('screen observation state listener failed')
      }
    }
    return next
  }

  function persist(patch: Partial<ScreenObservationConfig>) {
    config.update({ ...getConfig(), ...patch })
  }

  const pause: ScreenObserverService['pause'] = (request) => {
    const pauseUntil = computePauseUntil(request, new Date())
    persist({ pauseUntil: pauseUntil.toISOString() })
    log.log(`Screen observation paused until ${pauseUntil.toISOString()} (${request.reason})`)
    return publishStateIfChanged()
  }

  const resume: ScreenObserverService['resume'] = () => {
    persist({ pauseUntil: undefined })
    log.log('Screen observation resumed')
    return publishStateIfChanged()
  }

  const updateSettings: ScreenObserverService['updateSettings'] = (patch) => {
    // Undefined patch fields must not erase stored values, so merge per-field
    // instead of spreading the whole patch.
    const stored = getConfig()
    persist({
      enabled: patch.enabled ?? stored.enabled,
      allowedApps: patch.allowedApps ? dedupeAppNames(patch.allowedApps) : stored.allowedApps,
      dailySummaryEnabled: patch.dailySummaryEnabled ?? stored.dailySummaryEnabled,
      dailySummaryAtLocalTime: patch.dailySummaryAtLocalTime ?? stored.dailySummaryAtLocalTime,
    })
    return publishStateIfChanged()
  }

  const upsertTask: ScreenObserverService['upsertTask'] = (task) => {
    const stored = getConfig()
    const patch: Partial<ScreenObservationConfig> = { tasks: { ...stored.tasks, [task.id]: task } }
    if (task.status === 'active')
      patch.activeTaskId = task.id
    else if (stored.activeTaskId === task.id)
      patch.activeTaskId = undefined
    persist(patch)
    return publishStateIfChanged()
  }

  const forgetTaskStateEvidence: ScreenObserverService['forgetTaskStateEvidence'] = (request = {}) => {
    const stored = getConfig()
    const states = stored.taskWorkingStates ?? {}
    const clearState = (state: TaskWorkingState): TaskWorkingState => ({
      ...state,
      evidenceChain: [],
      lastEvidenceAt: undefined,
    })

    if (request.taskId) {
      const state = states[request.taskId]
      if (!state)
        return publishStateIfChanged()
      persist({
        taskWorkingStates: {
          ...states,
          [request.taskId]: clearState(state),
        },
      })
      return publishStateIfChanged()
    }

    persist({
      taskWorkingStates: Object.fromEntries(
        Object.entries(states).map(([taskId, state]) => [taskId, clearState(state)]),
      ),
    })
    return publishStateIfChanged()
  }

  async function captureWindowSummary(now: Date): Promise<ScreenObserverSummary | undefined> {
    const { settings, privacyState } = lastBroadcastState
    const longMemoryPollMs = getConfig().longMemoryPollIntervalMs ?? DEFAULT_LONG_MEMORY_POLL_MS
    const windowStart = lastCaptureEndedAt ?? new Date(now.getTime() - longMemoryPollMs)

    const activities = await getMineContextClient().getActivities({ since: windowStart })

    // Waterline advances even when no activities arrived: avoids re-querying
    // the same window and accumulating stale contexts on the next tick.
    lastCaptureEndedAt = now

    const apps = aggregateContextActivities(activities, settings.allowedApps)
    if (apps.length === 0)
      return undefined

    const overview = apps.map(app => `${app.appName} (${app.observedSeconds}s)`).join(', ')

    return {
      id: randomUUID(),
      capturedAt: now.toISOString(),
      windowStartedAt: windowStart.toISOString(),
      windowEndedAt: now.toISOString(),
      source: 'minecontext',
      privacyState,
      apps,
      // Task matching is core-agent/server reasoning; the desktop runtime
      // only reports what was on screen.
      taskSignals: [],
      summary: `observed ${apps.length} app(s): ${overview}`,
      // Digest quality proxy: share of observed apps that yielded any text.
      confidence: apps.filter(app => app.summary.length > 0).length / apps.length,
    }
  }

  async function tick() {
    if (ticking)
      return
    ticking = true

    try {
      const now = new Date()
      const stored = getConfig()

      // Clear an expired manual pause so the stored config does not rot.
      if (stored.pauseUntil && new Date(stored.pauseUntil).getTime() <= now.getTime())
        persist({ pauseUntil: undefined })

      observationSourceAvailable = await getMineContextClient().health()

      const settings = settingsFromConfig(getConfig())
      if (observationSourceAvailable && settings.enabled) {
        // Metadata-only probe: app name / window title for meeting detection.
        const focused = await getMineContextClient().getFocusedApp()
        suppression.isMeeting = isMeetingSurface(focused?.appName, focused?.windowTitle)
      }
      else {
        suppression.isMeeting = false
      }

      const state = publishStateIfChanged()

      if (observationSourceAvailable && shouldCaptureScreen(state.privacyState)) {
        const summary = await captureWindowSummary(now)
        if (summary) {
          latestSummaryAt = summary.capturedAt
          broadcast(context => context.emit(electronScreenObservationSummaryCaptured, { summary }))
          publishStateIfChanged()
          decideProgressTouches(summary, now)

          // C2: task-companion inference for the single activeTask.
          // Privacy / suppression already cleared by shouldCaptureScreen() above.
          const storedCfg = getConfig()
          const activeTask = storedCfg.activeTaskId
            ? (storedCfg.tasks ?? {})[storedCfg.activeTaskId]
            : undefined
          if (activeTask && activeTask.status === 'active') {
            const frame = buildObservationFrame(summary, activeTask, now)
            if (frame) {
              const signal = runTaskCompanion(frame, activeTask, now)
              publishStateIfChanged()
              decideCompanionTouch(signal, activeTask, summary.id, now)
            }
          }
        }
      }
    }
    catch (error) {
      log.withError(error).warn('screen observation tick failed')
    }
    finally {
      ticking = false
    }
  }

  /**
   * Near-realtime track: queries MineContext raw_context (individual screenshot
   * captures) and emits `electronScreenObservationCurrentStateCaptured`.
   *
   * This is independent from the long-memory tick — do not mix results from
   * these two tracks. Current state carries no VLM semantics; it only surfaces
   * which app/window is focused right now based on raw OS screenshot metadata.
   *
   * Silently skips when:
   * - MineContext is unreachable (observationSourceAvailable = false)
   * - Observation is disabled or suppressed
   * - raw_context results are empty (MineContext capture module not enabled)
   */
  function restartTimers() {
    if (longMemoryPollTimer) {
      clearInterval(longMemoryPollTimer)
      longMemoryPollTimer = undefined
    }
    if (currentStatePollTimer) {
      clearInterval(currentStatePollTimer)
      currentStatePollTimer = undefined
    }
    const stored = getConfig()
    const longMs = stored.longMemoryPollIntervalMs ?? DEFAULT_LONG_MEMORY_POLL_MS
    const currentMs = stored.currentStatePollIntervalMs ?? DEFAULT_CURRENT_STATE_POLL_MS
    longMemoryPollTimer = setInterval(() => void tick(), longMs)
    currentStatePollTimer = setInterval(() => void currentStateTick(), currentMs)
  }

  async function currentStateTick() {
    if (currentStateTicking)
      return
    currentStateTicking = true
    try {
      // Fast track guards: skip if screenshot capture is disabled, MineContext is down, or observation is off.
      if (!getConfig().screenshotCaptureEnabled)
        return
      if (!observationSourceAvailable)
        return
      const settings = settingsFromConfig(getConfig())
      if (!settings.enabled)
        return
      if (!shouldCaptureScreen(lastBroadcastState.privacyState))
        return

      const now = new Date()
      const currentStatePollMs = getConfig().currentStatePollIntervalMs ?? DEFAULT_CURRENT_STATE_POLL_MS
      const windowStart = lastCurrentStateEndedAt ?? new Date(now.getTime() - currentStatePollMs)

      const rawContexts = await getMineContextClient().getActivities({
        since: windowStart,
        limit: 20,
        contextType: 'raw_context',
      })
      lastCurrentStateEndedAt = now

      if (rawContexts.length === 0)
        return

      // Pick the most recently captured screenshot context.
      const sorted = [...rawContexts].sort((a, b) => {
        const normalize = (t: string) => t.includes('T') ? t : t.replace(' ', 'T')
        return new Date(normalize(b.create_time)).getTime() - new Date(normalize(a.create_time)).getTime()
      })
      const latest = sorted[0]!
      const screenshotRc = latest.raw_contexts?.find(rc => rc.source === 'screenshot')
      const rawApp = screenshotRc?.additional_info?.app
      const rawWindow = screenshotRc?.additional_info?.window

      const currentState: ScreenObserverCurrentState = {
        capturedAt: now.toISOString(),
        privacyState: lastBroadcastState.privacyState,
        focusedApp: rawApp ? { appName: rawApp as string, windowTitle: rawWindow as string | undefined } : undefined,
      }

      latestCurrentStateAt = currentState.capturedAt
      broadcast(context => context.emit(electronScreenObservationCurrentStateCaptured, currentState))
      publishStateIfChanged()

      // C2: fast-track companion update — window fingerprint feeds the
      // repeated-fingerprint detector so stuck score accumulates between
      // long-memory ticks. No touch is dispatched here; only the long-memory
      // tick drives touch decisions to avoid noise from transient snapshots.
      const storedCfg = getConfig()
      const activeTask = storedCfg.activeTaskId
        ? (storedCfg.tasks ?? {})[storedCfg.activeTaskId]
        : undefined
      if (activeTask && activeTask.status === 'active') {
        const frame = buildCurrentStateFrame(currentState, activeTask, now)
        if (frame) {
          runTaskCompanion(frame, activeTask, now)
          publishStateIfChanged()
        }
      }
    }
    catch (error) {
      log.withError(error).warn('current state tick failed')
    }
    finally {
      currentStateTicking = false
    }
  }

  function registerPauseShortcut() {
    const stored = getConfig()
    // An explicitly empty accelerator disables the shortcut.
    const accelerator = stored.pauseShortcutAccelerator ?? DEFAULT_PAUSE_SHORTCUT
    if (!accelerator)
      return

    try {
      const ok = globalShortcut.register(accelerator, () => {
        const state = resolveState()
        if (state.privacyState === 'paused')
          resume()
        else if (state.privacyState === 'observing')
          pause({ reason: 'manual_1h' })
        // Disabled / empty whitelist / suppressed: nothing sensible to toggle.
      })
      if (ok)
        registeredAccelerator = accelerator
      else
        log.warn(`Pause shortcut "${accelerator}" is held by another application`)
    }
    catch (error) {
      log.withError(error).warn(`Failed to register pause shortcut "${accelerator}"`)
    }
  }

  function ledgerEntryFor(taskId: string): TouchInteractionLedgerEntry {
    return getConfig().touchLedger?.[taskId] ?? emptyLedgerEntry()
  }

  function saveLedgerEntry(taskId: string, entry: TouchInteractionLedgerEntry) {
    persist({ touchLedger: { ...getConfig().touchLedger, [taskId]: entry } })
  }

  function notifyOpenTaskDetails(taskId: string) {
    broadcast(context => context.emit(electronScreenObservationOpenTaskDetails, { taskId }))
    for (const listener of openTaskDetailsListeners) {
      try {
        listener(taskId)
      }
      catch (error) {
        log.withError(error).warn('open-task-details listener failed')
      }
    }
  }

  async function presentTaskTouchNotice(touch: TouchEventPayload) {
    const action = await options.noticeWindow.openTaskTouch(touch)
    const outcome: TouchOutcome = action
      ? { kind: 'action', action }
      : { kind: 'ignored', level: touch.level }
    saveLedgerEntry(touch.taskId, applyTouchOutcome(ledgerEntryFor(touch.taskId), outcome, new Date()))

    if (action === 'details')
      notifyOpenTaskDetails(touch.taskId)
  }

  /**
   * Normalizes a renderer-supplied app whitelist.
   *
   * Before:
   * - [' Code ', 'code', 'Slack']
   *
   * After:
   * - ['Code', 'Slack'] (first spelling wins; duplicates compared case-insensitively)
   */
  function dedupeAppNames(appNames: string[]): string[] {
    const seen = new Set<string>()
    return appNames.filter((appName) => {
      const key = appName.toLowerCase()
      if (seen.has(key))
        return false
      seen.add(key)
      return true
    })
  }

  const deliverTouch: ScreenObserverService['deliverTouch'] = (touch) => {
    // Data plane: long-lived renderers (dashboard, task cards) always get the
    // touch, independent of whether anything is presented below.
    broadcast(context => context.emit(electronScreenObservationTouchDelivered, touch))

    const entry = ledgerEntryFor(touch.taskId)
    // "Don't remind me about this again": data still flows, presentation stops.
    if (entry.mutedAt)
      return

    if (touch.level === 'L2') {
      saveLedgerEntry(touch.taskId, recordTouchPresented(entry, touch.level, new Date()))
      presentTaskTouchNotice(touch).catch(error => log.withError(error).warn('Failed to present task-touch notice'))
      return
    }

    if (touch.level !== 'L3')
      return

    if (!Notification.isSupported()) {
      // Platforms without system notifications still get touched: fall back
      // to the L2 notice toast, and stamp the throttle clock either way so
      // the 30-minute L2+ limit cannot be bypassed by repeated L3 decisions.
      log.warn('System notifications unsupported; presenting L3 touch as an L2 notice instead')
      saveLedgerEntry(touch.taskId, recordTouchPresented(entry, touch.level, new Date()))
      presentTaskTouchNotice(touch).catch(error => log.withError(error).warn('Failed to present L3 fallback notice'))
      return
    }

    saveLedgerEntry(touch.taskId, recordTouchPresented(entry, touch.level, new Date()))

    const content = formatTouchNotification(touch.message, (key, named) => options.i18n.t(key, named))
    // Plain OS notification: Electron notifications do not steal focus and
    // there is deliberately no modal fallback (frozen interaction rule).
    const notification = new Notification({ title: content.title, body: content.body })
    notification.on('click', () => {
      // A click is an engagement, equivalent to choosing "details".
      saveLedgerEntry(touch.taskId, applyTouchOutcome(ledgerEntryFor(touch.taskId), { kind: 'action', action: 'details' }, new Date()))
      notifyOpenTaskDetails(touch.taskId)
    })
    // NOTICE:
    // L3 notifications that receive no click are NOT counted as ignores.
    // Root cause: Electron's Notification 'close' event fires inconsistently
    // across platforms (macOS only on explicit dismissal, Windows/Linux vary),
    // so silence is indistinguishable from "still sitting in the center".
    // Source: electron docs Notification events; platform behavior notes.
    // Removal condition: count L3 ignores once a reliable dismissal signal
    // exists (e.g. notification center APIs or an in-app fallback surface).
    notification.show()
  }

  /**
   * Converts a long-memory summary into a `TaskObservationFrame` bound to `task`.
   *
   * Returns `undefined` when:
   * - No summary apps match the task's `allowedApps` whitelist (off-task activity), OR
   * - All matched apps are denied by the privacy denylist / private-window filter.
   *
   * Privacy guarantee: `privacyFiltered: true` is only set after BOTH the
   * global `shouldCaptureScreen` gate AND the denylist / private-window check
   * have passed. Denylist or private content never reaches `runTaskCompanion`.
   */
  function buildObservationFrame(summary: ScreenObserverSummary, task: Task, now: Date): TaskObservationFrame | undefined {
    const taskApps = new Set(task.observation.allowedApps.map(a => a.toLowerCase()))
    const matchedApps = taskApps.size === 0
      ? summary.apps
      : summary.apps.filter(app => taskApps.has(app.appName.toLowerCase()))

    if (matchedApps.length === 0)
      return undefined

    // Privacy gate: reject denylist apps and private-window content BEFORE
    // any inference. Must run here — the renderer-layer denylist filter is
    // too late because `runTaskCompanion` writes to persisted task working state.
    if (isDeniedByPrivacyDenylist({ summary: summary.summary }))
      return undefined

    const allowedApps = matchedApps.filter(app => !isDeniedByPrivacyDenylist({
      appName: app.appName,
      windowTitle: app.windowTitle,
      summary: app.summary,
    }))
    if (allowedApps.length === 0)
      return undefined

    const topApp = allowedApps[0]!
    const windowFingerprint = topApp.windowTitle
      ? `${topApp.appName.toLowerCase()}:${topApp.windowTitle.toLowerCase()}`
      : topApp.appName.toLowerCase()

    return {
      taskId: task.id,
      capturedAt: now.toISOString(),
      summaryId: summary.id,
      appNames: allowedApps.map(app => app.appName),
      windowFingerprint,
      // Summary text feeds the C1 keyword detectors inside scoreTaskProgress /
      // scoreTaskStuck — no need to pre-compute evidence here.
      summary: allowedApps.map(app => app.summary).filter(Boolean).join(' '),
      confidence: summary.confidence,
      privacyFiltered: true,
    }
  }

  /**
   * Converts a near-realtime current-state snapshot into a lightweight frame.
   *
   * The fast track contributes no VLM semantics — summary is empty. Its value
   * is feeding window-fingerprint data to the repeated-fingerprint detector so
   * stuck evidence accumulates before the next long-memory tick.
   *
   * Returns `undefined` when:
   * - The focused app is absent,
   * - The app is outside the task whitelist, OR
   * - The app or window title is denied by the privacy denylist / private-window
   *   filter. Denied content must not contribute to task evidence or working state.
   */
  function buildCurrentStateFrame(currentState: ScreenObserverCurrentState, task: Task, now: Date): TaskObservationFrame | undefined {
    if (!currentState.focusedApp)
      return undefined

    const { appName, windowTitle } = currentState.focusedApp

    // Privacy gate: must run before whitelist check so a private-window
    // version of an allowed app (e.g. incognito Chrome) is still rejected.
    if (isDeniedByPrivacyDenylist({ appName, windowTitle }))
      return undefined

    const taskApps = new Set(task.observation.allowedApps.map(a => a.toLowerCase()))

    if (taskApps.size > 0 && !taskApps.has(appName.toLowerCase()))
      return undefined

    const windowFingerprint = windowTitle
      ? `${appName.toLowerCase()}:${windowTitle.toLowerCase()}`
      : appName.toLowerCase()

    return {
      taskId: task.id,
      capturedAt: now.toISOString(),
      appNames: [appName],
      windowFingerprint,
      summary: '',
      confidence: 0.5,
      privacyFiltered: true,
    }
  }

  /**
   * Runs the C1 task-companion kernel for `task` given a new observation `frame`.
   *
   * - Updates the in-memory `recentFrames` buffer (feeds repeated-fingerprint /
   *   search-loop detectors on the next call).
   * - Persists the new `TaskWorkingState` to config so stuck-score survives
   *   app restarts.
   * - Returns the `TaskCompanionSignal` for the caller to decide whether a touch
   *   is warranted.
   */
  function runTaskCompanion(frame: TaskObservationFrame, task: Task, now: Date): TaskCompanionSignal {
    const stored = getConfig()
    const previousState: TaskWorkingState | undefined = stored.taskWorkingStates?.[task.id]
    const taskRecentFrames = recentFrames.get(task.id) ?? []

    const { state: nextState, signal } = transitionTaskWorkingState({
      task,
      frame,
      recentFrames: taskRecentFrames,
      previousState,
      now,
    })

    // Cap the in-memory buffer at the same limit as the evidence chain.
    const frameCap = DEFAULT_TASK_COMPANION_THRESHOLDS.evidenceChainCap
    recentFrames.set(task.id, [...taskRecentFrames, frame].slice(-frameCap))

    persist({
      taskWorkingStates: {
        ...stored.taskWorkingStates,
        [task.id]: nextState,
      },
    })

    return signal
  }

  /**
   * Builds the `remainingWork` text for a stuck nudge from evidence priority.
   *
   * Prefers the most specific signal so the touch names what the model actually
   * saw ("repeated error surface for 12 minutes") instead of generic fallback copy.
   * Falls back to the task's existing progress narrative or an empty string when
   * no actionable evidence is present.
   */
  function buildStuckNudgeText(signal: TaskCompanionSignal, task: Task): string {
    const priority = ['semantic_blocker', 'search_doc_loop', 'repeated_error', 'no_progress'] as const
    const reversed = signal.evidence.slice().reverse()
    for (const kind of priority) {
      const entry = reversed.find(e => e.kind === kind)
      if (entry)
        return entry.description
    }
    return task.progressNarrative?.remainingWork ?? ''
  }

  /**
   * Dispatches a `task_blocked` touch when the companion signals that the user
   * is stuck and has not been nudged for this episode yet.
   *
   * Called after the long-memory tick only — the fast track updates working state
   * but does not trigger touches, to avoid noise from transient fingerprint matches.
   */
  function decideCompanionTouch(signal: TaskCompanionSignal, task: Task, summaryId: string, now: Date) {
    if (!signal.shouldNudge || signal.kind !== 'stuck_detected' || signal.recommendedTouchReason !== 'task_blocked')
      return

    const entry = ledgerEntryFor(task.id)
    if (entry.mutedAt)
      return

    const isFirstTaskForUser = !getConfig().firstTaskProgressDelivered

    const touch = decideScreenObservationTouch({
      id: randomUUID(),
      task,
      reason: 'task_blocked',
      message: {
        remainingWork: buildStuckNudgeText(signal, task),
        etaAt: task.progressNarrative?.etaAt,
        pace: task.progressNarrative?.pace,
        isOffTrack: true,
      },
      now,
      summaryId,
      lastL2PlusTouchAt: entry.lastL2PlusTouchAt ? new Date(entry.lastL2PlusTouchAt) : undefined,
      ignoredTouchesAtSameLevel: entry.ignoredCount,
      isFirstTaskForUser,
      isFirstProgressUpdateForTask: !entry.firstProgressDeliveredAt,
      isFullscreen: suppression.isFullscreen,
      isMeeting: suppression.isMeeting,
    })

    saveLedgerEntry(task.id, {
      ...entry,
      lastDecidedAt: now.toISOString(),
      firstProgressDeliveredAt: entry.firstProgressDeliveredAt ?? now.toISOString(),
    })
    if (isFirstTaskForUser)
      persist({ firstTaskProgressDelivered: true })

    deliverTouch(touch)
  }

  /**
   * The tick -> decide -> deliver bridge: runs the shared touch decision for
   * every active task after a capture, feeding it this runtime's interaction
   * ledger so the 30-minute throttle, the ignored-twice downgrade, and the
   * cold-start first-progress-L2 rule all act on the real end-to-end path.
   *
   * The decision cadence per task reuses the frozen 30-minute window: a task
   * is reconsidered at most once per window, so even L1 gestures cannot spam
   * every 30s tick.
   */
  function decideProgressTouches(summary: ScreenObserverSummary, now: Date) {
    const stored = getConfig()

    for (const task of Object.values(stored.tasks ?? {})) {
      if (task.status !== 'active')
        continue

      const entry = ledgerEntryFor(task.id)
      // Muted tasks are skipped at the decision stage, not just presentation.
      if (entry.mutedAt)
        continue
      if (entry.lastDecidedAt && now.getTime() - new Date(entry.lastDecidedAt).getTime() < TOUCH_THROTTLE_WINDOW_MS)
        continue

      // Re-read per task: with several active tasks in one tick, only the
      // first decided touch may claim the cold-start first-task L2 exception.
      const isFirstTaskForUser = !getConfig().firstTaskProgressDelivered

      const touch = decideScreenObservationTouch({
        id: randomUUID(),
        task,
        reason: 'task_progress',
        // The desktop runtime does not synthesize progress copy: the message
        // is the task's last known narrative (set by the chat layer); the
        // shared decide normalizer fills human-language fallbacks when empty.
        message: {
          remainingWork: task.progressNarrative?.remainingWork ?? '',
          etaAt: task.progressNarrative?.etaAt,
          pace: task.progressNarrative?.pace,
          isOffTrack: task.progressNarrative?.isOffTrack ?? false,
        },
        now,
        summaryId: summary.id,
        lastL2PlusTouchAt: entry.lastL2PlusTouchAt ? new Date(entry.lastL2PlusTouchAt) : undefined,
        ignoredTouchesAtSameLevel: entry.ignoredCount,
        isFirstTaskForUser,
        isFirstProgressUpdateForTask: !entry.firstProgressDeliveredAt,
        isFullscreen: suppression.isFullscreen,
        isMeeting: suppression.isMeeting,
      })

      saveLedgerEntry(task.id, {
        ...entry,
        lastDecidedAt: now.toISOString(),
        firstProgressDeliveredAt: entry.firstProgressDeliveredAt ?? now.toISOString(),
      })
      if (isFirstTaskForUser)
        persist({ firstTaskProgressDelivered: true })

      deliverTouch(touch)
    }
  }

  const registerWindow: ScreenObserverService['registerWindow'] = ({ context, window }) => {
    contexts.add(context)
    window.on('closed', () => {
      contexts.delete(context)
    })

    defineInvokeHandler(context, electronScreenObservationGetState, () => resolveState())
    defineInvokeHandler(context, electronScreenObservationUpdateSettings, patch => updateSettings(parseIpcPayload(settingsPatchSchema, patch ?? {}, 'screen observation settings')))
    defineInvokeHandler(context, electronScreenObservationUpdateMineContextConfig, (patch) => {
      const validated = parseIpcPayload(minecontextConfigPatchSchema, patch ?? {}, 'minecontext config')
      const stored = getConfig()
      const intervalsChanged = (validated.longMemoryPollIntervalMs !== undefined && validated.longMemoryPollIntervalMs !== stored.longMemoryPollIntervalMs)
        || (validated.currentStatePollIntervalMs !== undefined && validated.currentStatePollIntervalMs !== stored.currentStatePollIntervalMs)
      persist({
        minecontextBaseUrl: validated.baseUrl ?? stored.minecontextBaseUrl,
        screenshotCaptureEnabled: validated.screenshotCaptureEnabled ?? stored.screenshotCaptureEnabled,
        longMemoryPollIntervalMs: validated.longMemoryPollIntervalMs ?? stored.longMemoryPollIntervalMs,
        currentStatePollIntervalMs: validated.currentStatePollIntervalMs ?? stored.currentStatePollIntervalMs,
      })
      if (intervalsChanged)
        restartTimers()
      return publishStateIfChanged()
    })
    defineInvokeHandler(context, electronScreenObservationPause, request => pause(parseIpcPayload(pauseRequestSchema, request, 'screen observation pause')))
    defineInvokeHandler(context, electronScreenObservationResume, () => resume())
    defineInvokeHandler(context, electronScreenObservationUpsertTask, request => upsertTask(parseIpcPayload(upsertTaskRequestSchema, request, 'screen observation task').task))
    defineInvokeHandler(context, electronScreenObservationForgetTaskStateEvidence, request =>
      forgetTaskStateEvidence(parseIpcPayload(forgetTaskStateEvidenceRequestSchema, request ?? {}, 'screen observation task-state forget')))
  }

  const dispose: ScreenObserverService['dispose'] = () => {
    if (longMemoryPollTimer) {
      clearInterval(longMemoryPollTimer)
      longMemoryPollTimer = undefined
    }
    if (currentStatePollTimer) {
      clearInterval(currentStatePollTimer)
      currentStatePollTimer = undefined
    }
    if (registeredAccelerator) {
      try {
        globalShortcut.unregister(registeredAccelerator)
      }
      catch (error) {
        log.withError(error).warn('Failed to unregister pause shortcut')
      }
      registeredAccelerator = undefined
    }
    contexts.clear()
    stateListeners.clear()
    openTaskDetailsListeners.clear()
  }

  registerPauseShortcut()
  restartTimers()
  void tick()

  onAppBeforeQuit(() => dispose())

  return {
    registerWindow,
    getState: () => resolveState(),
    pause,
    resume,
    updateSettings,
    upsertTask,
    forgetTaskStateEvidence,
    deliverTouch,
    getTouchInteraction: (taskId) => {
      const entry = ledgerEntryFor(taskId)
      return { ...entry, muted: Boolean(entry.mutedAt) }
    },
    setSuppressionSignals: (signals) => {
      if (signals.isFullscreen !== undefined)
        suppression.isFullscreen = signals.isFullscreen
      if (signals.isMeeting !== undefined)
        suppression.isMeeting = signals.isMeeting
      publishStateIfChanged()
    },
    onStateChanged: (callback) => {
      stateListeners.add(callback)
      return () => stateListeners.delete(callback)
    },
    onOpenTaskDetails: (callback) => {
      openTaskDetailsListeners.add(callback)
      return () => openTaskDetailsListeners.delete(callback)
    },
    dispose,
  }
}
