import type { Readable } from 'node:stream'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { useLogg } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std'

type ScreenpipeExecutableSource = 'env' | 'resources' | 'home'

/**
 * Resolved screenpipe binary location.
 *
 * @param source - Where the executable path came from.
 */
export interface ScreenpipeExecutableResolution {
  /** Absolute path to the screenpipe executable. */
  executable: string
  /** How AIRI discovered the executable. */
  source: ScreenpipeExecutableSource
}

/** Process handle surface the supervisor needs from a spawned screenpipe child. */
export interface ScreenpipeProcessHandle {
  readonly pid?: number
  readonly stderr: Readable
  readonly stdout: Readable
  kill: () => boolean
  on: {
    (event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): ScreenpipeProcessHandle
    (event: 'error', listener: (error: Error) => void): ScreenpipeProcessHandle
  }
}

export type SpawnScreenpipeProcess = (
  executable: string,
  args: string[],
  options: { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: boolean },
) => ScreenpipeProcessHandle

export type ScreenpipeSupervisorMode = 'idle' | 'external' | 'starting' | 'managed' | 'unavailable' | 'error'

/** Current ownership state for the local screenpipe service. */
export interface ScreenpipeSupervisorState {
  /** Whether screenpipe is inactive, externally owned, or AIRI-managed. */
  mode: ScreenpipeSupervisorMode
  /** Data directory passed to the AIRI-managed screenpipe process, when known. */
  dataDirectory?: string
  /** Executable path AIRI used for the managed child, when known. */
  executable?: string
  /** Last startup/runtime error, if any. */
  lastError?: string
  /** Process id for the AIRI-managed child, when available. */
  pid?: number
}

export interface ScreenpipeSupervisor {
  /**
   * Ensures a local screenpipe HTTP service is available.
   *
   * Use when:
   * - The observation runtime has active capture intent.
   *
   * Expects:
   * - `health` checks the same localhost port the OCR client will query.
   *
   * Returns:
   * - The ownership state after probing or spawning.
   */
  ensureRunning: (options?: ScreenpipeEnsureRunningOptions) => Promise<ScreenpipeSupervisorState>
  /** Returns the current screenpipe sidecar ownership state. */
  getState: () => ScreenpipeSupervisorState
  /**
   * Stops only the screenpipe process AIRI started.
   *
   * Use when:
   * - Observation is disabled, no app is whitelisted, or AIRI is quitting.
   *
   * Expects:
   * - Externally started screenpipe instances must be left alone.
   */
  stop: () => Promise<void>
}

export interface ScreenpipeEnsureRunningOptions {
  /** screenpipe storage root passed through the `--data-dir` CLI flag. */
  dataDirectory?: string
}

export interface ScreenpipeSupervisorOptions {
  /** Health probe for the same local screenpipe API base URL used by the client. */
  health: () => Promise<boolean>
  /** Launch args for screenpipe's local server mode. */
  launchArgs?: string[]
  /** Health-poll interval during startup. @default 500 */
  healthPollIntervalMs?: number
  /** Port passed to screenpipe. @default 3030 */
  port?: number
  /** Test seam for executable discovery. */
  resolveExecutable?: () => Promise<ScreenpipeExecutableResolution | undefined>
  /** Test seam for process spawning. */
  spawnProcess?: SpawnScreenpipeProcess
  /** Time budget for waiting until the spawned service answers health checks. @default 15000 */
  startupTimeoutMs?: number
}

interface Deferred<T> {
  promise: Promise<T>
  reject: (error?: unknown) => void
  resolve: (value: T | PromiseLike<T>) => void
}

const DEFAULT_SCREENPIPE_PORT = 3030
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 500
const PROCESS_EXIT_TIMEOUT_MS = 2_000

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return {
    promise,
    reject,
    resolve,
  }
}

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function waitForProcessExit(exitPromise: Promise<void>, timeoutMs: number) {
  return Promise.race([
    exitPromise.then(() => true, () => false),
    new Promise<boolean>(resolve => setTimeout(resolve, timeoutMs, false)),
  ])
}

