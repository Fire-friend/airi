import { defineInvokeEventa, defineOutboundEventa } from '@moeru/eventa'

export const TOUCH_THROTTLE_WINDOW_MS = 30 * 60 * 1000
export const IGNORED_TOUCHES_BEFORE_DOWNGRADE = 2
export const DEFAULT_TOUCH_LEVEL = 'L1'
export const FIRST_TASK_FIRST_PROGRESS_LEVEL = 'L2'
export const FOCUS_SUPPRESSION_LEVEL = 'L0'
export const DEFAULT_DAILY_SUMMARY_LOCAL_TIME = '18:00'

export type TaskStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled' | 'archived'
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'
export type ObservationMode = 'whitelist'
export type TouchLevel = 'L0' | 'L1' | 'L2' | 'L3'
export type TouchAction = 'ack' | 'details' | 'mute_task' | 'pause_15m' | 'pause_1h' | 'pause_today' | 'resume'
export type TouchReason
  = | 'task_progress'
    | 'task_blocked'
    | 'deadline_risk'
    | 'daily_summary'
    | 'observation_state'
    | 'cold_start_progress'
export type TouchPolicyApplied
  = | 'first_task_first_progress_l2'
    | 'throttled_l2_plus_30m'
    | 'ignored_same_level_downgrade'
    | 'focus_or_meeting_l0'
    | 'empty_whitelist_not_observing'
    | 'zero_task_daily_summary_suppressed'
export type ScreenObserverPrivacyState
  = | 'observing'
    | 'paused'
    | 'not_observing_empty_whitelist'
    | 'suppressed_fullscreen'
    | 'suppressed_meeting'
    | 'disabled'

export interface TaskWorkWindow {
  startLocalTime: string
  endLocalTime: string
}

export interface TaskSchedule {
  startsAt?: string
  dueAt?: string
  timezone: string
  workWindow?: TaskWorkWindow
  dailySummaryAtLocalTime: string
}

export interface TaskObservationScope {
  enabled: boolean
  mode: ObservationMode
  allowedApps: string[]
  pauseUntil?: string
  privacyState: ScreenObserverPrivacyState
  isEffectivelyObserving: boolean
}

export interface TaskTouchPolicy {
  level: TouchLevel
  firstTaskFirstProgressUsesL2: boolean
  dailySummaryEnabled: boolean
}

export interface TaskProgressNarrative {
  remainingWork: string
  etaAt?: string
  pace?: string
  isOffTrack: boolean
}

export interface Task {
  id: string
  userId: string
  title: string
  status: TaskStatus
  priority: TaskPriority
  goal: string
  progressNarrative?: TaskProgressNarrative
  schedule: TaskSchedule
  observation: TaskObservationScope
  touchPolicy: TaskTouchPolicy
  createdAt: string
  updatedAt: string
}

export interface ScreenObserverAppSummary {
  appId: string
  appName: string
  windowTitle?: string
  observedSeconds: number
  summary: string
  matchedWhitelist: boolean
}

export type ScreenObserverTaskSignalKind = 'started' | 'continued' | 'blocked' | 'idle' | 'completed' | 'off_task'

export interface ScreenObserverTaskSignal {
  taskId: string
  signal: ScreenObserverTaskSignalKind
  evidence: string
  confidence: number
}

export interface ScreenObserverSummary {
  id: string
  taskId?: string
  capturedAt: string
  windowStartedAt: string
  windowEndedAt: string
  /** Observation backend that produced this summary. */
  source: 'screenpipe' | 'minecontext'
  privacyState: ScreenObserverPrivacyState
  apps: ScreenObserverAppSummary[]
  taskSignals: ScreenObserverTaskSignal[]
  summary: string
  confidence: number
  rawReference?: string
}

export interface TouchEventMessage {
  remainingWork: string
  etaAt?: string
  pace?: string
  isOffTrack: boolean
}

export interface TouchEventPayload {
  id: string
  taskId: string
  level: TouchLevel
  reason: TouchReason
  createdAt: string
  summaryId?: string
  message: TouchEventMessage
  actions: TouchAction[]
  policyApplied: TouchPolicyApplied[]
}

export interface TaskModelChangedPayload {
  task: Task
  change: 'created' | 'updated' | 'paused' | 'resumed' | 'completed' | 'cancelled'
  changedAt: string
  origin: 'chat' | 'dashboard' | 'settings' | 'observer' | 'system'
}

export interface ScreenObserverSummaryPayload {
  summary: ScreenObserverSummary
}

export interface DailySummaryPayload {
  id: string
  createdAt: string
  localDate: string
  tasks: Task[]
  taskSummaries: DailySummaryTaskLine[]
  touch?: TouchEventPayload
}

export type ScreenObservationI18nKey =
  | 'tamagotchi.screen_observation.daily_summary.progress.remaining_work.blocked'
  | 'tamagotchi.screen_observation.daily_summary.progress.remaining_work.ready'
  | 'tamagotchi.screen_observation.daily_summary.progress.pace.off_track'
  | 'tamagotchi.screen_observation.daily_summary.progress.pace.on_track'
  | 'tamagotchi.screen_observation.daily_summary.observation.off_track'
  | 'tamagotchi.screen_observation.daily_summary.observation.on_track'
  | 'tamagotchi.screen_observation.daily_summary.tomorrow.blocked'
  | 'tamagotchi.screen_observation.daily_summary.tomorrow.ready'

