import type { ScreenObserverSummary } from '@proj-airi/server-sdk-shared'

import { describe, expect, it } from 'vitest'

import {
  classifyScreenObservationContext,
  createScreenObservationContextsFromSummary,
} from './context-engine'

function summaryFixture(overrides: Partial<ScreenObserverSummary> = {}): ScreenObserverSummary {
  return {
    id: 'summary-1',
    capturedAt: '2026-06-13T03:00:00.000Z',
    windowStartedAt: '2026-06-13T02:59:30.000Z',
    windowEndedAt: '2026-06-13T03:00:00.000Z',
    source: 'screenpipe',
    privacyState: 'observing',
    apps: [{
      appId: 'code',
      appName: 'Code',
      windowTitle: 'screen-observer/index.ts',
      observedSeconds: 30,
      summary: 'windows: screen-observer/index.ts',
      matchedWhitelist: false,
    }],
    taskSignals: [],
    summary: 'observed 1 app(s): Code (30s)',
    confidence: 0.9,
    ...overrides,
  }
}

describe('classifyScreenObservationContext', () => {
  it('prioritizes visible errors as state context', () => {
    expect(classifyScreenObservationContext('screenpipe unavailable error in settings')).toBe('state_context')
  })

  it('classifies visible plans and todos as intent context', () => {
    expect(classifyScreenObservationContext('todo next plan for release')).toBe('intent_context')
  })

  it('falls back to activity context when no stronger signal exists', () => {
    expect(classifyScreenObservationContext('editing a report in Code')).toBe('activity_context')
  })
})

describe('createScreenObservationContextsFromSummary', () => {
  it('creates a normalized processed context with evidence linked to the summary', () => {
    const contexts = createScreenObservationContextsFromSummary(summaryFixture({
      summary: 'observed 1 app(s): Code (30s) with failed test output',
      apps: [{
        appId: 'code',
        appName: 'Code',
        windowTitle: 'screen-observer/index.ts',
        observedSeconds: 30,
        summary: 'failed test output',
        matchedWhitelist: false,
      }],
    }), { idFactory: () => 'context-1' })

    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.id).toBe('context-1')
    expect(contexts[0]!.contextType).toBe('state_context')
    expect(contexts[0]!.title).toBe('Screen state in Code')
    expect(contexts[0]!.confidence).toBe(0.9)
    expect(contexts[0]!.importance).toBe(60)
    expect(contexts[0]!.rawReference).toBe('screenpipe-summary:summary-1')
    expect(contexts[0]!.evidence).toEqual([{
      summaryId: 'summary-1',
      appName: 'Code',
      windowTitle: 'screen-observer/index.ts',
      observedSeconds: 30,
    }])
  })

  it('returns no contexts when the observation has no app evidence', () => {
    const contexts = createScreenObservationContextsFromSummary(summaryFixture({ apps: [] }))

    expect(contexts).toEqual([])
  })

  it('deduplicates keywords and entities through shared context normalization', () => {
    const contexts = createScreenObservationContextsFromSummary(summaryFixture({
      apps: [
        {
          appId: 'code',
          appName: 'Code',
          windowTitle: 'index.ts',
          observedSeconds: 5,
          summary: 'editing',
          matchedWhitelist: false,
        },
        {
          appId: 'code-duplicate',
          appName: 'code',
          windowTitle: 'index.ts',
          observedSeconds: 5,
          summary: 'editing',
          matchedWhitelist: false,
        },
      ],
    }), { idFactory: () => 'context-1' })

    expect(contexts[0]!.keywords.filter(keyword => keyword.toLowerCase() === 'code')).toHaveLength(1)
    expect(contexts[0]!.entities.filter(entity => entity.toLowerCase() === 'code')).toHaveLength(1)
  })
})
