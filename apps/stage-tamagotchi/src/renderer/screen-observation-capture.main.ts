import type { SerializableDesktopCapturerSource } from '@proj-airi/electron-screen-capture'
import type { VisionWorkloadId } from '@proj-airi/stage-ui/composables'
import type { SourcesOptions } from 'electron'

import type {
  NativeScreenObservationCaptureStartRequest,
  NativeScreenObservationCaptureStatus,
  NativeScreenObservationFrameResult,
} from '../shared/eventa/screen-observation'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { errorMessageFrom } from '@moeru/std'
import { setupElectronScreenCapture } from '@proj-airi/electron-screen-capture/renderer'
import { useVisionOrchestratorStore } from '@proj-airi/stage-ui/stores/modules/vision'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import {
  electronScreenObservationNativeCaptureGetStatus,
  electronScreenObservationNativeCaptureStart,
  electronScreenObservationNativeCaptureStop,
  electronScreenObservationNativeFrameInterpreted,
} from '../shared/eventa/screen-observation'
import { i18n } from './modules/i18n'

type ElectronScreenCapture = ReturnType<typeof setupElectronScreenCapture>
type VisionOrchestratorStore = ReturnType<typeof useVisionOrchestratorStore>
type RendererEventaContext = ReturnType<typeof createContext>['context']

interface ActiveSourceStream {
  source: SerializableDesktopCapturerSource
  stream: MediaStream
  video: HTMLVideoElement
}

let context: RendererEventaContext
let screenCapture: ElectronScreenCapture
let visionOrchestrator: VisionOrchestratorStore

let activeRequest: NativeScreenObservationCaptureStartRequest | undefined
let activeStreams: ActiveSourceStream[] = []
let intervalHandle: ReturnType<typeof setInterval> | undefined
let captureInFlight = false
let status: NativeScreenObservationCaptureStatus = {
  running: false,
  sourceCount: 0,
}

function sourcesOptionsFor(request: NativeScreenObservationCaptureStartRequest): SourcesOptions {
  return {
    types: request.mode === 'application' ? ['window'] : ['screen'],
    fetchWindowIcons: false,
  }
}

function sourceMatchesRequest(source: SerializableDesktopCapturerSource, request: NativeScreenObservationCaptureStartRequest) {
  if (request.mode === 'desktop')
    return source.id.startsWith('screen:')

  const allowed = request.allowedApps
    .map(app => app.trim().toLowerCase())
    .filter(Boolean)

  if (allowed.length === 0)
    return false

  const sourceName = source.name.toLowerCase()
  return source.id.startsWith('window:') && allowed.some(app => sourceName.includes(app))
}

function selectSources(sources: SerializableDesktopCapturerSource[], request: NativeScreenObservationCaptureStartRequest) {
  return sources
    .filter(source => sourceMatchesRequest(source, request))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function waitForVideo(video: HTMLVideoElement) {
  if (video.readyState >= 2)
    return

  await new Promise<void>((resolve) => {
    const handleLoadedMetadata = () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      resolve()
    }

    video.addEventListener('loadedmetadata', handleLoadedMetadata)
  })
}

async function startStream(source: SerializableDesktopCapturerSource, request: NativeScreenObservationCaptureStartRequest): Promise<ActiveSourceStream> {
  const stream = await screenCapture.selectWithSource(
    () => source.id,
    async () => await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }),
    {
      sourcesOptions: sourcesOptionsFor(request),
      request: { timeout: 15_000 },
    },
  )

  const hasLiveVideoTrack = stream.getVideoTracks().some(track => track.readyState === 'live')
  if (!hasLiveVideoTrack) {
    stream.getTracks().forEach(track => track.stop())
    throw new Error(`Source "${source.name}" did not provide a live video track`)
  }

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  document.body.append(video)
  await video.play()
  await waitForVideo(video)

  return { source, stream, video }
}

function stopStreams() {
  for (const entry of activeStreams) {
    entry.stream.getTracks().forEach(track => track.stop())
    entry.video.pause()
    entry.video.srcObject = null
    entry.video.remove()
  }

  activeStreams = []
}

