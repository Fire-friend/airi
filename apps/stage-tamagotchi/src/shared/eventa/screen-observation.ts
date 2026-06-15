import type {
  PauseObservationRequest,
  ScreenObservationSettings,
  ScreenObserverPrivacyState,
  ScreenObserverSummary,
  Task,
  TaskWorkingState,
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
 * MineContext connection and polling configuration exposed to the renderer.
 *
 * These values are user-editable in settings and persisted by the main process.
 * The renderer reads them back via `ScreenObservationRuntimeState.minecontextConfig`.
 */
export interface MineContextConfig {
  /** Base URL of the local MineContext service. @default 'http://127.0.0.1:1733' */
  baseUrl?: string
  /**
   * Whether the near-realtime current-state track (raw_context polling) is
   * active. Requires MineContext to be started with screenshot capture enabled
   * in its config (`capture_interval: 5`). Off by default — users must
   * explicitly enable it after configuring MineContext.
   *
   * @default false
   */
  screenshotCaptureEnabled?: boolean
  /**
   * How often to query MineContext for new activity_context entries (long-memory
   * track). Must be ≥ 10 000 ms.
   *
   * @default 30000
   */
  longMemoryPollIntervalMs?: number
  /**
   * How often to query MineContext for new raw_context entries (current-state
   * track). Meaningful only when `screenshotCaptureEnabled` is true. Must be ≥
   * 5 000 ms.
   *
   * @default 15000
   */
  currentStatePollIntervalMs?: number
}

export interface ForgetTaskStateEvidenceRequest {
  taskId?: string
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
  /** Per-task companion state produced by C1/C2; evidence remains task-local and provisional. */
  taskWorkingStates: Record<string, TaskWorkingState>
  /** MineContext connection and polling config; the renderer reads this to populate the settings UI. */
  minecontextConfig: MineContextConfig
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
/** Clears task-companion evidence without deleting the task or promoting it into personality memory. */
export const electronScreenObservationForgetTaskStateEvidence = defineInvokeEventa<ScreenObservationRuntimeState, ForgetTaskStateEvidenceRequest>('eventa:invoke:electron:screen-observation:forget-task-state-evidence')
/**
 * Permanently mutes stuck-task nudges for a task by stamping `mutedAt` in its
 * touch-interaction ledger. Unlike `forgetTaskStateEvidence`, this suppresses
 * ALL future `task_blocked` touches for the task — the evidence chain is left
 * intact so history is not lost.
 */
export const electronScreenObservationMuteTask = defineInvokeEventa<ScreenObservationRuntimeState, { taskId: string }>('eventa:invoke:electron:screen-observation:mute-task')

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
/**
 * Updates MineContext connection and polling config in the main process.
 * Returns the updated full runtime state so the renderer can reflect changes
 * immediately (same pattern as `electronScreenObservationUpdateSettings`).
 */
export const electronScreenObservationUpdateMineContextConfig = defineInvokeEventa<ScreenObservationRuntimeState, Partial<MineContextConfig>>('eventa:invoke:electron:screen-observation:update-minecontext-config')
