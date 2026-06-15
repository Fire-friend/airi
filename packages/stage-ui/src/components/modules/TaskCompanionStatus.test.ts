import type { TaskWorkingState } from '@proj-airi/server-sdk-shared'

import { describe, expect, it } from 'vitest'

import { stuckEvidenceText } from './taskCompanionEvidence'

function stateFixture(overrides: Partial<TaskWorkingState> = {}): TaskWorkingState {
  return {
    taskId: 'task-1',
    state: 'stuck',
    progressScore: 0,
    stuckScore: 3.5,
    evidenceChain: [],
    ...overrides,
  }
}

describe('stuckEvidenceText', () => {
  it('returns undefined for non-stuck states', () => {
    expect(stuckEvidenceText(stateFixture({ state: 'idle' }))).toBeUndefined()
    expect(stuckEvidenceText(stateFixture({ state: 'progressing' }))).toBeUndefined()
    expect(stuckEvidenceText(stateFixture({ state: 'possibly_stuck' }))).toBeUndefined()
    expect(stuckEvidenceText(stateFixture({ state: 'off_task' }))).toBeUndefined()
  })

  it('returns undefined when evidence chain is empty', () => {
    expect(stuckEvidenceText(stateFixture({ evidenceChain: [] }))).toBeUndefined()
  })

  it('returns undefined when called with undefined', () => {
    expect(stuckEvidenceText(undefined)).toBeUndefined()
  })

  it('prefers repeated_error over generic no_progress', () => {
    const state = stateFixture({
      evidenceChain: [
        { kind: 'no_progress', description: 'No progress evidence has appeared.', capturedAt: '2026-06-15T10:00:00Z' },
        { kind: 'repeated_error', description: 'Same task surface repeated 4 times without progress.', capturedAt: '2026-06-15T10:05:00Z' },
      ],
    })
    expect(stuckEvidenceText(state)).toBe('Same task surface repeated 4 times without progress.')
  })

  it('prefers search_doc_loop over no_progress', () => {
    const state = stateFixture({
      evidenceChain: [
        { kind: 'no_progress', description: 'No progress evidence has appeared.', capturedAt: '2026-06-15T10:00:00Z' },
        { kind: 'search_doc_loop', description: 'Task alternated between work surfaces and search/docs without progress.', capturedAt: '2026-06-15T10:05:00Z' },
      ],
    })
    expect(stuckEvidenceText(state)).toBe('Task alternated between work surfaces and search/docs without progress.')
  })

  it('prefers semantic_blocker over no_progress', () => {
    const state = stateFixture({
      evidenceChain: [
        { kind: 'no_progress', description: 'No progress evidence.', capturedAt: '2026-06-15T10:00:00Z' },
        { kind: 'semantic_blocker', description: 'Summary contains conservative blocker language.', capturedAt: '2026-06-15T10:05:00Z' },
      ],
    })
    expect(stuckEvidenceText(state)).toBe('Summary contains conservative blocker language.')
  })

  it('prefers semantic_blocker over repeated_error when both compete', () => {
    const state = stateFixture({
      evidenceChain: [
        { kind: 'repeated_error', description: 'Same error repeated 3 times.', capturedAt: '2026-06-15T10:00:00Z' },
        { kind: 'semantic_blocker', description: 'Summary contains blocker language: "cannot proceed without access".', capturedAt: '2026-06-15T10:05:00Z' },
      ],
    })
    expect(stuckEvidenceText(state)).toBe('Summary contains blocker language: "cannot proceed without access".')
  })

  it('falls back to no_progress when that is the only entry', () => {
    const state = stateFixture({
      evidenceChain: [
        { kind: 'no_progress', description: 'No progress evidence has appeared in the conservative stuck window.', capturedAt: '2026-06-15T10:00:00Z' },
      ],
    })
    expect(stuckEvidenceText(state)).toBe('No progress evidence has appeared in the conservative stuck window.')
  })

  it('picks the most recent repeated_error when multiple exist', () => {
    // The function reverses the chain before searching, so the last entry wins.
    const state = stateFixture({
      evidenceChain: [
        { kind: 'repeated_error', description: 'First error cycle.', capturedAt: '2026-06-15T10:00:00Z' },
        { kind: 'no_progress', description: 'No progress.', capturedAt: '2026-06-15T10:05:00Z' },
        { kind: 'repeated_error', description: 'Second error cycle — more specific.', capturedAt: '2026-06-15T10:10:00Z' },
      ],
    })
    expect(stuckEvidenceText(state)).toBe('Second error cycle — more specific.')
  })

  it('falls back to the last chain entry when no priority kind matches', () => {
    const state = stateFixture({
      evidenceChain: [
        { kind: 'semantic_progress', description: 'Some progress.', capturedAt: '2026-06-15T10:00:00Z' },
        { kind: 'off_task', description: 'Observation frame belongs to a different task.', capturedAt: '2026-06-15T10:05:00Z' },
      ],
    })
    // No stuck-priority kind present; falls back to last (reversed → first) chain entry.
    expect(stuckEvidenceText(state)).toBe('Observation frame belongs to a different task.')
  })
})
