// @vitest-environment jsdom
import type { ScreenObservationSettings, ScreenObserverSummary, Task, TaskWorkingState, TouchEventPayload } from '@proj-airi/server-sdk-shared'
import type { ScreenObservationContextUpdate } from '@proj-airi/stage-ui/stores/modules/screen-observation'

import type { ScreenObservationRuntimeState } from '../../shared/eventa'

import { createContext, defineInvokeHandler } from '@moeru/eventa'
import { createScreenObservationTask } from '@proj-airi/server-sdk-shared'
import { ScreenObservationActionsKey } from '@proj-airi/stage-ui/composables/useScreenObservationActions'
import { useScreenObservationStore } from '@proj-airi/stage-ui/stores/modules/screen-observation'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, inject } from 'vue'

import {
  electronScreenObservationCurrentStateCaptured,
  electronScreenObservationForgetTaskStateEvidence,
  electronScreenObservationGetState,
  electronScreenObservationPause,
  electronScreenObservationResume,
  electronScreenObservationStateChanged,
  electronScreenObservationSummaryCaptured,
  electronScreenObservationTouchDelivered,
  electronScreenObservationUpdateSettings,
  electronScreenObservationUpsertTask,
} from '../../shared/eventa'
import { initializeScreenObservationBridge, observationSettingsKey } from './screen-observation'

function runtimeState(overrides: Partial<ScreenObservationRuntimeState> = {}): ScreenObservationRuntimeState {
  return {
    settings: {
      enabled: false,
      mode: 'whitelist',
      allowedApps: [],
      dailySummaryEnabled: true,
      dailySummaryAtLocalTime: '18:00',
    },
    privacyState: 'disabled',
    suppression: { isFullscreen: false, isMeeting: false },
    observationSourceAvailable: true,
    tasks: [],
    ...overrides,
    taskWorkingStates: overrides.taskWorkingStates ?? {},
    minecontextConfig: overrides.minecontextConfig ?? {},
  }
}

function taskFixture(id: string): Task {
  return {
    id,
    userId: 'user-1',
    title: 'Write quarterly report',
    status: 'active',
    priority: 'normal',
    goal: 'Write quarterly report',
    schedule: { timezone: 'UTC', dailySummaryAtLocalTime: '18:00' },
    observation: {
      enabled: true,
      mode: 'whitelist',
      allowedApps: ['Obsidian'],
      privacyState: 'observing',
      isEffectivelyObserving: true,
    },
    touchPolicy: { level: 'L1', firstTaskFirstProgressUsesL2: true, dailySummaryEnabled: true },
    createdAt: '2026-06-11T10:00:00.000Z',
    updatedAt: '2026-06-11T10:00:00.000Z',
  }
}

function summaryFixture(id: string): ScreenObserverSummary {
  return {
    id,
    capturedAt: '2026-06-11T12:00:00.000Z',
    windowStartedAt: '2026-06-11T11:59:30.000Z',
    windowEndedAt: '2026-06-11T12:00:00.000Z',
    source: 'minecontext',
    privacyState: 'observing',
    apps: [{ appId: 'obsidian', appName: 'Obsidian', observedSeconds: 30, summary: 'editing report', matchedWhitelist: true }],
    taskSignals: [],
    summary: 'editing report outline',
    confidence: 0.9,
  }
}

function touchFixture(id: string): TouchEventPayload {
  return {
    id,
    taskId: 'task-1',
    level: 'L1',
    reason: 'task_progress',
    createdAt: '2026-06-11T12:00:00.000Z',
    message: { remainingWork: 'two sections left', isOffTrack: false },
    actions: ['ack', 'details', 'mute_task'],
    policyApplied: [],
  }
}

function taskWorkingStateFixture(taskId: string): TaskWorkingState {
  return {
    taskId,
    state: 'stuck',
    progressScore: 0.2,
    stuckScore: 3.7,
    stuckStartedAt: '2026-06-11T11:50:00.000Z',
    evidenceChain: [{
      kind: 'repeated_error',
      description: 'TypeError: heap out of memory while building the quarterly report chart.',
      fingerprint: 'terminal:error:heap-out-of-memory',
      capturedAt: '2026-06-11T11:59:30.000Z',
    }],
  }
}

