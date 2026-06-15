import type { ScreenObserverSummary, TouchAction, TouchEventPayload } from '@proj-airi/server-sdk-shared'
import type { BrowserWindow } from 'electron'
import type { Mock } from 'vitest'

import type { I18n } from '../../../libs/i18n'
import type { MineContextClient } from './minecontext'

import { createContext, defineInvoke } from '@moeru/eventa'
import { createScreenObservationTask, DEFAULT_TASK_COMPANION_THRESHOLDS } from '@proj-airi/server-sdk-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  electronScreenObservationForgetTaskStateEvidence,
  electronScreenObservationMuteTask,
  electronScreenObservationPause,
  electronScreenObservationSummaryCaptured,
  electronScreenObservationTouchDelivered,
  electronScreenObservationUpdateMineContextConfig,
  electronScreenObservationUpdateSettings,
  electronScreenObservationUpsertTask,
} from '../../../../shared/eventa/screen-observation'
import { setupScreenObserver } from './index'

// The end-to-end bridge test runs the real service against the real eventa
// dispatch, so only the OS boundaries are mocked: Electron (notifications,
// global shortcut) and the on-disk config store.
vi.mock('electron', () => {
  class MockNotification {
    static supported = true
    static instances: MockNotification[] = []
    static isSupported() {
      return MockNotification.supported
    }

    options: { title: string, body: string }
    listeners = new Map<string, () => void>()
    show = vi.fn()

    constructor(options: { title: string, body: string }) {
      this.options = options
      MockNotification.instances.push(this)
    }

    on(event: string, listener: () => void) {
      this.listeners.set(event, listener)
      return this
    }
  }

  return {
    Notification: MockNotification,
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  }
})

vi.mock('../../../libs/electron/persistence', () => ({
  // In-memory store per createConfig call: each setupScreenObserver instance
  // starts from its `default`, which also isolates the tests from each other.
  createConfig: (_namespace: string, _filename: string, _schema: unknown, options?: { default?: unknown }) => {
    let stored: unknown = options?.default ?? {}
    return {
      setup: () => ({ status: 'ok' }),
      get: () => stored,
      update: (next: unknown) => {
        stored = next
      },
      getDiagnostics: () => undefined,
    }
  },
}))

const POLL_INTERVAL_MS = 30 * 1000

const fakeI18n = {
  t: (key: string) => key,
  locale: () => 'en',
} as unknown as I18n

function activeTask(id: string, overrides?: { remainingWork?: string }) {
  return createScreenObservationTask({
    id,
    userId: 'user-1',
    title: 'Write quarterly report',
    status: 'active',
    observation: { allowedApps: ['Code'] },
    progressNarrative: {
      remainingWork: overrides?.remainingWork ?? 'two sections left, about 40 minutes',
      isOffTrack: false,
    },
  }, new Date('2026-06-11T09:00:00.000Z'))
}

