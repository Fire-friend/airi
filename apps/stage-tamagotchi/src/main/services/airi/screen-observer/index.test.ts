import type { ScreenObserverSummary, TouchAction, TouchEventPayload } from '@proj-airi/server-sdk-shared'
import type { BrowserWindow } from 'electron'
import type { Mock } from 'vitest'

import type { NativeScreenObservationFrameResult } from '../../../../shared/eventa/screen-observation'
import type { I18n } from '../../../libs/i18n'
import type { NativeScreenObservationCaptureController } from './native-capture'
import type { ScreenpipeClient } from './screenpipe'
import type { ScreenpipeSupervisor } from './supervisor'

import { fileURLToPath } from 'node:url'

import { createContext, defineInvoke } from '@moeru/eventa'
import { createScreenObservationTask } from '@proj-airi/server-sdk-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  electronScreenObservationOpenDataFolder,
  electronScreenObservationPause,
  electronScreenObservationSelectDataFolder,
  electronScreenObservationSummaryCaptured,
  electronScreenObservationTouchDelivered,
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
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['D:\\screenpipe-data'] })) },
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
    shell: { openPath: vi.fn(async () => '') },
  }
})

vi.mock('./native-capture', () => ({
  createNativeScreenObservationCapture: vi.fn(() => {
    throw new Error('native capture should be injected in screen observer tests')
  }),
}))

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
const TEST_SCREENPIPE_DATA_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))
const TEST_CUSTOM_SCREENPIPE_DATA_DIRECTORY = fileURLToPath(new URL('custom-screenpipe-data', import.meta.url))

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
  let ensureScreenpipeRunning: Mock<ScreenpipeSupervisor['ensureRunning']>
  let searchOcr: ReturnType<typeof vi.fn>
  let observer: ReturnType<typeof setupScreenObserver>
  let context: ReturnType<typeof createContext>
  let stopScreenpipe: Mock<ScreenpipeSupervisor['stop']>
  let startNativeCapture: Mock<NativeScreenObservationCaptureController['start']>
  let stopNativeCapture: Mock<NativeScreenObservationCaptureController['stop']>
  let nativeFrameListeners: Set<(frame: NativeScreenObservationFrameResult) => void>

  function setup(options: { screenpipeDataDirectory?: string } = {}) {
    openTaskTouch = vi.fn<(touch: TouchEventPayload) => Promise<TouchAction | undefined>>(async () => 'ack')
    searchOcr = vi.fn(async ({ appName }: { appName?: string }) => ({
      items: [{ appName: appName ?? 'Desktop App', windowName: 'report.md', text: 'Q2 numbers', timestamp: new Date().toISOString() }],
      complete: true,
    }))

    const screenpipe: ScreenpipeClient = {
      health: vi.fn(async () => true),
      searchOcr: searchOcr as unknown as ScreenpipeClient['searchOcr'],
      focusedWindow: vi.fn(async () => ({ appName: 'Code', windowTitle: 'report.md' })),
    }
    ensureScreenpipeRunning = vi.fn<ScreenpipeSupervisor['ensureRunning']>(async () => ({ mode: 'external' }))
    stopScreenpipe = vi.fn<ScreenpipeSupervisor['stop']>(async () => {})
    startNativeCapture = vi.fn<NativeScreenObservationCaptureController['start']>(async () => ({ running: true, sourceCount: 2 }))
    stopNativeCapture = vi.fn<NativeScreenObservationCaptureController['stop']>(async () => ({ running: false, sourceCount: 0 }))
    nativeFrameListeners = new Set<(frame: NativeScreenObservationFrameResult) => void>()

    const screenpipeSupervisor: ScreenpipeSupervisor = {
      ensureRunning: ensureScreenpipeRunning,
      getState: () => ({ mode: 'idle' }),
      stop: stopScreenpipe,
    }

    const nativeCapture: NativeScreenObservationCaptureController = {
      start: startNativeCapture,
      stop: stopNativeCapture,
      getStatus: vi.fn(async () => ({ running: false, sourceCount: 0 })),
      onFrame: (callback) => {
        nativeFrameListeners.add(callback)
        return () => nativeFrameListeners.delete(callback)
      },
      dispose: vi.fn(),
    }

    observer = setupScreenObserver({
      i18n: fakeI18n,
      noticeWindow: { openTaskTouch },
      screenpipe,
      screenpipeSupervisor,
      nativeCapture,
      screenpipeDataDirectory: options.screenpipeDataDirectory ?? TEST_SCREENPIPE_DATA_DIRECTORY,
    })

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
    expect(searchOcr).not.toHaveBeenCalled()

    // The user enables observation. Default desktop mode observes the whole
    // connected desktop stream instead of requiring an app list.
    const enabled = await updateSettings({ enabled: true, captureBackend: 'screenpipe' })
    expect(enabled.privacyState).toBe('observing')
    expect(enabled.settings.mode).toBe('desktop')
    expect(enabled.settings.captureBackend).toBe('screenpipe')

    // The chat layer registers the confirmed task with the runtime.
    const task = activeTask('task-1')
    const withTask = await upsertTask({ task })
    expect(withTask.tasks.map(t => t.id)).toEqual(['task-1'])

    // Next tick: capture runs without an app_name filter.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(ensureScreenpipeRunning).toHaveBeenCalled()
    expect(searchOcr).toHaveBeenCalled()
    for (const call of searchOcr.mock.calls)
      expect((call[0] as { appName?: string }).appName).toBeUndefined()
    expect(summaries.length).toBeGreaterThan(0)
    expect(summaries[0]!.apps[0]!.appName).toBe('Desktop App')
    expect(summaries[0]!.contexts).toHaveLength(1)
    expect(summaries[0]!.contexts![0]!.contextType).toBe('activity_context')
    expect(summaries[0]!.contexts![0]!.evidence[0]).toMatchObject({
      summaryId: summaries[0]!.id,
      appName: 'Desktop App',
      windowTitle: 'report.md',
    })

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

  it('starts and stops the internal screenpipe sidecar with explicit legacy capture intent', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)

    ensureScreenpipeRunning.mockClear()
    stopScreenpipe.mockClear()

    await updateSettings({ enabled: true, captureBackend: 'screenpipe' })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    expect(ensureScreenpipeRunning).toHaveBeenCalled()

    await updateSettings({ enabled: false, captureBackend: 'screenpipe' })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    expect(stopScreenpipe).toHaveBeenCalled()
  })

  it('uses native frame capture by default and converts interpreted frames into summaries', async () => {
    const summaries: ScreenObserverSummary[] = []
    context.on(electronScreenObservationSummaryCaptured, event => summaries.push(event.body!.summary))
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)

    ensureScreenpipeRunning.mockClear()
    startNativeCapture.mockClear()

    const enabled = await updateSettings({ enabled: true })
    expect(enabled.settings.captureBackend).toBe('native_frames')

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    expect(ensureScreenpipeRunning).not.toHaveBeenCalled()
    expect(startNativeCapture).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'desktop',
      intervalMs: 10_000,
      workloadId: 'screen:interpret',
      publishContext: true,
    }))

    for (const listener of nativeFrameListeners) {
      listener({
        id: 'frame-1',
        capturedAt: '2026-06-11T10:00:30.000Z',
        sourceId: 'screen:1',
        sourceName: 'Display 1',
        displayId: '1',
        width: 1280,
        height: 720,
        text: 'VS Code is open with a quarterly report draft.',
        confidence: 0.85,
      })
    }

    await vi.waitFor(() => {
      expect(summaries).toHaveLength(1)
      expect(summaries[0]!.source).toBe('native_frames')
      expect(summaries[0]!.apps[0]).toMatchObject({
        appName: 'Display 1',
        summary: 'VS Code is open with a quarterly report draft.',
      })
      expect(summaries[0]!.contexts?.[0]?.contextType).toBe('activity_context')
    })
  })

  it('opens the screenpipe data folder through Electron shell', async () => {
    const { shell } = await import('electron') as unknown as { shell: { openPath: Mock<(path: string) => Promise<string>> } }
    const openDataFolder = defineInvoke(context, electronScreenObservationOpenDataFolder)

    await expect(observer.openDataFolder()).resolves.toEqual({ path: TEST_SCREENPIPE_DATA_DIRECTORY })
    await expect(openDataFolder()).resolves.toEqual({ path: TEST_SCREENPIPE_DATA_DIRECTORY })

    expect(shell.openPath).toHaveBeenCalledTimes(2)
    expect(shell.openPath).toHaveBeenCalledWith(TEST_SCREENPIPE_DATA_DIRECTORY)
  })

  it('selects a custom screenpipe data folder through Electron dialog', async () => {
    const { dialog } = await import('electron') as unknown as {
      dialog: { showOpenDialog: Mock<(options: unknown) => Promise<{ canceled: boolean, filePaths: string[] }>> }
    }
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [TEST_CUSTOM_SCREENPIPE_DATA_DIRECTORY] })
    const selectDataFolder = defineInvoke(context, electronScreenObservationSelectDataFolder)

    await expect(observer.selectDataFolder()).resolves.toEqual({ path: TEST_CUSTOM_SCREENPIPE_DATA_DIRECTORY })
    await expect(selectDataFolder()).resolves.toEqual({ path: 'D:\\screenpipe-data' })

    expect(dialog.showOpenDialog).toHaveBeenCalledWith({
      defaultPath: TEST_SCREENPIPE_DATA_DIRECTORY,
      properties: ['openDirectory', 'createDirectory'],
    })
  })

  it('passes the configured data folder to managed screenpipe startup', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)

    ensureScreenpipeRunning.mockClear()

    await updateSettings({ enabled: true, captureBackend: 'screenpipe', screenpipeDataDirectory: TEST_CUSTOM_SCREENPIPE_DATA_DIRECTORY })

    await vi.waitFor(() => {
      expect(ensureScreenpipeRunning).toHaveBeenCalledWith({ dataDirectory: TEST_CUSTOM_SCREENPIPE_DATA_DIRECTORY })
    })
    expect(observer.getState().settings.screenpipeDataDirectory).toBe(TEST_CUSTOM_SCREENPIPE_DATA_DIRECTORY)
  })

  it('shows screenpipe as checking and starts a health tick immediately when observation is enabled', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)

    ensureScreenpipeRunning.mockClear()

    const enabled = await updateSettings({ enabled: true, captureBackend: 'screenpipe' })

    expect(enabled.privacyState).toBe('observing')
    expect(enabled.screenpipeAvailable).toBeUndefined()

    await vi.waitFor(() => expect(ensureScreenpipeRunning).toHaveBeenCalled())
    await vi.waitFor(() => expect(observer.getState().screenpipeAvailable).toBe(true))
  })

  it('treats application observation as a special scoped mode', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)

    await updateSettings({ enabled: true, captureBackend: 'screenpipe', mode: 'application', allowedApps: [' Code ', 'code'] })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    expect(observer.getState().settings.mode).toBe('application')
    expect(observer.getState().settings.allowedApps).toEqual(['Code'])
    expect(searchOcr).toHaveBeenCalled()
    for (const call of searchOcr.mock.calls)
      expect((call[0] as { appName?: string }).appName).toBe('Code')
  })

  it('does not start screenpipe for application mode without selected apps', async () => {
    const updateSettings = defineInvoke(context, electronScreenObservationUpdateSettings)

    ensureScreenpipeRunning.mockClear()
    await updateSettings({ enabled: true, mode: 'application', allowedApps: [] })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    expect(observer.getState().privacyState).toBe('not_observing_empty_whitelist')
    expect(ensureScreenpipeRunning).not.toHaveBeenCalled()
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
