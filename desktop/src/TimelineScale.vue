<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { localeCode, t } from "./i18n";
import { monthIndex, monthStart } from "./timeline-dates";
import type { TimelineBounds } from "./types";

const props = defineProps<{ bounds: TimelineBounds; activeDay?: number }>();
const emit = defineEmits<{ jump: [number] }>();
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
const getMonth = (value: string | null) => monthIndex(new Date(value ?? NaN));
const first = computed(() => getMonth(props.bounds.oldest));
const last = computed(() => getMonth(props.bounds.newest));
const active = computed(() =>
  props.activeDay === undefined
    ? last.value
    : monthIndex(new Date(props.activeDay)),
);
const spans = computed(() => {
  const full = Math.max(1, last.value - first.value + 1);
  return [full, 120, 36, 12].filter(
    (size, index) => index === 0 || size < full,
  );
});
const visible = computed(() => {
  const span = spans.value[zoom.value] ?? spans.value.at(-1)!;
  const low = Math.max(
    first.value,
    Math.min(
      last.value - span + 1,
      Math.round((center.value ?? active.value) - span / 2),
    ),
  );
  return { low, high: Math.min(last.value, low + span - 1) };
});
const month = computed(() =>
  Math.max(
    visible.value.low,
    Math.min(visible.value.high, scrub.value ?? active.value),
  ),
);
const label = computed(() => fullMonth.value.format(monthStart(month.value)));
const offset = (value: number) => {
  const { high, low } = visible.value;
  return high === low ? 50 : ((high - value) * 100) / (high - low);
};
const marks = computed(() => {
  const { low, high } = visible.value;
  const pxPerMonth = Math.max(1, height.value) / Math.max(1, high - low);
  const yearStep = Math.max(1, Math.ceil(32 / (pxPerMonth * 12)));
  const years: { at: number; text: string; year: boolean }[] = [];
  for (
    let year = Math.floor(high / 12);
    year >= Math.floor(low / 12);
    year -= yearStep
  ) {
    years.push({
      at: Math.min(high, year * 12 + 11),
      text: String(year),
      year: true,
    });
  }
  const step = [1, 2, 3, 6].find((months) => months * pxPerMonth >= 23);
  if (!step) return years;
  const labels = [...years];
  for (let at = high - (high % step); at >= low; at -= step) {
    if (years.some((year) => Math.abs(at - year.at) * pxPerMonth < 21))
      continue;
    labels.push({
      at,
      text: shortMonth.value.format(monthStart(at)),
      year: false,
    });
  }
  return labels.sort((a, b) => b.at - a.at);
});
watch([active, first, last], () => {
  zoom.value = Math.min(zoom.value, spans.value.length - 1);
  if (active.value < visible.value.low || active.value > visible.value.high)
    center.value = active.value;
});
watch(active, () => {
  keyboardTarget.value = undefined;
});
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (!track.value) return;
  observer = new ResizeObserver(([entry]) => {
    height.value = entry?.contentRect.height ?? 0;
  });
  observer.observe(track.value);
});
onBeforeUnmount(() => observer?.disconnect());

function zoomBy(direction: number) {
  center.value = active.value;
  zoom.value = Math.max(
    0,
    Math.min(spans.value.length - 1, zoom.value + direction),
  );
}
function jump(value: number) {
  keyboardTarget.value = Math.max(first.value, Math.min(last.value, value));
  emit("jump", keyboardTarget.value);
}
function trackMonth(event: PointerEvent) {
  const bounds = track.value!.getBoundingClientRect();
  const ratio = Math.max(
    0,
    Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height)),
  );
  return Math.round(
    visible.value.high - ratio * (visible.value.high - visible.value.low),
  );
}
function start(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary) return;
  pointer.value = event.pointerId;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  scrub.value = trackMonth(event);
}
function move(event: PointerEvent) {
  if (pointer.value === event.pointerId) scrub.value = trackMonth(event);
}
function stop(event: PointerEvent) {
  if (pointer.value !== event.pointerId) return;
  if (event.type === "pointerup") jump(trackMonth(event));
  scrub.value = undefined;
  pointer.value = undefined;
}
function keydown(event: KeyboardEvent) {
  const from = keyboardTarget.value ?? active.value;
  const target = {
    ArrowUp: from + 1,
    ArrowRight: from + 1,
    ArrowDown: from - 1,
    ArrowLeft: from - 1,
    PageUp: from + 12,
    PageDown: from - 12,
    Home: last.value,
    End: first.value,
  }[event.key];
  if (target === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  jump(target);
}
</script>

<template>
  <aside
    class="timeline-scale"
    :aria-label="t('Временная шкала')"
    @contextmenu.stop
  >
    <output class="timeline-current">{{ label }}</output>
    <div ref="track" class="timeline-track">
      <div class="timeline-axis" aria-hidden="true"></div>
      <div
        class="timeline-scrubber"
        role="slider"
        tabindex="0"
        aria-orientation="vertical"
        :aria-label="t('Дата на временной шкале')"
        :aria-valuemin="first"
        :aria-valuemax="last"
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
          :style="{ top: offset(month) + '%' }"
        ></span>
      </div>
      <button
        v-for="mark in marks"
        :key="(mark.year ? 'year-' : 'month-') + mark.at"
        class="timeline-mark"
        :class="{ 'year-mark': mark.year, 'current-mark': mark.at === month }"
        :style="{ top: offset(mark.at) + '%' }"
        :aria-label="
          t('Перейти к {0}', {
            '0': mark.year ? mark.text : fullMonth.format(monthStart(mark.at)),
          })
        "
        @click="jump(mark.at)"
      >
        {{ mark.text }}
      </button>
    </div>
    <div class="timeline-zoom">
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
