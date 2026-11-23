<script setup lang="ts">
import { t } from "./i18n";
import { ref, onMounted, onBeforeUnmount, nextTick } from "vue";
import { api } from "./api";
import { bytes, date } from "./format";
import type { UploadConflict, UploadConflictAnswer } from "./types";
const props = defineProps<{ conflict: UploadConflict }>();
const dialog = ref<HTMLElement>();
let previousFocus: HTMLElement | null = null;
onMounted(async () => {
  previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  await nextTick();
  dialog.value?.focus({ preventScroll: true });
});
onBeforeUnmount(() => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});
function tab(event: KeyboardEvent) {
  const items = Array.from(
    dialog.value?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled)",
    ) || [],
  );
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = event.shiftKey
    ? index <= 0
      ? items.length - 1
      : index - 1
    : (index + 1) % items.length;
  items[next]?.focus();
}
const emit = defineEmits<{ resolved: [id: string]; close: [] }>();
const name = ref(props.conflict.suggestedName),
  applyToAll = ref(false),
  busy = ref(false),
  error = ref("");
async function answer(action: UploadConflictAnswer["action"]) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api.answerUploadConflict({
      id: props.conflict.id,
      action,
      applyToAll: applyToAll.value,
      name: action === "rename" ? name.value : undefined,
    });
    emit("resolved", props.conflict.id);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div
    class="overlay upload-conflict-overlay"
    @keydown.esc.stop.prevent="!busy && emit('close')"
    @keydown.tab.stop.prevent="tab"
  >
    <section
      class="dialog conflict-dialog"
      ref="dialog"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-title"
    >
      <header class="dialog-header">
        <h2 id="conflict-title">
          {{ t("Файл с таким именем уже существует") }}
        </h2>
        <button
          class="icon-button"
          :disabled="busy"
          :aria-label="t('Вернуться к файлам')"
          @click="emit('close')"
        >
          <i aria-hidden="true" class="ri-close-line"></i>
        </button>
      </header>
      <p class="conflict-filename">{{ conflict.name }}</p>
      <p class="muted">
        {{ t("Папка: {0}", { "0": conflict.targetPath || t("Мой диск") }) }}
      </p>
      <div class="conflict-details">
        <div>
          <strong>{{ t("Существующий файл") }}</strong><span
            >{{ bytes(conflict.existing.sizeBytes) }} ·
            {{ date(conflict.existing.updatedAt) }}</span
          >
        </div>
        <div>
          <strong>{{ t("Загружаемый файл") }}</strong><span>{{
            bytes(conflict.incomingBytes)
          }}</span>
        </div>
      </div>
      <p v-if="conflict.existingCount > 1" class="muted">
        {{
          t(
            "Найдено файлов с этим именем: {0}. При замене изменится самый новый файл.",
            { "0": conflict.existingCount },
          )
        }}
      </p>
      <label
        >{{ t("Новое имя для переименования")
        }}<input
          v-model="name"
          :disabled="busy"
          maxlength="255"
          @keydown.enter.prevent="answer('rename')"
      /></label>
      <label class="conflict-apply"
        ><input v-model="applyToAll" type="checkbox" :disabled="busy" />{{
          t("Применить ко всем {0} совпадениям", { "0": conflict.remaining })
        }}</label
      >
      <p v-if="applyToAll" class="muted">
        {{
          t(
            "При переименовании остальных файлов свободные имена будут подобраны автоматически.",
          )
        }}
      </p>
      <p class="muted">
        {{
          t(
            "Замена сохранит избранное и теги существующего файла. Коррекция фото будет сброшена.",
          )
        }}
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <footer class="dialog-footer conflict-actions">
        <button class="button" :disabled="busy" @click="answer('skip')">
          {{ t("Проигнорировать") }}</button><button
          class="button"
          :disabled="busy || !name.trim()"
          @click="answer('rename')"
        >
          {{ t("Переименовать") }}</button
        ><button
          class="button primary"
          :disabled="busy"
          @click="answer('replace')"
        >
          {{ t("Заменить") }}
        </button>
      </footer>
      <button
        class="text-button conflict-cancel"
        :disabled="busy"
        @click="answer('cancel')"
      >
        {{ t("Отменить оставшиеся загрузки") }}
      </button>
    </section>
  </div>
</template>
