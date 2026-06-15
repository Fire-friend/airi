import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useConsciousnessStore } from './consciousness'
import { useScreenObservationStore } from './screen-observation'

vi.mock('../providers', () => ({
  useProvidersStore: () => ({
    getProviderMetadata: () => undefined,
    getModelsForProvider: () => [],
    isLoadingModels: {},
    modelLoadError: {},
    fetchModelsForProvider: vi.fn(),
  }),
}))

describe('useConsciousnessStore awareness container', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear()
    setActivePinia(createPinia())
  })

  it('builds a replace-self context message from model, intent, screen, goals, and habit facets', () => {
    const screenObservationStore = useScreenObservationStore()
    screenObservationStore.allowedApps = ['Obsidian']
    screenObservationStore.applyCurrentState({
      capturedAt: '2026-06-11T12:00:00.000Z',
      privacyState: 'observing',
      focusedApp: {
        appName: 'Obsidian',
        windowTitle: 'Quarterly report',
      },
    })
    screenObservationStore.habitFacets = [
      {
        key: 'focus_app:obsidian',
        kind: 'focus_app',
        label: 'Recurring focus app: Obsidian',
        status: 'stable',
        evidenceCount: 3,
        distinctDayCount: 2,
        decayedEvidenceCount: 2.7,
        halfLifeDays: 14,
        firstSeenAt: '2026-06-10T12:00:00.000Z',
        lastSeenAt: '2026-06-11T12:00:00.000Z',
        evidenceHashes: ['a', 'b', 'c'],
      },
      {
        key: 'focus_app:browser',
        kind: 'focus_app',
        label: 'Recurring focus app: Browser',
        status: 'provisional',
        evidenceCount: 1,
        distinctDayCount: 1,
        decayedEvidenceCount: 1,
        halfLifeDays: 14,
        firstSeenAt: '2026-06-11T12:00:00.000Z',
        lastSeenAt: '2026-06-11T12:00:00.000Z',
        evidenceHashes: ['d'],
      },
    ]

    const store = useConsciousnessStore()
    store.activeProvider = 'openai'
    store.activeModel = 'gpt-4.1'
    store.setCurrentActivity('preparing-response')
    store.setCurrentIntent('Answer the user about the active work')
    store.upsertAwarenessGoal({
      id: 'goal-1',
      text: 'Help the user finish the current AIRI task',
      source: 'conversation',
    })

    const contextMessage = store.createSelfAwarenessContextMessage()

    expect(contextMessage).toMatchObject({
      contextId: 'consciousness:self-awareness',
      lane: 'self-awareness',
      strategy: 'replace-self',
    })
    expect(contextMessage.text).toContain('Activity: preparing-response.')
    expect(contextMessage.text).toContain('Current intent: Answer the user about the active work.')
    expect(contextMessage.text).toContain('Model selection: provider=openai, model=gpt-4.1.')
    expect(contextMessage.text).toContain('Current screen link: focused app=Obsidian, window="Quarterly report"')
    expect(contextMessage.text).toContain('Active goals: Help the user finish the current AIRI task (conversation).')
    expect(contextMessage.text).toContain('Stable habit facets: Recurring focus app: Obsidian (evidence=3, days=2).')
    expect(contextMessage.text).toContain('Provisional habit facets: 1; treat these as hypotheses')
  })

  it('resets awareness state with model selection', () => {
    const store = useConsciousnessStore()
    store.activeProvider = 'openai'
    store.activeModel = 'gpt-4.1'
    store.setCurrentActivity('responding')
    store.setCurrentIntent('Answer the user')
    store.upsertAwarenessGoal({
      id: 'goal-1',
      text: 'Finish the task',
      source: 'conversation',
    })

    store.resetState()

    expect(store.activeProvider).toBe('')
    expect(store.activeModel).toBe('')
    expect(store.activity).toBe('idle')
    expect(store.currentIntent).toBe('')
    expect(store.awarenessGoals).toEqual([])
  })
})
