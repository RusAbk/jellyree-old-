<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from "vue";
import type { DriveFile } from "./types";
import { api } from "./api";
import { t } from "./i18n";
import TextViewer from "./TextViewer.vue";
import type TextEditorComponent from "./TextEditor.vue";
const TextEditor = defineAsyncComponent(() => import("./TextEditor.vue"));
const PdfViewer = defineAsyncComponent(() => import("./PdfViewer.vue"));
const props = defineProps<{ file: DriveFile }>();
const emit = defineEmits<{
  error: [message: string];
  close: [];
  saved: [file: DriveFile];
}>();
const source = ref<Awaited<ReturnType<typeof api.documentSource>>>();
const editing = ref(false),
  editorEncoding = ref("auto"),
  editor = ref<InstanceType<typeof TextEditorComponent>>();
let expectedObjectKey = props.file.object_key;
function edit(encoding: string) {
  if (
    typeof window.jellyree.saveTextDocument !== "function" ||
    typeof window.jellyree.setDocumentDraft !== "function"
  ) {
    emit(
      "error",
      t("Для редактирования документов полностью перезапустите приложение."),
    );
    return;
  }
  editorEncoding.value = encoding;
  editing.value = true;
}
async function save(data: Uint8Array) {
  const result = await api.saveTextDocument(
    props.file.id,
    expectedObjectKey,
    data,
  );
  expectedObjectKey = result.file.object_key;
  if (source.value) source.value = { ...source.value, data };
  emit("saved", result.file);
  return result;
}
function requestLeave() {
  return editor.value?.requestLeave() || Promise.resolve(true);
}
defineExpose({ requestLeave, isEditing: editing });
let disposed = false;
onMounted(async () => {
  try {
    if (typeof window.jellyree.documentSource !== "function")
      throw new Error(
        t("Для просмотра документов полностью перезапустите приложение."),
      );
    const value = await api.documentSource(
      props.file.id,
      props.file.object_key,
    );
    if (!disposed) source.value = value;
  } catch (error) {
    if (!disposed) emit("error", (error as Error).message);
  }
});
onBeforeUnmount(() => {
  disposed = true;
});
</script>
<template>
  <div v-if="!source" class="loading-state" role="status">
    {{ t("Получение документа…") }}
  </div>
  <PdfViewer
    v-else-if="source.kind === 'pdf'"
    :data="source.data"
    @error="emit('error', $event)"
    @keydown.esc.stop.prevent="emit('close')"
  />
  <TextViewer
    v-else-if="!editing"
    :data="source.data"
    :markdown="source.kind === 'markdown'"
    @keydown.esc.stop.prevent="emit('close')"
    @edit="edit"
  />
  <TextEditor
    v-else
    ref="editor"
    :data="source.data"
    :encoding="editorEncoding"
    :markdown="source.kind === 'markdown'"
    :save="save"
    @back="editing = false"
    @close="emit('close')"
  />
</template>
