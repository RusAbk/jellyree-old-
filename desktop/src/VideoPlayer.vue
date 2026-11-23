<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "./i18n";
import type { CapturedVideoFrame, DriveFile } from "./types";
import { playbackSpeeds, playbackSpeed, framePosition } from "./video-player";
const props = defineProps<{
  file: DriveFile;
  src: string;
  saveFrame: (file: DriveFile, frame: CapturedVideoFrame) => Promise<DriveFile>;
  downloadFrame: (
    file: DriveFile,
    frame: CapturedVideoFrame,
  ) => Promise<{ saved: boolean }>;
}>();
const emit = defineEmits<{ error: [message: string] }>();
const root = ref<HTMLElement>(),
  video = ref<HTMLVideoElement>();
const speed = ref(
  playbackSpeed(localStorage.getItem("jellyree-desktop-video-speed") || 1),
);
const speeds = computed(() =>
  [...new Set([...playbackSpeeds, speed.value])].sort((a, b) => a - b),
);
const ready = ref(false),
  seeking = ref(false),
  failed = ref(false),
  fullscreen = ref(false);
const saving = ref<"cloud" | "download" | null>(null),
  message = ref(""),
  error = ref("");
let disposed = false;
const canCapture = computed(
  () => ready.value && !seeking.value && !failed.value && !saving.value,
);
function loaded() {
  if (!video.value) return;
  if (video.value.playbackRate !== speed.value)
    video.value.playbackRate = speed.value;
  ready.value = video.value.readyState >= 2 && !!video.value.videoWidth;
}
function changeSpeed(value: number) {
  speed.value = playbackSpeed(value);
  if (video.value && video.value.playbackRate !== speed.value)
    video.value.playbackRate = speed.value;
  localStorage.setItem("jellyree-desktop-video-speed", String(speed.value));
}
function rateChanged() {
  if (video.value) changeSpeed(video.value.playbackRate);
}
function mediaError() {
  failed.value = true;
  ready.value = false;
  emit("error", t("Видеокодек не поддерживается. Скачайте оригинал."));
}
function capture(): Promise<CapturedVideoFrame> {
  const player = video.value;
  if (!player || player.readyState < 2 || player.seeking || !player.videoWidth)
    throw new Error(t("Дождитесь загрузки кадра или окончания перемотки."));
  if (player.videoWidth * player.videoHeight > 40_000_000)
    throw new Error(t("Разрешение кадра слишком большое для сохранения."));
  const timestamp = player.currentTime,
    canvas = document.createElement("canvas");
  canvas.width = player.videoWidth;
  canvas.height = player.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(t("Не удалось получить стопкадр."));
  // Snapshot the displayed frame synchronously; playback may continue while PNG is encoded.
  context.drawImage(player, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error(t("Не удалось получить стопкадр.")));
        return;
      }
      void blob
        .arrayBuffer()
        .then(
          (buffer) => resolve({ timestamp, data: new Uint8Array(buffer) }),
          reject,
        );
    }, "image/png");
  });
}
async function saveFrame(destination: "cloud" | "download") {
  if (!canCapture.value) return;
  const file = props.file,
    save = props.saveFrame,
    download = props.downloadFrame;
  saving.value = destination;
  error.value = "";
  message.value = "";
  try {
    const frame = await capture();
    if (destination === "cloud") {
      const saved = await save(file, frame);
      if (!disposed)
        message.value = t("Кадр {0} сохранён: {1}", {
          "0": framePosition(frame.timestamp),
          "1": saved.name,
        });
    } else {
      const result = await download(file, frame);
      if (!disposed && result.saved)
        message.value = t("Кадр {0} сохранён на компьютере.", {
          "0": framePosition(frame.timestamp),
        });
    }
  } catch (cause) {
    if (!disposed)
      error.value =
        (cause as Error).name === "SecurityError"
          ? t(
              "Не удалось получить стопкадр. Полностью перезапустите приложение.",
            )
          : (cause as Error).message;
  } finally {
    if (!disposed) saving.value = null;
  }
}
function fullscreenChanged() {
  fullscreen.value = document.fullscreenElement === root.value;
}
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement === root.value)
      await document.exitFullscreen();
    else await root.value?.requestFullscreen();
  } catch {
    error.value = t("Не удалось открыть полноэкранный режим.");
  }
}
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented) {
    event.stopPropagation();
    return;
  }
  const target = event.target as HTMLElement;
  if (target.closest("select, input, button")) return;
  const player = video.value;
  if (!player) return;
  let handled = true;
  if (event.code === "Space") {
    if (player.paused) void player.play().catch(() => {});
    else player.pause();
  } else if (event.shiftKey && event.key.toLowerCase() === "s")
    void saveFrame("cloud");
  else if (event.ctrlKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
    const index = speeds.value.indexOf(speed.value),
      delta = event.key === "ArrowUp" ? 1 : -1;
    changeSpeed(
      speeds.value[
        Math.max(0, Math.min(speeds.value.length - 1, index + delta))
      ]!,
    );
  } else if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
    if (Number.isFinite(player.duration))
      player.currentTime = Math.max(
        0,
        Math.min(
          player.duration,
          player.currentTime + (event.key === "ArrowLeft" ? -5 : 5),
        ),
      );
  } else handled = false;
  if (handled) {
    event.preventDefault();
    event.stopPropagation();
  }
}
onMounted(async () => {
  document.addEventListener("fullscreenchange", fullscreenChanged);
  await nextTick();
  root.value?.focus({ preventScroll: true });
});
onBeforeUnmount(() => {
  disposed = true;
  document.removeEventListener("fullscreenchange", fullscreenChanged);
  if (document.fullscreenElement === root.value)
    void document.exitFullscreen().catch(() => {});
  if (video.value) {
    video.value.pause();
    video.value.removeAttribute("src");
    video.value.load();
  }
});
</script>
<template>
  <section
    ref="root"
    class="desktop-video-player"
    tabindex="0"
    :aria-label="t('Видеоплеер')"
    @keydown="keydown"
  >
    <video
      ref="video"
      :src="src"
      crossorigin="anonymous"
      controls
      controlslist="nofullscreen"
      autoplay
      playsinline
      @loadedmetadata="loaded"
      @loadeddata="loaded"
      @canplay="loaded"
      @ratechange="rateChanged"
      @seeking="seeking = true"
      @seeked="
        seeking = false;
        loaded();
      "
      @error="mediaError"
      @dblclick.stop.prevent="toggleFullscreen"
    ></video>
    <div class="video-player-toolbar">
      <label
        >{{ t("Скорость воспроизведения")
        }}<select
          :value="speed"
          :aria-label="t('Скорость воспроизведения')"
          @change="
            changeSpeed(Number(($event.target as HTMLSelectElement).value))
          "
        >
          <option v-for="value in speeds" :key="value" :value="value">
            {{ value }}×
          </option>
        </select></label
      >
      <div class="video-frame-actions">
        <button
          class="button"
          :disabled="!canCapture"
          :title="t('Кадр появится в той же папке, что и видео.')"
          @click="saveFrame('cloud')"
        >
          <i
            aria-hidden="true"
            :class="
              saving === 'cloud'
                ? 'ri-loader-4-line spinning'
                : 'ri-camera-line'
            "
          ></i
          >{{
            saving === "cloud"
              ? t("Сохранение кадра…")
              : t("Сохранить кадр в папку")
          }}</button
        ><button
          class="button"
          :disabled="!canCapture"
          @click="saveFrame('download')"
        >
          <i aria-hidden="true" class="ri-download-2-line"></i
          >{{
            saving === "download"
              ? t("Сохранение кадра…")
              : t("Скачать стопкадр")
          }}</button
        ><button
          class="icon-button"
          :aria-label="
            fullscreen
              ? t('Выйти из полноэкранного режима')
              : t('Полноэкранный режим')
          "
          @click="toggleFullscreen"
        >
          <i
            aria-hidden="true"
            :class="
              fullscreen ? 'ri-fullscreen-exit-line' : 'ri-fullscreen-line'
            "
          ></i>
        </button>
      </div>
    </div>
    <p v-if="message" class="video-frame-result" role="status">{{ message }}</p>
    <p v-if="error" class="video-frame-error" role="alert">{{ error }}</p>
  </section>
</template>
