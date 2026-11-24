<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import FileThumb from "./FileThumb.vue";
import { localeCode, t } from "./i18n";
import { localDay, monthIndex } from "./timeline-dates";
import type { DriveFile } from "./types";

const props = defineProps<{
  files: DriveFile[];
  scrollRoot?: HTMLElement;
  selected: Set<string>;
  selection: Set<string>;
  draggedIds: string[];
  previewSize: number;
  busy: boolean;
}>();
const emit = defineEmits<{
  day: [number];
  select: [DriveFile, MouseEvent | KeyboardEvent, boolean?];
  open: [DriveFile];
  context: [MouseEvent, DriveFile];
  drag: [DragEvent, DriveFile];
}>();
const formatter = computed(
  () => new Intl.DateTimeFormat(localeCode(), { dateStyle: "long" }),
);
const days = computed(() => {
  const groups = new Map<number, DriveFile[]>();
  for (const file of props.files) {
    const time = localDay(new Date(file.created_at)).getTime();
    const day = Number.isFinite(time) ? time : -1;
    const group = groups.get(day);
    if (group) group.push(file);
    else groups.set(day, [file]);
  }
  return Array.from(groups, ([day, items]) => ({ day, items }));
});
const elements = new Map<number, HTMLElement>();
let frame = 0;
let announced: number | undefined;

function remember(day: number, element: unknown) {
  if (element instanceof HTMLElement) elements.set(day, element);
  else elements.delete(day);
}
function visibleDay() {
  frame = 0;
  const root = props.scrollRoot;
  if (!root || !days.value.length) return;
  const target = root.getBoundingClientRect().top + 32;
  let low = 0;
  let high = days.value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const top = elements
      .get(days.value[middle]!.day)
      ?.getBoundingClientRect().top;
    if (top !== undefined && top <= target) low = middle + 1;
    else high = middle;
  }
  const day = days.value[Math.max(0, low - 1)]?.day;
  if (day !== undefined && day !== -1 && day !== announced) {
    announced = day;
    emit("day", day);
  }
}
function scheduleDay() {
  if (!frame) frame = requestAnimationFrame(visibleDay);
}
watch(
  () => props.scrollRoot,
  (root, _, cleanup) => {
    root?.addEventListener("scroll", scheduleDay, { passive: true });
    const resize = new ResizeObserver(scheduleDay);
    if (root) resize.observe(root);
    cleanup(() => {
      root?.removeEventListener("scroll", scheduleDay);
      resize.disconnect();
    });
    scheduleDay();
  },
  { immediate: true, flush: "post" },
);
watch(days, scheduleDay, { flush: "post" });
onBeforeUnmount(() => cancelAnimationFrame(frame));

function scrollToMonth(month: number, allowEdge = false) {
  const root = props.scrollRoot;
  const dated = days.value.filter(({ day }) => day !== -1);
  if (!root || !dated.length) return false;
  const newest = monthIndex(new Date(dated[0]!.day));
  const oldest = monthIndex(new Date(dated.at(-1)!.day));
  if (!allowEdge && (month >= newest || month <= oldest)) return false;
  const target = dated.find(({ day }) => monthIndex(new Date(day)) <= month);
  const element = target && elements.get(target.day);
  if (!element) return false;
  root.scrollTo({
    top:
      root.scrollTop +
      element.getBoundingClientRect().top -
      root.getBoundingClientRect().top -
      5,
  });
  scheduleDay();
  return true;
}
defineExpose({ scrollToMonth });
</script>

<template>
  <div class="media-feed" :style="{ '--preview-size': previewSize + 'px' }">
    <section
      v-for="group in days"
      :key="group.day"
      :ref="(element) => remember(group.day, element)"
      class="media-day"
    >
      <h2 class="media-day-heading">
        {{ group.day === -1 ? t("Без даты") : formatter.format(group.day) }}
      </h2>
      <div class="media-day-grid">
        <article
          v-for="file in group.items"
          :key="file.id"
          class="file-card media-card"
          :data-file-id="file.id"
          :class="{
            selected: selected.has(file.id),
            'drag-source': draggedIds.includes(file.id),
          }"
          :aria-label="file.name"
          :title="file.name"
          :draggable="!busy"
          tabindex="0"
          @click="emit('select', file, $event)"
          @dblclick="emit('open', file)"
          @keydown.enter="emit('open', file)"
          @keydown.space.self.prevent="emit('select', file, $event, true)"
          @contextmenu="emit('context', $event, file)"
          @dragstart.stop="emit('drag', $event, file)"
        >
          <FileThumb :file="file" natural />
          <button
            class="file-checkbox"
            :class="{ checked: selected.has(file.id) }"
            :aria-label="t('Выбрать {0}', { '0': file.name })"
            :aria-pressed="selection.has(file.id)"
            @click.stop="emit('select', file, $event, true)"
          >
            <i
              aria-hidden="true"
              :class="
                selected.has(file.id)
                  ? 'ri-checkbox-fill'
                  : 'ri-checkbox-blank-line'
              "
            ></i>
          </button>
        </article>
      </div>
    </section>
  </div>
</template>
