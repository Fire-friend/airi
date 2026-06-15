import type { ContextMessage } from '../../types/chat'
import type { HabitFacet } from './screen-observation'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { refManualReset } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { useProvidersStore } from '../providers'
import { useScreenObservationStore } from './screen-observation'

const SELF_AWARENESS_CONTEXT_ID = 'consciousness:self-awareness'
const MAX_AWARENESS_GOALS = 5
const MAX_AWARENESS_HABIT_FACETS = 5

export type AgentActivityState
  = | 'idle'
    | 'listening'
    | 'preparing-response'
    | 'responding'
    | 'acting'

export type AgentAwarenessGoalSource
  = | 'conversation'
    | 'screen-observation'
    | 'system'
    | 'manual'

export type AgentAwarenessGoalStatus
  = | 'active'
    | 'completed'
    | 'dismissed'

export interface AgentAwarenessGoal {
  id: string
  text: string
  source: AgentAwarenessGoalSource
  status: AgentAwarenessGoalStatus
  createdAt: number
  updatedAt: number
}

export interface AgentAwarenessHabitFacet {
  key: string
  label: string
  status: HabitFacet['status']
  evidenceCount: number
  distinctDayCount: number
  lastSeenAt: string
  pinned?: boolean
}

export interface AgentAwarenessSnapshot {
  activity: AgentActivityState
  intent?: string
  model: {
    configured: boolean
    provider?: string
    model?: string
  }
  goals: AgentAwarenessGoal[]
  screen: {
    privacyState: string
    observationSourceAvailable?: boolean
    currentState?: {
      appName: string
      windowTitle?: string
      capturedAt: string
    }
  }
  memory: {
    stableHabitFacets: AgentAwarenessHabitFacet[]
    provisionalHabitFacetCount: number
  }
  updatedAt: number
}

export interface UpsertAgentAwarenessGoalInput {
  id: string
  text: string
  source: AgentAwarenessGoalSource
  status?: AgentAwarenessGoalStatus
}

function mapHabitFacet(facet: HabitFacet): AgentAwarenessHabitFacet {
  return {
    key: facet.key,
    label: facet.label,
    status: facet.status,
    evidenceCount: facet.evidenceCount,
    distinctDayCount: facet.distinctDayCount,
    lastSeenAt: facet.lastSeenAt,
    pinned: facet.pinned,
  }
}

function formatSelfAwarenessText(snapshot: AgentAwarenessSnapshot): string {
  const lines = [
    'Self-awareness snapshot: use this to keep AIRI grounded in its own state; do not repeat it unless relevant.',
    `Activity: ${snapshot.activity}.`,
    snapshot.intent ? `Current intent: ${snapshot.intent}.` : 'Current intent: none declared.',
    snapshot.model.configured
      ? `Model selection: provider=${snapshot.model.provider}, model=${snapshot.model.model}.`
      : 'Model selection: not fully configured.',
    `Screen observation: privacy=${snapshot.screen.privacyState}, source=${snapshot.screen.observationSourceAvailable === undefined ? 'unknown' : snapshot.screen.observationSourceAvailable ? 'available' : 'unavailable'}.`,
  ]

  if (snapshot.screen.currentState) {
    const windowText = snapshot.screen.currentState.windowTitle
      ? `, window="${snapshot.screen.currentState.windowTitle}"`
      : ''
    lines.push(`Current screen link: focused app=${snapshot.screen.currentState.appName}${windowText}; capturedAt=${snapshot.screen.currentState.capturedAt}.`)
  }
  else {
    lines.push('Current screen link: no privacy-allowed focused app is available.')
  }

  if (snapshot.goals.length > 0) {
    lines.push(`Active goals: ${snapshot.goals.map(goal => `${goal.text} (${goal.source})`).join('; ')}.`)
  }
  else {
    lines.push('Active goals: none recorded in the awareness container.')
  }

  if (snapshot.memory.stableHabitFacets.length > 0) {
    lines.push(`Stable habit facets: ${snapshot.memory.stableHabitFacets.map(facet => `${facet.label} (evidence=${facet.evidenceCount}, days=${facet.distinctDayCount})`).join('; ')}.`)
  }
  else {
    lines.push('Stable habit facets: none yet.')
  }

  lines.push(`Provisional habit facets: ${snapshot.memory.provisionalHabitFacetCount}; treat these as hypotheses, not personality or durable preference.`)

  return lines.join('\n')
}

