<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import type { DriveFile } from "./types";
import { renderImage, cancelImageWork } from "./image-service";
const props = withDefaults(
  defineProps<{ file: DriveFile; maxSize?: number }>(),
  { maxSize: 1600 },
);
const emit = defineEmits<{
  loaded: [dimensions: { width: number; height: number }];
  error: [error: Error];
  rendered: [canvas: HTMLCanvasElement];
}>();
const canvas = ref<HTMLCanvasElement>();
const owner = crypto.randomUUID();
let generation = 0;
watch(
  () => [
    props.file.object_key,
    JSON.stringify(props.file.adjustments),
    props.maxSize,
    canvas.value,
  ],
  async () => {
    if (!canvas.value) return;
    const id = ++generation;
    try {
      const result = await renderImage(
        owner,
        props.file,
        { adjustments: props.file.adjustments, maxSize: props.maxSize },
        props.maxSize > 640,
      );
      if (id !== generation || !canvas.value) {
        result.bitmap?.close();
        return;
      }
      const image = result.bitmap!;
      canvas.value.width = image.width;
      canvas.value.height = image.height;
      canvas.value.getContext("2d")!.drawImage(image, 0, 0);
      image.close();
      emit("loaded", { width: result.width, height: result.height });
      emit("rendered", canvas.value);
    } catch (error) {
      if ((error as Error).name !== "AbortError" && id === generation)
        emit("error", error as Error);
    }
  },
  { flush: "post", immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  cancelImageWork(owner);
});
</script>
<template>
  <canvas
    ref="canvas"
    class="processed-image"
    role="img"
    :aria-label="file.name"
    :data-image-id="file.id"
    draggable="false"
  ></canvas>
</template>
