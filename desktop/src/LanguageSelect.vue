<script setup lang="ts">
import { language, changeLanguage, t } from "./i18n";
defineProps<{ disabled?: boolean }>();
</script>
<template>
  <label class="language-select"
    ><i aria-hidden="true" class="ri-translate-2"></i
    ><span>{{ t("Язык") }}</span
    ><select
      :value="language"
      :aria-label="t('Язык')"
      :disabled="disabled"
      @change="changeLanguage(($event.target as HTMLSelectElement).value)"
    >
      <option value="en">English</option>
      <option value="ru">Русский</option>
      <option value="es">Español</option>
    </select></label
  >
</template>
