<script setup lang="ts">
import { t } from "./i18n";
import { computed, ref, onMounted, onBeforeUnmount, watch } from "vue";
import type { DriveFile } from "./types";
import { icon, imageStyle } from "./format";
import { api } from "./api";
import { runVideoPreview, videoDuration } from "./video-preview";
const props = defineProps<{
  file: DriveFile;
  compact?: boolean;
  natural?: boolean;
}>();
const isVideo = computed(() => props.file.mime_type.startsWith("video/"));
const isImage = computed(() => props.file.mime_type.startsWith("image/"));
const dimensions = ref({ width: 0, height: 0 });
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
  const angle = isVideo.value
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
  ...(isVideo.value ? {} : imageStyle(props.file.adjustments)),
  ...(geometry.value
    ? {
        width: `${(geometry.value.width / geometry.value.boundsWidth) * 100}%`,
        height: `${(geometry.value.height / geometry.value.boundsHeight) * 100}%`,
        transform: `translate(-50%, -50%) rotate(${isVideo.value ? 0 : (props.file.adjustments.rotate ?? 0)}deg)`,
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
  dimensions.value = { width: img.naturalWidth, height: img.naturalHeight };
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
    // Drawing a cross-origin video to a canvas is allowed without R2 CORS.
    // Keep the pixels in the canvas; do not export/read the tainted canvas.
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    dimensions.value = { width: video.videoWidth, height: video.videoHeight };
    videoReady.value = true;
    failed.value = false;
    finishVideo?.();
  } catch {
    finishVideo?.(true);
  }
}
function videoError() {
  if (decoding.value) finishVideo?.(true);
}
async function fetchPreview() {
  const generation = ++request;
  const current = () => !disposed && request === generation;
  if (isVideo.value) pending.value = true;
  try {
    if (isVideo.value) {
      await runVideoPreview(async () => {
        if (!current() || !visible) return;
        const value = await api.url(props.file.id);
        if (!current() || !visible) return;
        url.value = value;
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
      const value = await api.url(props.file.id);
      if (current()) url.value = value;
    }
  } catch {
    if (current()) failed.value = true;
  } finally {
    if (current()) pending.value = false;
  }
}
watch(
  () => props.file.object_key,
  () => {
    request++;
    finishVideo?.();
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
    <img
      v-if="!isVideo && url && !failed"
      :src="url"
      :alt="file.name"
      :style="thumbnailStyle"
      loading="lazy"
      draggable="false"
      @load="loaded"
      @error="failed = true"
    />
    <canvas
      v-if="isVideo"
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
