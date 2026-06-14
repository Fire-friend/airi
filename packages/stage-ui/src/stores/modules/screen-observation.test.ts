import type { ScreenObserverSummary, Task, TaskWorkingState, TouchEventPayload } from '@proj-airi/server-sdk-shared'

import { estimateTokens } from '@proj-airi/core-agent'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { LONG_MEMORY_CONTEXT_BUDGET_TOKENS, privacyStateLabelKey, provisionalPrivacyState, TASK_STATE_CONTEXT_BUDGET_TOKENS, useScreenObservationStore } from './screen-observation'

const now = new Date('2026-06-11T12:00:00.000Z')

describe('provisionalPrivacyState', () => {
  it('reports disabled while the master switch is off, regardless of whitelist', () => {
    expect(provisionalPrivacyState({ enabled: false, allowedApps: [], now })).toBe('disabled')
    expect(provisionalPrivacyState({ enabled: false, allowedApps: ['obsidian'], now })).toBe('disabled')
  })

  it('treats an enabled switch with an empty whitelist as the explicit not-observing dead-state', () => {
    expect(provisionalPrivacyState({ enabled: true, allowedApps: [], now })).toBe('not_observing_empty_whitelist')
  })

  it('reports paused only while pauseUntil is in the future', () => {
    expect(provisionalPrivacyState({
      enabled: true,
      allowedApps: ['obsidian'],
      pauseUntil: '2026-06-11T13:00:00.000Z',
      now,
    })).toBe('paused')
    expect(provisionalPrivacyState({
      enabled: true,
      allowedApps: ['obsidian'],
      pauseUntil: '2026-06-11T11:00:00.000Z',
      now,
    })).toBe('observing')
  })

  it('reports observing when enabled with a non-empty whitelist and no pause', () => {
    expect(provisionalPrivacyState({ enabled: true, allowedApps: ['obsidian'], now })).toBe('observing')
  })
})

describe('privacyStateLabelKey', () => {
  it('maps every state to a kebab-case i18n key', () => {
    expect(privacyStateLabelKey('observing')).toBe('settings.pages.modules.screen-observation.status.observing')
    expect(privacyStateLabelKey('not_observing_empty_whitelist')).toBe('settings.pages.modules.screen-observation.status.not-observing-empty-whitelist')
    expect(privacyStateLabelKey('suppressed_fullscreen')).toBe('settings.pages.modules.screen-observation.status.suppressed-fullscreen')
  })
})

