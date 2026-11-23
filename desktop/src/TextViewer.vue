<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import MarkdownPreview from "./MarkdownPreview.vue";
import { t } from "./i18n";
import { decodeText, textMatches } from "./document-text";
const props = defineProps<{ data: Uint8Array; markdown: boolean }>();
const emit = defineEmits<{ edit: [encoding: string] }>();
const encoding = ref("auto"),
  source = ref(false),
  wrap = ref(true),
  fontSize = ref(14),
  query = ref(""),
  current = ref(0);
const content = ref<HTMLElement>(),
  search = ref<HTMLInputElement>();
const text = computed(() => decodeText(props.data, encoding.value));
const formatted = computed(() => props.markdown && !source.value);
const parts = computed(() => textMatches(text.value, query.value));
const count = computed(() => parts.value.filter((p) => p.match >= 0).length);
onMounted(() => content.value?.focus({ preventScroll: true }));
watch([query, text], () => {
  current.value = 0;
  void focusMatch();
});
async function focusMatch() {
  await nextTick();
  content.value
    ?.querySelector(`[data-match="${current.value}"]`)
    ?.scrollIntoView({ block: "center" });
}
function moveMatch(delta: number) {
  if (!count.value) return;
  current.value = (current.value + delta + count.value) % count.value;
  void focusMatch();
}
function keydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    source.value = true;
    void nextTick(() => search.value?.focus());
  }
  // Arrow keys move the text caret/scrollbar, rather than switching files.
  if (
    [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ].includes(event.key)
  )
    event.stopPropagation();
}
</script>
<template>
  <section
    class="document-viewer text-viewer"
    :aria-label="markdown ? t('Просмотр Markdown') : t('Просмотр текста')"
    @keydown="keydown"
  >
    <div class="document-toolbar">
      <button class="button" @click="emit('edit', encoding)">
        <i class="ri-edit-line" aria-hidden="true"></i>{{ t("Редактировать") }}
      </button>
      <div
        v-if="markdown"
        class="document-tabs"
        role="tablist"
        :aria-label="t('Режим просмотра')"
      >
        <button role="tab" :aria-selected="!source" @click="source = false">
          {{ t("Документ") }}
        </button>
        <button role="tab" :aria-selected="source" @click="source = true">
          {{ t("Исходный текст") }}
        </button>
      </div>
      <label
        >{{ t("Кодировка")
        }}<select v-model="encoding" :aria-label="t('Кодировка')">
          <option value="auto">{{ t("Авто") }} (UTF)</option>
          <option value="utf-8">UTF-8</option>
          <option value="utf-16le">UTF-16 LE</option>
          <option value="utf-16be">UTF-16 BE</option>
          <option value="windows-1251">Windows-1251</option>
          <option value="windows-1252">Windows-1252</option>
        </select></label
      >
      <label
        >{{ t("Размер текста")
        }}<select v-model.number="fontSize" :aria-label="t('Размер текста')">
          <option
            v-for="size in [12, 14, 16, 18, 20, 24]"
            :key="size"
            :value="size"
          >
            {{ size }} px
          </option>
        </select></label
      >
      <label v-if="!formatted"
        ><input v-model="wrap" type="checkbox" />{{ t("Перенос строк") }}</label
      >
      <div v-if="!formatted" class="document-search">
        <input
          ref="search"
          v-model="query"
          type="search"
          :placeholder="t('Поиск в документе')"
          :aria-label="t('Поиск в документе')"
          @keydown.enter.prevent="moveMatch($event.shiftKey ? -1 : 1)"
        />
        <span v-if="query" role="status"
          >{{ count ? current + 1 : 0 }} / {{ count
          }}{{ count === 1000 ? "+" : "" }}</span
        >
        <button
          class="icon-button"
          :disabled="!count"
          :aria-label="t('Предыдущее совпадение')"
          @click="moveMatch(-1)"
        >
          <i class="ri-arrow-up-s-line"></i></button
        ><button
          class="icon-button"
          :disabled="!count"
          :aria-label="t('Следующее совпадение')"
          @click="moveMatch(1)"
        >
          <i class="ri-arrow-down-s-line"></i>
        </button>
      </div>
    </div>
    <div
      ref="content"
      class="document-scroll text-content"
      :style="{ fontSize: `${fontSize}px` }"
      tabindex="0"
    >
      <MarkdownPreview v-if="formatted" :text="text" />
      <pre
        v-else
        class="plain-text"
        :class="{ wrap }"
      ><template v-for="(part, i) in parts" :key="i"><mark v-if="part.match >= 0" :data-match="part.match" :class="{current: part.match === current}">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></pre>
      <p v-if="!text" class="document-empty">{{ t("Файл пуст.") }}</p>
    </div>
  </section>
</template>
