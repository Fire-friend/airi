<script setup lang="ts">
import { RouterLink } from 'vue-router'

// Accounts, sign-in, and the paid "Flux" balance were removed. The header now
// only exposes a link to settings, where the user configures model providers.
</script>

<template>
  <div flex items-center gap-2>
    <RouterLink
      border="2 solid neutral-100/60 dark:neutral-800/30"
      bg="neutral-50/70 dark:neutral-800/70"
      w-fit flex items-center justify-center rounded-xl p-2 backdrop-blur-md
      title="Settings"
      to="/settings"
    >
      <div i-solar:settings-minimalistic-bold-duotone size-5 text="neutral-500 dark:neutral-400" />
    </RouterLink>
  </div>
</template>