function pipeProcessLog(stream: Readable, write: (message: string) => void) {
  stream.on('data', (data) => {
    const message = data.toString('utf-8').trim()
    if (message)
      write(message)
  })
}

function screenpipeBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'screenpipe.exe' : 'screenpipe'
}

function defaultLaunchArgs(port: number, dataDirectory?: string) {
  const args = [
    '--port',
    String(port),
    '--disable-audio',
    '--disable-telemetry',
  ]
  if (dataDirectory)
    args.push('--data-dir', dataDirectory)
  return args
}

function defaultSpawnProcess(executable: string, args: string[], options: { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: boolean }) {
  return spawn(executable, args, options)
}

async function firstAccessibleExecutable(candidates: ScreenpipeExecutableResolution[]) {
  for (const candidate of candidates) {
    try {
      await access(candidate.executable)
      return candidate
    }
    catch {}
  }

  return undefined
}

/**
 * Resolves the screenpipe executable AIRI should manage.
 *
 * Use when:
 * - The screen-observation runtime needs to start screenpipe internally.
 *
 * Expects:
 * - Packaged builds may ship `extraResources/screenpipe/<binary>`.
 * - Developers may override discovery with `AIRI_SCREENPIPE_BIN` or
 *   `SCREENPIPE_BIN`.
 *
 * Returns:
 * - The first accessible binary candidate, or `undefined` when screenpipe is
 *   not installed/bundled.
 */
export async function resolveScreenpipeExecutable(): Promise<ScreenpipeExecutableResolution | undefined> {
  const binaryName = screenpipeBinaryName()
  const homeDirectory = homedir()
  const candidates: ScreenpipeExecutableResolution[] = []
  const envPath = process.env.AIRI_SCREENPIPE_BIN?.trim() || process.env.SCREENPIPE_BIN?.trim()

  if (envPath) {
    candidates.push({ executable: envPath, source: 'env' })
  }

  // Packaged builds can place screenpipe next to other Electron sidecars.
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    candidates.push({
      executable: join(process.resourcesPath, 'screenpipe', binaryName),
      source: 'resources',
    })
  }

  // Local desktop installer layout used by screenpipe's Windows installer and
  // the equivalent hidden home directory layout used by CLI installs.
  candidates.push(
    { executable: join(homeDirectory, 'screenpipe', 'bin', binaryName), source: 'home' },
    { executable: join(homeDirectory, '.screenpipe', 'bin', binaryName), source: 'home' },
  )

  return await firstAccessibleExecutable(candidates)
}

/**
 * Creates an Electron-owned screenpipe sidecar supervisor.
 *
 * Use when:
 * - AIRI should internally provide the localhost screenpipe service needed by
 *   screen observation.
 *
 * Expects:
 * - The observation runtime remains the privacy gate. This supervisor only
 *   starts screenpipe when asked and kills only the child it spawned.
 *
 * Returns:
 * - A lifecycle controller that treats already-healthy screenpipe as external
 *   and therefore never terminates it.
 */
