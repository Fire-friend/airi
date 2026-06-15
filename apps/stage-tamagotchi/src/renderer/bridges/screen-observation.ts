import type { ScreenObservationSettings } from '@proj-airi/server-sdk-shared'
import type { ScreenObservationContextUpdate } from '@proj-airi/stage-ui/stores/modules/screen-observation'
import type { Router } from 'vue-router'

import type { ScreenObservationRuntimeState } from '../../shared/eventa'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { ScreenObservationActionsKey } from '@proj-airi/stage-ui/composables/useScreenObservationActions'
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'
import { useScreenObservationStore } from '@proj-airi/stage-ui/stores/modules/screen-observation'
import { watchDebounced } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { provide } from 'vue'

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
} from '../../shared/eventa'

/**
 * Stable comparison key for observation settings.
 *
 * The bridge breaks the renderer↔main echo loop with this key instead of a
 * timing-sensitive "applying" flag: after the runtime's authoritative state
 * is applied to the store, the local key equals the last-known remote key,
 * so the settings watcher recognizes its own reflection and stays silent.
 * Only a genuine user edit makes the keys diverge and triggers a push.
 */
export function observationSettingsKey(settings: ScreenObservationSettings): string {
  return JSON.stringify([settings.enabled, settings.allowedApps, settings.dailySummaryEnabled, settings.dailySummaryAtLocalTime])
}

// Batches rapid settings edits (whitelist typing, toggle flurries) into one
// update-settings invoke; low enough that the tray state never feels laggy.
const SETTINGS_PUSH_DEBOUNCE_MS = 300

// open-task-details is broadcast to every registered window; only windows
// hosting a task surface may react, otherwise the settings window would be
// hijacked into the dashboard route.
const TASK_DETAILS_NAVIGABLE_ROUTES = new Set(['/', '/dashboard'])

export interface ScreenObservationContextPublisher {
  sendContextUpdate: (message: ScreenObservationContextUpdate) => void
}

export interface ScreenObservationBridgeOptions {
  /**
   * Eventa context to bind against.
   * @default the shared Electron ipcRenderer context
   */
  context?: ReturnType<typeof getElectronEventaContext>
  /** Router used to honor open-task-details navigation; navigation is skipped when omitted. */
  router?: Router
  /**
   * Context publisher for tests or alternate hosts.
   * @default useModsServerChannelStore()
   */
  contextPublisher?: ScreenObservationContextPublisher
}

/**
 * Connects the screen-observation Pinia store to the Electron-main runtime.
 *
 * Use when:
 * - Bootstrapping any tamagotchi renderer window (registered once in
 *   App.vue, alongside the other renderer bridges).
 * - Driving the mocked end-to-end bridge test: pass the renderer half of an
 *   in-memory eventa context pair via `options.context`.
 *
 * Expects:
 * - Pinia to be installed before invocation (the store is resolved eagerly).
 * - The main process to answer `get-state` / `update-settings` and broadcast
 *   state/summary/touch/open-task-details to this window.
 *
 * Returns:
 * - A dispose function detaching the event listeners and the settings watcher.
 */
