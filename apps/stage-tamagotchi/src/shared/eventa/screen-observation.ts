import type {
  PauseObservationRequest,
  ScreenObservationSettings,
  ScreenObserverPrivacyState,
  ScreenObserverSummary,
  Task,
  TouchEventPayload,
} from '@proj-airi/server-sdk-shared'

import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

/**
 * Near-realtime snapshot of what is on screen right now.
 *
 * Emitted every ~15 s (the current-state poll cadence) from raw MineContext
 * screenshot contexts — no VLM synthesis, just OS-level app/window metadata.
 * Consumers that need synthesized activity understanding should listen to
 * `electronScreenObservationSummaryCaptured` instead.
 *
 * Requires: MineContext's capture module must be started with screenshot
 * capture enabled (`capture_interval: 5` in MineContext config). When capture
 * is disabled (the default), raw_context results are empty and this event is
 * not emitted.
 */
export interface ScreenObserverCurrentState {
  capturedAt: string
  privacyState: ScreenObserverPrivacyState
  focusedApp?: {
    appName: string
    windowTitle?: string
  }
}

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
  /** Whether the local observation source (MineContext) responded to the last health check. */
  observationSourceAvailable: boolean
  /** ISO timestamp of the most recent captured long-memory summary, if any. */
  latestSummaryAt?: string
  /** ISO timestamp of the most recent near-realtime current-state snapshot, if any. */
  latestCurrentStateAt?: string
  /** Tasks registered with the desktop runtime; the main-process decide loop runs against these. */
  tasks: Task[]
}

export const electronScreenObservationGetState = defineInvokeEventa<ScreenObservationRuntimeState>('eventa:invoke:electron:screen-observation:get-state')
export const electronScreenObservationUpdateSettings = defineInvokeEventa<ScreenObservationRuntimeState, Partial<ScreenObservationSettings>>('eventa:invoke:electron:screen-observation:update-settings')
export const electronScreenObservationPause = defineInvokeEventa<ScreenObservationRuntimeState, PauseObservationRequest>('eventa:invoke:electron:screen-observation:pause')
export const electronScreenObservationResume = defineInvokeEventa<ScreenObservationRuntimeState>('eventa:invoke:electron:screen-observation:resume')
/**
 * Registers (or replaces) a task with the desktop runtime. The renderer's
 * chat confirmation card builds the Task via the shared contract helpers and
 * hands it over here; the main process persists it and decides progress
 * touches against it on each capture tick.
 */
export const electronScreenObservationUpsertTask = defineInvokeEventa<ScreenObservationRuntimeState, { task: Task }>('eventa:invoke:electron:screen-observation:upsert-task')

export const electronScreenObservationStateChanged = defineEventa<ScreenObservationRuntimeState>('eventa:event:electron:screen-observation:state-changed')
export const electronScreenObservationSummaryCaptured = defineEventa<{ summary: ScreenObserverSummary }>('eventa:event:electron:screen-observation:summary-captured')
/**
 * Near-realtime current-state snapshot (raw_context track, ~15 s cadence).
 * Independent output from `electronScreenObservationSummaryCaptured` (long-memory
 * activity_context track, 30 s cadence). Do not mix these two tracks.
 */
export const electronScreenObservationCurrentStateCaptured = defineEventa<ScreenObserverCurrentState>('eventa:event:electron:screen-observation:current-state-captured')
/** Broadcast for every touch the runtime delivers; renderers drive L1 role gestures and L2 notice content from this. */
export const electronScreenObservationTouchDelivered = defineEventa<TouchEventPayload>('eventa:event:electron:screen-observation:touch-delivered')
/** Emitted when the user clicks an L3 system notification; renderers navigate to the task details view. */
export const electronScreenObservationOpenTaskDetails = defineEventa<{ taskId: string }>('eventa:event:electron:screen-observation:open-task-details')
