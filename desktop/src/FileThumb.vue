<script setup lang="ts">
import { t } from "./i18n";
import { computed, ref, onMounted, onBeforeUnmount, watch } from "vue";
import type { DriveFile, ThumbnailEntry, ThumbnailRevision } from "./types";
import { icon, imageStyle } from "./format";
import { api } from "./api";
import { runVideoPreview, videoDuration } from "./video-preview";
import ProcessedImage from "./ProcessedImage.vue";
import { needsImageProcessing } from "../electron/image-adjustments.mjs";
import { thumbnailRevision, thumbnailBytes } from "./thumbnail";
const props = defineProps<{
  file: DriveFile;
  compact?: boolean;
  natural?: boolean;
}>();
const isVideo = computed(() => props.file.mime_type.startsWith("video/"));
const isImage = computed(() => props.file.mime_type.startsWith("image/"));
const processed = computed(
  () => isImage.value && needsImageProcessing(props.file.adjustments),
);
const dimensions = ref({ width: 0, height: 0 });
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
  if (!width || !height || !props.natural) return null;
  const angle =
    isVideo.value || processed.value
      ? 0
      : ((props.file.adjustments.rotate ?? 0) * Math.PI) / 180;
  return {
    width,
    height,
    boundsWidth:
      Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle)),
    boundsHeight:
      Math.abs(width * Math.sin(angle)) + Math.abs(height * Math.cos(angle)),
  };
});
const frameStyle = computed(() =>
  geometry.value
    ? {
        aspectRatio: `${geometry.value.boundsWidth} / ${geometry.value.boundsHeight}`,
      }
    : {},
);
const thumbnailStyle = computed(() => ({
  ...(isVideo.value || processed.value
    ? {}
    : imageStyle(props.file.adjustments)),
  ...(geometry.value
    ? {
        width: `${(geometry.value.width / geometry.value.boundsWidth) * 100}%`,
        height: `${(geometry.value.height / geometry.value.boundsHeight) * 100}%`,
        transform: `translate(-50%, -50%) rotate(${isVideo.value || processed.value ? 0 : (props.file.adjustments.rotate ?? 0)}deg)`,
      }
    : {}),
}));
let observer: IntersectionObserver | undefined,
  disposed = false,
  visible = false,
  request = 0,
  seekRequested = false;
