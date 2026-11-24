<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { t } from "./i18n";

const props = defineProps<{
  tags: string[];
  known: string[];
  busy: boolean;
  save: (tags: string[]) => Promise<boolean | undefined>;
}>();
const emit = defineEmits<{ close: [] }>();
const input = ref<HTMLInputElement>();
const draft = ref("");
const name = computed(() => draft.value.trim());
const full = computed(() => props.tags.length >= 50);
const suggestions = computed(() =>
  props.known
    .filter(
      (tag) =>
        !props.tags.includes(tag) &&
        tag.toLocaleLowerCase().includes(name.value.toLocaleLowerCase()),
    )
    .slice(0, 8),
);
onMounted(() => input.value?.focus());

async function add(tag: string) {
  if (full.value || !tag || props.tags.includes(tag)) return;
  if (await props.save([...props.tags, tag])) {
    draft.value = "";
    input.value?.focus();
  }
}
async function remove(tag: string) {
  if (await props.save(props.tags.filter((current) => current !== tag)))
    input.value?.focus();
}
</script>

<template>
  <aside
    class="preview-tags"
    :aria-label="t('Теги')"
    @keydown.esc.stop="emit('close')"
  >
    <header>
      <strong>{{ t("Теги") }}</strong>
      <button
        class="icon-button small"
        :aria-label="t('Закрыть')"
        @click="emit('close')"
      >
        <i class="ri-close-line" aria-hidden="true"></i>
      </button>
    </header>
    <div v-if="tags.length" class="preview-tag-list">
      <span v-for="tag in tags" :key="tag" class="preview-tag">
        {{ tag }}
        <button
          class="icon-button small"
          :aria-label="t('Удалить тег «{0}»', { 0: tag })"
          :disabled="busy"
          @click="remove(tag)"
        >
          <i class="ri-close-line" aria-hidden="true"></i>
        </button>
      </span>
    </div>
    <p v-else>{{ t("Теги ещё не добавлены") }}</p>
    <form @submit.prevent="add(name)">
      <input
        ref="input"
        v-model="draft"
        :aria-label="t('Добавить тег')"
        :placeholder="t('Добавить тег')"
        :disabled="busy || full"
        maxlength="255"
      />
      <button
        class="icon-button"
        :aria-label="t('Добавить тег')"
        :disabled="busy || full || !name || tags.includes(name)"
      >
        <i class="ri-add-line" aria-hidden="true"></i>
      </button>
    </form>
    <p v-if="full">{{ t("Не более 50 тегов.") }}</p>
    <div v-else-if="suggestions.length" class="preview-tag-list">
      <button
        v-for="suggestion in suggestions"
        :key="suggestion"
        class="preview-tag preview-tag-suggestion"
        :disabled="busy"
        @click="add(suggestion)"
      >
        <i class="ri-add-line" aria-hidden="true"></i> {{ suggestion }}
      </button>
    </div>
  </aside>
</template>
