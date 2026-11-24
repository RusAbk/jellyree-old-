<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { localeCode, t } from "./i18n";

const props = defineProps<{
  tags: string[];
  known: string[];
  busy: boolean;
  commaSeparated?: boolean;
  save: (tags: string[]) => boolean | Promise<boolean | undefined>;
}>();
const input = ref<HTMLInputElement>();
const draft = ref("");
const fragments = computed(() =>
  (props.commaSeparated ? draft.value.split(",") : [draft.value]).map((part) =>
    part.trim(),
  ),
);
const query = computed(() => fragments.value.at(-1) || "");
const selected = computed(() => new Set(props.tags));
const existing = computed(() => [...new Set(props.known)]);
const suggestions = computed(() => {
  const locale = localeCode();
  const term = query.value.toLocaleLowerCase(locale);
  if (!term) return [];
  return existing.value.filter(
    (tag) =>
      !selected.value.has(tag) && tag.toLocaleLowerCase(locale).includes(term),
  );
});
const maxTags = 50;
const full = computed(() => selected.value.size >= maxTags);
const withTags = (additions: string[]) => [
  ...new Set([...props.tags, ...additions.filter(Boolean)]),
];
const pendingTags = () => withTags(fragments.value);
const completed = computed(
  () => new Set(withTags(fragments.value.slice(0, -1))),
);
const draftAddsTags = computed(
  () => pendingTags().length > selected.value.size,
);
const overLimit = computed(() => pendingTags().length > maxTags);
onMounted(() => input.value?.focus());
defineExpose({ pendingTags });

async function apply(tags: string[], clearDraft = false) {
  if (props.busy || !(await props.save(tags))) return;
  if (clearDraft) draft.value = "";
  await nextTick();
  input.value?.focus();
}
function addDraft(event?: KeyboardEvent) {
  if (event?.isComposing) return;
  event?.preventDefault();
  if (!full.value && draftAddsTags.value && !overLimit.value)
    void apply(pendingTags(), true);
}
function canChoose(tag: string) {
  const count = completed.value.size + Number(!completed.value.has(tag));
  return !props.busy && !selected.value.has(tag) && count <= maxTags;
}
function choose(tag: string) {
  if (canChoose(tag)) void apply([...new Set([...completed.value, tag])], true);
}
</script>

<template>
  <div class="tag-editor">
    <div v-if="tags.length" class="tag-editor-list">
      <span v-for="tag in tags" :key="tag" class="tag-editor-chip">
        {{ tag }}
        <button
          type="button"
          class="icon-button small"
          :aria-label="t('Удалить тег «{0}»', { 0: tag })"
          :disabled="busy"
          @click="apply(tags.filter((current) => current !== tag))"
        >
          <i class="ri-close-line" aria-hidden="true"></i>
        </button>
      </span>
    </div>
    <div class="tag-editor-input">
      <input
        ref="input"
        v-model="draft"
        :aria-label="t('Добавить тег')"
        :placeholder="t('Добавить тег')"
        :readonly="busy"
        :disabled="full"
        :maxlength="commaSeparated ? 3000 : 255"
        @keydown.enter="addDraft($event)"
      />
      <button
        type="button"
        class="icon-button"
        :aria-label="t('Добавить тег')"
        :disabled="busy || full || !draftAddsTags || overLimit"
        @click="addDraft()"
      >
        <i class="ri-add-line" aria-hidden="true"></i>
      </button>
    </div>
    <p v-if="full || overLimit" class="tag-editor-muted">
      {{ t("Не более 50 тегов.") }}
    </p>
    <div
      v-if="!full && suggestions.length"
      class="tag-editor-group tag-editor-suggestions"
      role="group"
      :aria-label="t('Подсказки')"
    >
      <strong>{{ t("Подсказки") }}</strong>
      <div class="tag-editor-list tag-editor-choices">
        <button
          v-for="tag in suggestions"
          :key="tag"
          type="button"
          class="tag-editor-chip tag-editor-choice"
          :disabled="!canChoose(tag)"
          @click="choose(tag)"
        >
          {{ tag }}
        </button>
      </div>
    </div>
    <div
      class="tag-editor-group"
      role="group"
      :aria-label="t('Существующие теги')"
    >
      <strong>{{ t("Существующие теги") }}</strong>
      <div v-if="existing.length" class="tag-editor-list tag-editor-choices">
        <button
          v-for="tag in existing"
          :key="tag"
          type="button"
          class="tag-editor-chip tag-editor-choice"
          :class="{ 'tag-editor-selected': selected.has(tag) }"
          :disabled="!canChoose(tag)"
          @click="choose(tag)"
        >
          <i
            v-if="selected.has(tag)"
            class="ri-check-line"
            aria-hidden="true"
          ></i>
          {{ tag }}
        </button>
      </div>
      <p v-else class="tag-editor-muted">{{ t("Теги ещё не добавлены") }}</p>
    </div>
  </div>
</template>
