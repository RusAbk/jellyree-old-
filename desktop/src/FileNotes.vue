<script setup lang="ts">
import { Editor, generateHTML } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import DOMPurify from "dompurify";
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import { noteLimit, noteText } from "../electron/note-content.mjs";
import { api } from "./api";
import { dateTime } from "./format";
import { t } from "./i18n";
import type { FileNote } from "./types";

const props = defineProps<{ fileId: string; fileName: string }>();
const notes = ref<FileNote[]>([]);
const draft = ref<FileNote | null>();
const confirming = ref<string>();
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const root = ref<HTMLElement>();
const editor = shallowRef<Editor>();
const version = ref(0);
const extensions = [
  StarterKit.configure({
    blockquote: false,
    code: false,
    codeBlock: false,
    heading: { levels: [1, 2, 3] },
    horizontalRule: false,
    link: false,
    strike: false,
    trailingNode: false,
  }),
];
const purify = DOMPurify(window);
const rendered = computed(() =>
  notes.value.map((note) => ({
    ...note,
    html: purify.sanitize(generateHTML(note.body, extensions), {
      ALLOWED_TAGS: [
        "p",
        "br",
        "strong",
        "em",
        "u",
        "h1",
        "h2",
        "h3",
        "ul",
        "ol",
        "li",
      ],
      ALLOWED_ATTR: ["start"],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    }),
  })),
);

type Control = {
  id: string;
  name: string;
  icon: string;
  label: string;
  attributes?: { level: number };
  apply: (view: Editor) => boolean;
};
const controls = computed<Control[]>(() => [
  {
    id: "bold",
    name: "bold",
    icon: "ri-bold",
    label: t("Жирный текст"),
    apply: (view) => view.chain().focus().toggleBold().run(),
  },
  {
    id: "italic",
    name: "italic",
    icon: "ri-italic",
    label: t("Курсив"),
    apply: (view) => view.chain().focus().toggleItalic().run(),
  },
  {
    id: "underline",
    name: "underline",
    icon: "ri-underline",
    label: t("Подчёркнутый текст"),
    apply: (view) => view.chain().focus().toggleUnderline().run(),
  },
  ...([1, 2, 3] as const).map((level) => ({
    id: `h${level}`,
    name: "heading",
    icon: `ri-h-${level}`,
    label: t("Заголовок {0}", { "0": level }),
    attributes: { level },
    apply: (view: Editor) =>
      view.chain().focus().toggleHeading({ level }).run(),
  })),
  {
    id: "bulletList",
    name: "bulletList",
    icon: "ri-list-unordered",
    label: t("Маркированный список"),
    apply: (view) => view.chain().focus().toggleBulletList().run(),
  },
  {
    id: "orderedList",
    name: "orderedList",
    icon: "ri-list-ordered",
    label: t("Нумерованный список"),
    apply: (view) => view.chain().focus().toggleOrderedList().run(),
  },
]);
const text = computed(() => {
  version.value;
  return editor.value ? noteText(editor.value.getJSON()) : "";
});
const length = computed(() => [...text.value].length);
const activeControls = computed(() => {
  version.value;
  return new Set(
    controls.value
      .filter((control) =>
        editor.value?.isActive(control.name, control.attributes),
      )
      .map((control) => control.id),
  );
});

watch(
  root,
  (element, _, onCleanup) => {
    if (!element) return;
    const view = new Editor({
      element,
      extensions,
      content: draft.value?.body ?? {
        type: "doc",
        content: [{ type: "paragraph" }],
      },
      editorProps: {
        attributes: {
          "aria-label": t("Текст заметки"),
          role: "textbox",
          "aria-multiline": "true",
        },
      },
      onTransaction: () => {
        version.value++;
      },
    });
    editor.value = view;
    onCleanup(() => {
      view.destroy();
      editor.value = undefined;
    });
  },
  { flush: "post" },
);
watch(saving, (value) => editor.value?.setEditable(!value));