describe('initializeScreenObservationBridge', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear()
    setActivePinia(createPinia())
  })

  it('hydrates the store from get-state so the runtime wins over renderer-persisted settings', async () => {
    const context = createContext()
    defineInvokeHandler(context, electronScreenObservationGetState, () => runtimeState({
      settings: { enabled: true, mode: 'whitelist', allowedApps: ['Obsidian'], dailySummaryEnabled: true, dailySummaryAtLocalTime: '18:00' },
      privacyState: 'observing',
      tasks: [taskFixture('task-1')],
    }))

    const store = useScreenObservationStore()
    store.enabled = false
    store.allowedApps = ['stale-local-app']

    const dispose = initializeScreenObservationBridge({ context: context as never })

    await vi.waitFor(() => {
      expect(store.enabled).toBe(true)
      expect(store.allowedApps).toEqual(['Obsidian'])
      expect(store.privacyState).toBe('observing')
      expect(store.tasks.map(task => task.id)).toEqual(['task-1'])
    })

    dispose()
  })

  it('pushes user settings edits through update-settings and stays silent on the echoed state', async () => {
    const context = createContext()
    const received: Partial<ScreenObservationSettings>[] = []

    defineInvokeHandler(context, electronScreenObservationGetState, () => runtimeState())
    defineInvokeHandler(context, electronScreenObservationUpdateSettings, (requested) => {
      received.push(requested ?? {})
      const settings = { ...runtimeState().settings, ...requested }
      return runtimeState({
        settings,
        privacyState: settings.enabled && settings.allowedApps.length > 0 ? 'observing' : settings.enabled ? 'not_observing_empty_whitelist' : 'disabled',
      })
    })

    const store = useScreenObservationStore()
    const dispose = initializeScreenObservationBridge({ context: context as never })
    // observationSourceAvailable is only ever set by a runtime payload, so this
    // waits for hydration itself, not for a provisional state.
    await vi.waitFor(() => expect(store.observationSourceAvailable).toBe(true))

    store.enabled = true
    store.allowedApps = ['Obsidian']

    await vi.waitFor(() => {
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({ enabled: true, allowedApps: ['Obsidian'] })
      expect(store.privacyState).toBe('observing')
    })

    // The authoritative response was applied back to the store; the watcher
    // must recognize its own reflection and not loop another invoke.
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(received).toHaveLength(1)

    dispose()
  })

  it('does not let a late get-state response stomp settings the user edited during hydration', async () => {
    // ROOT CAUSE:
    //
    // If the user edits settings while the initial get-state invoke is in
    // flight, the late response used to overwrite the edit with the runtime's
    // stale settings AND record them as the last-known remote key, so the
    // settings watcher saw "no change" and never pushed the user's values.
    //
    // We fixed this by detecting local key drift since bridge init: a late
    // hydration then only records the remote key (arming the watcher to push)
    // instead of applying the stale settings over the user's edit.
    const context = createContext()
    const received: Partial<ScreenObservationSettings>[] = []

    let releaseGetState: (() => void) | undefined
    const getStateGate = new Promise<void>((resolve) => {
      releaseGetState = resolve
    })
    defineInvokeHandler(context, electronScreenObservationGetState, async () => {
      await getStateGate
      return runtimeState()
    })
    defineInvokeHandler(context, electronScreenObservationUpdateSettings, (requested) => {
      received.push(requested ?? {})
      return runtimeState({
        settings: { ...runtimeState().settings, ...requested },
        privacyState: 'observing',
      })
    })

    const store = useScreenObservationStore()
    const dispose = initializeScreenObservationBridge({ context: context as never })

    store.enabled = true
    store.allowedApps = ['Obsidian']
    releaseGetState?.()

    await vi.waitFor(() => {
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({ enabled: true, allowedApps: ['Obsidian'] })
    })
    expect(store.enabled).toBe(true)
    expect(store.allowedApps).toEqual(['Obsidian'])

    dispose()
  })

  it('applies broadcast state changes and publishes current-state plus long-memory context', async () => {
    const context = createContext()
    defineInvokeHandler(context, electronScreenObservationGetState, () => runtimeState())
    const published: ScreenObservationContextUpdate[] = []

    const store = useScreenObservationStore()
    const dispose = initializeScreenObservationBridge({
      context: context as never,
      contextPublisher: { sendContextUpdate: update => published.push(update) },
    })
    await vi.waitFor(() => expect(store.observationSourceAvailable).toBe(true))

    context.emit(electronScreenObservationStateChanged, runtimeState({
      settings: { enabled: true, mode: 'whitelist', allowedApps: ['Obsidian'], dailySummaryEnabled: true, dailySummaryAtLocalTime: '18:00' },
      privacyState: 'observing',
      tasks: [taskFixture('task-1')],
      taskWorkingStates: { 'task-1': taskWorkingStateFixture('task-1') },
    }))
    context.emit(electronScreenObservationCurrentStateCaptured, {
      capturedAt: '2026-06-11T12:00:00.000Z',
      privacyState: 'observing',
      focusedApp: { appName: 'Obsidian', windowTitle: 'Quarterly report' },
    })
    context.emit(electronScreenObservationSummaryCaptured, { summary: summaryFixture('s-1') })
    context.emit(electronScreenObservationTouchDelivered, touchFixture('t-1'))

    await vi.waitFor(() => {
      expect(store.privacyState).toBe('observing')
      expect(store.latestCurrentState?.focusedApp?.appName).toBe('Obsidian')
      expect(store.observationLog.map(entry => entry.id)).toEqual(['s-1'])
      expect(store.longMemoryCandidates).toHaveLength(1)
      expect(store.latestTouches.map(entry => entry.id)).toEqual(['t-1'])
      expect(published.map(update => update.contextId)).toEqual([
        'screen-observation:task-state:task-1',
        'screen-observation:current-state',
        'screen-observation:long-memory-candidates',
      ])
      expect(published[0]!.text).toContain('Current Task State')
      expect(published[0]!.text).toContain('heap out of memory')
    })

    dispose()
  })
})

