<script setup lang="ts">
import { createScreenObservationTask } from '@proj-airi/server-sdk-shared'
import { Button, FieldInput, FieldValues } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useScreenObservationActions } from '../../composables/useScreenObservationActions'
import { useScreenObservationStore } from '../../stores/modules/screen-observation'

const { t } = useI18n()
const tn = (key: string) => t(`settings.pages.modules.screen-observation.task-entry.${key}`)

const store = useScreenObservationStore()
const { allowedApps } = storeToRefs(store)
const actions = useScreenObservationActions()

const taskTitle = ref('')
const taskGoal = ref('')
const taskAllowedApps = ref<string[]>([])
const submitting = ref(false)

// Pre-fill apps from global whitelist when the user hasn't customised the list yet.
watch(allowedApps, (apps) => {
  if (taskAllowedApps.value.length === 0)
    taskAllowedApps.value = [...apps]
}, { immediate: true })

async function submit() {
  const title = taskTitle.value.trim()
  if (!title || submitting.value)
    return

  const task = createScreenObservationTask({
    id: crypto.randomUUID(),
    userId: 'local',
    title,
    goal: taskGoal.value.trim() || title,
    status: 'active',
    observation: {
      enabled: true,
      allowedApps: taskAllowedApps.value,
    },
  })

  submitting.value = true
  try {
    await actions?.upsertTask(task)
    taskTitle.value = ''
    taskGoal.value = ''
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <section flex="~ col gap-3">
    <div flex="~ col gap-1">
      <h3 class="m-0 text-sm font-semibold">
        {{ tn('title') }}
      </h3>
      <p class="m-0 text-xs text-neutral-500 dark:text-neutral-400">
        {{ tn('description') }}
      </p>
    </div>

    <FieldInput
      v-model="taskTitle"
      :label="tn('task-title.label')"
      :placeholder="tn('task-title.placeholder')"
      @keyup.enter="submit"
    />

    <FieldInput
      v-model="taskGoal"
      :label="tn('goal.label')"
      :description="tn('goal.description')"
      :placeholder="tn('goal.placeholder')"
    />

    <FieldValues
      v-model="taskAllowedApps"
      :label="tn('apps.label')"
      :description="tn('apps.description')"
      :value-placeholder="tn('apps.placeholder')"
    />

    <Button
      variant="primary"
      icon="i-solar:target-bold-duotone"
      :label="tn('set')"
      :disabled="!taskTitle.trim() || submitting"
      @click="submit"
    />
  </section>
</template>