export const useConsciousnessStore = defineStore('consciousness', () => {
  const providersStore = useProvidersStore()
  const screenObservationStore = useScreenObservationStore()

  // State
  const activeProvider = useLocalStorageManualReset<string>('settings/consciousness/active-provider', '')
  const activeModel = useLocalStorageManualReset<string>('settings/consciousness/active-model', '')
  const activeCustomModelName = useLocalStorageManualReset<string>('settings/consciousness/active-custom-model', '')
  const expandedDescriptions = refManualReset<Record<string, boolean>>(() => ({}))
  const modelSearchQuery = refManualReset<string>('')
  const activity = refManualReset<AgentActivityState>('idle')
  const currentIntent = refManualReset<string>('')
  const awarenessGoals = refManualReset<AgentAwarenessGoal[]>(() => [])
  const awarenessUpdatedAt = refManualReset<number>(() => Date.now())

  // Computed properties
  const supportsModelListing = computed(() => {
    return providersStore.getProviderMetadata(activeProvider.value)?.capabilities.listModels !== undefined
  })

  const providerModels = computed(() => {
    return providersStore.getModelsForProvider(activeProvider.value)
  })

  const isLoadingActiveProviderModels = computed(() => {
    return providersStore.isLoadingModels[activeProvider.value] || false
  })

  const activeProviderModelError = computed(() => {
    return providersStore.modelLoadError[activeProvider.value] || null
  })

  const filteredModels = computed(() => {
    if (!modelSearchQuery.value.trim()) {
      return providerModels.value
    }

    const query = modelSearchQuery.value.toLowerCase().trim()
    return providerModels.value.filter(model =>
      model.name.toLowerCase().includes(query)
      || model.id.toLowerCase().includes(query)
      || (model.description && model.description.toLowerCase().includes(query)),
    )
  })

  function resetModelSelection() {
    activeModel.reset()
    activeCustomModelName.reset()
    expandedDescriptions.reset()
    modelSearchQuery.reset()
  }

  async function loadModelsForProvider(provider: string) {
    if (provider && providersStore.getProviderMetadata(provider)?.capabilities.listModels !== undefined) {
      await providersStore.fetchModelsForProvider(provider)
    }
  }

  async function getModelsForProvider(provider: string) {
    if (provider && providersStore.getProviderMetadata(provider)?.capabilities.listModels !== undefined) {
      return providersStore.getModelsForProvider(provider)
    }

    return []
  }

  const configured = computed(() => {
    return !!activeProvider.value && !!activeModel.value
  })

  const activeAwarenessGoals = computed(() => {
    return awarenessGoals.value
      .filter(goal => goal.status === 'active')
      .slice(0, MAX_AWARENESS_GOALS)
  })

  const awarenessSnapshot = computed<AgentAwarenessSnapshot>(() => {
    const latestCurrentState = screenObservationStore.latestCurrentState
    return {
      activity: activity.value,
      intent: currentIntent.value.trim() || undefined,
      model: {
        configured: configured.value,
        provider: activeProvider.value || undefined,
        model: activeModel.value || undefined,
      },
      goals: activeAwarenessGoals.value,
      screen: {
        privacyState: screenObservationStore.privacyState,
        observationSourceAvailable: screenObservationStore.observationSourceAvailable,
        currentState: latestCurrentState?.focusedApp
          ? {
              appName: latestCurrentState.focusedApp.appName,
              windowTitle: latestCurrentState.focusedApp.windowTitle,
              capturedAt: latestCurrentState.capturedAt,
            }
          : undefined,
      },
      memory: {
        stableHabitFacets: screenObservationStore.stableHabitFacets
          .slice(0, MAX_AWARENESS_HABIT_FACETS)
          .map(mapHabitFacet),
        provisionalHabitFacetCount: screenObservationStore.provisionalHabitFacets.length,
      },
      updatedAt: awarenessUpdatedAt.value,
    }
  })

  const selfAwarenessPromptText = computed(() => formatSelfAwarenessText(awarenessSnapshot.value))

  function touchAwareness() {
    awarenessUpdatedAt.value = Date.now()
  }

  function setCurrentActivity(nextActivity: AgentActivityState) {
    activity.value = nextActivity
    touchAwareness()
  }

  function setCurrentIntent(intent: string) {
    currentIntent.value = intent.trim()
    touchAwareness()
  }

  function clearCurrentIntent() {
    currentIntent.reset()
    touchAwareness()
  }

  function upsertAwarenessGoal(input: UpsertAgentAwarenessGoalInput) {
    const now = Date.now()
    const existing = awarenessGoals.value.find(goal => goal.id === input.id)
    const nextGoal: AgentAwarenessGoal = {
      id: input.id,
      text: input.text,
      source: input.source,
      status: input.status ?? existing?.status ?? 'active',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    awarenessGoals.value = [
      nextGoal,
      ...awarenessGoals.value.filter(goal => goal.id !== input.id),
    ]
    touchAwareness()
  }

  function setAwarenessGoalStatus(id: string, status: AgentAwarenessGoalStatus) {
    awarenessGoals.value = awarenessGoals.value.map(goal => goal.id === id
      ? { ...goal, status, updatedAt: Date.now() }
      : goal)
    touchAwareness()
  }

  function clearAwarenessGoals() {
    awarenessGoals.reset()
    touchAwareness()
  }

  function createSelfAwarenessContextMessage(): ContextMessage {
    return {
      id: `${SELF_AWARENESS_CONTEXT_ID}:${Date.now()}`,
      contextId: SELF_AWARENESS_CONTEXT_ID,
      lane: 'self-awareness',
      strategy: ContextUpdateStrategy.ReplaceSelf,
      text: selfAwarenessPromptText.value,
      createdAt: Date.now(),
    }
  }

  function resetState() {
    activeProvider.reset()
    resetModelSelection()
    activity.reset()
    currentIntent.reset()
    awarenessGoals.reset()
    awarenessUpdatedAt.value = Date.now()
  }

  return {
    // State
    configured,
    activeProvider,
    activeModel,
    customModelName: activeCustomModelName,
    expandedDescriptions,
    modelSearchQuery,
    activity,
    currentIntent,
    awarenessGoals,
    awarenessUpdatedAt,

    // Computed
    supportsModelListing,
    providerModels,
    isLoadingActiveProviderModels,
    activeProviderModelError,
    filteredModels,
    activeAwarenessGoals,
    awarenessSnapshot,
    selfAwarenessPromptText,

    // Actions
    resetModelSelection,
    loadModelsForProvider,
    getModelsForProvider,
    setCurrentActivity,
    setCurrentIntent,
    clearCurrentIntent,
    upsertAwarenessGoal,
    setAwarenessGoalStatus,
    clearAwarenessGoals,
    createSelfAwarenessContextMessage,
    resetState,
  }
})