async function load() {
  draft.value = undefined;
  confirming.value = undefined;
  loading.value = true;
  error.value = "";
  try {
    notes.value = await api.listFileNotes(props.fileId);
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function edit(note: FileNote | null) {
  error.value = "";
  confirming.value = undefined;
  draft.value = note;
}

async function save() {
  const view = editor.value;
  if (!view || saving.value || !text.value.trim() || length.value > noteLimit)
    return;
  const previous = draft.value;
  saving.value = true;
  error.value = "";
  try {
    const result = await api.saveFileNote(props.fileId, {
      body: view.getJSON(),
      ...(previous ? { id: previous.id, revision: previous.revision } : {}),
    });
    notes.value = previous
      ? notes.value.map((note) => (note.id === result.id ? result : note))
      : [result, ...notes.value];
    draft.value = undefined;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    saving.value = false;
  }
}

async function remove(note: FileNote) {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await api.deleteFileNote(props.fileId, note.id, note.revision);
    notes.value = notes.value.filter(({ id }) => id !== note.id);
    confirming.value = undefined;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <p class="file-notes-name muted" :title="fileName">{{ fileName }}</p>
  <div v-if="draft !== undefined">
    <div class="file-note-editor">
      <div
        class="file-note-toolbar"
        role="group"
        :aria-label="t('Форматирование заметки')"
      >
        <button
          v-for="control in controls"
          :key="control.id"
          type="button"
          class="icon-button"
          :title="control.label"
          :aria-label="control.label"
          :aria-pressed="activeControls.has(control.id)"
          :disabled="saving"
          @mousedown.prevent
          @click="editor && control.apply(editor)"
        >
          <i aria-hidden="true" :class="control.icon"></i>
        </button>
      </div>
      <div ref="root" class="file-note-body"></div>
    </div>
    <p class="file-note-count" :class="{ danger: length > noteLimit }">
      {{ length }} / {{ noteLimit }}
    </p>
    <p v-if="length > noteLimit" class="error" role="status">
      {{ t("Заметка может содержать до 500 символов.") }}
    </p>
    <div class="dialog-footer">
      <button
        type="button"
        class="button"
        :disabled="saving"
        @click="
          draft = undefined;
          error = '';
        "
      >
        {{ t("Отмена") }}
      </button>
      <button
        type="button"
        class="button primary"
        :disabled="saving || !text.trim() || length > noteLimit"
        @click="save"
      >
        {{ t("Сохранить") }}
      </button>
    </div>
  </div>
  <template v-else>
    <p v-if="loading" role="status" class="muted">
      {{ t("Загрузка заметок…") }}
    </p>
    <template v-else>
      <button
        type="button"
        class="button"
        :disabled="saving"
        @click="edit(null)"
      >
        <i aria-hidden="true" class="ri-add-line"></i
        >{{ t("Добавить заметку") }}
      </button>
      <p v-if="!notes.length && !error" class="file-note-empty muted">
        {{ t("Заметок пока нет") }}
      </p>
      <div v-else class="file-note-list">
        <article v-for="note in rendered" :key="note.id" class="file-note-card">
          <header>
            <time :datetime="note.updated_at">{{
              dateTime(note.updated_at)
            }}</time>
            <div v-if="confirming !== note.id">
              <button
                type="button"
                class="icon-button small"
                :disabled="saving"
                :title="t('Изменить заметку')"
                :aria-label="t('Изменить заметку')"
                @click="edit(note)"
              >
                <i aria-hidden="true" class="ri-edit-line"></i>
              </button>
              <button
                type="button"
                class="icon-button small"
                :disabled="saving"
                :title="t('Удалить заметку')"
                :aria-label="t('Удалить заметку')"
                @click="confirming = note.id"
              >
                <i aria-hidden="true" class="ri-delete-bin-line"></i>
              </button>
            </div>
          </header>
          <div class="file-note-body" v-html="note.html"></div>
          <div v-if="confirming === note.id" class="file-note-confirm">
            <span>{{ t("Удалить заметку?") }}</span>
            <button
              type="button"
              class="button"
              :disabled="saving"
              @click="confirming = undefined"
            >
              {{ t("Отмена") }}
            </button>
            <button
              type="button"
              class="button danger"
              :disabled="saving"
              @click="remove(note)"
            >
              {{ t("Удалить") }}
            </button>
          </div>
        </article>
      </div>
    </template>
  </template>
  <div v-if="error" class="file-note-error">
    <p class="error" role="alert">{{ error }}</p>
    <button type="button" class="text-button" :disabled="saving" @click="load">
      {{ t("Обновить") }}
    </button>
  </div>
</template>