let finishVideo: ((error?: boolean) => void) | undefined;
function loaded(event: Event) {
  const img = event.target as HTMLImageElement;
  if (cachedEntry.value) return;
  dimensions.value = { width: img.naturalWidth, height: img.naturalHeight };
  if (readable && !processed.value) {
    const scale = Math.min(
      1,
      640 / Math.max(img.naturalWidth, img.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    void saveThumbnail(canvas);
  }
}
async function saveThumbnail(canvas: HTMLCanvasElement) {
  if (cacheEpoch === null) return;
  const generation = request,
    epoch = cacheEpoch,
    currentRevision = revision.value;
  const metadata = { ...dimensions.value, duration: duration.value };
  const data = await thumbnailBytes(canvas);
  if (!data || disposed || generation !== request) return;
  await api.thumbnails
    .put(currentRevision, { ...metadata, data }, epoch)
    .catch(() => {});
}
function releaseBlob() {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = "";
}
async function loadCached(current: () => boolean) {
  if (typeof window.jellyree.thumbnails?.get !== "function") return false;
  try {
    const result = await api.thumbnails.get(revision.value);
    if (!current()) return false;
    cacheEpoch = result.epoch;
    if (!result.entry) return false;
    cachedEntry.value = result.entry;
    dimensions.value = {
      width: result.entry.width,
      height: result.entry.height,
    };
    duration.value = result.entry.duration;
    blobUrl = URL.createObjectURL(
      new Blob([new Uint8Array(result.entry.data)], { type: "image/webp" }),
    );
    url.value = blobUrl;
    if (isVideo.value) videoReady.value = true;
    return true;
  } catch {
    return false;
  }
}
async function sourceUrl(currentRevision: ThumbnailRevision) {
  if (typeof window.jellyree.thumbnails?.source === "function") {
    try {
      const value = await api.thumbnails.source(currentRevision);
      return { url: value, readable: true };
    } catch {
      /* The ordinary preview remains available if the cache is unavailable. */
    }
  }
  return { url: await api.url(currentRevision.id), readable: false };
}
function releaseDecoder() {
  if (decoder.value) {
    decoder.value.pause();
    decoder.value.removeAttribute("src");
    decoder.value.load();
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
    !decoding.value ||
    video !== decoder.value ||
    video.currentSrc !== url.value ||
    video.seeking ||
    video.readyState < 2
  )
    return;
  // Wait for an actual decoded frame before seeking. Some streaming responses
  // initially clamp seeks to zero; their first frame is still a valid preview.
  if (!seekRequested && event.type === "loadeddata") {
    seekRequested = true;
    try {
      video.currentTime =
        duration.value > 0 ? Math.min(1, duration.value / 2) : 0;
    } catch {
      // A non-seekable stream can still provide its current frame.
    }
    if (video.seeking || video.readyState < 2) return;
  }
  const canvas = poster.value;
  if (!canvas || !video.videoWidth || !video.videoHeight) return;
  try {
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
    finishVideo?.();
  } catch {
    finishVideo?.(true);
  }
}
function videoError() {
  if (decoding.value) finishVideo?.(true);
}
function imageError() {
  if (cachedEntry.value) {
    releaseBlob();
    cachedEntry.value = null;
    url.value = "";
    videoReady.value = false;
    duration.value = 0;
    void fetchPreview(false);
  } else failed.value = true;
}
async function fetchPreview(useCache = true) {
  const generation = ++request;
  const current = () => !disposed && request === generation;
  pending.value = true;
  try {
    if (useCache && (await loadCached(current))) return;
    if (!current()) return;
    if (isVideo.value) {
      await runVideoPreview(async () => {
        if (!current() || !visible) return;
        const value = await sourceUrl(revision.value);
        if (!current() || !visible) return;
        readable = value.readable;
        url.value = value.url;
        await new Promise<void>((resolve) => {
          let settled = false;
          const timer = setTimeout(() => finish(true), 20000);
          const finish = (error = false) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (current() && error) failed.value = true;
            decoding.value = false;
            releaseDecoder();
            if (finishVideo === finish) finishVideo = undefined;
            resolve();
          };
          finishVideo = finish;
          seekRequested = false;
          decoding.value = true;
        });
      });
    } else {
      const value = await sourceUrl(revision.value);
      if (current()) {
        readable = value.readable;
        url.value = value.url;
      }
    }
  } catch {
    if (current()) failed.value = true;
  } finally {
    if (current()) pending.value = false;
  }
}
watch(
  () => JSON.stringify(revision.value),
  () => {
    request++;
    finishVideo?.();
    releaseBlob();
    cachedEntry.value = null;
    cacheEpoch = null;
    readable = false;
    url.value = "";
    failed.value = false;
    videoReady.value = false;
    duration.value = 0;
    pending.value = false;
    dimensions.value = { width: 0, height: 0 };
    if (visible && (isImage.value || isVideo.value)) void fetchPreview();
  },
);
onMounted(() => {
  if (!isImage.value && !isVideo.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) {
        if (isImage.value) observer?.disconnect();
        if (!videoReady.value && !pending.value && !failed.value)
          void fetchPreview();
      } else if (isVideo.value && pending.value) {
        request++;
        finishVideo?.();
        pending.value = false;
      }
    },
    { rootMargin: "180px" },
  );
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => {
  disposed = true;
  request++;
  finishVideo?.();
  releaseDecoder();
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
        'natural-loaded': !!geometry && !failed,
        'video-ready': videoReady,
      },
      file.mime_type.split('/')[0],
    ]"
    :style="frameStyle"
  >
    <ProcessedImage
      v-if="processed && url && !failed && !cachedEntry"
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
      loading="lazy"
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
      :class="pending ? 'ri-loader-4-line spinning' : icon(file.mime_type)"
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
    <span v-if="isVideo && videoReady" class="video-badge"
      ><i aria-hidden="true" class="ri-play-fill"></i
      ><span v-if="!compact">{{ durationLabel }}</span></span
    >
    <span v-if="isVideo && failed && !compact" class="video-unavailable">{{
      t("Превью недоступно")
    }}</span>
    <span
      v-else-if="!compact && (isVideo ? !videoReady && !pending : !url)"
      class="extension"
      >{{
        file.name.includes(".")
          ? file.name.split(".").pop()?.toUpperCase()
          : t("ФАЙЛ")
      }}</span
    >
  </div>
</template>
