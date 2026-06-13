import type { ScreenpipeExecutableResolution, ScreenpipeProcessHandle, SpawnScreenpipeProcess } from './supervisor'

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { createScreenpipeSupervisor } from './supervisor'

class FakeScreenpipeProcess extends EventEmitter implements ScreenpipeProcessHandle {
  readonly pid = 1234
  readonly stderr: Readable
  readonly stdout: Readable
  readonly kill = vi.fn(() => {
    this.emit('close', 0, null)
    return true
  })

  constructor(streams: { stderr: Readable, stdout: Readable }) {
    super()
    this.stderr = streams.stderr
    this.stdout = streams.stdout
  }
}

function createQuietReadable(): Readable {
  return new Readable({ read() {} })
}

describe('screenpipe supervisor', () => {
  it('reuses an already healthy external screenpipe service without spawning', async () => {
    const spawnProcess = vi.fn<SpawnScreenpipeProcess>()
    const resolveExecutable = vi.fn<() => Promise<ScreenpipeExecutableResolution | undefined>>(async () => ({ executable: 'screenpipe', source: 'env' }))
    const supervisor = createScreenpipeSupervisor({
      health: vi.fn(async () => true),
      resolveExecutable,
      spawnProcess,
    })

    await expect(supervisor.ensureRunning()).resolves.toMatchObject({ mode: 'external' })
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('reports unavailable when AIRI cannot find a screenpipe binary', async () => {
    const spawnProcess = vi.fn<SpawnScreenpipeProcess>()
    const supervisor = createScreenpipeSupervisor({
      health: vi.fn(async () => false),
      resolveExecutable: vi.fn(async () => undefined),
      spawnProcess,
      startupTimeoutMs: 1,
    })

    await expect(supervisor.ensureRunning()).resolves.toMatchObject({ mode: 'unavailable' })
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('spawns screenpipe and only stops the managed child process', async () => {
    let healthy = false
    const child = new FakeScreenpipeProcess({
      stderr: createQuietReadable(),
      stdout: createQuietReadable(),
    })
    const resolveExecutable = vi.fn<() => Promise<ScreenpipeExecutableResolution | undefined>>(async () => ({ executable: 'screenpipe', source: 'env' }))
    const spawnProcess = vi.fn<SpawnScreenpipeProcess>(() => {
      healthy = true
      return child
    })
    const supervisor = createScreenpipeSupervisor({
      health: vi.fn(async () => healthy),
      healthPollIntervalMs: 1,
      resolveExecutable,
      spawnProcess,
      startupTimeoutMs: 50,
    })

    await expect(supervisor.ensureRunning()).resolves.toMatchObject({
      mode: 'managed',
      pid: 1234,
    })
    expect(spawnProcess).toHaveBeenCalledWith(
      'screenpipe',
      ['--port', '3030', '--disable-audio', '--disable-telemetry'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )

    await supervisor.stop()

    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(supervisor.getState()).toEqual({ mode: 'idle' })
  })

  it('passes the configured data directory to the screenpipe child process', async () => {
    let healthy = false
    const child = new FakeScreenpipeProcess({
      stderr: createQuietReadable(),
      stdout: createQuietReadable(),
    })
    const spawnProcess = vi.fn<SpawnScreenpipeProcess>(() => {
      healthy = true
      return child
    })
    const supervisor = createScreenpipeSupervisor({
      health: vi.fn(async () => healthy),
      healthPollIntervalMs: 1,
      resolveExecutable: vi.fn(async () => ({ executable: 'screenpipe', source: 'env' as const })),
      spawnProcess,
      startupTimeoutMs: 50,
    })

    await expect(supervisor.ensureRunning({ dataDirectory: 'D:\\screenpipe-data' })).resolves.toMatchObject({
      dataDirectory: 'D:\\screenpipe-data',
      mode: 'managed',
    })
    expect(spawnProcess).toHaveBeenCalledWith(
      'screenpipe',
      ['--port', '3030', '--disable-audio', '--disable-telemetry', '--data-dir', 'D:\\screenpipe-data'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
  })
})