export type I18nTextParam = string | number | boolean | null | undefined

export interface I18nTextPayload {
  key: ScreenObservationI18nKey
  params?: Record<string, I18nTextParam>
}

export type LocalizedText = string | I18nTextPayload

export interface DailySummaryProgressNarrative {
  remainingWork: LocalizedText
  etaAt?: string
  pace?: LocalizedText
  isOffTrack: boolean
}

export interface DailySummaryTaskLine {
  taskId: string
  title: string
  progress: DailySummaryProgressNarrative
  observation: LocalizedText
  tomorrowSuggestion: LocalizedText
}

export interface ScreenObservationSettings {
  enabled: boolean
  mode: ObservationMode
  allowedApps: string[]
  dailySummaryEnabled: boolean
  dailySummaryAtLocalTime: string
}

export interface ScreenObservationSnapshot {
  settings: ScreenObservationSettings
  tasks: Task[]
  latestSummaries: ScreenObserverSummary[]
  latestTouches: TouchEventPayload[]
  privacyState: ScreenObserverPrivacyState
}

export interface UpsertTaskRequest {
  task: Task
  origin: TaskModelChangedPayload['origin']
}

export interface PauseObservationRequest {
  pauseUntil?: string
  reason: 'manual_15m' | 'manual_1h' | 'manual_today' | 'fullscreen' | 'meeting'
}

export interface CreateTaskInput {
  id: string
  userId: string
  title: string
  goal?: string
  status?: TaskStatus
  priority?: TaskPriority
  schedule?: Partial<TaskSchedule>
  observation?: Partial<Omit<TaskObservationScope, 'privacyState' | 'isEffectivelyObserving'>>
  touchPolicy?: Partial<TaskTouchPolicy>
  progressNarrative?: TaskProgressNarrative
}

export interface ObservationStateInput {
  enabled: boolean
  allowedApps: string[]
  pauseUntil?: string
  now?: Date
  isFullscreen?: boolean
  isMeeting?: boolean
}

export interface NormalizeSummaryInput {
  id: string
  taskId?: string
  capturedAt: string
  windowStartedAt: string
  windowEndedAt: string
  source?: ScreenObserverSummary['source']
  privacyState: ScreenObserverPrivacyState
  apps?: ScreenObserverAppSummary[]
  taskSignals?: ScreenObserverTaskSignal[]
  summary: string
  confidence?: number
  rawReference?: string
}

export interface DecideTouchInput {
  id: string
  task: Task
  reason: TouchReason
  message: TouchEventMessage
  now: Date
  summaryId?: string
  requestedLevel?: TouchLevel
  lastL2PlusTouchAt?: Date
  ignoredTouchesAtSameLevel?: number
  isFirstTaskForUser?: boolean
  isFirstProgressUpdateForTask?: boolean
  isFullscreen?: boolean
  isMeeting?: boolean
}

export interface DailySummaryDecision {
  shouldSend: boolean
  payload?: DailySummaryPayload
  policyApplied: TouchPolicyApplied[]
}

export interface DailySummaryTaskInput {
  task: Task
  progress?: TaskProgressNarrative
  observation: string
  tomorrowSuggestion: string
}

export interface DecideDailySummaryInput {
  id: string
  createdAt: string
  localDate: string
  enabled: boolean
  tasks: DailySummaryTaskInput[]
  touch?: TouchEventPayload
}

export type TaskCompanionState = 'idle' | 'progressing' | 'possibly_stuck' | 'stuck' | 'off_task'

export type TaskCompanionSignalKind
  = | 'progress_detected'
    | 'possible_stuck'
    | 'stuck_detected'
    | 'off_task'
    | 'idle'

export type TaskObservationEvidenceKind
  = | 'semantic_progress'
    | 'subgoal_progress'
    | 'new_task_artifact'
    | 'repeated_error'
    | 'search_doc_loop'
    | 'no_progress'
    | 'semantic_blocker'
    | 'off_task'

export interface TaskObservationEvidence {
  kind: TaskObservationEvidenceKind
  description: string
  fingerprint?: string
  weight?: number
  capturedAt?: string
  summaryId?: string
}

export interface TaskObservationFrame {
  taskId: string
  capturedAt: string
  summaryId?: string
  windowStartedAt?: string
  windowEndedAt?: string
  appNames: string[]
  windowFingerprint?: string
  summary: string
  progressEvidence?: TaskObservationEvidence[]
  stuckEvidence?: TaskObservationEvidence[]
  offTaskEvidence?: TaskObservationEvidence[]
  confidence?: number
  privacyFiltered: boolean
}

export interface TaskWorkingState {
  taskId: string
  state: TaskCompanionState
  progressScore: number
  stuckScore: number
  evidenceChain: TaskObservationEvidence[]
  lastProgressAt?: string
  lastEvidenceAt?: string
  stuckStartedAt?: string
  lastNudgeAt?: string
  mutedUntil?: string
  episodeId?: string
}

