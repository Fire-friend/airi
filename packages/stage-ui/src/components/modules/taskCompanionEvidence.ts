import type { TaskObservationEvidenceKind, TaskWorkingState } from '@proj-airi/server-sdk-shared'

/** Priority order for the stuck nudge: most specific first so the interrupt names the concrete signal. */
const STUCK_EVIDENCE_PRIORITY: TaskObservationEvidenceKind[] = [
  'semantic_blocker',
  'search_doc_loop',
  'repeated_error',
  'no_progress',
]

/**
 * Picks the most specific stuck-evidence description from the chain.
 *
 * Walks the priority list and returns the first matching entry description
 * so the nudge names the actual signal rather than generic copy.
 */
export function stuckEvidenceText(state: TaskWorkingState | undefined): string | undefined {
  if (!state || state.state !== 'stuck')
    return undefined
  const chain = state.evidenceChain.slice().reverse()
  for (const kind of STUCK_EVIDENCE_PRIORITY) {
    const entry = chain.find(e => e.kind === kind)
    if (entry)
      return entry.description
  }
  return chain[0]?.description
}
