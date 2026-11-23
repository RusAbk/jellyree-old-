<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import type { DriveFile } from "./types";
import { icon, imageStyle } from "./format";
const props = defineProps<{ file: DriveFile; compact?: boolean }>();
const root = ref<HTMLElement>(),
  url = ref(""),
  failed = ref(false);
let observer: IntersectionObserver | undefined,
  disposed = false;
onMounted(() => {
  if (!props.file.mime_type.startsWith("image/")) return;
  observer = new IntersectionObserver(
    async (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer?.disconnect();
      try {
        const value = await window.jellyree.url(props.file.id);
        if (!disposed) url.value = value;
      } catch {
        failed.value = true;
      }
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
    :class="[{ compact }, file.mime_type.split('/')[0]]"
  >
    <img
      v-if="url && !failed"
      :src="url"
      :alt="file.name"
      :style="imageStyle(file.adjustments)"
      loading="lazy"
      @error="failed = true"
    />
    <i aria-hidden="true" v-else :class="icon(file.mime_type)"></i>
    <span v-if="!compact && !url" class="extension">{{
      file.name.includes(".")
        ? file.name.split(".").pop()?.toUpperCase()
        : "ФАЙЛ"
    }}</span>
  </div>
</template>