export interface TaskCompanionSignal {
  taskId: string
  kind: TaskCompanionSignalKind
  state: TaskCompanionState
  createdAt: string
  score: number
  confidence: number
  evidence: TaskObservationEvidence[]
  shouldNudge: boolean
  recommendedTouchReason?: TouchReason
  episodeId?: string
}

export interface TaskCompanionThresholds {
  maxScore: number
  progressScoreThreshold: number
  progressStuckDecay: number
  idleScoreDecay: number
  semanticProgressWeight: number
  semanticBlockerWeight: number
  repeatedFingerprintCount: number
  repeatedFingerprintWindowMs: number
  repeatedFingerprintWeight: number
  searchLoopFrameCount: number
  searchLoopWindowMs: number
  searchLoopWeight: number
  noProgressWindowMs: number
  noProgressWeight: number
  possibleStuckScoreThreshold: number
  stuckScoreThreshold: number
  stuckDurationMs: number
  nudgeCooldownMs: number
  evidenceChainCap: number
}

export interface TaskCompanionScoringInput {
  task: Task
  frame: TaskObservationFrame
  recentFrames?: TaskObservationFrame[]
  previousState?: TaskWorkingState
  thresholds?: Partial<TaskCompanionThresholds>
  now?: Date
}

export interface TaskCompanionScore {
  score: number
  confidence: number
  evidence: TaskObservationEvidence[]
}

export interface TaskCompanionTransition {
  state: TaskWorkingState
  signal: TaskCompanionSignal
}

export const DEFAULT_TASK_COMPANION_THRESHOLDS: TaskCompanionThresholds = {
  maxScore: 5,
  progressScoreThreshold: 1.5,
  progressStuckDecay: 0.35,
  idleScoreDecay: 0.8,
  semanticProgressWeight: 1,
  semanticBlockerWeight: 1,
  repeatedFingerprintCount: 3,
  repeatedFingerprintWindowMs: 10 * 60 * 1000,
  repeatedFingerprintWeight: 2.5,
  searchLoopFrameCount: 4,
  searchLoopWindowMs: 10 * 60 * 1000,
  searchLoopWeight: 3,
  noProgressWindowMs: 15 * 60 * 1000,
  noProgressWeight: 1,
  possibleStuckScoreThreshold: 1.75,
  stuckScoreThreshold: 3,
  stuckDurationMs: 10 * 60 * 1000,
  nudgeCooldownMs: TOUCH_THROTTLE_WINDOW_MS,
  evidenceChainCap: 20,
}

const touchRank: Record<TouchLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
}

const touchLevels: TouchLevel[] = ['L0', 'L1', 'L2', 'L3']

/**
 * Builds a normalized task model from chat-confirmed user intent.
 *
 * Use when chat, dashboard, Electron, or server code needs the same default
 * schedule, observation, and touch policy semantics. Callers provide the id so
 * this shared contract stays deterministic across runtimes.
 */
export function createScreenObservationTask(input: CreateTaskInput, now = new Date()): Task {
  const allowedApps = input.observation?.allowedApps ?? []
  const privacyState = resolveObservationPrivacyState({
    enabled: input.observation?.enabled ?? true,
    allowedApps,
    pauseUntil: input.observation?.pauseUntil,
    now,
  })
  const createdAt = now.toISOString()

  return {
    id: input.id,
    userId: input.userId,
    title: input.title,
    status: input.status ?? 'draft',
    priority: input.priority ?? 'normal',
    goal: input.goal ?? input.title,
    progressNarrative: input.progressNarrative,
    schedule: {
      timezone: input.schedule?.timezone ?? 'UTC',
      startsAt: input.schedule?.startsAt,
      dueAt: input.schedule?.dueAt,
      workWindow: input.schedule?.workWindow,
      dailySummaryAtLocalTime: input.schedule?.dailySummaryAtLocalTime ?? DEFAULT_DAILY_SUMMARY_LOCAL_TIME,
    },
    observation: {
      enabled: input.observation?.enabled ?? true,
      mode: 'whitelist',
      allowedApps,
      pauseUntil: input.observation?.pauseUntil,
      privacyState,
      isEffectivelyObserving: privacyState === 'observing',
    },
    touchPolicy: {
      level: input.touchPolicy?.level ?? DEFAULT_TOUCH_LEVEL,
      firstTaskFirstProgressUsesL2: input.touchPolicy?.firstTaskFirstProgressUsesL2 ?? true,
      dailySummaryEnabled: input.touchPolicy?.dailySummaryEnabled ?? true,
    },
    createdAt,
    updatedAt: createdAt,
  }
}

/**
 * Resolves the user-visible observation state for privacy controls.
 *
 * Empty whitelist is an explicit off state even when the master toggle is on.
 */
export function resolveObservationPrivacyState(input: ObservationStateInput): ScreenObserverPrivacyState {
  if (!input.enabled)
    return 'disabled'
  if (input.allowedApps.length === 0)
    return 'not_observing_empty_whitelist'
  if (input.isMeeting)
    return 'suppressed_meeting'
  if (input.isFullscreen)
    return 'suppressed_fullscreen'
  if (input.pauseUntil) {
    const now = input.now ?? new Date()
    if (new Date(input.pauseUntil).getTime() > now.getTime())
      return 'paused'
  }
  return 'observing'
}

