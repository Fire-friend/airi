import type { NativeScreenObservationCaptureStartRequest, NativeScreenObservationCaptureStatus, NativeScreenObservationFrameResult } from '../../../../shared/eventa/screen-observation'

import { join, resolve } from 'node:path'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { initScreenCaptureForWindow } from '@proj-airi/electron-screen-capture/main'
import { BrowserWindow, ipcMain } from 'electron'

import {
  electronScreenObservationNativeCaptureGetStatus,
  electronScreenObservationNativeCaptureStart,
  electronScreenObservationNativeCaptureStop,
  electronScreenObservationNativeFrameInterpreted,
} from '../../../../shared/eventa/screen-observation'
import { baseUrl, getElectronMainDirname, load } from '../../../libs/electron/location'

interface NativeCaptureWindowHandle {
  window: BrowserWindow
  context: ReturnType<typeof createContext>['context']
}

export interface NativeScreenObservationCaptureController {
  start: (request: NativeScreenObservationCaptureStartRequest) => Promise<NativeScreenObservationCaptureStatus>
  stop: () => Promise<NativeScreenObservationCaptureStatus>
  getStatus: () => Promise<NativeScreenObservationCaptureStatus>
  onFrame: (callback: (frame: NativeScreenObservationFrameResult) => void) => () => void
  dispose: () => void
}

const STOPPED_STATUS: NativeScreenObservationCaptureStatus = {
  running: false,
  sourceCount: 0,
}

/**
 * Creates the hidden renderer-backed native frame capture controller.
 *
 * Use when:
 * - The screen observer runs in native frame mode and must capture real
 *   desktop/window frames without screenpipe video chunks.
 * - Main process code needs to start/stop capture while renderer code owns
 *   `getDisplayMedia` streams and canvas frame extraction.
 *
 * Expects:
 * - `initScreenCaptureForMain()` already ran during Electron bootstrap.
 * - The renderer entry `screen-observation-capture.html` is included in
 *   electron-vite renderer inputs.
 *
 * Returns:
 * - A controller that lazily creates one hidden BrowserWindow and relays
 *   interpreted frame results back to subscribers.
 */
export function createNativeScreenObservationCapture(): NativeScreenObservationCaptureController {
  const frameListeners = new Set<(frame: NativeScreenObservationFrameResult) => void>()
  let handlePromise: Promise<NativeCaptureWindowHandle> | undefined
  let status: NativeScreenObservationCaptureStatus = STOPPED_STATUS

  async function createHandle(): Promise<NativeCaptureWindowHandle> {
    const window = new BrowserWindow({
      title: 'AIRI Screen Observation Capture',
      show: false,
      webPreferences: {
        preload: join(getElectronMainDirname(), '../preload/index.mjs'),
        sandbox: false,
        backgroundThrottling: false,
      },
    })

    const { context } = createContext(ipcMain, window)
    context.on(electronScreenObservationNativeFrameInterpreted, (event) => {
      const frame = event.body
      if (!frame)
        return

      status = {
        ...status,
        running: true,
        lastFrameAt: frame.capturedAt,
        lastInterpretationAt: frame.text ? frame.capturedAt : status.lastInterpretationAt,
        lastError: frame.error,
      }

      for (const listener of frameListeners)
        listener(frame)
    })

    window.on('closed', () => {
      if (handlePromise) {
        handlePromise = undefined
        status = STOPPED_STATUS
      }
    })

    initScreenCaptureForWindow(window)
    await load(window, baseUrl(resolve(getElectronMainDirname(), '..', 'renderer'), 'screen-observation-capture.html'))

    return { window, context }
  }

  async function ensureHandle(): Promise<NativeCaptureWindowHandle> {
    if (handlePromise) {
      const handle = await handlePromise
      if (!handle.window.isDestroyed())
        return handle
    }

    handlePromise = createHandle()
    return await handlePromise
  }

  async function start(request: NativeScreenObservationCaptureStartRequest): Promise<NativeScreenObservationCaptureStatus> {
    const handle = await ensureHandle()
    const invokeStart = defineInvoke(handle.context, electronScreenObservationNativeCaptureStart)
    status = await invokeStart(request)
    return status
  }

  async function stop(): Promise<NativeScreenObservationCaptureStatus> {
    if (!handlePromise) {
      status = STOPPED_STATUS
      return status
    }

    const handle = await handlePromise
    if (handle.window.isDestroyed()) {
      status = STOPPED_STATUS
      handlePromise = undefined
      return status
    }

    const invokeStop = defineInvoke(handle.context, electronScreenObservationNativeCaptureStop)
    status = await invokeStop()
    return status
  }

  async function getStatus(): Promise<NativeScreenObservationCaptureStatus> {
    if (!handlePromise)
      return status

    const handle = await handlePromise
    if (handle.window.isDestroyed()) {
      status = STOPPED_STATUS
      handlePromise = undefined
      return status
    }

    const invokeGetStatus = defineInvoke(handle.context, electronScreenObservationNativeCaptureGetStatus)
    status = await invokeGetStatus()
    return status
  }

  return {
    start,
    stop,
    getStatus,
    onFrame(callback) {
      frameListeners.add(callback)
      return () => frameListeners.delete(callback)
    },
    dispose() {
      frameListeners.clear()
      if (!handlePromise) {
        status = STOPPED_STATUS
        return
      }

      void handlePromise.then((handle) => {
        if (!handle.window.isDestroyed())
          handle.window.destroy()
      })
      handlePromise = undefined
      status = STOPPED_STATUS
    },
  }
}
