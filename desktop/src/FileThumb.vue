<script setup lang="ts">
import { t } from "./i18n";
import { computed, ref, onMounted, onBeforeUnmount, watch } from "vue";
import type { DriveFile, ThumbnailEntry, ThumbnailRevision } from "./types";
import { fileExtensionBadge, icon, imageStyle } from "./format";
import { api } from "./api";
import { runThumbnailPreview, videoDuration } from "./video-preview";
import ProcessedImage from "./ProcessedImage.vue";
import {
  thumbnailRevision,
  thumbnailBytes,
  thumbnailGeometry,
  usesProcessedThumbnail,
} from "./thumbnail";
import {
  isImageFile,
  isHeicFile,
  isPxzFile,
} from "../electron/image-formats.mjs";
const props = defineProps<{
  file: DriveFile;
  compact?: boolean;
  natural?: boolean;
  contained?: boolean;
}>();
const emit = defineEmits<{
  dimensions: [dimensions: { width: number; height: number }];
}>();
const isPxz = computed(() => isPxzFile(props.file));
const isVideo = computed(
  () =>
    !isPxz.value &&
    !isHeicFile(props.file) &&
    props.file.mime_type.startsWith("video/"),
);
const isImage = computed(() => isPxz.value || isImageFile(props.file));
const extension = computed(() => fileExtensionBadge(props.file.name));
const processed = computed(() => usesProcessedThumbnail(props.file));
const dimensions = ref({ width: 0, height: 0 });
watch(dimensions, (value) => {
  if (value.width && value.height) emit("dimensions", value);
});
const revision = computed(() => thumbnailRevision(props.file));
const cachedEntry = ref<ThumbnailEntry | null>(null);
let cacheEpoch: number | null = null,
  blobUrl = "",
  readable = false;
const root = ref<HTMLElement>(),
  poster = ref<HTMLCanvasElement>(),
  decoder = ref<HTMLVideoElement>();
const url = ref(""),
  failed = ref(false),
  videoReady = ref(false),
  pending = ref(false),
  decoding = ref(false),
  duration = ref(0);
const durationLabel = computed(() => videoDuration(duration.value));
const geometry = computed(() => {
  const { width, height } = dimensions.value;
  if (!width || !height || (!props.natural && !props.contained)) return null;
  return {
    width,
    height,
    ...thumbnailGeometry(props.file, { width, height }),
  };
});
const frameStyle = computed(() =>
  props.natural && geometry.value
    ? {
        aspectRatio: `${geometry.value.boundsWidth} / ${geometry.value.boundsHeight}`,
      }
    : {},
);
const thumbnailStyle = computed(() => {
  const style =
    isVideo.value || processed.value ? {} : imageStyle(props.file.adjustments);
  if (!geometry.value) return style;
  const { width, height, boundsWidth, boundsHeight, rotation } = geometry.value;
  return {
    ...style,
    width: props.contained
      ? `min(${(width / boundsWidth) * 100}cqw, ${(width / boundsHeight) * 100}cqh)`
      : `${(width / boundsWidth) * 100}%`,
    height: props.contained
      ? `min(${(height / boundsWidth) * 100}cqw, ${(height / boundsHeight) * 100}cqh)`
      : `${(height / boundsHeight) * 100}%`,
    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
  };
});
let observer: IntersectionObserver | undefined,
  disposed = false,
  visible = false,
  request = 0,
  seekRequested = false,
  capturing = false;
let work: AbortController | undefined,
  retryTimer: ReturnType<typeof setTimeout> | undefined,
  retries = 0,
  mediaUrl = "";