/**
 * Normalizes observation summaries before they enter task reasoning.
 *
 * The summary contract intentionally carries app/time/evidence summaries, not
 * screenshots or raw OCR text.
 */
export function normalizeScreenObserverSummary(input: NormalizeSummaryInput): ScreenObserverSummary {
  return {
    id: input.id,
    taskId: input.taskId,
    capturedAt: input.capturedAt,
    windowStartedAt: input.windowStartedAt,
    windowEndedAt: input.windowEndedAt,
    source: input.source ?? 'minecontext',
    privacyState: input.privacyState,
    apps: (input.apps ?? []).map(app => ({
      ...app,
      observedSeconds: Math.max(0, app.observedSeconds),
    })),
    taskSignals: (input.taskSignals ?? []).map(signal => ({
      ...signal,
      confidence: clampConfidence(signal.confidence),
    })),
    summary: input.summary,
    confidence: clampConfidence(input.confidence ?? 1),
    rawReference: input.rawReference,
  }
}

const progressTerms = [
  'completed',
  'done',
  'fixed',
  'implemented',
  'located',
  'passed',
  'resolved',
  'updated',
  'wrote',
]

const blockerTerms = [
  'blocked',
  'cannot',
  'crash',
  'error',
  'exception',
  'failed',
  'failing',
  'stuck',
  'timeout',
]

const searchDocTerms = [
  'docs',
  'documentation',
  'google',
  'search',
  'stackoverflow',
  'stack overflow',
]

const workSurfaceTerms = [
  'code',
  'console',
  'editor',
  'error',
  'terminal',
  'test',
  'trace',
]

function companionThresholds(input?: Partial<TaskCompanionThresholds>): TaskCompanionThresholds {
  return { ...DEFAULT_TASK_COMPANION_THRESHOLDS, ...input }
}

function normalizeCompanionText(value: string | undefined): string {
  return (value ?? '').toLowerCase().replaceAll(/\s+/g, ' ').trim()
}

function frameText(frame: TaskObservationFrame): string {
  return normalizeCompanionText([
    frame.summary,
    frame.windowFingerprint,
    ...frame.appNames,
  ].filter(Boolean).join(' '))
}

function containsAnyTerm(text: string, terms: readonly string[]): boolean {
  return terms.some(term => text.includes(term))
}

function evidenceWeight(evidence: TaskObservationEvidence): number {
  return Math.max(0, evidence.weight ?? 1)
}

function evidenceAt(evidence: TaskObservationEvidence, fallback: string): TaskObservationEvidence {
  return { ...evidence, capturedAt: evidence.capturedAt ?? fallback }
}

function frameFingerprint(frame: TaskObservationFrame): string | undefined {
  return normalizeCompanionText(frame.windowFingerprint || frame.summary).slice(0, 160) || undefined
}

function frameTime(frame: TaskObservationFrame): number {
  return new Date(frame.capturedAt).getTime()
}

function durationMs(frames: readonly TaskObservationFrame[]): number {
  const times = frames.map(frameTime).filter(Number.isFinite)
  if (times.length === 0)
    return 0

  return Math.max(...times) - Math.min(...times)
}

function recentFrameSet(frame: TaskObservationFrame, recentFrames: readonly TaskObservationFrame[] | undefined): TaskObservationFrame[] {
  const frames = [...(recentFrames ?? []), frame]
  const seen = new Set<string>()
  return frames.filter((candidate) => {
    const key = `${candidate.summaryId ?? ''}:${candidate.capturedAt}:${candidate.windowFingerprint ?? candidate.summary}`
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  }).sort((a, b) => frameTime(a) - frameTime(b))
}

function repeatedFingerprintEvidence(
  frame: TaskObservationFrame,
  recentFrames: readonly TaskObservationFrame[],
  thresholds: TaskCompanionThresholds,
): TaskObservationEvidence | undefined {
  const fingerprint = frameFingerprint(frame)
  if (!fingerprint)
    return undefined

  const repeatedFrames = recentFrames.filter(candidate => frameFingerprint(candidate) === fingerprint)
  if (repeatedFrames.length < thresholds.repeatedFingerprintCount)
    return undefined
  if (durationMs(repeatedFrames) < thresholds.repeatedFingerprintWindowMs)
    return undefined
  if (!repeatedFrames.some(candidate => containsAnyTerm(frameText(candidate), blockerTerms) || candidate.stuckEvidence?.length))
    return undefined

  return {
    kind: 'repeated_error',
    description: `Same task surface repeated ${repeatedFrames.length} times without enough progress evidence.`,
    fingerprint,
    weight: thresholds.repeatedFingerprintWeight,
    capturedAt: frame.capturedAt,
    summaryId: frame.summaryId,
  }
}

function frameCompanionCategory(frame: TaskObservationFrame): 'search_or_docs' | 'work_surface' | 'other' {
  const text = frameText(frame)
  if (containsAnyTerm(text, searchDocTerms))
    return 'search_or_docs'
  if (containsAnyTerm(text, workSurfaceTerms))
    return 'work_surface'
  return 'other'
}