describe('useScreenObservationStore appliers', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear()
    setActivePinia(createPinia())
  })

  function summaryFixture(
    id: string,
    capturedAt = '2026-06-11T12:00:00.000Z',
    overrides: Partial<ScreenObserverSummary> = {},
  ): ScreenObserverSummary {
    const start = new Date(new Date(capturedAt).getTime() - 30_000).toISOString()
    return {
      id,
      capturedAt,
      windowStartedAt: start,
      windowEndedAt: capturedAt,
      source: 'minecontext',
      privacyState: 'observing',
      apps: [{ appId: 'obsidian', appName: 'Obsidian', observedSeconds: 30, summary: 'editing report', matchedWhitelist: true }],
      taskSignals: [],
      summary: 'editing report outline',
      confidence: 0.9,
      ...overrides,
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

  function taskFixture(id = 'task-1'): Task {
    return {
      id,
      userId: 'user-1',
      title: 'Write quarterly report',
      status: 'active',
      priority: 'normal',
      goal: 'Write quarterly report with the final chart',
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

  function taskWorkingStateFixture(overrides: Partial<TaskWorkingState> = {}): TaskWorkingState {
    return {
      taskId: 'task-1',
      state: 'stuck',
      progressScore: 0.2,
      stuckScore: 3.8,
      stuckStartedAt: '2026-06-11T11:50:00.000Z',
      evidenceChain: [{
        kind: 'repeated_error',
        description: `TypeError: heap out of memory while building chart\n${'Worker crashed\n'.repeat(200)}Supervisor giving up`,
        fingerprint: 'terminal:error:heap-out-of-memory',
        capturedAt: '2026-06-11T11:59:30.000Z',
      }],
      ...overrides,
    }
  }

  it('applyRuntimeState lets the runtime win over renderer-persisted settings', () => {
    const store = useScreenObservationStore()
    store.enabled = true
    store.allowedApps = ['stale-local-app']

    store.applyRuntimeState({
      settings: { enabled: false, mode: 'whitelist', allowedApps: [], dailySummaryEnabled: true, dailySummaryAtLocalTime: '18:00' },
      privacyState: 'disabled',
      observationSourceAvailable: true,
    })

    expect(store.enabled).toBe(false)
    expect(store.allowedApps).toEqual([])
    expect(store.privacyState).toBe('disabled')
    expect(store.observationSourceAvailable).toBe(true)
  })

  it('applyRuntimeState surfaces the runtime-resolved suppression states the renderer cannot derive', () => {
    const store = useScreenObservationStore()

    store.applyRuntimeState({
      settings: { enabled: true, mode: 'whitelist', allowedApps: ['obsidian'], dailySummaryEnabled: true, dailySummaryAtLocalTime: '18:00' },
      privacyState: 'suppressed_meeting',
    })

    expect(store.privacyState).toBe('suppressed_meeting')
    expect(store.isEffectivelyObserving).toBe(false)
  })

  it('applySummary prepends new entries and replaces redelivered duplicates by id', () => {
    const store = useScreenObservationStore()

    store.applySummary(summaryFixture('s-1'))
    store.applySummary(summaryFixture('s-2'))
    expect(store.observationLog.map(entry => entry.id)).toEqual(['s-2', 's-1'])

    const redelivered = { ...summaryFixture('s-1'), summary: 'updated digest' }
    store.applySummary(redelivered)
    expect(store.observationLog.map(entry => entry.id)).toEqual(['s-1', 's-2'])
    expect(store.observationLog[0]!.summary).toBe('updated digest')
  })

  it('builds short-lived current-state context without adding long-memory evidence', () => {
    const store = useScreenObservationStore()
    store.allowedApps = ['obsidian']
    const longWindowTitle = `Quarterly report ${'chart '.repeat(200)}`

    const contextUpdate = store.applyCurrentState({
      capturedAt: '2026-06-11T12:00:00.000Z',
      privacyState: 'observing',
      focusedApp: { appName: 'Obsidian', windowTitle: longWindowTitle },
    })

    expect(contextUpdate).toMatchObject({
      contextId: 'screen-observation:current-state',
      strategy: 'replace-self',
      metadata: { lane: 'current-state', retention: 'ephemeral', longMemory: false },
    })
    expect(contextUpdate?.text).toContain('short-lived')
    expect(contextUpdate?.text).toContain(longWindowTitle)
    expect(contextUpdate?.metadata).not.toHaveProperty('tokenJuice')
    expect(store.latestCurrentState?.focusedApp?.appName).toBe('Obsidian')
    expect(store.longMemoryCandidates).toHaveLength(0)
  })

  it('builds budgeted task-state context without dropping task and stuck evidence', () => {
    const store = useScreenObservationStore()

    const updates = store.applyRuntimeState({
      settings: { enabled: true, mode: 'whitelist', allowedApps: ['obsidian'], dailySummaryEnabled: true, dailySummaryAtLocalTime: '18:00' },
      privacyState: 'observing',
      tasks: [taskFixture()],
      taskWorkingStates: { 'task-1': taskWorkingStateFixture() },
    })

    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      contextId: 'screen-observation:task-state:task-1',
      strategy: 'replace-self',
      metadata: {
        lane: 'task-state',
        retention: 'ephemeral-task-state',
        tokenJuice: true,
        tokenBudget: TASK_STATE_CONTEXT_BUDGET_TOKENS,
        longMemory: false,
        personality: false,
        forgettable: true,
      },
    })
    expect(estimateTokens(updates[0]!.text)).toBeLessThanOrEqual(TASK_STATE_CONTEXT_BUDGET_TOKENS)
    expect(updates[0]!.text).toContain('Write quarterly report')
    expect(updates[0]!.text).toContain('State: stuck')
    expect(updates[0]!.text).toContain('heap out of memory')
  })

  it('forgets task-state evidence and publishes a cleared task-state context', () => {
    const store = useScreenObservationStore()
    store.applyRuntimeState({
      settings: { enabled: true, mode: 'whitelist', allowedApps: ['obsidian'], dailySummaryEnabled: true, dailySummaryAtLocalTime: '18:00' },
      privacyState: 'observing',
      tasks: [taskFixture()],
      taskWorkingStates: { 'task-1': taskWorkingStateFixture() },
    })

    const updates = store.forgetTaskStateEvidence('task-1')

    expect(store.taskWorkingStates['task-1']?.evidenceChain).toEqual([])
    expect(updates).toHaveLength(1)
    expect(updates[0]!.contextId).toBe('screen-observation:task-state:task-1')
    expect(updates[0]!.metadata).toMatchObject({ evidenceCount: 0, forgettable: true })
    expect(updates[0]!.text).toContain('evidence was cleared')
    expect(updates[0]!.text).not.toContain('heap out of memory')
  })

  it('does not publish current-state for a non-whitelisted focused app', () => {
    const store = useScreenObservationStore()
    store.allowedApps = ['Code']

    const contextUpdate = store.applyCurrentState({
      capturedAt: '2026-06-11T12:00:00.000Z',
      privacyState: 'observing',
      focusedApp: { appName: 'Obsidian', windowTitle: 'Quarterly report' },
    })

    expect(contextUpdate).toBeUndefined()
    expect(store.latestCurrentState).toBeUndefined()
    expect(store.longMemoryCandidates).toHaveLength(0)
  })

  it('blocks denied apps and private windows before they reach context or memory', () => {
    const store = useScreenObservationStore()
    store.allowedApps = ['Bitwarden']

    expect(store.applyCurrentState({
      capturedAt: '2026-06-11T12:00:00.000Z',
      privacyState: 'observing',
      focusedApp: { appName: 'Bitwarden', windowTitle: 'Vault' },
    })).toBeUndefined()
    expect(store.latestCurrentState).toBeUndefined()

    const deniedSummary = summaryFixture('s-private', '2026-06-11T12:00:00.000Z', {
      apps: [{
        appId: 'browser',
        appName: 'Browser',
        windowTitle: 'github.com/settings/tokens',
        observedSeconds: 30,
        summary: 'viewing token settings',
        matchedWhitelist: true,
      }],
      summary: 'viewing token settings',
    })

    expect(store.applySummary(deniedSummary)).toBeUndefined()
    expect(store.observationLog).toHaveLength(0)
    expect(store.longMemoryCandidates).toHaveLength(0)
  })

  it('dedupes long-memory candidates by content-addressed hash', () => {
    const store = useScreenObservationStore()

    const first = store.applySummary(summaryFixture('s-1'))
    const duplicate = store.applySummary(summaryFixture('s-redelivered'))

    expect(first?.duplicate).toBe(false)
    expect(first?.contextUpdate).toMatchObject({
      contextId: 'screen-observation:long-memory-candidates',
      strategy: 'replace-self',
      metadata: {
        lane: 'long-memory-candidate',
        privacyFiltered: true,
        tokenJuice: true,
        tokenBudget: LONG_MEMORY_CONTEXT_BUDGET_TOKENS,
      },
    })
    expect(estimateTokens(first!.contextUpdate!.text)).toBeLessThanOrEqual(LONG_MEMORY_CONTEXT_BUDGET_TOKENS)
    expect(duplicate?.duplicate).toBe(true)
    expect(duplicate?.contextUpdate).toBeUndefined()
    expect(store.longMemoryCandidates).toHaveLength(1)
  })

  it('promotes recurring app focus to a stable facet only after multi-day evidence', () => {
    const store = useScreenObservationStore()

    store.applySummary(summaryFixture('s-1', '2026-06-09T12:00:00.000Z'))
    store.applySummary(summaryFixture('s-2', '2026-06-10T12:00:00.000Z'))
    const result = store.applySummary(summaryFixture('s-3', '2026-06-11T12:00:00.000Z'))

    expect(result?.promotedFacets).toHaveLength(1)
    expect(store.stableHabitFacets).toHaveLength(1)
    expect(store.stableHabitFacets[0]).toMatchObject({
      key: 'focus_app:obsidian',
      status: 'stable',
      evidenceCount: 3,
      distinctDayCount: 3,
      halfLifeDays: 14,
    })
    expect(result?.contextUpdate?.text).toContain('Stable facets: Recurring focus app: Obsidian')
  })

  it('forgets a facet and clears its evidence chain', () => {
    const store = useScreenObservationStore()

    store.applySummary(summaryFixture('s-1', '2026-06-09T12:00:00.000Z'))
    store.applySummary(summaryFixture('s-2', '2026-06-10T12:00:00.000Z'))
    store.applySummary(summaryFixture('s-3', '2026-06-11T12:00:00.000Z'))
    expect(store.stableHabitFacets).toHaveLength(1)

    store.forgetFacet('focus_app:obsidian')

    expect(store.habitFacets).toHaveLength(0)
    expect(store.longMemoryCandidates).toHaveLength(0)
    expect(store.forgottenFacetKeys).toContain('focus_app:obsidian')
  })

  it('applyTouch prepends and dedupes by id', () => {
    const store = useScreenObservationStore()

    store.applyTouch(touchFixture('t-1'))
    store.applyTouch(touchFixture('t-2'))
    store.applyTouch(touchFixture('t-1'))

    expect(store.latestTouches.map(entry => entry.id)).toEqual(['t-1', 't-2'])
  })
})
