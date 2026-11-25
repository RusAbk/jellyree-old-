<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { localeCode, t } from "./i18n";
import { monthIndex, monthStart } from "./timeline-dates";

const props = defineProps<{
  months: number[];
  activeDay?: number;
  loading: boolean;
  failed: boolean;
}>();
const emit = defineEmits<{ jump: [number]; retry: [] }>();
const track = ref<HTMLElement>();
const height = ref(0);
const zoom = ref(0);
const center = ref<number>();
const scrub = ref<number>();
const pointer = ref<number>();
const keyboardTarget = ref<number>();
const shortMonth = computed(
  () => new Intl.DateTimeFormat(localeCode(), { month: "short" }),
);
const fullMonth = computed(
  () =>
    new Intl.DateTimeFormat(localeCode(), { month: "long", year: "numeric" }),
);
const lastIndex = computed(() => Math.max(0, props.months.length - 1));
const active = computed(() => {
  if (props.activeDay === undefined) return 0;
  const value = monthIndex(new Date(props.activeDay));
  const index = props.months.findIndex((month) => month <= value);
  return index === -1 ? lastIndex.value : index;
});
const spans = computed(() => {
  const full = Math.max(1, props.months.length);
  return [full, 120, 36, 12, 4].filter(
    (size, index) => index === 0 || size < full,
  );
});
const visible = computed(() => {
  const span = spans.value[zoom.value] ?? spans.value.at(-1)!;
  const start = Math.max(
    0,
    Math.min(
      lastIndex.value - span + 1,
      Math.round((center.value ?? active.value) - span / 2),
    ),
  );
  return { start, end: Math.min(lastIndex.value, start + span - 1) };
});
const slot = computed(() =>
  Math.max(
    visible.value.start,
    Math.min(visible.value.end, scrub.value ?? active.value),
  ),
);
const month = computed(() => props.months[slot.value]);
const label = computed(() =>
  month.value === undefined
    ? ""
    : fullMonth.value.format(monthStart(month.value)),
);
const offset = (index: number) => {
  const { start, end } = visible.value;
  return end === start ? 50 : ((index - start) * 100) / (end - start);
};
const marks = computed(() => {
  const { start, end } = visible.value;
  const pxPerSlot = Math.max(1, height.value) / Math.max(1, end - start);
  const years: {
    index: number;
    text: string;
    year: boolean;
    detail?: string;
  }[] = [];
  let previous = -Infinity;
  let previousYear: number | undefined;
  for (let index = start; index <= end; index++) {
    const value = props.months[index];
    if (value === undefined) break;
    const year = Math.floor(value / 12);
    if (year === previousYear) continue;
    previousYear = year;
    if ((index - previous) * pxPerSlot < 32) continue;
    years.push({
      index,
      text: String(year),
      year: true,
      detail:
        pxPerSlot >= 36
          ? shortMonth.value.format(monthStart(value))
          : undefined,
    });
    previous = index;
  }
  const labels = [...years];
  const step = Math.max(1, Math.ceil(23 / pxPerSlot));
  for (let index = start; index <= end; index += step) {
    const value = props.months[index];
    if (value === undefined) break;
    if (years.some((year) => Math.abs(index - year.index) * pxPerSlot < 21))
      continue;
    labels.push({
      index,
      text: shortMonth.value.format(monthStart(value)),
      year: false,
    });
  }
  return labels.sort((a, b) => a.index - b.index);
});
watch([active, () => props.months], () => {
  zoom.value = Math.min(zoom.value, spans.value.length - 1);
  if (active.value < visible.value.start || active.value > visible.value.end)
    center.value = active.value;
  keyboardTarget.value = undefined;
});
watch(
  track,
  (element, _, onCleanup) => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      height.value = entry?.contentRect.height ?? 0;
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  },
  { flush: "post" },
);