function searchDocLoopEvidence(
  frame: TaskObservationFrame,
  recentFrames: readonly TaskObservationFrame[],
  thresholds: TaskCompanionThresholds,
): TaskObservationEvidence | undefined {
  const frames = recentFrames.filter(candidate => candidate.privacyFiltered)
  if (frames.length < thresholds.searchLoopFrameCount)
    return undefined
  if (durationMs(frames) < thresholds.searchLoopWindowMs)
    return undefined

  const categories = frames.map(frameCompanionCategory)
  const searchCount = categories.filter(category => category === 'search_or_docs').length
  const workCount = categories.filter(category => category === 'work_surface').length
  const transitions = categories.reduce((total, category, index) => {
    if (index === 0)
      return total
    return category !== 'other' && categories[index - 1] !== 'other' && category !== categories[index - 1]
      ? total + 1
      : total
  }, 0)

  if (searchCount < 2 || workCount < 2 || transitions < 2)
    return undefined

  return {
    kind: 'search_doc_loop',
    description: 'Task alternated between work surfaces and search/docs without enough progress evidence.',
    fingerprint: 'search-doc-loop',
    weight: thresholds.searchLoopWeight,
    capturedAt: frame.capturedAt,
    summaryId: frame.summaryId,
  }
}

function noProgressEvidence(
  frame: TaskObservationFrame,
  previousState: TaskWorkingState | undefined,
  thresholds: TaskCompanionThresholds,
  now: Date,
): TaskObservationEvidence | undefined {
  if (!previousState?.lastProgressAt)
    return undefined
  if (now.getTime() - new Date(previousState.lastProgressAt).getTime() < thresholds.noProgressWindowMs)
    return undefined

  return {
    kind: 'no_progress',
    description: 'No progress evidence has appeared in the conservative stuck window.',
    weight: thresholds.noProgressWeight,
    capturedAt: frame.capturedAt,
    summaryId: frame.summaryId,
  }
}

function initialTaskWorkingState(taskId: string): TaskWorkingState {
  return {
    taskId,
    state: 'idle',
    progressScore: 0,
    stuckScore: 0,
    evidenceChain: [],
  }
}

function companionEvidenceChain(
  previousState: TaskWorkingState,
  evidence: readonly TaskObservationEvidence[],
  thresholds: TaskCompanionThresholds,
): TaskObservationEvidence[] {
  return [...previousState.evidenceChain, ...evidence]
    .slice(-thresholds.evidenceChainCap)
}

function companionEpisodeId(evidence: readonly TaskObservationEvidence[], frame: TaskObservationFrame): string | undefined {
  const fingerprint = evidence.find(entry => entry.fingerprint)?.fingerprint ?? frameFingerprint(frame)
  return fingerprint ? `stuck:${fingerprint}` : undefined
}

function earliestFrameAt(frames: readonly TaskObservationFrame[]): string | undefined {
  return frames
    .map(frame => frame.capturedAt)
    .sort()[0]
}

function canNudgeTaskCompanion(
  previousState: TaskWorkingState,
  nextState: TaskCompanionState,
  episodeId: string | undefined,
  thresholds: TaskCompanionThresholds,
  now: Date,
): boolean {
  if (nextState !== 'stuck')
    return false
  if (previousState.mutedUntil && new Date(previousState.mutedUntil).getTime() > now.getTime())
    return false
  if (previousState.lastNudgeAt && episodeId === previousState.episodeId)
    return false
  if (!previousState.lastNudgeAt)
    return true

  return now.getTime() - new Date(previousState.lastNudgeAt).getTime() >= thresholds.nudgeCooldownMs
}

export function scoreTaskProgress(input: TaskCompanionScoringInput): TaskCompanionScore {
  if (!input.frame.privacyFiltered || input.frame.taskId !== input.task.id)
    return { score: 0, confidence: 0, evidence: [] }

  const thresholds = companionThresholds(input.thresholds)
  const evidence = (input.frame.progressEvidence ?? [])
    .map(entry => evidenceAt(entry, input.frame.capturedAt))
  const text = frameText(input.frame)

  if (containsAnyTerm(text, progressTerms)) {
    evidence.push({
      kind: 'semantic_progress',
      description: 'Summary contains conservative progress language.',
      weight: thresholds.semanticProgressWeight,
      capturedAt: input.frame.capturedAt,
      summaryId: input.frame.summaryId,
    })
  }

  const score = Math.min(thresholds.maxScore, evidence.reduce((total, entry) => total + evidenceWeight(entry), 0))
  return {
    score,
    confidence: clampConfidence(score / thresholds.progressScoreThreshold),
    evidence,
  }
}