function captureFrame(entry: ActiveSourceStream, request: NativeScreenObservationCaptureStartRequest) {
  const { video } = entry
  if (video.readyState < 2)
    return undefined

  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  if (sourceWidth <= 0 || sourceHeight <= 0)
    return undefined

  const scale = Math.min(request.maxWidth / sourceWidth, request.maxHeight / sourceHeight, 1)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(sourceWidth * scale)
  canvas.height = Math.round(sourceHeight * scale)

  const ctx = canvas.getContext('2d')
  if (!ctx)
    throw new Error('Failed to create canvas context for screen observation capture')

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

  return {
    dataUrl: canvas.toDataURL('image/jpeg', request.quality),
    width: canvas.width,
    height: canvas.height,
  }
}

function emitFrame(frame: NativeScreenObservationFrameResult) {
  context.emit(electronScreenObservationNativeFrameInterpreted, frame)
}

async function captureAndInterpret(entry: ActiveSourceStream, request: NativeScreenObservationCaptureStartRequest) {
  const capturedAt = new Date().toISOString()
  let width = 0
  let height = 0

  try {
    const frame = captureFrame(entry, request)
    if (!frame)
      return

    width = frame.width
    height = frame.height

    const result = await visionOrchestrator.processCapture({
      imageDataUrl: frame.dataUrl,
      workloadId: request.workloadId as VisionWorkloadId,
      sourceId: entry.source.id,
      capturedAt: new Date(capturedAt).getTime(),
      publishContext: request.publishContext,
    })

    status = {
      ...status,
      running: true,
      lastFrameAt: capturedAt,
      lastInterpretationAt: capturedAt,
      lastError: undefined,
    }

    emitFrame({
      id: crypto.randomUUID(),
      capturedAt,
      sourceId: entry.source.id,
      sourceName: entry.source.name,
      displayId: entry.source.display_id,
      width,
      height,
      text: result.text,
      confidence: result.text ? 0.85 : 0.2,
    })
  }
  catch (error) {
    const message = errorMessageFrom(error) ?? 'Unknown native screen observation capture error'
    status = {
      ...status,
      running: true,
      lastFrameAt: capturedAt,
      lastError: message,
    }

    emitFrame({
      id: crypto.randomUUID(),
      capturedAt,
      sourceId: entry.source.id,
      sourceName: entry.source.name,
      displayId: entry.source.display_id,
      width,
      height,
      error: message,
      confidence: 0,
    })
  }
}

async function captureTick() {
  if (!activeRequest)
    return
  if (captureInFlight)
    return

  captureInFlight = true
  try {
    await Promise.all(activeStreams.map(entry => captureAndInterpret(entry, activeRequest!)))
  }
  finally {
    captureInFlight = false
  }
}

async function stopCapture(): Promise<NativeScreenObservationCaptureStatus> {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = undefined
  }

  activeRequest = undefined
  stopStreams()
  captureInFlight = false
  status = {
    ...status,
    running: false,
    sourceCount: 0,
  }
  return status
}

async function startCapture(request: NativeScreenObservationCaptureStartRequest): Promise<NativeScreenObservationCaptureStatus> {
  await stopCapture()

  activeRequest = request
  const sources = await screenCapture.getSources(sourcesOptionsFor(request))
  const selectedSources = selectSources(sources, request)

  if (selectedSources.length === 0) {
    status = {
      running: false,
      sourceCount: 0,
      lastError: request.mode === 'application'
        ? 'No matching application windows found for native screen observation.'
        : 'No display sources found for native screen observation.',
    }
    return status
  }

  activeStreams = await Promise.all(selectedSources.map(source => startStream(source, request)))
  status = {
    running: true,
    sourceCount: activeStreams.length,
    lastError: undefined,
  }

  void captureTick()
  intervalHandle = setInterval(() => {
    void captureTick()
  }, request.intervalMs)

  return status
}

const app = createApp({
  setup() {
    const eventa = createContext(window.electron.ipcRenderer)
    context = eventa.context
    screenCapture = setupElectronScreenCapture(context)
    visionOrchestrator = useVisionOrchestratorStore()

    defineInvokeHandler(context, electronScreenObservationNativeCaptureStart, request => startCapture(request))
    defineInvokeHandler(context, electronScreenObservationNativeCaptureStop, () => stopCapture())
    defineInvokeHandler(context, electronScreenObservationNativeCaptureGetStatus, () => status)

    return () => null
  },
})

app
  .use(createPinia())
  .use(i18n)
  .mount('#app')