function zoomBy(direction: number) {
  center.value = active.value;
  zoom.value = Math.max(
    0,
    Math.min(spans.value.length - 1, zoom.value + direction),
  );
}
function jump(index: number) {
  const target = Math.max(0, Math.min(lastIndex.value, index));
  const value = props.months[target];
  if (value === undefined) return;
  keyboardTarget.value = target;
  emit("jump", value);
}
function trackSlot(event: PointerEvent) {
  const bounds = track.value!.getBoundingClientRect();
  const ratio = Math.max(
    0,
    Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height)),
  );
  const { start, end } = visible.value;
  return Math.round(start + ratio * (end - start));
}
function start(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary) return;
  pointer.value = event.pointerId;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  scrub.value = trackSlot(event);
}
function move(event: PointerEvent) {
  if (pointer.value === event.pointerId) scrub.value = trackSlot(event);
}
function stop(event: PointerEvent) {
  if (pointer.value !== event.pointerId) return;
  if (event.type === "pointerup") jump(trackSlot(event));
  scrub.value = undefined;
  pointer.value = undefined;
}
function keydown(event: KeyboardEvent) {
  const from = keyboardTarget.value ?? active.value;
  const year = Math.floor(props.months[from]! / 12);
  const target = {
    ArrowUp: from - 1,
    ArrowRight: from - 1,
    ArrowDown: from + 1,
    ArrowLeft: from + 1,
    PageUp: () =>
      props.months.findIndex((month) => Math.floor(month / 12) <= year) - 1,
    PageDown: () => {
      const index = props.months.findIndex(
        (month) => Math.floor(month / 12) < year,
      );
      return index === -1 ? lastIndex.value : index;
    },
    Home: 0,
    End: lastIndex.value,
  }[event.key];
  if (target === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  jump(typeof target === "number" ? target : target());
}
</script>

<template>
  <aside
    class="timeline-scale"
    :aria-label="t('Временная шкала')"
    @contextmenu.stop
  >
    <header class="timeline-heading">
      <span>{{ t("Временная шкала") }}</span>
      <div v-if="months.length" class="timeline-date">
        <output class="timeline-current" :title="label">{{ label }}</output>
        <button
          v-if="failed"
          class="icon-button small"
          :title="t('Повторить')"
          :aria-label="t('Повторить')"
          @click="emit('retry')"
        >
          <i aria-hidden="true" class="ri-refresh-line"></i>
        </button>
      </div>
    </header>
    <div v-if="!months.length" class="timeline-track timeline-empty">
      <div class="timeline-axis" aria-hidden="true"></div>
      <span role="status">{{
        t(loading ? "Загрузка дат…" : failed ? "Даты недоступны" : "Нет дат")
      }}</span>
      <button
        v-if="failed && !loading"
        class="text-button"
        @click="emit('retry')"
      >
        {{ t("Повторить") }}
      </button>
    </div>
    <div v-else ref="track" class="timeline-track">
      <div class="timeline-axis" aria-hidden="true"></div>
      <div
        class="timeline-scrubber"
        role="slider"
        tabindex="0"
        aria-orientation="vertical"
        :aria-label="t('Дата на временной шкале')"
        :aria-valuemin="months.at(-1)"
        :aria-valuemax="months[0]"
        :aria-valuenow="month"
        :aria-valuetext="label"
        @pointerdown="start"
        @pointermove="move"
        @pointerup="stop"
        @pointercancel="stop"
        @lostpointercapture="stop"
        @keydown="keydown"
      >
        <span
          class="timeline-thumb"
          :style="{ top: offset(slot) + '%' }"
        ></span>
      </div>
      <button
        v-for="mark in marks"
        :key="months[mark.index]"
        class="timeline-mark"
        :class="{ 'year-mark': mark.year, 'current-mark': mark.index === slot }"
        :style="{ top: offset(mark.index) + '%' }"
        :aria-label="
          t('Перейти к {0}', {
            '0': mark.year
              ? mark.text
              : fullMonth.format(monthStart(months[mark.index]!)),
          })
        "
        @click="jump(mark.index)"
      >
        {{ mark.text }}
        <small v-if="mark.detail" aria-hidden="true">{{ mark.detail }}</small>
      </button>
    </div>
    <div v-if="months.length" class="timeline-zoom">
      <button
        class="icon-button small"
        :aria-label="t('Уменьшить масштаб шкалы')"
        :title="t('Уменьшить масштаб шкалы')"
        :disabled="zoom === 0"
        @click="zoomBy(-1)"
      >
        <i aria-hidden="true" class="ri-subtract-line"></i>
      </button>
      <button
        class="icon-button small"
        :aria-label="t('Увеличить масштаб шкалы')"
        :title="t('Увеличить масштаб шкалы')"
        :disabled="zoom >= spans.length - 1"
        @click="zoomBy(1)"
      >
        <i aria-hidden="true" class="ri-add-line"></i>
      </button>
    </div>
  </aside>
</template>
