<script setup lang="ts">
import { t } from "./i18n";
import { computed, ref, onMounted, onBeforeUnmount, watch } from "vue";
import type { DriveFile } from "./types";
import { icon, imageStyle } from "./format";
import { api } from "./api";
const props = defineProps<{
  file: DriveFile;
  compact?: boolean;
  natural?: boolean;
}>();
const dimensions = ref({ width: 0, height: 0 });
const geometry = computed(() => {
  const { width, height } = dimensions.value;
  if (!width || !height || !props.natural) return null;
  const angle = ((props.file.adjustments.rotate ?? 0) * Math.PI) / 180;
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
  ...imageStyle(props.file.adjustments),
  ...(geometry.value
    ? {
        width: `${(geometry.value.width / geometry.value.boundsWidth) * 100}%`,
        height: `${(geometry.value.height / geometry.value.boundsHeight) * 100}%`,
        transform: `translate(-50%, -50%) rotate(${props.file.adjustments.rotate ?? 0}deg)`,
      }
    : {}),
}));
function loaded(event: Event) {
  const img = event.target as HTMLImageElement;
  dimensions.value = { width: img.naturalWidth, height: img.naturalHeight };
}
const root = ref<HTMLElement>(),
  url = ref(""),
  failed = ref(false);
let observer: IntersectionObserver | undefined,
  disposed = false,
  visible = false,
  request = 0;
async function fetchPreview() {
  const generation = ++request;
  try {
    const value = await api.url(props.file.id);
    if (!disposed && request === generation) url.value = value;
  } catch {
    if (!disposed && request === generation) failed.value = true;
  }
}
watch(
  () => props.file.object_key,
  () => {
    request++;
    url.value = "";
    failed.value = false;
    dimensions.value = { width: 0, height: 0 };
    if (visible && props.file.mime_type.startsWith("image/"))
      void fetchPreview();
  },
);
onMounted(() => {
  if (!props.file.mime_type.startsWith("image/")) return;
  observer = new IntersectionObserver(
    async (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer?.disconnect();
      visible = true;
      await fetchPreview();
    },
    { rootMargin: "180px" },
  );
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
});
</script>
<template>
  <div
    ref="root"
    class="file-thumb"
    :class="[
      { compact, natural, 'natural-loaded': !!geometry && !failed },
      file.mime_type.split('/')[0],
    ]"
    :style="frameStyle"
  >
    <img
      v-if="url && !failed"
      :src="url"
      :alt="file.name"
      :style="thumbnailStyle"
      loading="lazy"
      @load="loaded"
      @error="failed = true"
    />
    <i aria-hidden="true" v-else :class="icon(file.mime_type)"></i>
    <span v-if="!compact && !url" class="extension">{{
      file.name.includes(".")
        ? file.name.split(".").pop()?.toUpperCase()
        : t("ФАЙЛ")
    }}</span>
  </div>
</template>
