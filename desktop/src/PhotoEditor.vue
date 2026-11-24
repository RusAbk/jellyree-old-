<script setup lang="ts">
import {
  ref,
  shallowRef,
  reactive,
  computed,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
} from "vue";
import { t } from "./i18n";
import { api } from "./api";
import type { Adjustments, DriveFile } from "./types";
import {
  normalizeImageAdjustments,
  defaultImageAdjustments,
  adjustmentRanges,
  imageBounds,
  cropRectangle,
  type ImageAdjustments,
} from "../electron/image-adjustments.mjs";
import { renderImage, cancelImageWork } from "./image-service";
import { stretchMapping, type Histogram } from "./image-pixels.mjs";
import {
  clamp,
  dragCrop,
  dragStretch,
  type Band,
  type CropMode,
  type Point,
  type Rectangle,
  type StretchMode,
} from "./image-geometry";
import {
  editGroups,
  imagePresets,
  copiedImageEdits,
  resetColorAndTone,
  smartAuto,
  fitCrop,
} from "./image-editor-model";
const props = defineProps<{
  file: DriveFile;
  save: (adjustments: Adjustments) => Promise<boolean>;
}>();
const emit = defineEmits<{ close: [] }>();
const initial = normalizeImageAdjustments(props.file.adjustments),
  draft = reactive<ImageAdjustments>(normalizeImageAdjustments(initial));
const history = ref<ImageAdjustments[]>([normalizeImageAdjustments(initial)]),
  historyIndex = ref(0);
const section = ref("quick"),
  tool = ref("crop"),
  ratio = ref("free"),
  previewScale = ref(100);
const comparing = ref(false),
  clipping = ref(false),
  busy = ref(false),
  rendering = ref(false),
  error = ref(""),
  message = ref(""),
  discard = ref(false);
const brushSize = ref(20),
  brushStrength = ref(50),
  cursor = ref<{ x: number; y: number }>();
const exportFormat = ref<"png" | "jpeg" | "webp">("jpeg"),
  exportSize = ref(0),
  quality = ref(92);
const canvas = ref<HTMLCanvasElement>(),
  root = ref<HTMLElement>(),
  viewport = ref<HTMLElement>(),
  frame = ref<HTMLElement>();
const sourceSize = ref({ width: 0, height: 0 }),
  displaySize = ref({ width: 1, height: 1 }),
  viewportSize = ref({ width: 800, height: 600 });
const histogram = ref<Histogram>({
  bins: new Array(64).fill(0),
  shadows: 0,
  highlights: 0,
});
const owner = crypto.randomUUID(),
  exportOwner = crypto.randomUUID();
let observer: ResizeObserver | undefined,
  timer: ReturnType<typeof setTimeout> | undefined,
  request = 0,
  disposed = false;