export function scoreTaskStuck(input: TaskCompanionScoringInput): TaskCompanionScore {
  if (!input.frame.privacyFiltered || input.frame.taskId !== input.task.id || input.frame.offTaskEvidence?.length)
    return { score: 0, confidence: 0, evidence: [] }

  const thresholds = companionThresholds(input.thresholds)
  const now = input.now ?? new Date(input.frame.capturedAt)
  const recentFrames = recentFrameSet(input.frame, input.recentFrames)
  const progress = scoreTaskProgress(input)
  const evidence = (input.frame.stuckEvidence ?? [])
    .map(entry => evidenceAt(entry, input.frame.capturedAt))

  const text = frameText(input.frame)
  if (containsAnyTerm(text, blockerTerms)) {
    evidence.push({
      kind: 'semantic_blocker',
      description: 'Summary contains conservative blocker language.',
      weight: thresholds.semanticBlockerWeight,
      capturedAt: input.frame.capturedAt,
      summaryId: input.frame.summaryId,
    })
  }

  const repeated = repeatedFingerprintEvidence(input.frame, recentFrames, thresholds)
  if (repeated)
    evidence.push(repeated)

  const loop = progress.score === 0 ? searchDocLoopEvidence(input.frame, recentFrames, thresholds) : undefined
  if (loop)
    evidence.push(loop)

  const idle = progress.score === 0 ? noProgressEvidence(input.frame, input.previousState, thresholds, now) : undefined
  if (idle)
    evidence.push(idle)

  const score = Math.min(thresholds.maxScore, evidence.reduce((total, entry) => total + evidenceWeight(entry), 0))
  return {
    score,
    confidence: clampConfidence(score / thresholds.stuckScoreThreshold),
    evidence,
  }
}

export function transitionTaskWorkingState(input: TaskCompanionScoringInput): TaskCompanionTransition {
  const thresholds = companionThresholds(input.thresholds)
  const now = input.now ?? new Date(input.frame.capturedAt)
  const previousState = input.previousState ?? initialTaskWorkingState(input.task.id)
  const recentFrames = recentFrameSet(input.frame, input.recentFrames)
  const offTaskEvidence = input.frame.taskId !== input.task.id
    ? [{
        kind: 'off_task' as const,
        description: 'Observation frame belongs to a different task.',
        capturedAt: input.frame.capturedAt,
        summaryId: input.frame.summaryId,
      }]
    : (input.frame.offTaskEvidence ?? []).map(entry => evidenceAt(entry, input.frame.capturedAt))
  const progress = scoreTaskProgress(input)
  const stuck = scoreTaskStuck(input)

  let nextCompanionState: TaskCompanionState = 'idle'
  let nextProgressScore = Math.min(thresholds.maxScore, previousState.progressScore * thresholds.idleScoreDecay + progress.score)
  let nextStuckScore = Math.min(thresholds.maxScore, previousState.stuckScore * thresholds.idleScoreDecay + stuck.score)
  let lastProgressAt = previousState.lastProgressAt
  let stuckStartedAt = previousState.stuckStartedAt

  if (!input.frame.privacyFiltered) {
    nextCompanionState = 'idle'
    nextStuckScore = previousState.stuckScore * thresholds.idleScoreDecay
    stuckStartedAt = undefined
  }
  else if (offTaskEvidence.length > 0) {
    nextCompanionState = 'off_task'
    nextStuckScore = previousState.stuckScore * thresholds.idleScoreDecay
    stuckStartedAt = undefined
  }
  else if (progress.score >= thresholds.progressScoreThreshold) {
    nextCompanionState = 'progressing'
    lastProgressAt = now.toISOString()
    nextStuckScore = Math.max(0, previousState.stuckScore * thresholds.progressStuckDecay - progress.score)
    stuckStartedAt = undefined
  }
  else if (nextStuckScore >= thresholds.possibleStuckScoreThreshold) {
    stuckStartedAt = previousState.stuckStartedAt ?? earliestFrameAt(recentFrames) ?? now.toISOString()
    const stuckDurationMs = now.getTime() - new Date(stuckStartedAt).getTime()
    nextCompanionState = nextStuckScore >= thresholds.stuckScoreThreshold && stuckDurationMs >= thresholds.stuckDurationMs
      ? 'stuck'
      : 'possibly_stuck'
  }

  if (nextCompanionState === 'idle')
    stuckStartedAt = undefined

  const evidence = nextCompanionState === 'off_task'
    ? offTaskEvidence
    : [...progress.evidence, ...stuck.evidence]
  const episodeId = nextCompanionState === 'stuck'
    ? companionEpisodeId(stuck.evidence, input.frame)
    : undefined
  const shouldNudge = canNudgeTaskCompanion(previousState, nextCompanionState, episodeId, thresholds, now)
  const nextState: TaskWorkingState = {
    ...previousState,
    taskId: input.task.id,
    state: nextCompanionState,
    progressScore: Math.round(nextProgressScore * 100) / 100,
    stuckScore: Math.round(nextStuckScore * 100) / 100,
    evidenceChain: companionEvidenceChain(previousState, evidence, thresholds),
    lastProgressAt,
    lastEvidenceAt: evidence.length > 0 ? now.toISOString() : previousState.lastEvidenceAt,
    stuckStartedAt,
    lastNudgeAt: shouldNudge ? now.toISOString() : previousState.lastNudgeAt,
    episodeId,
  }
  const signalKind: TaskCompanionSignalKind = nextCompanionState === 'progressing'
    ? 'progress_detected'
    : nextCompanionState === 'possibly_stuck'
      ? 'possible_stuck'
      : nextCompanionState === 'stuck'
        ? 'stuck_detected'
        : nextCompanionState === 'off_task'
          ? 'off_task'
          : 'idle'

  return {
    state: nextState,
    signal: {
      taskId: input.task.id,
      kind: signalKind,
      state: nextCompanionState,
      createdAt: now.toISOString(),
      score: nextCompanionState === 'progressing' ? progress.score : nextStuckScore,
      confidence: nextCompanionState === 'progressing' ? progress.confidence : clampConfidence(nextStuckScore / thresholds.stuckScoreThreshold),
      evidence,
      shouldNudge,
      recommendedTouchReason: nextCompanionState === 'stuck' ? 'task_blocked' : nextCompanionState === 'progressing' ? 'task_progress' : undefined,
      episodeId,
    },
  }
}

