import type {
  ScreenObservationContextEvidence,
  ScreenObservationContextType,
  ScreenObservationProcessedContext,
  ScreenObserverSummary,
} from '@proj-airi/server-sdk-shared'

import { randomUUID } from 'node:crypto'

import { normalizeScreenObservationProcessedContext } from '@proj-airi/server-sdk-shared'

/**
 * Options for creating fallback contexts from a screenpipe summary.
 */
export interface CreateContextFromSummaryOptions {
  /** Injected for deterministic tests; defaults to `crypto.randomUUID`. */
  idFactory?: () => string
}

interface ContextTypeRule {
  contextType: ScreenObservationContextType
  patterns: RegExp[]
}

// NOTICE:
// MineContext's screenshot processor classifies VLM output into stable context
// categories, then merges and vectorizes them for downstream consumption.
// AIRI does not yet have the VLM processor wired here, so this small heuristic
// bridge produces the same category shape from screenpipe OCR/app digests.
// Source: `https://github.com/volcengine/MineContext/blob/main/opencontext/context_processing/processor/screenshot_processor.py`
// Removal condition: route screenpipe keyframes through an AIRI-native VLM
// processor and keep this module only as a no-model fallback.
const CONTEXT_TYPE_RULES: ContextTypeRule[] = [
  {
    contextType: 'state_context',
    patterns: [
      /\berror\b/iu,
      /\bexception\b/iu,
      /\bfailed\b/iu,
      /\bfailure\b/iu,
      /\bunavailable\b/iu,
      /\bblocked\b/iu,
      /\bwarning\b/iu,
      /\bstatus\b/iu,
      /\bprogress\b/iu,
    ],
  },
  {
    contextType: 'intent_context',
    patterns: [
      /\btodo\b/iu,
      /\bnext\b/iu,
      /\bplan\b/iu,
      /\bgoal\b/iu,
      /\bwill\b/iu,
      /\bshould\b/iu,
    ],
  },
  {
    contextType: 'procedural_context',
    patterns: [
      /\bstep\b/iu,
      /\bworkflow\b/iu,
      /\binstall\b/iu,
      /\bbuild\b/iu,
      /\brun\b/iu,
      /\bdebug\b/iu,
      /\bconfigure\b/iu,
    ],
  },
  {
    contextType: 'knowledge_context',
    patterns: [
      /\breadme\b/iu,
      /\bdocs?\b/iu,
      /\bpdf\b/iu,
      /\bnotion\b/iu,
      /\bobsidian\b/iu,
      /\bmarkdown\b/iu,
    ],
  },
  {
    contextType: 'semantic_context',
    patterns: [
      /\barchitecture\b/iu,
      /\bconcept\b/iu,
      /\bdefinition\b/iu,
      /\bexplain\b/iu,
      /\breference\b/iu,
    ],
  },
  {
    contextType: 'entity_context',
    patterns: [
      /\bproject\b/iu,
      /\brepository\b/iu,
      /\brepo\b/iu,
      /\bissue\b/iu,
      /\bpull request\b/iu,
      /\bteam\b/iu,
    ],
  },
]

/**
 * Classifies a screen observation text digest into a MineContext-compatible context type.
 *
 * Use when:
 * - OCR/window metadata is available but VLM screenshot interpretation has not
 *   produced a richer context yet.
 *
 * Expects:
 * - The input is already privacy-filtered for the active observation mode.
 *
 * Returns:
 * - A stable context category, defaulting to `activity_context`.
 */
export function classifyScreenObservationContext(text: string): ScreenObservationContextType {
  for (const rule of CONTEXT_TYPE_RULES) {
    if (rule.patterns.some(pattern => pattern.test(text)))
      return rule.contextType
  }
  return 'activity_context'
}

/**
 * Creates processed context drafts from one screenpipe summary.
 *
 * Use when:
 * - AIRI needs MineContext-style processed contexts before the VLM screenshot
 *   processor is available.
 *
 * Expects:
 * - The summary app digests are already scoped by desktop/application privacy
 *   mode and contain no raw screenshot payload.
 *
 * Returns:
 * - Zero or one normalized context draft linked back to the summary evidence.
 */
export function createScreenObservationContextsFromSummary(
  summary: ScreenObserverSummary,
  options: CreateContextFromSummaryOptions = {},
): ScreenObservationProcessedContext[] {
  if (summary.apps.length === 0)
    return []

  const sourceText = textForClassification(summary)
  const contextType = classifyScreenObservationContext(sourceText)
  const title = titleForContext(contextType, summary)
  const description = descriptionForContext(summary)
  const createdAt = summary.capturedAt

  return [normalizeScreenObservationProcessedContext({
    id: options.idFactory?.() ?? randomUUID(),
    contextType,
    title,
    summary: description,
    keywords: keywordsForSummary(summary, contextType),
    entities: entitiesForSummary(summary),
    confidence: Math.max(0.1, Math.min(1, summary.confidence)),
    importance: importanceForContext(contextType, summary),
    createdAt,
    eventTime: summary.windowEndedAt,
    updatedAt: createdAt,
    evidence: evidenceForSummary(summary),
    rawReference: summary.rawReference ?? `screenpipe-summary:${summary.id}`,
  })]
}

function textForClassification(summary: ScreenObserverSummary) {
  return [
    summary.summary,
    ...summary.apps.flatMap(app => [
      app.appName,
      app.windowTitle ?? '',
      app.summary,
    ]),
  ].join('\n')
}

function titleForContext(contextType: ScreenObservationContextType, summary: ScreenObserverSummary) {
  const appNames = summary.apps.map(app => app.appName).slice(0, 3).join(', ')
  switch (contextType) {
    case 'state_context':
      return `Screen state in ${appNames}`
    case 'intent_context':
      return `Possible intent in ${appNames}`
    case 'procedural_context':
      return `Observed workflow in ${appNames}`
    case 'knowledge_context':
      return `Visible knowledge in ${appNames}`
    case 'semantic_context':
      return `Visible concept in ${appNames}`
    case 'entity_context':
      return `Visible entities in ${appNames}`
    case 'activity_context':
      return `Observed activity in ${appNames}`
  }
}

function descriptionForContext(summary: ScreenObserverSummary) {
  const apps = summary.apps
    .map(app => `${app.appName}${app.windowTitle ? `: ${app.windowTitle}` : ''}`)
    .join('; ')
  return `${summary.summary}. Evidence surfaces: ${apps}.`
}

function keywordsForSummary(summary: ScreenObserverSummary, contextType: ScreenObservationContextType) {
  return [
    contextType,
    'screen-observation',
    'screenpipe',
    ...summary.apps.map(app => app.appName),
    ...summary.apps.map(app => app.windowTitle ?? ''),
  ]
}

function entitiesForSummary(summary: ScreenObserverSummary) {
  return [
    ...summary.apps.map(app => app.appName),
    ...summary.apps.map(app => app.windowTitle ?? ''),
  ]
}

function evidenceForSummary(summary: ScreenObserverSummary): ScreenObservationContextEvidence[] {
  return summary.apps.map(app => ({
    summaryId: summary.id,
    appName: app.appName,
    windowTitle: app.windowTitle,
    observedSeconds: app.observedSeconds,
  }))
}

function importanceForContext(contextType: ScreenObservationContextType, summary: ScreenObserverSummary) {
  const visibleSeconds = summary.apps.reduce((total, app) => total + app.observedSeconds, 0)
  const base = Math.min(80, 20 + visibleSeconds)
  if (contextType === 'state_context' || contextType === 'intent_context')
    return base + 10
  return base
}
