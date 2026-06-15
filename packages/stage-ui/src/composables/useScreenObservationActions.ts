import type { PauseObservationRequest, Task } from '@proj-airi/server-sdk-shared'
import type { InjectionKey } from 'vue'

import { inject } from 'vue'

/**
 * Imperative operations that bridge the renderer to the Electron main process
 * for screen-observation task management.
 *
 * The bridge provides these via `provide(ScreenObservationActionsKey, ...)`;
 * UI components inject them with `useScreenObservationActions()` so the
 * package boundary stays Electron-free.
 */
export interface ScreenObservationActions {
  /** Registers or replaces a task in the runtime; sets it active when task.status === 'active'. */
  upsertTask: (task: Task) => Promise<void>
  /** Clears task-companion evidence for one task (or all tasks when taskId is omitted). */
  forgetTaskStateEvidence: (taskId?: string) => Promise<void>
  /** Permanently mutes stuck-task nudges by stamping `mutedAt` in the touch ledger; evidence is kept, future touches are suppressed. */
  muteTask: (taskId: string) => Promise<void>
  /** Pauses screen observation globally for the requested duration. */
  pauseObservation: (request: PauseObservationRequest) => Promise<void>
  /** Resumes screen observation if it is currently paused. */
  resumeObservation: () => Promise<void>
}

export const ScreenObservationActionsKey: InjectionKey<ScreenObservationActions> = Symbol('screen-observation-actions')

/**
 * Injects the bridge-provided task operations into a component.
 *
 * Returns `undefined` in environments without a bridge (web, tests without
 * explicit provide). Callers guard with optional chaining: `actions?.upsertTask(...)`.
 */
export function useScreenObservationActions(): ScreenObservationActions | undefined {
  return inject(ScreenObservationActionsKey)
}