/**
 * Applies the fixed L0-L3 touch policy for task progress notifications.
 *
 * This is a pure decision function: callers own persistence and delivery.
 */
export function decideScreenObservationTouch(input: DecideTouchInput): TouchEventPayload {
  const policyApplied: TouchPolicyApplied[] = []
  let level = input.requestedLevel ?? input.task.touchPolicy.level

  if (
    input.reason === 'task_progress'
    && input.task.touchPolicy.firstTaskFirstProgressUsesL2
    && input.isFirstTaskForUser
    && input.isFirstProgressUpdateForTask
    && touchRank[level] < touchRank[FIRST_TASK_FIRST_PROGRESS_LEVEL]
  ) {
    level = FIRST_TASK_FIRST_PROGRESS_LEVEL
    policyApplied.push('first_task_first_progress_l2')
  }

  if (
    touchRank[level] >= touchRank.L2
    && input.lastL2PlusTouchAt
    && input.now.getTime() - input.lastL2PlusTouchAt.getTime() < TOUCH_THROTTLE_WINDOW_MS
  ) {
    level = 'L1'
    policyApplied.push('throttled_l2_plus_30m')
  }

  if ((input.ignoredTouchesAtSameLevel ?? 0) >= IGNORED_TOUCHES_BEFORE_DOWNGRADE) {
    level = downgradeTouchLevel(level)
    policyApplied.push('ignored_same_level_downgrade')
  }

  if (input.isFullscreen || input.isMeeting) {
    level = FOCUS_SUPPRESSION_LEVEL
    policyApplied.push('focus_or_meeting_l0')
  }

  if (input.task.observation.privacyState === 'not_observing_empty_whitelist')
    policyApplied.push('empty_whitelist_not_observing')

  return {
    id: input.id,
    taskId: input.task.id,
    level,
    reason: input.reason,
    createdAt: input.now.toISOString(),
    summaryId: input.summaryId,
    message: normalizeTouchMessage(input.message, input.task),
    actions: actionsForTouchLevel(level),
    policyApplied,
  }
}

/**
 * Decides whether the daily summary should emit, and builds its task rows.
 *
 * Zero-task days are suppressed so the summary channel stays meaningful.
 */
export function decideDailySummary(taskCount: number, enabled: boolean): DailySummaryDecision
export function decideDailySummary(input: DecideDailySummaryInput): DailySummaryDecision
export function decideDailySummary(inputOrTaskCount: number | DecideDailySummaryInput, enabled = true): DailySummaryDecision {
  if (typeof inputOrTaskCount === 'number') {
    if (!enabled)
      return { shouldSend: false, policyApplied: [] }
    if (inputOrTaskCount === 0)
      return { shouldSend: false, policyApplied: ['zero_task_daily_summary_suppressed'] }
    return { shouldSend: true, policyApplied: [] }
  }

  const input = inputOrTaskCount
  if (!input.enabled)
    return { shouldSend: false, policyApplied: [] }
  if (input.tasks.length === 0)
    return { shouldSend: false, policyApplied: ['zero_task_daily_summary_suppressed'] }

  const tasks = input.tasks.map(taskInput => taskInput.task)
  return {
    shouldSend: true,
    payload: {
      id: input.id,
      createdAt: input.createdAt,
      localDate: input.localDate,
      tasks,
      taskSummaries: input.tasks.map(createDailySummaryTaskLine),
      touch: input.touch,
    },
    policyApplied: [],
  }
}

const barePercentagePrefixPattern = /^[\p{L}\p{N}_-]+/u
const barePercentageValuePattern = /^\d{1,3}(?:\.\d+)?%$/u
const percentWrapperPairs: Record<string, string> = {
  '(': ')',
  '[': ']',
  '（': '）',
  '【': '】',
}

export function isBarePercentage(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed)
    return false

  if (isBarePercentageValue(trimmed))
    return true

  const prefix = trimmed.match(barePercentagePrefixPattern)?.[0]
  if (!prefix)
    return false

  let remainder = trimmed.slice(prefix.length).trimStart()
  if (!remainder)
    return false

  const separator = remainder.at(0)
  if (separator && ':：=-'.includes(separator))
    remainder = remainder.slice(1).trimStart()

  return isBarePercentageValue(remainder)
}

function isBarePercentageValue(value: string): boolean {
  let token = value.trim()
  const first = token.at(0)
  const expectedClose = first ? percentWrapperPairs[first] : undefined
  if (expectedClose) {
    if (!token.endsWith(expectedClose))
      return false
    token = token.slice(1, -1).trim()
  }
  else if (!first || first < '0' || first > '9') {
    return false
  }

  return barePercentageValuePattern.test(token.replace(/\s+/gu, ''))
}

