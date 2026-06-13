<script setup lang="ts">
import type { ScreenObservationContextType, ScreenObserverSummary } from '@proj-airi/server-sdk-shared'

import { Button, Callout, FieldCheckbox, FieldInput, FieldRange, FieldValues, TransitionVertical } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useScreenObservationStore } from '../../stores/modules/screen-observation'

const { t, locale } = useI18n()
const tn = (key: string, params?: Record<string, unknown>) => t(`settings.pages.modules.screen-observation.${key}`, params ?? {})

const store = useScreenObservationStore()
const {
  enabled,
  observationMode,
  allowedApps,
  frameCaptureIntervalMs,
  dailySummaryEnabled,
  dailySummaryAtLocalTime,
  autoPauseOnFocus,
  onboardingCompleted,
  observationLog,
  privacyState,
  nativeCaptureStatus,
  statusLabelKey,
  tasks,
  latestSummaryAt,
} = storeToRefs(store)

const showOnboarding = computed(() => enabled.value && !onboardingCompleted.value)
const observationAction = computed(() => enabled.value
  ? {
      icon: 'i-solar:stop-circle-bold-duotone',
      label: tn('actions.stop'),
      variant: 'danger' as const,
    }
  : {
      icon: 'i-solar:play-circle-bold-duotone',
      label: tn('actions.start'),
      variant: 'primary' as const,
    })
const useApplicationMode = computed({
  get: () => observationMode.value === 'application',
  set: (value: boolean) => {
    observationMode.value = value ? 'application' : 'desktop'
  },
})
const showApplicationList = computed(() => enabled.value && useApplicationMode.value)

// Application mode without apps is the only enabled-but-not-observing state.
const showEmptyWhitelistWarning = computed(() => showApplicationList.value && privacyState.value === 'not_observing_empty_whitelist')

const STATUS_THEME: Record<string, 'primary' | 'violet' | 'lime' | 'orange'> = {
  observing: 'lime',
  paused: 'violet',
  not_observing_empty_whitelist: 'orange',
  suppressed_fullscreen: 'violet',
  suppressed_meeting: 'violet',
  disabled: 'primary',
}