describe('screen observer end-to-end bridge', () => {
  let openTaskTouch: Mock<(touch: TouchEventPayload) => Promise<TouchAction | undefined>>
  let getActivities: ReturnType<typeof vi.fn>
  let observer: ReturnType<typeof setupScreenObserver>
  let context: ReturnType<typeof createContext>

  function setup() {
    openTaskTouch = vi.fn<(touch: TouchEventPayload) => Promise<TouchAction | undefined>>(async () => 'ack')
    getActivities = vi.fn(async () => [
      {
        id: 'ctx-1',
        title: 'Q2 numbers editing',
        summary: 'Q2 numbers',
        keywords: [],
        entities: [],
        context_type: 'activity_context',
        confidence: 90,
        importance: 80,
        create_time: new Date().toISOString(),
        event_time: new Date().toISOString(),
        raw_contexts: [
          {
            object_id: 'rc-1',
            content_format: 'image',
            source: 'screenshot',
            create_time: new Date().toISOString(),
            additional_info: { app: 'Code', window: 'report.md' },
          },
        ],
      },
    ])

    const minecontext: MineContextClient = {
      health: vi.fn(async () => true),
      getActivities: getActivities as unknown as MineContextClient['getActivities'],
      getFocusedApp: vi.fn(async () => ({ appName: 'Code', windowTitle: 'report.md' })),
    }

    observer = setupScreenObserver({ i18n: fakeI18n, noticeWindow: { openTaskTouch }, minecontext })

    context = createContext()
    // NOTICE:
    // The service types its contexts after the electron adapter
    // (`createContext(ipcMain)`), whose context is the core EventContext plus
    // transport extensions the service never uses (it only emits and installs
    // invoke handlers). The core in-memory context is the honest stand-in for
    // a renderer bridge in tests.
    // Removal condition: type ScreenObserverService.registerWindow after the
    // core InvocableEventContext once eventa exports a stable name for it.
    observer.registerWindow({
      context: context as unknown as Parameters<typeof observer.registerWindow>[0]['context'],
      window: { on: vi.fn() } as unknown as BrowserWindow,
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-11T10:00:00.000Z'))
    setup()
  })

  afterEach(() => {
    observer.dispose()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('wires settings -> poller -> capture -> decision -> delivery as one chain', async () => {
    const summaries: ScreenObserverSummary[] = []
    const touches: TouchEventPayload[] = []
    context.on(electronScreenObservationSummaryCaptured, event => summaries.push(event.body!.summary))
    context.on(electronScreenObservationTouchDelivered, event => touches.push(event.body!))

    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)
    const upsertTask = defineInvoke(context, electronScreenObservationUpsertTask)

    // Fresh install: observation is off, the poller must not capture.
    expect(observer.getState().privacyState).toBe('disabled')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(getActivities).not.toHaveBeenCalled()

    // The user enables observation and whitelists an app in settings. The
    // whitelist arrives untrimmed and with a case-insensitive duplicate.
    const enabled = await updateSettings({ enabled: true, allowedApps: [' Code ', 'code'] })
    expect(enabled.privacyState).toBe('observing')
    expect(enabled.settings.allowedApps).toEqual(['Code'])

    // The chat layer registers the confirmed task with the runtime.
    const task = activeTask('task-1')
    const withTask = await upsertTask({ task })
    expect(withTask.tasks.map(t => t.id)).toEqual(['task-1'])

    // Next tick: capture runs and receives activities from MineContext.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(getActivities).toHaveBeenCalled()
    expect(summaries.length).toBeGreaterThan(0)
    expect(summaries[0]!.apps[0]!.appName).toBe('Code')
    expect(summaries[0]!.source).toBe('minecontext')

    // The decision ran against the shared policy: the brand-new user's first
    // task delivers its first progress update at L2 (cold-start exception),
    // which presents as the notice toast and stamps the throttle ledger.
    expect(touches).toHaveLength(1)
    expect(touches[0]!.taskId).toBe('task-1')
    expect(touches[0]!.level).toBe('L2')
    expect(touches[0]!.policyApplied).toContain('first_task_first_progress_l2')
    expect(openTaskTouch).toHaveBeenCalledTimes(1)
    expect(observer.getTouchInteraction('task-1').lastL2PlusTouchAt).toBeDefined()

    // Another tick 30s later: capture continues, but the per-task decision
    // cadence (the frozen 30-minute window) prevents touch spam.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(touches).toHaveLength(1)

    // Past the 30-minute window the next decision happens, now at the
    // default L1 (cold-start exception spent): broadcast only, no toast.
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    expect(touches).toHaveLength(2)
    expect(touches[1]!.level).toBe('L1')
    expect(openTaskTouch).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed IPC payloads at the runtime boundary', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)
    const pause = defineInvoke(context, electronScreenObservationPause)

    // Renderer payloads are untrusted: TypeScript cannot protect this
    // boundary, so deliberately malformed payloads bypass the types.
    await expect(updateSettings({ allowedApps: 'not-an-array' } as unknown as Parameters<typeof updateSettings>[0])).rejects.toThrow(/Invalid screen observation settings/)
    await expect(updateSettings({ dailySummaryAtLocalTime: '25:99' })).rejects.toThrow(/Invalid screen observation settings/)
    await expect(pause({ reason: 'whenever' } as unknown as Parameters<typeof pause>[0])).rejects.toThrow(/Invalid screen observation pause/)
    await expect(pause({ reason: 'manual_15m', pauseUntil: 'not-a-date' })).rejects.toThrow(/Invalid screen observation pause/)
  })

  it('upsertTask with status=active sets the active companion task', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)
    const upsertTask = defineInvoke(context, electronScreenObservationUpsertTask)

    await updateSettings({ enabled: true, allowedApps: ['Code'] })

    const task = activeTask('task-companion')
    await upsertTask({ task })

    // Advance one long-memory poll: companion frame should be built and
    // companion should update working state (no stuck evidence yet, so no touch).
    const touches: TouchEventPayload[] = []
    context.on(electronScreenObservationTouchDelivered, event => touches.push(event.body!))

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    // task_progress touch dispatched by the existing decideProgressTouches path;
    // no task_blocked from companion (not stuck yet).
    const progressTouches = touches.filter(t => t.reason === 'task_progress')
    const blockedTouches = touches.filter(t => t.reason === 'task_blocked')
    expect(progressTouches.length).toBeGreaterThan(0)
    expect(blockedTouches).toHaveLength(0)
  })

  it('companion accumulates stuck evidence and dispatches task_blocked once per episode', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)
    const upsertTask = defineInvoke(context, electronScreenObservationUpsertTask)

    const touches: TouchEventPayload[] = []
    context.on(electronScreenObservationTouchDelivered, event => touches.push(event.body!))

    // Override: summary with a blocker term so semantic_blocker evidence (weight 1)
    // fires on every long-memory tick, accumulating stuckScore toward the threshold.
    getActivities.mockResolvedValue([
      {
        id: 'ctx-stuck',
        title: 'error in code',
        summary: 'cannot fix the error in code',
        keywords: [],
        entities: [],
        context_type: 'activity_context',
        confidence: 90,
        importance: 80,
        create_time: new Date().toISOString(),
        event_time: new Date().toISOString(),
        raw_contexts: [
          {
            object_id: 'rc-stuck',
            content_format: 'image',
            source: 'screenshot',
            create_time: new Date().toISOString(),
            additional_info: { app: 'Code', window: 'report.md' },
          },
        ],
      },
    ])

    await updateSettings({ enabled: true, allowedApps: ['Code'] })
    await upsertTask({ task: activeTask('task-stuck') })

    // Threshold recap (conservative defaults):
    //   semanticBlockerWeight = 1   → each tick with blocker term adds 1 to stuckScore
    //   stuckScoreThreshold   = 3   → needs stuckScore ≥ 3 (reached after ~5 ticks via decay)
    //   stuckDurationMs       = 10 min → must be possibly_stuck for ≥ 10 min before 'stuck'
    //   nudgeCooldownMs       = 30 min → per episode, prevents repeated nudges
    //
    // Ticks 1–3: semantic_blocker accumulates (summary has "error"); stuckScore after:
    //   tick 1: 0 * 0.8 + 1 = 1.0  → idle (< possibleStuckThreshold 1.75)
    //   tick 2: 1.0 * 0.8 + 1 = 1.8 → possibly_stuck; stuckStartedAt = first frame ts
    //   tick 3: 1.8 * 0.8 + 1 = 2.44 → possibly_stuck; stuckDurationMs still < 10 min
    // No task_blocked expected yet.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    }
    const blockedAfterThreeTicks = touches.filter(t => t.reason === 'task_blocked')
    expect(blockedAfterThreeTicks).toHaveLength(0)

    // Advance past stuckDurationMs (10 min) so the state can flip to 'stuck'.
    // One more tick fires; stuckScore accumulates further and stuckDurationMs is met.
    await vi.advanceTimersByTimeAsync(DEFAULT_TASK_COMPANION_THRESHOLDS.stuckDurationMs + POLL_INTERVAL_MS)

    const blockedTouches = touches.filter(t => t.reason === 'task_blocked')
    expect(blockedTouches).toHaveLength(1)
    expect(blockedTouches[0]!.taskId).toBe('task-stuck')

    // The stuck nudge must earn the interrupt: message.remainingWork should name
    // the specific evidence the companion saw, not the task's generic narrative.
    // The mock summary contains "cannot" (blockerTerms) → semantic_blocker evidence.
    const nudgeText = blockedTouches[0]!.message.remainingWork
    expect(nudgeText).toBe('Summary contains conservative blocker language.')
    expect(nudgeText).not.toBe('two sections left, about 40 minutes')

    // Second stuck tick in same episode: shouldNudge=false → no additional touch.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(touches.filter(t => t.reason === 'task_blocked')).toHaveLength(1)
  })

  it('forgets persisted task-state evidence without deleting the task state', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)
    const upsertTask = defineInvoke(context, electronScreenObservationUpsertTask)
    const forgetTaskStateEvidence = defineInvoke(context, electronScreenObservationForgetTaskStateEvidence)

    getActivities.mockResolvedValue([
      {
        id: 'ctx-stuck',
        title: 'error in code',
        summary: 'cannot fix the error in code',
        keywords: [],
        entities: [],
        context_type: 'activity_context',
        confidence: 90,
        importance: 80,
        create_time: new Date().toISOString(),
        event_time: new Date().toISOString(),
        raw_contexts: [
          {
            object_id: 'rc-stuck',
            content_format: 'image',
            source: 'screenshot',
            create_time: new Date().toISOString(),
            additional_info: { app: 'Code', window: 'report.md' },
          },
        ],
      },
    ])

    await updateSettings({ enabled: true, allowedApps: ['Code'] })
    await upsertTask({ task: activeTask('task-forget') })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    expect(observer.getState().taskWorkingStates['task-forget']?.evidenceChain.length).toBeGreaterThan(0)

    const cleared = await forgetTaskStateEvidence({ taskId: 'task-forget' })

    expect(cleared.taskWorkingStates['task-forget']).toMatchObject({
      taskId: 'task-forget',
      evidenceChain: [],
    })
    expect(observer.getState().taskWorkingStates['task-forget']?.evidenceChain).toEqual([])
  })

  it('off-task apps do not trigger companion inference', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)
    const upsertTask = defineInvoke(context, electronScreenObservationUpsertTask)

    await updateSettings({ enabled: true, allowedApps: ['Code'] })

    // Task only allows 'Obsidian', but mock returns 'Code'.
    const offTaskTask = createScreenObservationTask({
      id: 'task-offtask',
      userId: 'user-1',
      title: 'Write docs',
      status: 'active',
      observation: { allowedApps: ['Obsidian'] },
      progressNarrative: { remainingWork: 'three pages left', isOffTrack: false },
    }, new Date('2026-06-11T10:00:00.000Z'))
    await upsertTask({ task: offTaskTask })

    const touches: TouchEventPayload[] = []
    context.on(electronScreenObservationTouchDelivered, event => touches.push(event.body!))

    // Advance many ticks — companion gets no frames (off-task app), no task_blocked.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    }
    await vi.advanceTimersByTimeAsync(DEFAULT_TASK_COMPANION_THRESHOLDS.stuckDurationMs + POLL_INTERVAL_MS)

    const blockedTouches = touches.filter(t => t.reason === 'task_blocked')
    expect(blockedTouches).toHaveLength(0)
  })

  it('denylist app (1Password) produces no task evidence even when task-whitelisted', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)
    const upsertTask = defineInvoke(context, electronScreenObservationUpsertTask)

    // 1Password is on the default denylist: even if the task explicitly whitelists
    // it as an allowed app, the privacy gate must block frames before inference runs.
    getActivities.mockResolvedValue([
      {
        id: 'ctx-password',
        title: '1password vault',
        summary: 'reviewing saved credentials',
        keywords: [],
        entities: [],
        context_type: 'activity_context',
        confidence: 90,
        importance: 80,
        create_time: new Date().toISOString(),
        event_time: new Date().toISOString(),
        raw_contexts: [
          {
            object_id: 'rc-pw',
            content_format: 'image',
            source: 'screenshot',
            create_time: new Date().toISOString(),
            additional_info: { app: '1Password', window: 'Vault' },
          },
        ],
      },
    ])

    await updateSettings({ enabled: true, allowedApps: ['1Password'] })
    const task = createScreenObservationTask({
      id: 'task-denylist',
      userId: 'user-1',
      title: 'Review credentials',
      status: 'active',
      observation: { allowedApps: ['1Password'] },
      progressNarrative: { remainingWork: 'check all entries', isOffTrack: false },
    }, new Date('2026-06-11T10:00:00.000Z'))
    await upsertTask({ task })

    for (let i = 0; i < 5; i++)
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    // No evidence must accumulate: the privacy gate must have returned undefined
    // from buildObservationFrame, skipping runTaskCompanion for every tick.
    const taskState = observer.getState().taskWorkingStates['task-denylist']
    expect(taskState?.evidenceChain ?? []).toHaveLength(0)
  })

  it('private-window content (incognito Chrome) produces no task evidence', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)
    const upsertTask = defineInvoke(context, electronScreenObservationUpsertTask)

    // Chrome is on the task whitelist, but the user is in an incognito window.
    // The denylist matches window titles containing 'incognito' and must prevent
    // the frame from being built so no task evidence or working state is written.
    getActivities.mockResolvedValue([
      {
        id: 'ctx-incognito',
        title: 'incognito browsing',
        summary: 'user is browsing privately',
        keywords: [],
        entities: [],
        context_type: 'activity_context',
        confidence: 90,
        importance: 80,
        create_time: new Date().toISOString(),
        event_time: new Date().toISOString(),
        raw_contexts: [
          {
            object_id: 'rc-incognito',
            content_format: 'image',
            source: 'screenshot',
            create_time: new Date().toISOString(),
            additional_info: { app: 'Chrome', window: 'Incognito Mode' },
          },
        ],
      },
    ])

    await updateSettings({ enabled: true, allowedApps: ['Chrome'] })
    const task = createScreenObservationTask({
      id: 'task-incognito',
      userId: 'user-1',
      title: 'Browse docs',
      status: 'active',
      observation: { allowedApps: ['Chrome'] },
      progressNarrative: { remainingWork: 'read through pages', isOffTrack: false },
    }, new Date('2026-06-11T10:00:00.000Z'))
    await upsertTask({ task })

    const touches: TouchEventPayload[] = []
    context.on(electronScreenObservationTouchDelivered, event => touches.push(event.body!))

    // Advance well past the stuck threshold; if frames were built from private-window
    // content, a task_blocked touch would eventually fire. It must not.
    for (let i = 0; i < 5; i++)
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(DEFAULT_TASK_COMPANION_THRESHOLDS.stuckDurationMs + POLL_INTERVAL_MS)

    const taskState = observer.getState().taskWorkingStates['task-incognito']
    expect(taskState?.evidenceChain ?? []).toHaveLength(0)
    expect(touches.filter(t => t.reason === 'task_blocked')).toHaveLength(0)
  })

  it('muteTask stamps mutedAt in the ledger and suppresses subsequent task_blocked nudges', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)
    const upsertTask = defineInvoke(context, electronScreenObservationUpsertTask)
    const muteTask = defineInvoke(context, electronScreenObservationMuteTask)

    getActivities.mockResolvedValue([
      {
        id: 'ctx-mute',
        title: 'error in code',
        summary: 'cannot fix the error in code',
        keywords: [],
        entities: [],
        context_type: 'activity_context',
        confidence: 90,
        importance: 80,
        create_time: new Date().toISOString(),
        event_time: new Date().toISOString(),
        raw_contexts: [
          {
            object_id: 'rc-mute',
            content_format: 'image',
            source: 'screenshot',
            create_time: new Date().toISOString(),
            additional_info: { app: 'Code', window: 'report.md' },
          },
        ],
      },
    ])

    const touches: TouchEventPayload[] = []
    context.on(electronScreenObservationTouchDelivered, event => touches.push(event.body!))

    await updateSettings({ enabled: true, allowedApps: ['Code'] })
    await upsertTask({ task: activeTask('task-mute') })

    // Advance to stuck state so task_blocked fires.
    for (let i = 0; i < 3; i++)
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(DEFAULT_TASK_COMPANION_THRESHOLDS.stuckDurationMs + POLL_INTERVAL_MS)

    const blockedBefore = touches.filter(t => t.reason === 'task_blocked')
    expect(blockedBefore).toHaveLength(1)

    // Mute the task: must stamp mutedAt, NOT just clear evidence.
    await muteTask({ taskId: 'task-mute' })
    expect(observer.getTouchInteraction('task-mute').muted).toBe(true)

    // Evidence chain must still be intact (mute != forget).
    const stateAfterMute = observer.getState().taskWorkingStates['task-mute']
    expect(stateAfterMute?.evidenceChain.length).toBeGreaterThan(0)

    // Advance well past nudge cooldown: further task_blocked touches must be suppressed.
    await vi.advanceTimersByTimeAsync(DEFAULT_TASK_COMPANION_THRESHOLDS.stuckDurationMs + POLL_INTERVAL_MS * 5)
    expect(touches.filter(t => t.reason === 'task_blocked')).toHaveLength(1)
  })

  it('currentStateTick: denied app in raw_context produces no task evidence (fast-track privacy)', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)
    const updateMineContextConfig = defineInvoke(context, electronScreenObservationUpdateMineContextConfig)
    const upsertTask = defineInvoke(context, electronScreenObservationUpsertTask)

    // Route raw_context requests to denied content; long-memory track returns nothing.
    getActivities.mockImplementation(async (opts: Parameters<typeof getActivities>[0]) => {
      if (opts?.contextType === 'raw_context') {
        return [
          {
            id: 'rc-denied',
            context_type: 'raw_context',
            confidence: 90,
            importance: 80,
            create_time: new Date().toISOString(),
            event_time: new Date().toISOString(),
            raw_contexts: [
              {
                object_id: 'rc-1password',
                content_format: 'image',
                source: 'screenshot',
                create_time: new Date().toISOString(),
                additional_info: { app: '1Password', window: 'Vault' },
              },
            ],
          },
        ]
      }
      return []
    })

    await updateSettings({ enabled: true, allowedApps: ['1Password'] })
    await updateMineContextConfig({ screenshotCaptureEnabled: true })
    const task = createScreenObservationTask({
      id: 'task-cs-denied',
      userId: 'user-1',
      title: 'Manage credentials',
      status: 'active',
      observation: { allowedApps: ['1Password'] },
      progressNarrative: { remainingWork: 'review entries', isOffTrack: false },
    }, new Date('2026-06-11T10:00:00.000Z'))
    await upsertTask({ task })

    // Advance several current-state poll intervals (15 s each).
    for (let i = 0; i < 5; i++)
      await vi.advanceTimersByTimeAsync(15_000)

    // buildCurrentStateFrame must have returned undefined for every tick:
    // no evidence, no working state written.
    const taskState = observer.getState().taskWorkingStates['task-cs-denied']
    expect(taskState?.evidenceChain ?? []).toHaveLength(0)
  })

  it('currentStateTick: private window in raw_context produces no task evidence (fast-track privacy)', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)
    const updateMineContextConfig = defineInvoke(context, electronScreenObservationUpdateMineContextConfig)
    const upsertTask = defineInvoke(context, electronScreenObservationUpsertTask)

    getActivities.mockImplementation(async (opts: Parameters<typeof getActivities>[0]) => {
      if (opts?.contextType === 'raw_context') {
        return [
          {
            id: 'rc-incognito',
            context_type: 'raw_context',
            confidence: 90,
            importance: 80,
            create_time: new Date().toISOString(),
            event_time: new Date().toISOString(),
            raw_contexts: [
              {
                object_id: 'rc-private',
                content_format: 'image',
                source: 'screenshot',
                create_time: new Date().toISOString(),
                additional_info: { app: 'Chrome', window: 'Incognito Mode' },
              },
            ],
          },
        ]
      }
      return []
    })

    await updateSettings({ enabled: true, allowedApps: ['Chrome'] })
    await updateMineContextConfig({ screenshotCaptureEnabled: true })
    const task = createScreenObservationTask({
      id: 'task-cs-incognito',
      userId: 'user-1',
      title: 'Browse docs',
      status: 'active',
      observation: { allowedApps: ['Chrome'] },
      progressNarrative: { remainingWork: 'read pages', isOffTrack: false },
    }, new Date('2026-06-11T10:00:00.000Z'))
    await upsertTask({ task })

    const touches: TouchEventPayload[] = []
    context.on(electronScreenObservationTouchDelivered, event => touches.push(event.body!))

    for (let i = 0; i < 5; i++)
      await vi.advanceTimersByTimeAsync(15_000)

    const taskState = observer.getState().taskWorkingStates['task-cs-incognito']
    expect(taskState?.evidenceChain ?? []).toHaveLength(0)
    expect(touches.filter(t => t.reason === 'task_blocked')).toHaveLength(0)
  })

  it('falls back to an L2 notice and still stamps the throttle clock when system notifications are unsupported', async () => {
    const { Notification } = await import('electron') as unknown as { Notification: { supported: boolean } }
    Notification.supported = false

    try {
      observer.deliverTouch({
        id: 'touch-1',
        taskId: 'task-9',
        level: 'L3',
        reason: 'deadline_risk',
        createdAt: new Date().toISOString(),
        message: { remainingWork: 'final review pending', isOffTrack: true },
        actions: ['ack', 'details', 'mute_task'],
        policyApplied: [],
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(openTaskTouch).toHaveBeenCalledTimes(1)
      expect(observer.getTouchInteraction('task-9').lastL2PlusTouchAt).toBeDefined()
    }
    finally {
      Notification.supported = true
    }
  })
})
