<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import {
  getDocument,
  GlobalWorkerOptions,
  PasswordResponses,
  TextLayer,
} from "pdfjs-dist";
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { t } from "./i18n";
GlobalWorkerOptions.workerSrc = workerUrl;
const props = defineProps<{ data: Uint8Array }>();
const emit = defineEmits<{ error: [message: string] }>();
const root = ref<HTMLElement>(),
  scroll = ref<HTMLElement>(),
  pageElement = ref<HTMLElement>();
const page = ref(1),
  pageInput = ref("1"),
  total = ref(0),
  scale = ref("fit"),
  loading = ref(true),
  rendering = ref(false),
  passwordNeeded = ref(false),
  password = ref(""),
  incorrectPassword = ref(false);
const zooms = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
let pdf: PDFDocumentProxy | undefined,
  task: PDFDocumentLoadingTask | undefined,
  renderTask: RenderTask | undefined,
  textLayer: TextLayer | undefined,
  passwordCallback: ((password: string) => void) | undefined,
  observer: ResizeObserver | undefined;
let disposed = false,
  generation = 0,
  resizeTimer: ReturnType<typeof setTimeout> | undefined;
const canMove = computed(() => !loading.value && !!total.value);
function go(value: number) {
  page.value = Math.max(
    1,
    Math.min(total.value || 1, Math.trunc(Number(value)) || 1),
  );
  pageInput.value = String(page.value);
}
function unlock() {
  passwordNeeded.value = false;
  passwordCallback?.(password.value);
  password.value = "";
}
async function render() {
  const id = ++generation;
  renderTask?.cancel();
  textLayer?.cancel();
  if (!pdf || disposed || !pageElement.value || !scroll.value) return;
  rendering.value = true;
  try {
    const item = await pdf.getPage(page.value);
    if (disposed || id !== generation) return;
    const original = item.getViewport({ scale: 1 });
    const zoom =
      scale.value === "fit"
        ? Math.max(
            0.1,
            Math.min(3, (scroll.value.clientWidth - 48) / original.width),
          )
        : Number(scale.value);
    const viewport = item.getViewport({ scale: zoom });
    // Cap raster memory for unusually large pages, preserving the CSS page size.
    const density = Math.min(
      window.devicePixelRatio || 1,
      2,
      Math.sqrt(16_000_000 / (viewport.width * viewport.height)),
    );
    const canvas = document.createElement("canvas"),
      layer = document.createElement("div");
    canvas.width = Math.max(1, Math.ceil(viewport.width * density));
    canvas.height = Math.max(1, Math.ceil(viewport.height * density));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    layer.className = "pdf-text-layer";
    pageElement.value.replaceChildren(canvas, layer);
    pageElement.value.style.width = `${viewport.width}px`;
    pageElement.value.style.height = `${viewport.height}px`;
    pageElement.value.style.setProperty("--total-scale-factor", String(zoom));
    renderTask = item.render({
      canvas,
      viewport,
      transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0],
    });
    await renderTask.promise;
    if (disposed || id !== generation) return;
    textLayer = new TextLayer({
      textContentSource: item.streamTextContent(),
      container: layer,
      viewport,
    });
    await textLayer.render();
  } catch (cause) {
    if (
      !disposed &&
      id === generation &&
      (cause as Error).name !== "RenderingCancelledException"
    )
      emit(
        "error",
        t("Не удалось отобразить PDF. Попробуйте скачать оригинал."),
      );
  } finally {
    if (id === generation && !disposed) rendering.value = false;
  }
}
function keydown(event: KeyboardEvent) {
  if ((event.target as HTMLElement).closest("input, select, button")) {
    if (["ArrowLeft", "ArrowRight"].includes(event.key))
      event.stopPropagation();
    return;
  }
  if (["ArrowLeft", "PageUp"].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    go(page.value - 1);
  }
  if (["ArrowRight", "PageDown"].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    go(page.value + 1);
  }
}
watch([page, scale], () => {
  if (scroll.value) scroll.value.scrollTop = 0;
  void render();
});
onMounted(async () => {
  try {
    const assets = new URL("./pdfjs/", document.baseURI).href;
    task = getDocument({
      data: props.data.slice(),
      cMapUrl: assets + "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: assets + "standard_fonts/",
      wasmUrl: assets + "wasm/",
      useWorkerFetch: true,
      useSystemFonts: false,
      maxImageSize: 40_000_000,
      canvasMaxAreaInBytes: 64_000_000,
    });
    task.onPassword = (callback: (value: string) => void, reason: number) => {
      passwordCallback = callback;
      incorrectPassword.value = reason === PasswordResponses.INCORRECT_PASSWORD;
      passwordNeeded.value = true;
    };
    pdf = await task.promise;
    if (disposed) return;
    total.value = pdf.numPages;
    loading.value = false;
    await nextTick();
    await render();
    if (disposed) return;
    observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      if (scale.value === "fit")
        resizeTimer = setTimeout(() => void render(), 100);
    });
    if (scroll.value) observer.observe(scroll.value);
    root.value?.focus({ preventScroll: true });
  } catch {
    if (!disposed)
      emit(
        "error",
        t(
          "Не удалось открыть PDF. Файл повреждён или имеет неподдерживаемый формат.",
        ),
      );
  }
});
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  clearTimeout(resizeTimer);
  observer?.disconnect();
  renderTask?.cancel();
  textLayer?.cancel();
  void task?.destroy().catch(() => {});
});
</script>
<template>
  <section
    ref="root"
    class="document-viewer pdf-viewer"
    :aria-label="t('Просмотр PDF')"
    tabindex="0"
    @keydown="keydown"
  >
    <div class="document-toolbar">
      <button
        class="icon-button"
        :aria-label="t('Предыдущая страница')"
        :disabled="!canMove || page <= 1"
        @click="go(page - 1)"
      >
        <i class="ri-arrow-left-s-line"></i>
      </button>
      <label
        >{{ t("Страница")
        }}<input
          type="number"
          v-model="pageInput"
          :min="1"
          :max="total || 1"
          :disabled="!canMove"
          :aria-label="t('Страница')"
          @change="go(Number(pageInput))"
          @keydown.enter.prevent="go(Number(pageInput))"
        /><span>/ {{ total || "…" }}</span></label
      >
      <button
        class="icon-button"
        :aria-label="t('Следующая страница')"
        :disabled="!canMove || page >= total"
        @click="go(page + 1)"
      >
        <i class="ri-arrow-right-s-line"></i>
      </button>
      <label
        >{{ t("Масштаб")
        }}<select
          v-model="scale"
          :disabled="!canMove"
          :aria-label="t('Масштаб')"
        >
          <option value="fit">{{ t("По ширине") }}</option>
          <option v-for="zoom in zooms" :key="zoom" :value="String(zoom)">
            {{ zoom * 100 }}%
          </option>
        </select></label
      >
      <span v-if="rendering" class="document-rendering" role="status">{{
        t("Отрисовка страницы…")
      }}</span>
    </div>
    <form
      v-if="passwordNeeded"
      class="document-password"
      @submit.prevent="unlock"
    >
      <label
        >{{ t("PDF защищён паролем")
        }}<input
          v-model="password"
          type="password"
          :aria-label="t('Пароль PDF')"
          autocomplete="off"
      /></label>
      <p v-if="incorrectPassword" role="alert">
        {{ t("Неверный пароль. Попробуйте ещё раз.") }}
      </p>
      <button class="button primary" type="submit">
        {{ t("Открыть PDF") }}
      </button>
    </form>
    <div v-else-if="loading" class="loading-state">
      {{ t("Открытие PDF…") }}
    </div>
    <div
      ref="scroll"
      class="document-scroll pdf-scroll"
      tabindex="0"
      :aria-busy="rendering"
    >
      <div ref="pageElement" class="pdf-page"></div>
    </div>
  </section>
</template>
