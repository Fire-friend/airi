import type {
  DailySummaryPayload,
  ObservationMode,
  ScreenObservationCaptureBackend,
  ScreenObservationSettings,
  ScreenObservationSnapshot,
  ScreenObserverPrivacyState,
  ScreenObserverSummary,
  Task,
  TouchEventPayload,
  TouchLevel,
} from '@proj-airi/server-sdk-shared'

import { DEFAULT_DAILY_SUMMARY_LOCAL_TIME, DEFAULT_FRAME_CAPTURE_INTERVAL_MS, DEFAULT_TOUCH_LEVEL } from '@proj-airi/server-sdk-shared'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

/** Inputs for the renderer-side provisional privacy-state fallback. */
export interface ProvisionalPrivacyStateInput {
  enabled: boolean
  mode: ObservationMode
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
 *   renderer can know: disabled > application mode without apps > paused
 *   until future > observing.
 */
export function provisionalPrivacyState(input: ProvisionalPrivacyStateInput): ScreenObserverPrivacyState {
  if (!input.enabled)
    return 'disabled'
  if (input.mode === 'application' && input.allowedApps.length === 0)
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
  /** Whether the local screenpipe service responded to the last health check. */
  screenpipeAvailable?: boolean
  /** Hidden native frame capture window status, when native capture is selected. */
  nativeCaptureStatus?: {
    running: boolean
    sourceCount: number
    lastFrameAt?: string
    lastInterpretationAt?: string
    lastError?: string
  }
  /** ISO timestamp for the latest summary captured by the runtime, if any. */
  latestSummaryAt?: string
  /** Tasks registered with the runtime's decide loop; omitted payloads keep the current list. */
  tasks?: Task[]
}

/** Result returned after asking the active runtime to open screenpipe's local data directory. */
export interface ScreenObservationDataFolderResult {
  /** Absolute directory path passed to the host OS shell. */
  path: string
}

/** Runtime-provided command for opening screenpipe's local data directory. */
export type OpenScreenObservationDataFolder = () => Promise<ScreenObservationDataFolderResult>

/** Result returned after asking the active runtime to choose a screenpipe storage directory. */
export interface ScreenObservationDataFolderSelectionResult {
  /** Absolute directory path selected by the user; absent when the picker is cancelled. */
  path?: string
}

/** Runtime-provided command for selecting screenpipe's local data directory. */
export type SelectScreenObservationDataFolder = () => Promise<ScreenObservationDataFolderSelectionResult>

// Renderer-side display caps. The runtime owns durable history; these only
// bound what one window keeps in memory for the log/touch surfaces.
const OBSERVATION_LOG_DISPLAY_CAP = 200
const TOUCH_DISPLAY_CAP = 50

export const useScreenObservationStore = defineStore('screen-observation', () => {
  // Privacy-first defaults frozen in the product decision (issue AIR-5):
  // master switch off, desktop observation mode, daily summary on at 18:00, L1 touch.
  const enabled = useLocalStorageManualReset<boolean>('settings/screen-observation/enabled', false)
  const observationMode = useLocalStorageManualReset<ObservationMode>('settings/screen-observation/mode', 'desktop')
  const allowedApps = useLocalStorageManualReset<string[]>('settings/screen-observation/allowed-apps', [])
  const captureBackend = useLocalStorageManualReset<ScreenObservationCaptureBackend>('settings/screen-observation/capture-backend', 'native_frames')
  if (captureBackend.value !== 'native_frames')
    captureBackend.value = 'native_frames'
  const frameCaptureIntervalMs = useLocalStorageManualReset<number>('settings/screen-observation/frame-capture-interval-ms', DEFAULT_FRAME_CAPTURE_INTERVAL_MS)
  const dailySummaryEnabled = useLocalStorageManualReset<boolean>('settings/screen-observation/daily-summary-enabled', true)
  const dailySummaryAtLocalTime = useLocalStorageManualReset<string>('settings/screen-observation/daily-summary-at', DEFAULT_DAILY_SUMMARY_LOCAL_TIME)
  const screenpipeDataDirectory = useLocalStorageManualReset<string>('settings/screen-observation/screenpipe-data-directory', '')
  const defaultTouchLevel = useLocalStorageManualReset<TouchLevel>('settings/screen-observation/default-touch-level', DEFAULT_TOUCH_LEVEL)
  const autoPauseOnFocus = useLocalStorageManualReset<boolean>('settings/screen-observation/auto-pause-on-focus', true)
  const onboardingCompleted = useLocalStorageManualReset<boolean>('settings/screen-observation/onboarding-completed', false)

  // Runtime state. Hydrated by applySnapshot once the desktop runtime
  // (Electron main process ScreenObserver) pushes the authoritative
  // ScreenObservationSnapshot over Eventa; provisional before that.
  const tasks = ref<Task[]>([])
  const observationLog = ref<ScreenObserverSummary[]>([])
  const latestTouches = ref<TouchEventPayload[]>([])
  const latestDailySummary = ref<DailySummaryPayload>()
  const pauseUntil = ref<string>()
  const snapshotPrivacyState = ref<ScreenObserverPrivacyState>()
  const screenpipeAvailable = ref<boolean>()
  const nativeCaptureStatus = ref<RuntimeObservationState['nativeCaptureStatus']>()
  const latestSummaryAt = ref<string>()
  const openDataFolderHandler = shallowRef<OpenScreenObservationDataFolder>()
  const selectDataFolderHandler = shallowRef<SelectScreenObservationDataFolder>()

  const privacyState = computed<ScreenObserverPrivacyState>(() =>
    snapshotPrivacyState.value ?? provisionalPrivacyState({
      enabled: enabled.value,
      mode: observationMode.value,
      allowedApps: allowedApps.value,
      pauseUntil: pauseUntil.value,
      now: new Date(),
    }))

  const isEffectivelyObserving = computed(() => privacyState.value === 'observing')
  const statusLabelKey = computed(() => privacyStateLabelKey(privacyState.value))

  const activeTasks = computed(() => tasks.value.filter(task => task.status === 'active' || task.status === 'paused'))

  function applySettings(settings: ScreenObservationSettings) {
    enabled.value = settings.enabled
    observationMode.value = settings.mode
    allowedApps.value = [...settings.allowedApps]
    captureBackend.value = settings.captureBackend
    frameCaptureIntervalMs.value = settings.frameCaptureIntervalMs
    dailySummaryEnabled.value = settings.dailySummaryEnabled
    dailySummaryAtLocalTime.value = settings.dailySummaryAtLocalTime
    screenpipeDataDirectory.value = settings.screenpipeDataDirectory ?? ''
  }

  function applySnapshot(snapshot: ScreenObservationSnapshot) {
    applySettings(snapshot.settings)
    tasks.value = snapshot.tasks
    observationLog.value = snapshot.latestSummaries
    latestTouches.value = snapshot.latestTouches
    snapshotPrivacyState.value = snapshot.privacyState
    latestSummaryAt.value = snapshot.latestSummaries
      .map(summary => summary.capturedAt)
      .sort()
      .at(-1)
  }

  /**
   * Applies the runtime's authoritative state (settings + resolved privacy
   * state). The runtime wins over renderer-persisted settings: it is the
   * component that actually gates capture, so the UI must never claim a
   * different observation state than the poller is in.
   */
  function applyRuntimeState(state: RuntimeObservationState) {
    applySettings(state.settings)
    pauseUntil.value = state.pauseUntil
    snapshotPrivacyState.value = state.privacyState
    screenpipeAvailable.value = state.screenpipeAvailable
    nativeCaptureStatus.value = state.nativeCaptureStatus
    latestSummaryAt.value = state.latestSummaryAt
    if (state.tasks)
      tasks.value = state.tasks
  }

  function setOpenDataFolderHandler(handler?: OpenScreenObservationDataFolder) {
    openDataFolderHandler.value = handler
  }

  function setSelectDataFolderHandler(handler?: SelectScreenObservationDataFolder) {
    selectDataFolderHandler.value = handler
  }

  async function openDataFolder(): Promise<ScreenObservationDataFolderResult> {
    const handler = openDataFolderHandler.value
    if (!handler)
      throw new Error('Screen observation data folder opener is not available in this runtime.')
    return await handler()
  }

  async function selectDataFolder(): Promise<ScreenObservationDataFolderSelectionResult> {
    const handler = selectDataFolderHandler.value
    if (!handler)
      throw new Error('Screen observation data folder picker is not available in this runtime.')
    return await handler()
  }

  /** Inserts a captured summary at the head of the log, replacing any redelivered duplicate by id. */
  function applySummary(summary: ScreenObserverSummary) {
    const rest = observationLog.value.filter(entry => entry.id !== summary.id)
    observationLog.value = [summary, ...rest].slice(0, OBSERVATION_LOG_DISPLAY_CAP)
    if (!latestSummaryAt.value || summary.capturedAt >= latestSummaryAt.value)
      latestSummaryAt.value = summary.capturedAt
  }

  /** Inserts a delivered touch at the head of the list, replacing any redelivered duplicate by id. */
  function applyTouch(touch: TouchEventPayload) {
    const rest = latestTouches.value.filter(entry => entry.id !== touch.id)
    latestTouches.value = [touch, ...rest].slice(0, TOUCH_DISPLAY_CAP)
  }

  function applyDailySummary(payload: DailySummaryPayload) {
    latestDailySummary.value = payload
  }

  function resetState() {
    enabled.reset()
    observationMode.reset()
    allowedApps.reset()
    captureBackend.reset()
    frameCaptureIntervalMs.reset()
    dailySummaryEnabled.reset()
    dailySummaryAtLocalTime.reset()
    screenpipeDataDirectory.reset()
    defaultTouchLevel.reset()
    autoPauseOnFocus.reset()
    onboardingCompleted.reset()
    tasks.value = []
    observationLog.value = []
    latestTouches.value = []
    latestDailySummary.value = undefined
    pauseUntil.value = undefined
    snapshotPrivacyState.value = undefined
    screenpipeAvailable.value = undefined
    nativeCaptureStatus.value = undefined
    latestSummaryAt.value = undefined
  }

  return {
    enabled,
    observationMode,
    allowedApps,
    captureBackend,
    frameCaptureIntervalMs,
    dailySummaryEnabled,
    dailySummaryAtLocalTime,
    screenpipeDataDirectory,
    defaultTouchLevel,
    autoPauseOnFocus,
    onboardingCompleted,
    tasks,
    activeTasks,
    observationLog,
    latestTouches,
    latestDailySummary,
    pauseUntil,
    privacyState,
    isEffectivelyObserving,
    statusLabelKey,
    screenpipeAvailable,
    nativeCaptureStatus,
    latestSummaryAt,
    applySnapshot,
    applyRuntimeState,
    setOpenDataFolderHandler,
    setSelectDataFolderHandler,
    openDataFolder,
    selectDataFolder,
    applySummary,
    applyTouch,
    applyDailySummary,
    resetState,
  }
})