export function createScreenpipeSupervisor(options: ScreenpipeSupervisorOptions): ScreenpipeSupervisor {
  const log = useLogg('screenpipe-supervisor').useGlobalConfig()
  const port = options.port ?? DEFAULT_SCREENPIPE_PORT
  const resolveExecutable = options.resolveExecutable ?? resolveScreenpipeExecutable
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  const healthPollIntervalMs = options.healthPollIntervalMs ?? DEFAULT_HEALTH_POLL_INTERVAL_MS

  let currentProcess: ScreenpipeProcessHandle | undefined
  let currentProcessExit = createDeferred<void>()
  let currentState: ScreenpipeSupervisorState = { mode: 'idle' }
  let currentDataDirectory: string | undefined
  let expectedProcessExit = false
  let startPromise: Promise<ScreenpipeSupervisorState> | undefined

  function setState(next: ScreenpipeSupervisorState) {
    currentState = next
    if (next.lastError)
      log.warn(next.lastError)
  }

  async function waitUntilHealthy(deadlineAt: number) {
    while (Date.now() < deadlineAt) {
      if (await options.health())
        return true
      await delay(healthPollIntervalMs)
    }

    return await options.health()
  }

  function clearProcessState() {
    currentProcess = undefined
    currentDataDirectory = undefined
    currentProcessExit.resolve()
    currentProcessExit = createDeferred<void>()
  }

  function attachProcessListeners(processHandle: ScreenpipeProcessHandle, executable: string) {
    pipeProcessLog(processHandle.stdout, message => log.log(message))
    pipeProcessLog(processHandle.stderr, message => log.warn(message))

    processHandle.on('error', (error) => {
      if (currentProcess !== processHandle)
        return

      const message = errorMessageFrom(error) ?? 'Failed to spawn screenpipe.'
      clearProcessState()
      setState({ executable, lastError: message, mode: 'error' })
    })

    processHandle.on('close', (code, signal) => {
      if (currentProcess !== processHandle)
        return

      const exitMessage = signal
        ? `screenpipe exited with signal ${signal}.`
        : `screenpipe exited with code ${code ?? 0}.`

      clearProcessState()

      if (expectedProcessExit)
        setState({ mode: 'idle' })
      else
        setState({ executable, lastError: exitMessage, mode: 'error' })

      expectedProcessExit = false
    })
  }

  async function startManagedProcess(dataDirectory?: string) {
    if (await options.health()) {
      setState({ mode: 'external' })
      return currentState
    }

    const resolved = await resolveExecutable()
    if (!resolved) {
      setState({
        lastError: 'screenpipe executable was not found. Set AIRI_SCREENPIPE_BIN or bundle screenpipe under Electron resources.',
        mode: 'unavailable',
      })
      return currentState
    }

    setState({ executable: resolved.executable, mode: 'starting' })
    log.withFields({
      executable: resolved.executable,
      source: resolved.source,
    }).log('spawning screenpipe')

    const launchArgs = options.launchArgs ?? defaultLaunchArgs(port, dataDirectory)
    const processHandle = spawnProcess(resolved.executable, launchArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    currentProcess = processHandle
    currentDataDirectory = dataDirectory
    expectedProcessExit = false
    attachProcessListeners(processHandle, resolved.executable)

    const healthy = await waitUntilHealthy(Date.now() + startupTimeoutMs)
    if (!healthy) {
      expectedProcessExit = true
      processHandle.kill()
      await waitForProcessExit(currentProcessExit.promise, PROCESS_EXIT_TIMEOUT_MS)
      setState({
        executable: resolved.executable,
        lastError: `screenpipe did not become healthy on port ${port} within ${startupTimeoutMs}ms.`,
        mode: 'error',
      })
      return currentState
    }

    setState({
      dataDirectory,
      executable: resolved.executable,
      mode: 'managed',
      pid: processHandle.pid,
    })
    return currentState
  }

  async function stop() {
    if (!currentProcess) {
      if (currentState.mode !== 'external')
        setState({ mode: 'idle' })
      return
    }

    const activeProcess = currentProcess
    const exitPromise = currentProcessExit.promise
    expectedProcessExit = true
    activeProcess.kill()
    await waitForProcessExit(exitPromise, PROCESS_EXIT_TIMEOUT_MS)

    if (currentProcess === activeProcess) {
      clearProcessState()
      setState({ mode: 'idle' })
      expectedProcessExit = false
    }
  }

  return {
    async ensureRunning(request = {}) {
      if (currentProcess && currentDataDirectory !== request.dataDirectory)
        await stop()

      if (currentProcess && await options.health()) {
        setState({
          dataDirectory: currentDataDirectory,
          executable: currentState.executable,
          mode: 'managed',
          pid: currentProcess.pid,
        })
        return currentState
      }

      if (!currentProcess && await options.health()) {
        setState({ mode: 'external' })
        return currentState
      }

      if (startPromise)
        return await startPromise

      startPromise = startManagedProcess(request.dataDirectory)
      try {
        return await startPromise
      }
      finally {
        startPromise = undefined
      }
    },
    getState() {
      return currentState
    },
    stop,
  }
}