describe('observationSettingsKey', () => {
  it('treats identical settings as equal and any field change as different', () => {
    const base: ScreenObservationSettings = { enabled: true, mode: 'whitelist', allowedApps: ['a'], dailySummaryEnabled: true, dailySummaryAtLocalTime: '18:00' }

    expect(observationSettingsKey({ ...base, allowedApps: ['a'] })).toBe(observationSettingsKey(base))
    expect(observationSettingsKey({ ...base, allowedApps: ['a', 'b'] })).not.toBe(observationSettingsKey(base))
    expect(observationSettingsKey({ ...base, enabled: false })).not.toBe(observationSettingsKey(base))
    expect(observationSettingsKey({ ...base, dailySummaryAtLocalTime: '19:00' })).not.toBe(observationSettingsKey(base))
  })
})

describe('initializeScreenObservationBridge task actions (ScreenObservationActionsKey)', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear()
    setActivePinia(createPinia())
  })

  function setupBridgeWithHandlers() {
    const context = createContext()
    const upsertTaskCalls: { task: Task }[] = []
    const forgetCalls: { taskId?: string }[] = []

    const task = createScreenObservationTask({
      id: 'task-set-test',
      userId: 'local',
      title: 'Review PR',
      status: 'active',
      observation: { allowedApps: ['GitHub'] },
    }, new Date('2026-06-15T10:00:00.000Z'))

    defineInvokeHandler(context, electronScreenObservationGetState, () => runtimeState())
    defineInvokeHandler(context, electronScreenObservationUpsertTask, (req) => {
      upsertTaskCalls.push(req ?? { task: task! })
      return runtimeState({ tasks: [req?.task ?? task] })
    })
    defineInvokeHandler(context, electronScreenObservationForgetTaskStateEvidence, (req) => {
      forgetCalls.push(req ?? {})
      return runtimeState()
    })

    return { context, upsertTaskCalls, forgetCalls, task }
  }

  // NOTICE: context typed as `any` to avoid vue-tsc strict contravariance on EventContext generics.
  function mountBridgeWithChild<T>(
    context: any,
    childSetup: () => T,
  ): { app: ReturnType<typeof createApp>, childResult: { value: T | undefined }, dispose: () => void } {
    let disposeRef: (() => void) = () => {}
    const childResult: { value: T | undefined } = { value: undefined }

    const Child = defineComponent({
      setup() {
        childResult.value = childSetup()
        return () => {}
      },
    })

    const Parent = defineComponent({
      setup() {
        disposeRef = initializeScreenObservationBridge({ context })
        return () => h(Child)
      },
    })

    const app = createApp(Parent)
    app.mount(document.createElement('div'))

    return {
      app,
      childResult,
      dispose: () => {
        app.unmount()
        disposeRef()
      },
    }
  }

  it('upsertTask invokes the main-process handler and applies the returned state to the store', async () => {
    const { context, upsertTaskCalls, task } = setupBridgeWithHandlers()
    const store = useScreenObservationStore()

    const { childResult, dispose } = mountBridgeWithChild(context, () => inject(ScreenObservationActionsKey))

    await vi.waitFor(() => expect(store.observationSourceAvailable).toBe(true))

    await childResult.value!.upsertTask(task)

    expect(upsertTaskCalls).toHaveLength(1)
    expect(upsertTaskCalls[0]!.task.id).toBe('task-set-test')
    expect(store.tasks.map(t => t.id)).toContain('task-set-test')

    dispose()
  })

  it('forgetTaskStateEvidence invokes the main-process handler with the given taskId', async () => {
    const { context, forgetCalls } = setupBridgeWithHandlers()
    const store = useScreenObservationStore()

    const { childResult, dispose } = mountBridgeWithChild(context, () => inject(ScreenObservationActionsKey))

    await vi.waitFor(() => expect(store.observationSourceAvailable).toBe(true))

    await childResult.value!.forgetTaskStateEvidence('task-set-test')

    expect(forgetCalls).toHaveLength(1)
    expect(forgetCalls[0]).toMatchObject({ taskId: 'task-set-test' })

    dispose()
  })

  it('forgetTaskStateEvidence clears all evidence when no taskId is given', async () => {
    const { context, forgetCalls } = setupBridgeWithHandlers()
    const store = useScreenObservationStore()

    const { childResult, dispose } = mountBridgeWithChild(context, () => inject(ScreenObservationActionsKey))

    await vi.waitFor(() => expect(store.observationSourceAvailable).toBe(true))

    await childResult.value!.forgetTaskStateEvidence()

    expect(forgetCalls).toHaveLength(1)
    expect(forgetCalls[0]).toEqual({})

    dispose()
  })

  it('muteTask invokes forgetTaskStateEvidence with the given taskId and applies returned state', async () => {
    const { context, forgetCalls } = setupBridgeWithHandlers()
    const store = useScreenObservationStore()

    const { childResult, dispose } = mountBridgeWithChild(context, () => inject(ScreenObservationActionsKey))

    await vi.waitFor(() => expect(store.observationSourceAvailable).toBe(true))

    await childResult.value!.muteTask('task-set-test')

    expect(forgetCalls).toHaveLength(1)
    expect(forgetCalls[0]).toMatchObject({ taskId: 'task-set-test' })

    dispose()
  })

  it('pauseObservation invokes the pause handler and applies returned state', async () => {
    const context = createContext()
    const pauseCalls: { reason: string }[] = []

    defineInvokeHandler(context, electronScreenObservationGetState, () => runtimeState())
    defineInvokeHandler(context, electronScreenObservationForgetTaskStateEvidence, () => runtimeState())
    defineInvokeHandler(context, electronScreenObservationUpsertTask, () => runtimeState())
    defineInvokeHandler(context, electronScreenObservationPause, (req) => {
      pauseCalls.push(req ?? { reason: 'manual_15m' })
      return runtimeState({ privacyState: 'paused', ...{ pauseUntil: '2099-01-01T00:00:00Z' } })
    })

    const store = useScreenObservationStore()
    const { childResult, dispose } = mountBridgeWithChild(context, () => inject(ScreenObservationActionsKey))

    await vi.waitFor(() => expect(store.observationSourceAvailable).toBe(true))

    await childResult.value!.pauseObservation({ reason: 'manual_15m' })

    expect(pauseCalls).toHaveLength(1)
    expect(pauseCalls[0]).toMatchObject({ reason: 'manual_15m' })
    expect(store.privacyState).toBe('paused')

    dispose()
  })

  it('resumeObservation invokes the resume handler and applies returned state', async () => {
    const context = createContext()
    let resumeCalled = false

    defineInvokeHandler(context, electronScreenObservationGetState, () => runtimeState({ privacyState: 'paused' }))
    defineInvokeHandler(context, electronScreenObservationForgetTaskStateEvidence, () => runtimeState())
    defineInvokeHandler(context, electronScreenObservationUpsertTask, () => runtimeState())
    defineInvokeHandler(context, electronScreenObservationResume, () => {
      resumeCalled = true
      return runtimeState({ settings: { enabled: true, mode: 'whitelist', allowedApps: ['Obsidian'], dailySummaryEnabled: true, dailySummaryAtLocalTime: '18:00' }, privacyState: 'observing' })
    })

    const store = useScreenObservationStore()
    const { childResult, dispose } = mountBridgeWithChild(context, () => inject(ScreenObservationActionsKey))

    await vi.waitFor(() => expect(store.observationSourceAvailable).toBe(true))

    await childResult.value!.resumeObservation()

    expect(resumeCalled).toBe(true)
    expect(store.privacyState).toBe('observing')

    dispose()
  })
})