export function initializeScreenObservationBridge(options: ScreenObservationBridgeOptions = {}) {
  const context = options.context ?? getElectronEventaContext()
  const store = useScreenObservationStore()
  const contextPublisher = options.contextPublisher ?? useModsServerChannelStore()
  const {
    enabled,
    allowedApps,
    dailySummaryEnabled,
    dailySummaryAtLocalTime,
    minecontextBaseUrl,
    screenshotCaptureEnabled,
    longMemoryPollIntervalMs,
    currentStatePollIntervalMs,
  } = storeToRefs(store)

  const getState = defineInvoke(context, electronScreenObservationGetState)
  const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)
  const updateMineContextConfig = defineInvoke(context, electronScreenObservationUpdateMineContextConfig)
  const upsertTaskIpc = defineInvoke(context, electronScreenObservationUpsertTask)
  const forgetEvidenceIpc = defineInvoke(context, electronScreenObservationForgetTaskStateEvidence)
  const pauseIpc = defineInvoke(context, electronScreenObservationPause)
  const resumeIpc = defineInvoke(context, electronScreenObservationResume)

  provide(ScreenObservationActionsKey, {
    upsertTask: async (task) => {
      const state = await upsertTaskIpc({ task })
      if (state)
        applyRuntimeState(state)
    },
    forgetTaskStateEvidence: async (taskId) => {
      const state = await forgetEvidenceIpc(taskId ? { taskId } : {})
      if (state)
        applyRuntimeState(state)
    },
    muteTask: async (taskId) => {
      const state = await forgetEvidenceIpc({ taskId })
      if (state)
        applyRuntimeState(state)
    },
    pauseObservation: async (request) => {
      const state = await pauseIpc(request)
      if (state)
        applyRuntimeState(state)
    },
    resumeObservation: async () => {
      const state = await resumeIpc()
      if (state)
        applyRuntimeState(state)
    },
  })

  let lastKnownRemoteKey: string | undefined

  function applyRuntimeState(state: ScreenObservationRuntimeState) {
    lastKnownRemoteKey = observationSettingsKey(state.settings)
    for (const contextUpdate of store.applyRuntimeState(state))
      contextPublisher.sendContextUpdate(contextUpdate)
  }

  function currentLocalSettings(): ScreenObservationSettings {
    return {
      enabled: enabled.value,
      mode: 'whitelist',
      allowedApps: [...allowedApps.value],
      dailySummaryEnabled: dailySummaryEnabled.value,
      dailySummaryAtLocalTime: dailySummaryAtLocalTime.value,
    }
  }

  // The runtime is the component that actually gates capture, so its
  // persisted settings win over renderer localStorage on startup — the UI
  // must never claim observation is on while the poller is disabled.
  //
  // One exception: if the user edits settings while get-state is still in
  // flight, the late response must not stomp that edit. We detect the edit
  // by key drift since init and only record the remote key, which makes the
  // settings watcher push the user's values instead of silently losing them.
  const localKeyAtInit = observationSettingsKey(currentLocalSettings())
  void getState()
    .then((state) => {
      if (!state)
        return
      if (observationSettingsKey(currentLocalSettings()) !== localKeyAtInit) {
        lastKnownRemoteKey = observationSettingsKey(state.settings)
        return
      }
      applyRuntimeState(state)
    })
    .catch(error => console.warn('[screen-observation] failed to hydrate runtime state:', error))

  const stopSettingsWatcher = watchDebounced(
    [enabled, allowedApps, dailySummaryEnabled, dailySummaryAtLocalTime],
    async () => {
      const local = currentLocalSettings()
      if (observationSettingsKey(local) === lastKnownRemoteKey)
        return

      try {
        const state = await updateSettings(local)
        if (state)
          applyRuntimeState(state)
      }
      catch (error) {
        console.warn('[screen-observation] failed to push settings to runtime:', error)
      }
    },
    { debounce: SETTINGS_PUSH_DEBOUNCE_MS, deep: true },
  )

  const stopMineContextConfigWatcher = watchDebounced(
    [minecontextBaseUrl, screenshotCaptureEnabled, longMemoryPollIntervalMs, currentStatePollIntervalMs],
    async () => {
      try {
        const state = await updateMineContextConfig({
          baseUrl: minecontextBaseUrl.value || undefined,
          screenshotCaptureEnabled: screenshotCaptureEnabled.value,
          longMemoryPollIntervalMs: longMemoryPollIntervalMs.value,
          currentStatePollIntervalMs: currentStatePollIntervalMs.value,
        })
        if (state)
          applyRuntimeState(state)
      }
      catch (error) {
        console.warn('[screen-observation] failed to push minecontext config to runtime:', error)
      }
    },
    { debounce: SETTINGS_PUSH_DEBOUNCE_MS, deep: true },
  )

  const offStateChanged = context.on(electronScreenObservationStateChanged, (event) => {
    if (event.body)
      applyRuntimeState(event.body)
  })

  const offSummaryCaptured = context.on(electronScreenObservationSummaryCaptured, (event) => {
    if (!event.body)
      return
    const result = store.applySummary(event.body.summary)
    if (result?.contextUpdate)
      contextPublisher.sendContextUpdate(result.contextUpdate)
  })

  const offCurrentStateCaptured = context.on(electronScreenObservationCurrentStateCaptured, (event) => {
    if (!event.body)
      return
    const contextUpdate = store.applyCurrentState(event.body)
    if (contextUpdate)
      contextPublisher.sendContextUpdate(contextUpdate)
  })

  const offTouchDelivered = context.on(electronScreenObservationTouchDelivered, (event) => {
    if (event.body)
      store.applyTouch(event.body)
  })

  const offOpenTaskDetails = context.on(electronScreenObservationOpenTaskDetails, () => {
    const router = options.router
    if (!router)
      return
    const currentPath = router.currentRoute.value.path
    if (!TASK_DETAILS_NAVIGABLE_ROUTES.has(currentPath) || currentPath === '/dashboard')
      return

    void router.push('/dashboard').catch((error) => {
      console.warn('[screen-observation] failed to navigate to task details:', error)
    })
  })

  return () => {
    stopSettingsWatcher()
    stopMineContextConfigWatcher()
    offStateChanged()
    offSummaryCaptured()
    offCurrentStateCaptured()
    offTouchDelivered()
    offOpenTaskDetails()
  }
}