let displaySignal: AbortSignal | undefined;
let finishDisplay: ((error?: Error) => void) | undefined;
const ready = ref(false);
function releaseMedia(value: string) {
  if (value === mediaUrl) mediaUrl = "";
  if (
    value.startsWith("jellyree-media:") &&
    typeof window.jellyree.releaseMedia === "function"
  )
    void api.releaseMedia(value).catch(() => {});
}
function releaseBlob() {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = "";
}
function releaseDecoder() {
  if (decoder.value) {
    decoder.value.pause();
    decoder.value.removeAttribute("src");
    decoder.value.load();
  }
}
function stop() {
  request++;
  clearTimeout(retryTimer);
  releaseDecoder();
  work?.abort();
  finishDisplay?.(new DOMException("Preview canceled", "AbortError"));
  releaseMedia(mediaUrl);
  decoding.value = false;
  pending.value = false;
  if (!ready.value) url.value = "";
}
async function loadCached(current: () => boolean, signal: AbortSignal) {
  if (typeof window.jellyree.thumbnails?.get !== "function") return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const result = await Promise.race([
      api.thumbnails.get(revision.value),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Cache read timed out")),
          2000,
        );
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
    if (!current()) return false;
    cacheEpoch = result.epoch;
    if (!result.entry) return false;
    cachedEntry.value = result.entry;
    dimensions.value = {
      width: result.entry.width,
      height: result.entry.height,
    };
    duration.value = result.entry.duration;
    releaseBlob();
    blobUrl = URL.createObjectURL(
      new Blob([new Uint8Array(result.entry.data)], { type: "image/webp" }),
    );
    url.value = blobUrl;
    ready.value = true;
    if (isVideo.value) videoReady.value = true;
    retries = 0;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}
async function sourceUrl(
  currentRevision: ThumbnailRevision,
  signal: AbortSignal,
) {
  if (typeof window.jellyree.thumbnails?.source !== "function")
    return { url: await api.url(currentRevision.id), readable: false };
  const id = crypto.randomUUID();
  const abort = () => {
    if (typeof window.jellyree.cancelPreview === "function")
      void api.cancelPreview(id).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const value = await api.thumbnails.source(currentRevision, id);
    if (signal.aborted) {
      releaseMedia(value);
      signal.throwIfAborted();
    }
    return { url: value, readable: true };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function saveThumbnail(canvas: HTMLCanvasElement) {
  const generation = request,
    currentRevision = revision.value,
    epoch = cacheEpoch,
    signal = displaySignal;
  const metadata = { ...dimensions.value, duration: duration.value };
  try {
    const data = await thumbnailBytes(canvas);
    if (disposed || generation !== request || signal?.aborted) return;
    // Keep only the small decoded thumbnail in the grid, rather than every full-size photo.
    if (data) {
      const entry = { ...metadata, data };
      releaseBlob();
      cachedEntry.value = entry;
      blobUrl = URL.createObjectURL(
        new Blob([new Uint8Array(data)], { type: "image/webp" }),
      );
      url.value = blobUrl;
      if (epoch !== null)
        void api.thumbnails.put(currentRevision, entry, epoch).catch(() => {});
    }
    ready.value = true;
    retries = 0;
    finishDisplay?.();
  } catch (error) {
    if (generation === request) finishDisplay?.(error as Error);
  }
}
function loaded(event: Event) {
  if (cachedEntry.value) return;
  const image = event.target as HTMLImageElement;
  if (image.currentSrc !== url.value && image.src !== url.value) return;
  dimensions.value = { width: image.naturalWidth, height: image.naturalHeight };
  if (!readable) {
    ready.value = true;
    retries = 0;
    finishDisplay?.();
    return;
  }
  try {
    const scale = Math.min(
      1,
      640 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas
      .getContext("2d")
      ?.drawImage(image, 0, 0, canvas.width, canvas.height);
    void saveThumbnail(canvas);
  } catch (error) {
    finishDisplay?.(error as Error);
  }
}
function metadata(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (
    !decoding.value ||
    video !== decoder.value ||
    video.currentSrc !== url.value
  )
    return;
  dimensions.value = { width: video.videoWidth, height: video.videoHeight };
  duration.value = Number.isFinite(video.duration) ? video.duration : 0;
}
function capture(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (
    capturing ||
    !decoding.value ||
    video !== decoder.value ||
    video.currentSrc !== url.value ||
    video.seeking ||
    video.readyState < 2
  )
    return;
  if (!seekRequested && event.type === "loadeddata") {
    seekRequested = true;
    try {
      video.currentTime =
        duration.value > 0 ? Math.min(1, duration.value / 2) : 0;
    } catch {}
    if (video.seeking || video.readyState < 2) return;
  }
  const canvas = poster.value;
  if (!canvas || !video.videoWidth || !video.videoHeight) return;
  try {
    capturing = true;
    const scale = Math.min(
      1,
      640 / Math.max(video.videoWidth, video.videoHeight),
    );
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    dimensions.value = { width: video.videoWidth, height: video.videoHeight };
    videoReady.value = true;
    failed.value = false;
    if (readable) void saveThumbnail(canvas);
    else {
      ready.value = true;
      retries = 0;
      finishDisplay?.();
    }
  } catch (error) {
    finishDisplay?.(error as Error);
  }
}
function videoError() {
  if (decoding.value) finishDisplay?.(new Error("Video preview failed"));
}
function imageError() {
  if (cachedEntry.value) {
    stop();
    releaseBlob();
    cachedEntry.value = null;
    ready.value = false;
    videoReady.value = false;
    url.value = "";
    void fetchPreview(false);
  } else finishDisplay?.(new Error("Image preview failed"));
}
function retry() {
  stop();
  retries = 0;
  failed.value = false;
  if (visible) void fetchPreview(false);
}
async function fetchPreview(useCache = true) {
  const generation = ++request,
    controller = new AbortController();
  work = controller;
  const current = () =>
    !disposed && generation === request && !controller.signal.aborted;
  pending.value = true;
  failed.value = false;
  try {
    if (useCache && (await loadCached(current, controller.signal))) return;
    if (!current() || !visible) return;
    await runThumbnailPreview(
      async (signal) => {
        displaySignal = signal;
        let acquired = "";
        try {
          if (!current() || !visible || signal.aborted) return;
          if (isPxz.value) {
            const { renderPxzPreview } = await import("./pxz-preview");
            const { canvas, width, height } = await renderPxzPreview(
              props.file,
              640,
              signal,
            );
            if (!current()) return;
            dimensions.value = { width, height };
            await saveThumbnail(canvas);
            if (current() && !cachedEntry.value)
              throw new Error("PXZ thumbnail could not be saved");
            return;
          }
          const value = processed.value
            ? { url: "processed", readable: true }
            : await sourceUrl(revision.value, signal);
          acquired = value.url;
          if (!current() || !visible || signal.aborted) return;
          readable = value.readable;
          if (acquired.startsWith("jellyree-media:")) mediaUrl = acquired;
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const abort = () => finish(signal.reason);
            const finish = (error?: Error) => {
              if (settled) return;
              settled = true;
              signal.removeEventListener("abort", abort);
              if (finishDisplay === finish) finishDisplay = undefined;
              if (error) reject(error);
              else resolve();
            };
            finishDisplay = finish;
            signal.addEventListener("abort", abort, { once: true });
            seekRequested = false;
            capturing = false;
            url.value = value.url;
            if (isVideo.value) decoding.value = true;
          });
        } finally {
          if (displaySignal === signal) displaySignal = undefined;
          if (current()) {
            releaseDecoder();
            decoding.value = false;
          }
          releaseMedia(acquired);
        }
      },
      { signal: controller.signal },
    );
  } catch {
    if (current()) {
      failed.value = true;
      releaseDecoder();
      decoding.value = false;
      if (!ready.value) url.value = "";
      if (visible && retries < 2) {
        retries++;
        retryTimer = setTimeout(() => {
          if (!disposed && visible && generation === request)
            void fetchPreview(false);
        }, 750 * retries);
      }
    }
  } finally {
    if (current()) pending.value = false;
  }
}
watch(
  () => JSON.stringify(revision.value),
  () => {
    stop();
    releaseBlob();
    cachedEntry.value = null;
    cacheEpoch = null;
    readable = false;
    ready.value = false;
    url.value = "";
    failed.value = false;
    videoReady.value = false;
    duration.value = 0;
    dimensions.value = { width: 0, height: 0 };
    retries = 0;
    if (visible && (isImage.value || isVideo.value)) void fetchPreview();
  },
);
onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) {
        if (ready.value && cachedEntry.value && !url.value) {
          blobUrl = URL.createObjectURL(
            new Blob([new Uint8Array(cachedEntry.value.data)], {
              type: "image/webp",
            }),
          );
          url.value = blobUrl;
        } else if (
          (isImage.value || isVideo.value) &&
          !ready.value &&
          !pending.value &&
          (!failed.value || retries < 2)
        ) {
          clearTimeout(retryTimer);
          void fetchPreview();
        }
      } else {
        if (pending.value) stop();
        if (ready.value && cachedEntry.value) {
          releaseBlob();
          url.value = "";
        }
      }
    },
    { root: root.value?.closest(".files-scroll"), rootMargin: "180px" },
  );
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => {
  disposed = true;
  stop();
  releaseBlob();
  observer?.disconnect();
});
</script>
<template>
  <div
    ref="root"
    class="file-thumb"
    :class="[
      {
        compact,
        natural,
        contained,
        'natural-loaded': !!geometry && !failed,
        'video-ready': videoReady,
      },
      isImage ? 'image' : file.mime_type.split('/')[0],
    ]"
    :style="frameStyle"
  >
    <ProcessedImage
      v-if="processed && !isPxz && url && !failed && !cachedEntry"
      :file="file"
      :max-size="640"
      :style="thumbnailStyle"
      @loaded="dimensions = $event"
      @error="imageError"
      @rendered="saveThumbnail"
    />
    <img
      v-else-if="(cachedEntry || !isVideo) && url && !failed"
      :src="url"
      :alt="file.name"
      :style="thumbnailStyle"
      :class="{
        'cached-thumbnail': !!cachedEntry,
        'processed-image': processed,
        'video-poster': isVideo,
      }"
      :crossorigin="!cachedEntry && readable ? 'anonymous' : undefined"
      loading="eager"
      draggable="false"
      @load="loaded"
      @error="imageError"
    />
    <canvas
      v-if="isVideo && !cachedEntry"
      v-show="videoReady"
      ref="poster"
      class="video-poster"
      :style="thumbnailStyle"
      role="img"
      :aria-label="t('Превью видео: {0}', { '0': file.name })"
      draggable="false"
    ></canvas>
    <i
      v-if="isVideo ? !videoReady : !url || failed"
      aria-hidden="true"
      :class="
        pending ? 'ri-loader-4-line spinning' : icon(file.mime_type, file.name)
      "
    ></i>
    <video
      v-if="decoding"
      ref="decoder"
      class="video-decoder"
      :src="url"
      :crossorigin="readable ? 'anonymous' : undefined"
      muted
      playsinline
      preload="auto"
      aria-hidden="true"
      draggable="false"
      @loadedmetadata="metadata"
      @loadeddata="capture"
      @seeked="capture"
      @error="videoError"
    ></video>
    <button
      v-if="failed && !pending"
      class="thumbnail-retry"
      :aria-label="t('Повторить')"
      :title="t('Повторить')"
      @click.stop="retry"
      @dblclick.stop
      @keydown.stop
    >
      <i aria-hidden="true" class="ri-refresh-line"></i>
    </button>
    <span
      v-if="extension"
      class="file-extension-badge"
      :style="{ backgroundColor: extension.color }"
      :title="extension.label"
      >{{ extension.label }}</span
    >
    <span v-if="isVideo && videoReady" class="video-badge"
      ><i aria-hidden="true" class="ri-play-fill"></i
      ><span v-if="!compact">{{ durationLabel }}</span></span
    >
    <span v-if="isVideo && failed && !compact" class="video-unavailable">{{
      t("Превью недоступно")
    }}</span>
    <span
      v-else-if="!extension && !compact && !url && !pending"
      class="extension"
      >{{ t("ФАЙЛ") }}</span
    >
  </div>
</template>