const timeFormat = computed(() => new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit', hour12: false }))
const dateTimeFormat = computed(() => new Intl.DateTimeFormat(locale.value, {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
}))

const latestSummaryTime = computed(() => latestSummaryAt.value
  ? dateTimeFormat.value.format(new Date(latestSummaryAt.value))
  : undefined)

const runtimeStatusKey = computed(() => {
  if (!enabled.value)
    return 'runtime.disabled'
  if (privacyState.value === 'not_observing_empty_whitelist')
    return 'runtime.waiting-for-apps'
  if (privacyState.value === 'paused')
    return 'runtime.paused'
  if (privacyState.value === 'suppressed_fullscreen')
    return 'runtime.suppressed-fullscreen'
  if (privacyState.value === 'suppressed_meeting')
    return 'runtime.suppressed-meeting'
  if (nativeCaptureStatus.value?.lastError && !nativeCaptureStatus.value.lastInterpretationAt)
    return 'runtime.native-error'
  if (latestSummaryAt.value)
    return 'runtime.native-observed'
  if (nativeCaptureStatus.value?.running)
    return 'runtime.native-capturing'
  return 'runtime.native-starting'
})

const runtimeStatusTheme = computed(() => {
  if (runtimeStatusKey.value === 'runtime.native-observed')
    return 'lime'
  if (runtimeStatusKey.value === 'runtime.waiting-for-apps' || runtimeStatusKey.value === 'runtime.native-error')
    return 'orange'
  if (runtimeStatusKey.value === 'runtime.paused' || runtimeStatusKey.value.startsWith('runtime.suppressed-'))
    return 'violet'
  return 'primary'
})

const runtimeStatusLabel = computed(() => tn(runtimeStatusKey.value, {
  time: latestSummaryTime.value,
  count: nativeCaptureStatus.value?.sourceCount ?? 0,
  error: nativeCaptureStatus.value?.lastError ?? '',
}))

function toggleObservation() {
  enabled.value = !enabled.value
}

function logTimeRange(entry: ScreenObserverSummary) {
  return `${timeFormat.value.format(new Date(entry.windowStartedAt))} – ${timeFormat.value.format(new Date(entry.windowEndedAt))}`
}

function logPurpose(entry: ScreenObserverSummary) {
  const task = entry.taskId ? tasks.value.find(candidate => candidate.id === entry.taskId) : undefined
  return task ? tn('log.purpose-task', { task: task.title }) : tn('log.purpose-general')
}

function logApps(entry: ScreenObserverSummary) {
  return entry.apps.map(app => app.appName).join(', ')
}

function logContextType(type: ScreenObservationContextType) {
  return type.replace(/_context$/u, '').replaceAll('_', ' ')
}

// TODO: wire to the desktop runtime over Eventa once the Electron main
// process ScreenObserver lands — must also purge matching runtime-owned
// observation data, not only the renderer-side digest log.
function deleteTodayLog() {
  observationLog.value = []
}
</script>

<template>
  <div flex="~ col gap-4">
    <Callout :theme="STATUS_THEME[privacyState] ?? 'primary'" :label="tn('status-title')">
      {{ t(statusLabelKey) }}
    </Callout>

    <section
      :class="[
        'flex flex-col gap-3 rounded-lg px-3 py-3',
        'bg-neutral-50/80 dark:bg-neutral-900/40',
        'sm:flex-row sm:items-center sm:justify-between',
      ]"
    >
      <div class="flex flex-col gap-1">
        <h3 class="m-0 text-sm font-semibold">
          {{ tn('enable.label') }}
        </h3>
        <p class="m-0 text-xs text-neutral-500 dark:text-neutral-400">
          {{ tn('enable.description') }}
        </p>
      </div>
      <Button
        size="sm"
        :variant="observationAction.variant"
        :icon="observationAction.icon"
        :label="observationAction.label"
        @click="toggleObservation"
      />
    </section>

    <Callout :theme="runtimeStatusTheme" :label="tn('runtime.title')">
      {{ runtimeStatusLabel }}
    </Callout>

    <TransitionVertical>
      <section
        v-if="showOnboarding"
        :class="[
          'flex flex-col gap-3 rounded-xl p-4',
          'border-2 border-solid border-primary-100 bg-primary-50/60',
          'dark:border-primary-900/60 dark:bg-primary-900/10',
        ]"
      >
        <ol class="m-0 flex flex-col gap-2 pl-5 text-sm">
          <li>{{ tn('onboarding.what-it-sees') }}</li>
          <li>{{ tn('onboarding.where-data-goes') }}</li>
          <li>{{ tn('onboarding.how-to-pause') }}</li>
        </ol>
        <Button
          variant="primary" size="sm"
          icon="i-solar:check-circle-bold-duotone" :label="tn('onboarding.confirm')"
          @click="onboardingCompleted = true"
        />
      </section>
    </TransitionVertical>

    <template v-if="enabled">
      <section flex="~ col gap-3">
        <FieldCheckbox
          v-model="useApplicationMode"
          :label="tn('application-mode.label')"
          :description="tn('application-mode.description')"
        />

        <Callout v-if="showEmptyWhitelistWarning" theme="orange" :label="tn('whitelist.empty-title')">
          {{ tn('status.not-observing-empty-whitelist') }}
        </Callout>

        <TransitionVertical>
          <FieldValues
            v-if="showApplicationList"
            v-model="allowedApps"
            :label="tn('whitelist.label')"
            :description="tn('whitelist.description')"
            :value-placeholder="tn('whitelist.placeholder')"
          />
        </TransitionVertical>
      </section>

      <section flex="~ col gap-3">
        <FieldRange
          v-model="frameCaptureIntervalMs"
          :label="tn('capture.interval-label')"
          :description="tn('capture.interval-description')"
          :min="2000"
          :max="60000"
          :step="1000"
          :format-value="value => `${(value / 1000).toFixed(0)}s`"
        />
      </section>

      <section flex="~ col gap-3">
        <FieldCheckbox
          v-model="autoPauseOnFocus"
          :label="tn('auto-pause.label')"
          :description="tn('auto-pause.description')"
        />
        <p class="m-0 text-xs text-neutral-500 dark:text-neutral-400">
          {{ tn('auto-pause.never-read') }}
        </p>
      </section>

      <section flex="~ col gap-3">
        <FieldCheckbox
          v-model="dailySummaryEnabled"
          :label="tn('daily-summary.label')"
          :description="tn('daily-summary.description')"
        />
        <TransitionVertical>
          <FieldInput
            v-if="dailySummaryEnabled"
            v-model="dailySummaryAtLocalTime"
            type="time"
            :label="tn('daily-summary.time-label')"
            :description="tn('daily-summary.zero-task-note')"
          />
        </TransitionVertical>
      </section>

      <section flex="~ col gap-3">
        <div class="flex items-center justify-between gap-2">
          <div flex="~ col gap-1">
            <h3 class="m-0 text-sm font-semibold">
              {{ tn('log.title') }}
            </h3>
            <p class="m-0 text-xs text-neutral-500 dark:text-neutral-400">
              {{ tn('log.description') }}
            </p>
          </div>
          <Button
            variant="danger" size="sm"
            icon="i-solar:trash-bin-trash-bold-duotone" :label="tn('log.delete-today')"
            :disabled="!observationLog.length"
            @click="deleteTodayLog"
          />
        </div>

        <div
          v-if="!observationLog.length"
          :class="[
            'rounded-lg p-6 text-center text-xs',
            'border-2 border-dashed border-neutral-200 text-neutral-500',
            'dark:border-neutral-800',
          ]"
        >
          {{ tn('log.empty') }}
        </div>

        <ul v-else class="m-0 flex flex-col gap-2 p-0">
          <li
            v-for="entry in observationLog"
            :key="entry.id"
            :class="[
              'flex flex-col gap-1 rounded-lg px-3 py-2',
              'list-none bg-neutral-50/80 dark:bg-neutral-900/40',
            ]"
          >
            <div class="flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <span>{{ logTimeRange(entry) }}</span>
              <span>{{ logPurpose(entry) }}</span>
            </div>
            <div class="text-sm font-medium">
              {{ logApps(entry) }}
            </div>
            <div class="text-xs text-neutral-600 dark:text-neutral-300">
              {{ entry.summary }}
            </div>
            <div v-if="entry.contexts?.length" :class="['mt-1 flex flex-col gap-1']">
              <div
                v-for="context in entry.contexts.slice(0, 3)"
                :key="context.id"
                :class="[
                  'border-l-2 border-primary-300 pl-2',
                  'dark:border-primary-700',
                ]"
              >
                <div class="flex items-center justify-between gap-2 text-[11px] text-primary-600 uppercase dark:text-primary-300">
                  <span>{{ logContextType(context.contextType) }}</span>
                  <span>{{ Math.round(context.confidence * 100) }}%</span>
                </div>
                <div class="text-xs text-neutral-700 font-medium dark:text-neutral-200">
                  {{ context.title }}
                </div>
                <div class="text-xs text-neutral-500 dark:text-neutral-400">
                  {{ context.summary }}
                </div>
              </div>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
