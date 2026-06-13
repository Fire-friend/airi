import type {
  ObservationMode,
  PauseObservationRequest,
  ScreenObservationSettings,
  ScreenObserverPrivacyState,
  ScreenObserverSummary,
  Task,
  TouchEventPayload,
} from '@proj-airi/server-sdk-shared'

import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

/**
 * Live state of the Electron-main screen observation runtime.
 *
 * This is the desktop runtime's view (collection triggers, OS signals,
 * pause state, the local task registry the decide loop runs against) —
 * model shapes and touch decisions are owned by the server contract in
 * `@proj-airi/server-sdk-shared` and are not duplicated here.
 */
export interface ScreenObservationRuntimeState {
  settings: ScreenObservationSettings
  /** Resolved from settings + pause + OS suppression; single source of truth for tray and renderer badges. */
  privacyState: ScreenObserverPrivacyState
  /** ISO timestamp until which observation is manually paused, if any. */
  pauseUntil?: string
  /** OS-level focus suppression signals (fullscreen apps / active meetings force L0). */
  suppression: {
    isFullscreen: boolean
    isMeeting: boolean
  }
  /**
   * Whether the local screenpipe service responded to the last health check.
   * Undefined means observation is idle or the runtime is checking after a
   * settings change.
   */
  screenpipeAvailable?: boolean
  /** Native frame capture window status when the native backend is selected. */
  nativeCaptureStatus?: NativeScreenObservationCaptureStatus
  /** ISO timestamp of the most recent captured summary, if any. */
  latestSummaryAt?: string
  /** Tasks registered with the desktop runtime; the main-process decide loop runs against these. */
  tasks: Task[]
}

export type NativeScreenObservationVisionWorkloadId = 'screen:interpret' | 'screen:understand' | 'screen:ocr' | 'screen:ui-automation'

/**
 * Start request sent from Electron main to the hidden native frame capture window.
 */
export interface NativeScreenObservationCaptureStartRequest {
  mode: ObservationMode
  allowedApps: string[]
  intervalMs: number
  workloadId: NativeScreenObservationVisionWorkloadId
  publishContext: boolean
  maxWidth: number
  maxHeight: number
  quality: number
}

/**
 * Live status reported by the hidden native frame capture window.
 */
export interface NativeScreenObservationCaptureStatus {
  running: boolean
  sourceCount: number
  lastFrameAt?: string
  lastInterpretationAt?: string
  lastError?: string
}

/**
 * One captured frame after local VLM/OCR interpretation.
 */
export interface NativeScreenObservationFrameResult {
  id: string
  capturedAt: string
  sourceId: string
  sourceName: string
  displayId?: string
  width: number
  height: number
  text?: string
  error?: string
  confidence: number
}

export const electronScreenObservationGetState = defineInvokeEventa<ScreenObservationRuntimeState>('eventa:invoke:electron:screen-observation:get-state')
export const electronScreenObservationUpdateSettings = defineInvokeEventa<ScreenObservationRuntimeState, Partial<ScreenObservationSettings>>('eventa:invoke:electron:screen-observation:update-settings')
export const electronScreenObservationPause = defineInvokeEventa<ScreenObservationRuntimeState, PauseObservationRequest>('eventa:invoke:electron:screen-observation:pause')
export const electronScreenObservationResume = defineInvokeEventa<ScreenObservationRuntimeState>('eventa:invoke:electron:screen-observation:resume')
export const electronScreenObservationOpenDataFolder = defineInvokeEventa<{ path: string }>('eventa:invoke:electron:screen-observation:open-data-folder')
export const electronScreenObservationSelectDataFolder = defineInvokeEventa<{ path?: string }>('eventa:invoke:electron:screen-observation:select-data-folder')
export const electronScreenObservationNativeCaptureStart = defineInvokeEventa<NativeScreenObservationCaptureStatus, NativeScreenObservationCaptureStartRequest>('eventa:invoke:electron:screen-observation:native-capture:start')
export const electronScreenObservationNativeCaptureStop = defineInvokeEventa<NativeScreenObservationCaptureStatus>('eventa:invoke:electron:screen-observation:native-capture:stop')
export const electronScreenObservationNativeCaptureGetStatus = defineInvokeEventa<NativeScreenObservationCaptureStatus>('eventa:invoke:electron:screen-observation:native-capture:get-status')
/**
 * Registers (or replaces) a task with the desktop runtime. The renderer's
 * chat confirmation card builds the Task via the shared contract helpers and
 * hands it over here; the main process persists it and decides progress
 * touches against it on each capture tick.
 */
export const electronScreenObservationUpsertTask = defineInvokeEventa<ScreenObservationRuntimeState, { task: Task }>('eventa:invoke:electron:screen-observation:upsert-task')

export const electronScreenObservationStateChanged = defineEventa<ScreenObservationRuntimeState>('eventa:event:electron:screen-observation:state-changed')
export const electronScreenObservationSummaryCaptured = defineEventa<{ summary: ScreenObserverSummary }>('eventa:event:electron:screen-observation:summary-captured')
export const electronScreenObservationNativeFrameInterpreted = defineEventa<NativeScreenObservationFrameResult>('eventa:event:electron:screen-observation:native-frame-interpreted')
/** Broadcast for every touch the runtime delivers; renderers drive L1 role gestures and L2 notice content from this. */
export const electronScreenObservationTouchDelivered = defineEventa<TouchEventPayload>('eventa:event:electron:screen-observation:touch-delivered')
/** Emitted when the user clicks an L3 system notification; renderers navigate to the task details view. */
export const electronScreenObservationOpenTaskDetails = defineEventa<{ taskId: string }>('eventa:event:electron:screen-observation:open-task-details')