function normalizeTouchMessage(message: TouchEventMessage, task: Task): TouchEventMessage {
  const isOffTrack = message.isOffTrack

  return {
    remainingWork: normalizeTouchMessageSentence(
      message.remainingWork,
      isOffTrack
        ? `The next concrete step for ${task.title} is blocked.`
        : `The next concrete step for ${task.title} is ready.`,
    ),
    etaAt: message.etaAt,
    pace: message.pace !== undefined
      ? normalizeTouchMessageSentence(
          message.pace,
          isOffTrack
            ? 'Current pace is off track.'
            : 'Current pace is on track.',
        )
      : undefined,
    isOffTrack,
  }
}

function normalizeTouchMessageSentence(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  if (!trimmed || isBarePercentage(trimmed))
    return fallback
  return trimmed
}

function createDailySummaryTaskLine(input: DailySummaryTaskInput): DailySummaryTaskLine {
  const progress = normalizeDailySummaryProgress(input.progress ?? input.task.progressNarrative, input.task)
  return {
    taskId: input.task.id,
    title: input.task.title,
    progress,
    observation: normalizeDailySummarySentence(input.observation, defaultObservation(input.task, progress)),
    tomorrowSuggestion: normalizeDailySummarySentence(input.tomorrowSuggestion, defaultTomorrowSuggestion(input.task, progress)),
  }
}

function normalizeDailySummaryProgress(progress: TaskProgressNarrative | undefined, task: Task): DailySummaryProgressNarrative {
  const isOffTrack = progress?.isOffTrack ?? false
  return {
    remainingWork: normalizeDailySummarySentence(
      progress?.remainingWork,
      dailySummaryI18nText(
        isOffTrack
          ? 'tamagotchi.screen_observation.daily_summary.progress.remaining_work.blocked'
          : 'tamagotchi.screen_observation.daily_summary.progress.remaining_work.ready',
        { title: task.title },
      ),
    ),
    etaAt: progress?.etaAt,
    pace: progress?.pace ? normalizeDailySummarySentence(
      progress.pace,
      dailySummaryI18nText(
        isOffTrack
          ? 'tamagotchi.screen_observation.daily_summary.progress.pace.off_track'
          : 'tamagotchi.screen_observation.daily_summary.progress.pace.on_track',
      ),
    ) : undefined,
    isOffTrack,
  }
}

function normalizeDailySummarySentence(value: string | undefined, fallback: I18nTextPayload): LocalizedText {
  const trimmed = value?.trim()
  if (!trimmed || isBarePercentage(trimmed))
    return fallback
  return trimmed
}

function dailySummaryI18nText(key: ScreenObservationI18nKey, params?: Record<string, I18nTextParam>): I18nTextPayload {
  return params ? { key, params } : { key }
}

function defaultObservation(task: Task, progress: DailySummaryProgressNarrative): I18nTextPayload {
  if (progress.isOffTrack)
    return dailySummaryI18nText('tamagotchi.screen_observation.daily_summary.observation.off_track', { title: task.title })
  return dailySummaryI18nText('tamagotchi.screen_observation.daily_summary.observation.on_track', { title: task.title })
}

function defaultTomorrowSuggestion(task: Task, progress: DailySummaryProgressNarrative): I18nTextPayload {
  if (progress.isOffTrack)
    return dailySummaryI18nText('tamagotchi.screen_observation.daily_summary.tomorrow.blocked', { title: task.title })
  return dailySummaryI18nText('tamagotchi.screen_observation.daily_summary.tomorrow.ready', { title: task.title })
}

function downgradeTouchLevel(level: TouchLevel): TouchLevel {
  return touchLevels[Math.max(0, touchRank[level] - 1)]!
}

function actionsForTouchLevel(level: TouchLevel): TouchAction[] {
  switch (level) {
    case 'L0':
      return ['details']
    case 'L1':
      return ['details', 'mute_task']
    case 'L2':
      return ['ack', 'details', 'mute_task', 'pause_15m', 'pause_1h']
    case 'L3':
      return ['ack', 'details', 'mute_task', 'pause_15m', 'pause_1h', 'pause_today']
  }

  throw new Error(`Unsupported touch level: ${level}`)
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value))
    return 0
  return Math.max(0, Math.min(1, value))
}

export const screenObservationGetSnapshot = defineInvokeEventa<ScreenObservationSnapshot>('screen-observation:get-snapshot')
export const screenObservationUpsertTask = defineInvokeEventa<Task, UpsertTaskRequest>('screen-observation:task:upsert')
export const screenObservationPause = defineInvokeEventa<ScreenObservationSnapshot, PauseObservationRequest>('screen-observation:pause')
export const screenObservationResume = defineInvokeEventa<ScreenObservationSnapshot>('screen-observation:resume')

export const screenObservationTaskChanged = defineOutboundEventa<TaskModelChangedPayload>('screen-observation:task-changed')
export const screenObserverSummaryReceived = defineOutboundEventa<ScreenObserverSummaryPayload>('screen-observation:summary-received')
export const screenObservationTouch = defineOutboundEventa<TouchEventPayload>('screen-observation:touch')
export const screenObservationDailySummary = defineOutboundEventa<DailySummaryPayload>('screen-observation:daily-summary')
