<script setup lang="ts">
import type { PauseObservationRequest, Task, TaskObservationEvidenceKind, TaskWorkingState } from '@proj-airi/server-sdk-shared'

import { Button } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useScreenObservationActions } from '../../composables/useScreenObservationActions'
import { useScreenObservationStore } from '../../stores/modules/screen-observation'
import { stuckEvidenceText } from './taskCompanionEvidence'

const { t, locale } = useI18n()
const tn = (key: string, params?: Record<string, unknown>) => t(`settings.pages.modules.screen-observation.task-companion.${key}`, params ?? {})

const store = useScreenObservationStore()
const { activeTasks, taskWorkingStates, privacyState } = storeToRefs(store)
const actions = useScreenObservationActions()

interface TaskEntry {
  task: Task
  state: TaskWorkingState | undefined
}

const taskEntries = computed<TaskEntry[]>(() =>
  activeTasks.value.map(task => ({
    task,
    state: taskWorkingStates.value[task.id],
  })),
)

const STATE_BADGE: Record<string, { cls: string, icon: string }> = {
  progressing: { cls: 'bg-lime-100 text-lime-700 dark:bg-lime-900/30 dark:text-lime-400', icon: 'i-solar:graph-up-bold-duotone' },
  possibly_stuck: { cls: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400', icon: 'i-solar:danger-triangle-bold-duotone' },
  stuck: { cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', icon: 'i-solar:fire-bold-duotone' },
  off_task: { cls: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400', icon: 'i-solar:arrow-right-up-bold-duotone' },
  idle: { cls: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400', icon: 'i-solar:clock-circle-bold-duotone' },
}

// Positive evidence kinds — displayed with a green dot.
const PROGRESS_EVIDENCE_KINDS: ReadonlySet<TaskObservationEvidenceKind> = new Set([
  'semantic_progress',
  'subgoal_progress',
  'new_task_artifact',
])

const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit', hour12: false }))

function formatTime(iso: string | undefined): string | undefined {
  return iso ? dateFormat.value.format(new Date(iso)) : undefined
}

function stuckDurationText(state: TaskWorkingState | undefined): string | undefined {
  if (!state?.stuckStartedAt)
    return undefined
  const minutes = Math.round((Date.now() - new Date(state.stuckStartedAt).getTime()) / 60_000)
  return minutes >= 1 ? tn('stuck-duration', { minutes }) : undefined
}

function recentEvidence(state: TaskWorkingState | undefined) {
  return state?.evidenceChain?.slice(-3) ?? []
}

function evidenceDotClass(kind: TaskObservationEvidenceKind): string {
  if (PROGRESS_EVIDENCE_KINDS.has(kind))
    return 'bg-lime-500'
  if (kind === 'off_task')
    return 'bg-neutral-400'
  return 'bg-orange-400'
}

async function forgetEvidence(taskId: string) {
  await actions?.forgetTaskStateEvidence(taskId)
}

async function completeTask(task: Task) {
  await actions?.upsertTask({ ...task, status: 'completed' })
}

async function muteTask(taskId: string) {
  await actions?.muteTask(taskId)
}

async function pause(reason: PauseObservationRequest['reason']) {
  await actions?.pauseObservation({ reason })
}

async function resume() {
  await actions?.resumeObservation()
}
</script>

<template>
  <section v-if="taskEntries.length" flex="~ col gap-4">
    <div flex="~ col gap-1">
      <h3 class="m-0 text-sm font-semibold">
        {{ tn('title') }}
      </h3>
      <p class="m-0 text-xs text-neutral-500 dark:text-neutral-400">
        {{ tn('description') }}
      </p>
    </div>

    <div
      v-for="{ task, state } in taskEntries"
      :key="task.id"
      :class="[
        'flex flex-col gap-3 rounded-xl p-4',
        'border border-solid border-neutral-200 dark:border-neutral-800',
        'bg-neutral-50/60 dark:bg-neutral-900/40',
      ]"
    >
      <!-- Task title + companion state badge -->
      <div class="flex items-start justify-between gap-2">
        <div flex="~ col gap-1 flex-1">
          <span class="text-sm font-semibold">{{ task.title }}</span>
          <span v-if="task.goal !== task.title" class="text-xs text-neutral-500 dark:text-neutral-400">{{ task.goal }}</span>
        </div>
        <span
          :class="[
            'flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
            (STATE_BADGE[state?.state ?? 'idle'] ?? STATE_BADGE.idle).cls,
          ]"
        >
          <span :class="[(STATE_BADGE[state?.state ?? 'idle'] ?? STATE_BADGE.idle).icon, 'size-3']" />
          {{ tn(`state.${state?.state ?? 'idle'}`) }}
        </span>
      </div>

      <!-- Proactive stuck nudge: earns the interrupt with specific evidence + a concrete next step.
           The text names the actual signal the model saw (not "you seem stuck"). -->
      <div
        v-if="state?.state === 'stuck'"
        :class="[
          'flex flex-col gap-2 rounded-lg px-3 py-2',
          'bg-red-50/60 dark:bg-red-900/10',
          'border border-solid border-red-200 dark:border-red-900/40',
        ]"
      >
        <div class="flex items-start gap-2">
          <span class="i-solar:fire-bold-duotone mt-0.5 size-4 shrink-0 text-red-500" />
          <div flex="~ col gap-1">
            <p class="m-0 text-xs text-red-700 font-medium dark:text-red-400">
              {{ stuckEvidenceText(state) ?? tn('stuck.generic') }}
              <span v-if="stuckDurationText(state)" class="ml-1 font-normal opacity-75">
                ({{ stuckDurationText(state) }})
              </span>
            </p>
            <p class="m-0 text-xs text-red-600/80 dark:text-red-400/70">
              {{ tn('stuck.suggestion') }}
            </p>
          </div>
        </div>
      </div>

      <!-- Recent evidence items (last 3, oldest to newest) -->
      <ul v-if="recentEvidence(state).length" class="m-0 flex flex-col gap-1 p-0">
        <li
          v-for="(entry, i) in recentEvidence(state)"
          :key="i"
          class="list-none text-xs text-neutral-500 dark:text-neutral-400"
        >
          <span :class="['mr-1 inline-block size-1.5 rounded-full align-middle', evidenceDotClass(entry.kind)]" />
          {{ entry.description }}
        </li>
      </ul>

      <!-- Timestamps -->
      <div
        v-if="state?.lastNudgeAt || state?.lastProgressAt"
        class="flex flex-wrap gap-4 text-xs text-neutral-400 dark:text-neutral-500"
      >
        <span v-if="state.lastProgressAt">{{ tn('last-progress', { time: formatTime(state.lastProgressAt) }) }}</span>
        <span v-if="state.lastNudgeAt">{{ tn('last-nudge', { time: formatTime(state.lastNudgeAt) }) }}</span>
      </div>

      <!-- Companion controls: task-level and observation-level actions -->
      <div class="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon="i-solar:bell-off-bold-duotone"
          :label="tn('actions.forget-evidence')"
          @click="forgetEvidence(task.id)"
        />
        <Button
          variant="secondary"
          size="sm"
          icon="i-solar:bell-bold-duotone"
          :label="tn('actions.mute')"
          @click="muteTask(task.id)"
        />
        <Button
          variant="secondary"
          size="sm"
          icon="i-solar:check-circle-bold-duotone"
          :label="tn('actions.complete')"
          @click="completeTask(task)"
        />
      </div>

      <!-- Observation pause/resume controls (global, shown per-task card for quick access) -->
      <div v-if="privacyState !== 'paused'" class="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon="i-solar:pause-bold-duotone"
          :label="tn('actions.pause-15m')"
          @click="pause('manual_15m')"
        />
        <Button
          variant="secondary"
          size="sm"
          icon="i-solar:pause-bold-duotone"
          :label="tn('actions.pause-1h')"
          @click="pause('manual_1h')"
        />
      </div>
      <div v-else class="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon="i-solar:play-bold-duotone"
          :label="tn('actions.resume')"
          @click="resume()"
        />
      </div>
    </div>
  </section>
</template>
