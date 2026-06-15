import type { Task } from '@proj-airi/server-sdk-shared'

import { createScreenObservationTask } from '@proj-airi/server-sdk-shared'
import { describe, expect, it } from 'vitest'

// Tests verify the task-building contract used by TaskSetEntry.vue so the
// component's submit handler cannot silently break the IPC shape.

describe('createScreenObservationTask (TaskSetEntry contract)', () => {
  const now = new Date('2026-06-15T10:00:00.000Z')

  function buildTask(overrides: Parameters<typeof createScreenObservationTask>[0]): Task {
    return createScreenObservationTask(overrides, now)
  }

  it('sets status to active when the user confirms the task', () => {
    const task = buildTask({
      id: 'task-123',
      userId: 'local',
      title: 'Write the introduction',
      status: 'active',
    })
    expect(task.status).toBe('active')
  })

  it('uses title as goal when goal is omitted', () => {
    const task = buildTask({
      id: 'task-123',
      userId: 'local',
      title: 'Write the introduction',
    })
    expect(task.goal).toBe('Write the introduction')
  })

  it('uses the provided goal over title when given', () => {
    const task = buildTask({
      id: 'task-123',
      userId: 'local',
      title: 'Write the introduction',
      goal: 'Draft three paragraphs about the problem',
    })
    expect(task.goal).toBe('Draft three paragraphs about the problem')
  })

  it('puts specified apps in observation.allowedApps', () => {
    const task = buildTask({
      id: 'task-123',
      userId: 'local',
      title: 'Write the introduction',
      observation: { allowedApps: ['Obsidian', 'VS Code'] },
    })
    expect(task.observation.allowedApps).toEqual(['Obsidian', 'VS Code'])
  })

  it('builds a task where observation.enabled is true by default', () => {
    const task = buildTask({
      id: 'task-123',
      userId: 'local',
      title: 'Write the introduction',
      status: 'active',
    })
    expect(task.observation.enabled).toBe(true)
  })

  it('sets privacyState to not_observing_empty_whitelist when no apps provided', () => {
    const task = buildTask({
      id: 'task-123',
      userId: 'local',
      title: 'Write the introduction',
      status: 'active',
      observation: { allowedApps: [] },
    })
    // Empty whitelist makes the task inactive as an observer from the start.
    expect(task.observation.privacyState).toBe('not_observing_empty_whitelist')
    expect(task.observation.isEffectivelyObserving).toBe(false)
  })
})