let previousFocus: HTMLElement | null = null;
let gestureFrame = 0;
type Drag = {
  id: number;
  mode: CropMode | "liquify" | StretchMode;
  origin: Point;
  start: Point;
  pointer: Point;
  original: ImageAdjustments;
  crop: Rectangle;
  aspect?: number;
  stretch?: { source: number; map: ReturnType<typeof stretchMapping> };
  last: Point;
  moved: boolean;
};
let drag: Drag | undefined;
const dirty = computed(
  () =>
    JSON.stringify(normalizeImageAdjustments(draft)) !==
    JSON.stringify(initial),
);
const geometry = computed(
  () => section.value === "geometry" && !comparing.value,
);
const renderedGeometry = shallowRef<ImageAdjustments>();
const geometryReady = computed(() => {
  const rendered = renderedGeometry.value;
  return (
    geometry.value &&
    rendered &&
    rendered.rotate === draft.rotate &&
    rendered.flipX === draft.flipX &&
    rendered.flipY === draft.flipY
  );
});
const stretchDraft = shallowRef<Band>();
const stretchGuide = computed(() => {
  const shown = renderedGeometry.value;
  if (!shown || shown.stretchAxis !== draft.stretchAxis) return;
  const map = stretchMapping(
    shown.stretchStart,
    shown.stretchEnd,
    shown.stretchAmount,
  );
  const start = map.toDisplay(stretchDraft.value?.start ?? shown.stretchStart);
  const end = map.toDisplay(stretchDraft.value?.end ?? shown.stretchEnd);
  return shown.stretchAxis === "x"
    ? {
        left: `${start * 100}%`,
        width: `${(end - start) * 100}%`,
        top: 0,
        height: "100%",
      }
    : {
        top: `${start * 100}%`,
        height: `${(end - start) * 100}%`,
        left: 0,
        width: "100%",
      };
});
const fit = computed(() =>
  Math.min(
    1,
    (viewportSize.value.width - 60) / displaySize.value.width,
    (viewportSize.value.height - 60) / displaySize.value.height,
  ),
);
const frameStyle = computed(() => ({
  width: `${Math.max(1, (displaySize.value.width * fit.value * previewScale.value) / 100)}px`,
  height: `${Math.max(1, (displaySize.value.height * fit.value * previewScale.value) / 100)}px`,
}));
const crop = computed(() => cropRectangle(draft));
const cropStyle = computed(() => {
  const { x, y, width, height } = crop.value;
  return {
    "--crop-left": `${x * 100}%`,
    "--crop-top": `${y * 100}%`,
    "--crop-width": `${width * 100}%`,
    "--crop-height": `${height * 100}%`,
    "--crop-right": `${(x + width) * 100}%`,
    "--crop-bottom": `${(y + height) * 100}%`,
  };
});
const resultSize = computed(() =>
  imageBounds(sourceSize.value.width, sourceSize.value.height, draft),
);
const controls = computed(
  () => editGroups.find((group) => group.id === section.value)?.controls || [],
);
const brushStyle = computed(() => {
  if (!cursor.value) return {};
  const size =
    (brushSize.value / 100) *
    Math.min(displaySize.value.width, displaySize.value.height) *
    fit.value *
    (previewScale.value / 100) *
    2;
  return {
    left: `${cursor.value.x * 100}%`,
    top: `${cursor.value.y * 100}%`,
    width: `${size}px`,
    height: `${size}px`,
  };
});
function snapshot() {
  return normalizeImageAdjustments(draft);
}
function record() {
  const value = snapshot();
  if (
    JSON.stringify(value) === JSON.stringify(history.value[historyIndex.value])
  )
    return;
  history.value = [
    ...history.value.slice(0, historyIndex.value + 1),
    value,
  ].slice(-80);
  historyIndex.value = history.value.length - 1;
}
function mutate(fn: () => void) {
  fn();
  record();
  message.value = "";
}
function undo() {
  record();
  if (historyIndex.value > 0)
    Object.assign(
      draft,
      normalizeImageAdjustments(history.value[--historyIndex.value]),
    );
}
function redo() {
  if (historyIndex.value < history.value.length - 1)
    Object.assign(
      draft,
      normalizeImageAdjustments(history.value[++historyIndex.value]),
    );
}
function resetGroup() {
  mutate(() => {
    if (section.value === "geometry")
      for (const key of [
        "rotate",
        "cropZoom",
        "cropX",
        "cropY",
        "cropWidth",
        "cropHeight",
        "flipX",
        "flipY",
        "strokes",
        "stretchAxis",
        "stretchAmount",
        "stretchStart",
        "stretchEnd",
      ] as const)
        Object.assign(draft, { [key]: normalizeImageAdjustments()[key] });
    else
      for (const [key] of controls.value)
        draft[key] = defaultImageAdjustments[key];
  });
}
function preset(values: Partial<ImageAdjustments>) {
  mutate(() => Object.assign(draft, resetColorAndTone(snapshot(), values)));
}
function cropRatio() {
  if (ratio.value === "free" || !sourceSize.value.width) return;
  const bounds = imageBounds(
    sourceSize.value.width,
    sourceSize.value.height,
    draft,
    true,
  );
  const value =
    ratio.value === "original"
      ? bounds.width / bounds.height
      : Number(ratio.value);
  Object.assign(draft, fitCrop(snapshot(), value, bounds.width, bounds.height));
}
function activeAspect() {
  if (ratio.value === "free") return;
  return ratio.value === "original"
    ? resultSize.value.fullWidth / resultSize.value.fullHeight
    : Number(ratio.value);
}
function setRotation(delta: number) {
  mutate(() => {
    draft.rotate = ((draft.rotate + delta + 540) % 360) - 180;
    cropRatio();
  });
}
const renderOptions = computed(() => {
  const adjustments = comparing.value ? defaultImageAdjustments : snapshot();
  return {
    adjustments: geometry.value
      ? {
          ...adjustments,
          cropX: 0,
          cropY: 0,
          cropWidth: 1,
          cropHeight: 1,
          cropZoom: 0,
        }
      : adjustments,
    maxSize: 1200,
    uncropped: geometry.value,
    clipping: clipping.value && !comparing.value,
  };
});
async function render() {
  if (!canvas.value || disposed) return;
  const id = ++request;
  const options = renderOptions.value;
  rendering.value = true;
  try {
    const result = await renderImage(owner, props.file, options, true);
    if (disposed || id !== request || !canvas.value) {
      result.bitmap?.close();
      return;
    }
    const image = result.bitmap!;
    canvas.value.width = image.width;
    canvas.value.height = image.height;
    canvas.value.getContext("2d")!.drawImage(image, 0, 0);
    displaySize.value = { width: image.width, height: image.height };
    renderedGeometry.value = options.uncropped
      ? options.adjustments
      : undefined;
    sourceSize.value = {
      width: result.sourceWidth,
      height: result.sourceHeight,
    };
    histogram.value = result.histogram;
    image.close();
    error.value = "";
  } catch (e) {
    if ((e as Error).name !== "AbortError" && id === request)
      error.value = (e as Error).message;
  } finally {
    if (id === request) rendering.value = false;
  }
}
watch(
  () => JSON.stringify(renderOptions.value),
  () => {
    clearTimeout(timer);
    timer = setTimeout(() => void render(), 45);
  },
);
const clientPoint = (event: PointerEvent) => ({
  x: event.clientX,
  y: event.clientY,
});
const imagePoint = (point: Point, box: DOMRect) => ({
  x: (point.x - box.left) / box.width,
  y: (point.y - box.top) / box.height,
});
const inside = (point: Point) => ({ x: clamp(point.x), y: clamp(point.y) });
function pointerDown(event: PointerEvent) {
  if (
    drag ||
    !geometryReady.value ||
    busy.value ||
    event.button !== 0 ||
    !sourceSize.value.width
  )
    return;
  const target = event.target as HTMLElement;
  const origin = clientPoint(event);
  const p = imagePoint(origin, frame.value!.getBoundingClientRect());
  const original = snapshot();
  let mode: Drag["mode"] = "liquify";
  let stretch: Drag["stretch"];
  if (tool.value === "stretch") {
    const shown = renderedGeometry.value!;
    if (
      shown.stretchAxis !== draft.stretchAxis ||
      shown.stretchStart !== draft.stretchStart ||
      shown.stretchEnd !== draft.stretchEnd ||
      shown.stretchAmount !== draft.stretchAmount
    )
      return;
    const map = stretchMapping(
      shown.stretchStart,
      shown.stretchEnd,
      shown.stretchAmount,
    );
    stretch = { map, source: map.toSource(p[shown.stretchAxis]) };
    mode = (target.closest<HTMLElement>("[data-stretch]")?.dataset.stretch ??
      "stretch-new") as StretchMode;
  } else if (tool.value === "crop") {
    mode = (target.closest<HTMLElement>("[data-handle]")?.dataset.handle ??
      (target.closest(".crop-box") ? "move" : "new")) as CropMode;
  }
  event.preventDefault();
  frame.value!.focus({ preventScroll: true });
  frame.value!.setPointerCapture(event.pointerId);
  drag = {
    id: event.pointerId,
    mode,
    origin,
    pointer: origin,
    start: mode === "new" ? inside(p) : p,
    original,
    crop: crop.value,
    aspect: activeAspect(),
    stretch,
    last: inside(p),
    moved: false,
  };
}
function applyDrag(current: Drag, final = false) {
  const box = frame.value!.getBoundingClientRect();
  const p = imagePoint(current.pointer, box);
  cursor.value = inside(p);
  if (current.stretch) {
    const a = current.original;
    stretchDraft.value = dragStretch(
      current.mode as StretchMode,
      { start: a.stretchStart, end: a.stretchEnd },
      current.stretch.source,
      current.stretch.map.toSource(p[a.stretchAxis]),
    );
  } else if (current.mode === "liquify") {
    const point = inside(p),
      { x, y } = current.last;
    const dx = point.x - x,
      dy = point.y - y;
    const distance = Math.hypot(dx * box.width, dy * box.height);
    const radius = brushSize.value / 100;
    const radiusPx = radius * Math.min(box.width, box.height);
    if (distance < (final ? 0.25 : Math.max(2, radiusPx * 0.12))) return;
    const steps = Math.min(
      128 - draft.strokes.length,
      Math.ceil(distance / (radiusPx * 0.4)),
    );
    if (!steps) return;
    for (let i = 0; i < steps; i++) {
      draft.strokes.push({
        x: clamp(x + (dx * i) / steps),
        y: clamp(y + (dy * i) / steps),
        dx: dx / steps,
        dy: dy / steps,
        radius,
        strength: brushStrength.value / 100,
      });
    }
    current.last = point;
  } else {
    const next = dragCrop(
      current.mode as CropMode,
      current.crop,
      current.start,
      p,
      {
        width: resultSize.value.fullWidth,
        height: resultSize.value.fullHeight,
      },
      current.aspect,
    );
    Object.assign(draft, {
      cropX: next.x,
      cropY: next.y,
      cropWidth: next.width,
      cropHeight: next.height,
      cropZoom: 0,
    });
  }
}
function edgeScroll() {
  gestureFrame = 0;
  if (!drag || !viewport.value || drag.mode === "liquify") return;
  const pane = viewport.value,
    bounds = pane.getBoundingClientRect();
  const speed = (p: number, start: number, end: number) =>
    clamp(
      (p < start + 26 ? p - start - 26 : Math.max(0, p - end + 26)) / 3,
      -20,
      20,
    );
  const left = pane.scrollLeft,
    top = pane.scrollTop;
  pane.scrollBy(
    speed(drag.pointer.x, bounds.left, bounds.right),
    speed(drag.pointer.y, bounds.top, bounds.bottom),
  );
  if (pane.scrollLeft !== left || pane.scrollTop !== top) {
    applyDrag(drag);
    gestureFrame = requestAnimationFrame(edgeScroll);
  }
}
function pointerMove(event: PointerEvent) {
  if (!frame.value) return;
  const pointer = clientPoint(event);
  if (!drag || drag.id !== event.pointerId) {
    cursor.value = inside(
      imagePoint(pointer, frame.value.getBoundingClientRect()),
    );
    return;
  }
  drag.pointer = pointer;
  drag.moved ||=
    Math.hypot(pointer.x - drag.origin.x, pointer.y - drag.origin.y) >= 3;
  if (!drag.moved) return;
  applyDrag(drag);
  if (!gestureFrame && drag.mode !== "liquify")
    gestureFrame = requestAnimationFrame(edgeScroll);
}
function finishDrag(canceled: boolean) {
  if (!drag) return false;
  const current = drag;
  drag = undefined;
  cancelAnimationFrame(gestureFrame);
  gestureFrame = 0;
  if (frame.value?.hasPointerCapture(current.id))
    frame.value.releasePointerCapture(current.id);
  if (canceled && current.moved) Object.assign(draft, current.original);
  if (!canceled && current.moved) {
    if (stretchDraft.value) {
      draft.stretchStart = stretchDraft.value.start;
      draft.stretchEnd = stretchDraft.value.end;
    }
    record();
  }
  stretchDraft.value = undefined;
  return true;
}
function pointerUp(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return;
  drag.pointer = clientPoint(event);
  drag.moved ||=
    Math.hypot(
      drag.pointer.x - drag.origin.x,
      drag.pointer.y - drag.origin.y,
    ) >= 3;
  if (drag.moved) applyDrag(drag, true);
  finishDrag(false);
}
function pointerCancel(event: PointerEvent) {
  if (drag?.id === event.pointerId) finishDrag(true);
}
function close() {
  if (busy.value) return;
  if (dirty.value) discard.value = true;
  else emit("close");
}
async function save() {
  if (busy.value || !sourceSize.value.width) return;
  busy.value = true;
  error.value = "";
  try {
    if (await props.save(snapshot())) emit("close");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function exportImage() {
  if (busy.value || !sourceSize.value.width) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const result = await renderImage(
      exportOwner,
      props.file,
      {
        adjustments: snapshot(),
        maxSize: exportSize.value,
        export: exportFormat.value,
        quality: quality.value,
      },
      true,
    );
    const saved = await api.exportImage(
      props.file.id,
      new Uint8Array(result.bytes!),
      exportFormat.value,
    );
    if (saved.saved)
      message.value = t("Обработанное изображение сохранено на компьютере.");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Tab") {
    const scope = discard.value
      ? root.value?.querySelector(".editor-discard")
      : root.value;
    const controls = [
      ...(scope?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex='0']",
      ) || []),
    ].filter((element) => element.getClientRects().length);
    const first = controls[0],
      last = controls[controls.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        document.activeElement === root.value)
    ) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  if (event.key === "Escape") {
    event.preventDefault();
    if (finishDrag(true)) return;
    if (discard.value) discard.value = false;
    else close();
  }
  if (busy.value) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redo();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void save();
  }
}
watch(discard, async (value) => {
  if (value) {
    await nextTick();
    root.value
      ?.querySelector<HTMLButtonElement>(".editor-discard button")
      ?.focus();
  }
});
onMounted(async () => {
  previousFocus = document.activeElement as HTMLElement;
  await nextTick();
  root.value?.focus({ preventScroll: true });
  observer = new ResizeObserver(([entry]) => {
    if (entry)
      viewportSize.value = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
  });
  if (viewport.value) observer.observe(viewport.value);
  void render();
});
onBeforeUnmount(() => {
  disposed = true;
  request++;
  clearTimeout(timer);
  finishDrag(true);
  cancelImageWork(owner);
  cancelImageWork(exportOwner);
  observer?.disconnect();
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});
</script>
<template>
  <div
    ref="root"
    class="photo-editor"
    role="dialog"
    aria-modal="true"
    :aria-label="t('Редактор изображения')"
    tabindex="-1"
    @keydown.stop="keydown"
  >
    <header class="photo-editor-header">
      <div>
        <strong>{{ t("Редактор изображения") }}</strong><small>{{
          file.name
        }}</small>
      </div>
      <div class="photo-editor-actions">
        <button
          class="button"
          :disabled="busy || historyIndex === 0"
          :aria-label="t('Отменить шаг')"
          @click="undo"
        >
          <i aria-hidden="true" class="ri-arrow-go-back-line"></i>
        </button>
        <button
          class="button"
          :disabled="busy || historyIndex === history.length - 1"
          :aria-label="t('Повторить шаг')"
          @click="redo"
        >
          <i aria-hidden="true" class="ri-arrow-go-forward-line"></i>
        </button>
        <span class="editor-step">{{
          t("Шаг {0} из {1}", { "0": historyIndex + 1, "1": history.length })
        }}</span>
        <button
          class="button compare-button"
          :aria-pressed="comparing"
          :disabled="busy"
          @pointerdown.prevent="comparing = true"
          @pointerup="comparing = false"
          @pointerleave="comparing = false"
          @pointercancel="comparing = false"
          @blur="comparing = false"
          @keydown.space.prevent="comparing = true"
          @keyup.space.prevent="comparing = false"
          @keydown.enter.prevent="comparing = true"
          @keyup.enter.prevent="comparing = false"
        >
          {{ t("Удерживать для сравнения") }}
        </button>
        <button
          class="button primary"
          :disabled="busy || !sourceSize.width"
          @click="save"
        >
          {{ t("Сохранить коррекцию") }}
        </button>
        <button
          class="icon-button"
          :disabled="busy"
          :aria-label="t('Закрыть редактор')"
          @click="close"
        >
          <i aria-hidden="true" class="ri-close-line"></i>
        </button>
      </div>
    </header>
    <div class="photo-editor-body">
      <div class="photo-editor-preview">
        <div class="editor-view-toolbar">
          <button class="text-button" @click="previewScale = 100">
            {{ t("Подогнать") }}</button><label
            >{{ t("Масштаб просмотра")
            }}<input
              v-model.number="previewScale"
              type="range"
              min="25"
              max="300"
              :aria-label="t('Масштаб просмотра')"
            /><output>{{ Math.round(previewScale) }}%</output></label
          ><button
            class="text-button"
            :aria-pressed="clipping"
            @click="clipping = !clipping"
          >
            {{ t("Показать клиппинг") }}
          </button>
        </div>
        <div ref="viewport" class="editor-canvas-scroll">
          <div class="editor-canvas-stage">
            <div
              ref="frame"
              class="editor-image-frame"
              :class="{ geometry, liquify: geometry && tool === 'liquify' }"
              :style="frameStyle"
              tabindex="0"
              :aria-label="t('Область изображения')"
              :aria-busy="geometry && !geometryReady"
              @pointerdown="pointerDown"
              @pointermove="pointerMove"
              @pointerup="pointerUp"
              @pointercancel="pointerCancel"
              @lostpointercapture="pointerCancel"
              @pointerleave="!drag && (cursor = undefined)"
            >
              <canvas
                ref="canvas"
                :aria-label="
                  comparing ? t('Оригинал') : t('Обработанное изображение')
                "
                role="img"
              ></canvas>
              <div
                v-if="geometryReady && tool === 'crop'"
                class="crop-guide"
                :style="cropStyle"
              >
                <div class="crop-shade"></div>
                <div class="crop-box">
                  <span
                    v-for="handle in [
                      'nw',
                      'n',
                      'ne',
                      'e',
                      'se',
                      's',
                      'sw',
                      'w',
                    ]"
                    :key="handle"
                    class="crop-handle"
                    :class="handle"
                    :data-handle="handle"
                  ></span>
                </div>
              </div>
              <div
                v-if="geometryReady && tool === 'stretch' && stretchGuide"
                class="stretch-band"
                :class="{ horizontal: draft.stretchAxis === 'x' }"
                :style="stretchGuide"
                data-stretch="stretch-move"
              >
                <span
                  class="stretch-handle start"
                  data-stretch="stretch-start"
                ></span>
                <span
                  class="stretch-handle end"
                  data-stretch="stretch-end"
                ></span>
              </div>
              <span
                v-if="geometryReady && tool === 'liquify' && cursor"
                class="liquify-cursor"
                :style="brushStyle"
              ></span>
            </div>
          </div>
        </div>
        <div class="editor-render-status" role="status">
          <span v-if="rendering"
            ><i aria-hidden="true" class="ri-loader-4-line spinning"></i>
            {{ t("Обновление превью…") }}</span
          ><span v-else-if="sourceSize.width">{{
            t("Результат: {0} × {1} px", {
              "0": resultSize.width,
              "1": resultSize.height,
            })
          }}</span
          ><span v-if="comparing">{{ t("Оригинал") }}</span
          ><span v-else-if="dirty">{{ t("Есть несохранённые правки") }}</span>
        </div>
      </div>
      <aside class="photo-editor-controls">
        <nav class="editor-tabs" :aria-label="t('Инструменты редактора')">
          <button
            v-for="tab in [
              { id: 'quick', label: t('Быстрые настройки') },
              ...editGroups.map((group) => ({
                id: group.id,
                label: t(group.label),
              })),
              { id: 'geometry', label: t('Геометрия') },
            ]"
            :key="tab.id"
            :aria-pressed="section === tab.id"
            @click="section = tab.id"
          >
            {{ tab.label }}
          </button>
        </nav>
        <fieldset :disabled="busy">
          <template v-if="section === 'quick'">
            <div class="editor-quick-actions">
              <button
                class="button primary"
                :disabled="!sourceSize.width"
                @click="
                  mutate(() =>
                    Object.assign(draft, smartAuto(histogram, snapshot())),
                  )
                "
              >
                {{ t("Умная автокоррекция") }}</button><button
                class="button"
                @click="preset(imagePresets[0]!.values)"
              >
                {{ t("Базовая автокоррекция") }}
              </button>
            </div>
            <h3>{{ t("Пресеты") }}</h3>
            <div class="editor-presets">
              <button
                v-for="item in imagePresets"
                :key="item.label"
                class="button"
                @click="preset(item.values)"
              >
                {{ t(item.label) }}
              </button>
            </div>
            <div class="editor-quick-actions">
              <button
                class="button"
                @click="
                  copiedImageEdits = snapshot();
                  message = t('Правки скопированы.');
                "
              >
                {{ t("Копировать правки") }}</button><button
                class="button"
                :disabled="!copiedImageEdits"
                @click="
                  mutate(() =>
                    Object.assign(
                      draft,
                      normalizeImageAdjustments(copiedImageEdits!),
                    ),
                  )
                "
              >
                {{ t("Вставить правки") }}
              </button>
            </div>
          </template>
          <label
            v-for="[key, label] in controls"
            :key="key"
            class="editor-slider"
            ><span
              >{{ t(label) }}<output>{{ Math.round(draft[key]) }}</output></span
            ><input
              v-model.number="draft[key]"
              type="range"
              :min="adjustmentRanges[key][0]"
              :max="adjustmentRanges[key][1]"
              :aria-label="t(label)"
              @change="record"
          /></label>
          <template v-if="section === 'geometry'">
            <div class="editor-tool-tabs">
              <button
                v-for="item in [
                  { id: 'crop', label: t('Кадрирование') },
                  { id: 'liquify', label: t('Пластика') },
                  { id: 'stretch', label: t('Растяжение') },
                ]"
                :key="item.id"
                class="button"
                :aria-pressed="tool === item.id"
                @click="tool = item.id"
              >
                {{ item.label }}
              </button>
            </div>
            <div class="editor-geometry-buttons">
              <button class="button" @click="setRotation(-90)">↶ 90°</button
              ><button class="button" @click="setRotation(90)">↷ 90°</button
              ><button
                class="button"
                :aria-pressed="draft.flipX"
                @click="mutate(() => (draft.flipX = !draft.flipX))"
              >
                {{ t("Отразить по горизонтали") }}</button
              ><button
                class="button"
                :aria-pressed="draft.flipY"
                @click="mutate(() => (draft.flipY = !draft.flipY))"
              >
                {{ t("Отразить по вертикали") }}
              </button>
            </div>
            <label class="editor-slider"
              ><span
                >{{ t("Поворот") }}<output>{{ draft.rotate }}°</output></span
              ><input
                v-model.number="draft.rotate"
                type="range"
                min="-180"
                max="180"
                :aria-label="t('Поворот')"
                @change="
                  cropRatio();
                  record();
                "
            /></label>
            <template v-if="tool === 'crop'">
              <label class="editor-field"
                >{{ t("Пропорции кадра")
                }}<select
                  v-model="ratio"
                  :aria-label="t('Пропорции кадра')"
                  @change="mutate(cropRatio)"
                >
                  <option value="free">{{ t("Свободно") }}</option>
                  <option value="original">{{ t("Исходные") }}</option>
                  <option value="1">1:1</option>
                  <option :value="String(4 / 3)">4:3</option>
                  <option value="1.5">3:2</option>
                  <option :value="String(16 / 9)">16:9</option>
                  <option :value="String(9 / 16)">9:16</option>
                </select></label
              >
              <label class="editor-slider"
                ><span
                  >{{ t("Приближение кадра")
                  }}<output>{{ draft.cropZoom }}%</output></span
                ><input
                  v-model.number="draft.cropZoom"
                  type="range"
                  min="0"
                  max="60"
                  :aria-label="t('Приближение кадра')"
                  @change="record"
              /></label>
              <p class="editor-hint">
                {{
                  t(
                    "Перетащите рамку или её края. Потяните по изображению, чтобы задать новый кадр.",
                  )
                }}
              </p>
              <button
                class="button"
                @click="
                  mutate(() => {
                    ratio = 'free';
                    Object.assign(draft, {
                      cropX: 0,
                      cropY: 0,
                      cropWidth: 1,
                      cropHeight: 1,
                      cropZoom: 0,
                    });
                  })
                "
              >
                {{ t("На весь кадр") }}
              </button>
            </template>
            <template v-if="tool === 'liquify'"
              ><label class="editor-slider"
                ><span
                  >{{ t("Размер кисти")
                  }}<output>{{ brushSize }}%</output></span
                ><input
                  v-model.number="brushSize"
                  type="range"
                  min="4"
                  max="50"
                  :aria-label="t('Размер кисти')" /></label
              ><label class="editor-slider"
                ><span
                  >{{ t("Сила кисти")
                  }}<output>{{ brushStrength }}%</output></span
                ><input
                  v-model.number="brushStrength"
                  type="range"
                  min="5"
                  max="100"
                  :aria-label="t('Сила кисти')"
              /></label>
              <p class="editor-hint">
                {{ t("Потяните кистью, чтобы сдвинуть детали изображения.") }}
                {{ t("Мазков: {0} / 128", { "0": draft.strokes.length }) }}
              </p>
              <button
                class="button"
                @click="mutate(() => (draft.strokes = []))"
              >
                {{ t("Очистить пластику") }}
              </button></template
            >
            <template v-if="tool === 'stretch'"
              ><label class="editor-field"
                >{{ t("Направление")
                }}<select
                  v-model="draft.stretchAxis"
                  :aria-label="t('Направление')"
                  @change="record"
                >
                  <option value="y">{{ t("По вертикали") }}</option>
                  <option value="x">{{ t("По горизонтали") }}</option>
                </select></label
              ><label class="editor-slider"
                ><span
                  >{{ t("Сила растяжения")
                  }}<output>{{ draft.stretchAmount }}%</output></span
                ><input
                  v-model.number="draft.stretchAmount"
                  type="range"
                  min="-85"
                  max="85"
                  :aria-label="t('Сила растяжения')"
                  @change="record"
              /></label>
              <p class="editor-hint">
                {{
                  t(
                    "Перетащите полосу или её границы. Чтобы выбрать новую полосу, начните снаружи.",
                  )
                }}
              </p>
              <button
                class="button"
                @click="
                  mutate(() => {
                    draft.stretchAmount = 0;
                    draft.stretchStart = 0.3;
                    draft.stretchEnd = 0.7;
                  })
                "
              >
                {{ t("Сбросить растяжение") }}
              </button></template
            >
          </template>
          <button
            v-if="section !== 'quick'"
            class="text-button editor-group-reset"
            @click="resetGroup"
          >
            {{ t("Сбросить раздел") }}
          </button>
          <section class="editor-histogram">
            <h3>{{ t("Гистограмма") }}</h3>
            <div
              class="histogram-bars"
              role="img"
              :aria-label="t('Гистограмма изображения')"
            >
              <span
                v-for="(value, index) in histogram.bins"
                :key="index"
                :style="{ height: `${Math.max(1, value * 100)}%` }"
              ></span>
            </div>
            <p>
              {{
                t("Тени: {0}% · Света: {1}%", {
                  "0": histogram.shadows.toFixed(1),
                  "1": histogram.highlights.toFixed(1),
                })
              }}
            </p>
          </section>
          <details class="editor-export">
            <summary>{{ t("Экспорт изображения") }}</summary>
            <label class="editor-field"
              >{{ t("Формат")
              }}<select
                v-model="exportFormat"
                :aria-label="t('Формат экспорта')"
              >
                <option value="jpeg">JPEG</option>
                <option value="png">PNG</option>
                <option value="webp">WebP</option>
              </select></label
            ><label class="editor-field"
              >{{ t("Размер экспорта")
              }}<select
                v-model.number="exportSize"
                :aria-label="t('Размер экспорта')"
              >
                <option :value="0">{{ t("Исходное разрешение") }}</option>
                <option :value="2048">2048 px</option>
                <option :value="3840">3840 px</option>
                <option :value="6000">6000 px</option>
              </select></label
            ><label v-if="exportFormat !== 'png'" class="editor-slider"
              ><span
                >{{ t("Качество") }}<output>{{ quality }}%</output></span
              ><input
                v-model.number="quality"
                type="range"
                min="40"
                max="100"
                :aria-label="t('Качество экспорта')" /></label
            ><button
              class="button"
              :disabled="!sourceSize.width"
              @click="exportImage"
            >
              {{ busy ? t("Экспорт…") : t("Сохранить обработанную копию") }}
            </button>
          </details>
        </fieldset>
        <p v-if="error" class="error" role="alert">
          {{ error }}
          <button v-if="!busy" class="text-button" @click="render">
            {{ t("Повторить") }}
          </button>
        </p>
        <p v-if="message" class="editor-message" role="status">{{ message }}</p>
        <footer class="editor-controls-footer">
          <button
            class="button"
            :disabled="busy"
            @click="
              mutate(() => Object.assign(draft, normalizeImageAdjustments()))
            "
          >
            {{ t("Сбросить всё") }}
          </button>
          <p class="editor-hint">
            {{
              t(
                "Оригинал остаётся в R2. Правки сохраняются отдельно; экспорт создаёт обработанную копию.",
              )
            }}
          </p>
        </footer>
      </aside>
    </div>
    <div
      v-if="discard"
      class="editor-discard"
      role="alertdialog"
      :aria-label="t('Есть несохранённые правки')"
    >
      <strong>{{ t("Есть несохранённые правки") }}</strong><button
        class="button"
        @click="discard = false"
      >
        {{ t("Продолжить редактирование") }}</button
      ><button class="button danger" @click="emit('close')">
        {{ t("Не сохранять") }}
      </button>
    </div>
  </div>
</template>
