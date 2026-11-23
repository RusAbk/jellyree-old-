<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";
import {
  undo,
  redo,
  undoDepth,
  redoDepth,
  indentWithTab,
  isolateHistory,
} from "@codemirror/commands";
import { openSearchPanel, gotoLine } from "@codemirror/search";
import { api } from "./api";
import { t, language } from "./i18n";
import { textDocumentInfo, encodeTextDocument } from "./document-text";
import MarkdownPreview from "./MarkdownPreview.vue";
import type { DriveFile } from "./types";
const props = defineProps<{
  data: Uint8Array;
  encoding: string;
  markdown: boolean;
  save: (data: Uint8Array) => Promise<{ file: DriveFile; warning?: string }>;
}>();
const emit = defineEmits<{ back: []; close: [] }>();
const info = textDocumentInfo(props.data, props.encoding);
const draft = ref(info.text),
  baseline = ref(info.text),
  previewText = ref(info.text);
const owner = crypto.randomUUID();
const dirty = computed(() => draft.value !== baseline.value);
const preview = ref(
  localStorage.getItem("jellyree-desktop-markdown-preview") !== "off",
);
const wrap = ref(true),
  fontSize = ref(14),
  busy = ref(false),
  error = ref(""),
  message = ref("");
const canUndo = ref(false),
  canRedo = ref(false),
  line = ref(1),
  column = ref(1);
const host = ref<HTMLElement>(),
  root = ref<HTMLElement>(),
  dialog = ref<HTMLElement>(),
  cancelButton = ref<HTMLButtonElement>();
const confirming = ref(false);
const wrapConfig = new Compartment(),
  phrasesConfig = new Compartment();
let view: EditorView | undefined,
  disposed = false,
  previewTimer: ReturnType<typeof setTimeout> | undefined;
let leavePromise: Promise<boolean> | undefined,
  leaveResolve: ((leave: boolean) => void) | undefined;
function phrases() {
  return EditorState.phrases.of({
    Find: t("Найти"),
    Replace: t("Заменить"),
    next: t("Далее"),
    previous: t("Назад"),
    all: t("Все"),
    "match case": t("Учитывать регистр"),
    "by word": t("Слова целиком"),
    regexp: t("Регулярное выражение"),
    replace: t("Заменить"),
    "replace all": t("Заменить всё"),
    close: t("Закрыть"),
    "Go to line": t("Перейти к строке"),
    go: t("Перейти"),
  });
}
function syncDraft() {
  void api.setDocumentDraft(owner, dirty.value || busy.value).catch(() => {
    if (!disposed)
      error.value = t(
        "Не удалось включить защиту несохранённых изменений. Перезапустите приложение.",
      );
  });
}
watch([dirty, busy], syncDraft, { flush: "sync" });
watch(draft, (value) => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewText.value = value;
  }, 150);
  message.value = "";
});
watch(preview, (value) =>
  localStorage.setItem(
    "jellyree-desktop-markdown-preview",
    value ? "on" : "off",
  ),
);
watch(wrap, (value) =>
  view?.dispatch({
    effects: wrapConfig.reconfigure(value ? EditorView.lineWrapping : []),
  }),
);
watch(language, () =>
  view?.dispatch({ effects: phrasesConfig.reconfigure(phrases()) }),
);
watch(fontSize, () => {
  void nextTick(() => view?.requestMeasure());
});
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || busy.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
async function save() {
  if (busy.value) return false;
  if (!dirty.value) return true;
  const snapshot = draft.value,
    data = encodeTextDocument(snapshot, info);
  if (data.length > 4 * 1024 * 1024) {
    error.value = t("Для редактирования доступны текстовые файлы до 4 МБ.");
    return false;
  }
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const result = await props.save(data);
    if (disposed) return true;
    baseline.value = snapshot;
    message.value =
      result.warning ||
      (draft.value === snapshot
        ? t("Документ сохранён.")
        : t("Версия сохранена. Новые правки ещё не сохранены."));
    return true;
  } catch (cause) {
    if (!disposed) error.value = (cause as Error).message;
    return false;
  } finally {
    if (!disposed) busy.value = false;
  }
}
function resolveLeave(value: boolean) {
  confirming.value = false;
  const resolve = leaveResolve;
  leavePromise = undefined;
  leaveResolve = undefined;
  resolve?.(value);
  if (!value) view?.focus();
}
async function saveAndLeave() {
  if (await save()) {
    // Typing remains available during saving. Never discard edits made after the snapshot.
    if (!dirty.value) resolveLeave(true);
  }
}
function requestLeave(): Promise<boolean> {
  if (busy.value) {
    message.value = t("Дождитесь окончания сохранения.");
    return Promise.resolve(false);
  }
  if (!dirty.value) return Promise.resolve(true);
  if (leavePromise) return leavePromise;
  confirming.value = true;
  leavePromise = new Promise((resolve) => {
    leaveResolve = resolve;
  });
  void nextTick(() => cancelButton.value?.focus());
  return leavePromise;
}
async function back() {
  if (await requestLeave()) emit("back");
}
function surround(before: string, after = before, placeholder = t("Текст")) {
  if (!view) return;
  const { from, to } = view.state.selection.main,
    selection = view.state.sliceDoc(from, to) || placeholder;
  view.dispatch({
    changes: { from, to, insert: before + selection + after },
    selection: {
      anchor: from + before.length,
      head: from + before.length + selection.length,
    },
    userEvent: "input",
    annotations: isolateHistory.of("full"),
  });
  view.focus();
}
function prefix(value: string) {
  if (!view) return;
  const selection = view.state.selection.main;
  const first = view.state.doc.lineAt(selection.from),
    last = view.state.doc.lineAt(selection.to);
  const changes = [];
  for (let number = first.number; number <= last.number; number++)
    changes.push({ from: view.state.doc.line(number).from, insert: value });
  view.dispatch({
    changes,
    userEvent: "input",
    annotations: isolateHistory.of("full"),
  });
  view.focus();
}
function command(action: (view: EditorView) => boolean) {
  if (view) {
    action(view);
    view.focus();
  }
}
function keydown(event: KeyboardEvent) {
  if (confirming.value) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy.value) resolveLeave(false);
    }
    if (event.key === "Tab") {
      const buttons = [
        ...(dialog.value?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) || []),
      ];
      const first = buttons[0],
        last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    return;
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "s" &&
    !event.defaultPrevented
  ) {
    event.preventDefault();
    event.stopPropagation();
    void save();
    return;
  }
  if (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !view?.dom.querySelector(".cm-search")
  ) {
    event.preventDefault();
    emit("close");
  }
  if (
    [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Escape",
    ].includes(event.key)
  )
    event.stopPropagation();
}
onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: info.text,
      extensions: [
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              void save();
              return true;
            },
          },
          ...(props.markdown
            ? [
                {
                  key: "Mod-b",
                  run: () => {
                    surround("**");
                    return true;
                  },
                },
                {
                  key: "Mod-i",
                  run: () => {
                    surround("*");
                    return true;
                  },
                },
              ]
            : []),
          indentWithTab,
        ]),
        basicSetup,
        props.markdown ? markdownLanguage() : [],
        wrapConfig.of(EditorView.lineWrapping),
        phrasesConfig.of(phrases()),
        EditorView.contentAttributes.of({
          "aria-label": t("Текст документа"),
          spellcheck: "false",
        }),
        EditorView.theme(
          {
            "&": {
              height: "100%",
              fontSize: "inherit",
              backgroundColor: "#1b1f2c",
              color: "#dce0ed",
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
            },
            ".cm-content": { padding: "16px 0", caretColor: "#cfb7ff" },
            ".cm-line": { padding: "0 16px" },
            ".cm-gutters": {
              backgroundColor: "#202535",
              color: "#7c86a2",
              borderRight: "1px solid #343b50",
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: "#2a3043",
            },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
              backgroundColor: "#5b497a !important",
            },
            ".cm-panels": { backgroundColor: "#252a3b", color: "#e1e4f0" },
            ".cm-textfield, .cm-button": {
              background: "#1b1f2c",
              color: "#e1e4f0",
              border: "1px solid #454c65",
            },
            ".cm-cursor": { borderLeftColor: "#cfb7ff" },
          },
          { dark: true },
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) draft.value = update.state.doc.toString();
          if (update.docChanged || update.selectionSet) {
            const position = update.state.selection.main.head,
              currentLine = update.state.doc.lineAt(position);
            line.value = currentLine.number;
            column.value = position - currentLine.from + 1;
            canUndo.value = undoDepth(update.state) > 0;
            canRedo.value = redoDepth(update.state) > 0;
          }
        }),
      ],
    }),
  });
  view.focus();
});
onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener("beforeunload", beforeUnload);
  clearTimeout(previewTimer);
  view?.destroy();
  void api.setDocumentDraft(owner, false).catch(() => {});
  leaveResolve?.(false);
});
defineExpose({ requestLeave });
</script>
<template>
  <section
    ref="root"
    class="document-viewer text-editor"
    :aria-label="markdown ? t('Редактор Markdown') : t('Редактор текста')"
    @keydown="keydown"
    :style="{ '--editor-font-size': `${fontSize}px` }"
  >
    <div class="document-toolbar" :inert="confirming">
      <button class="button primary" :disabled="!dirty || busy" @click="save">
        <i
          aria-hidden="true"
          :class="busy ? 'ri-loader-4-line spinning' : 'ri-save-line'"
        ></i
        >{{ busy ? t("Сохранение…") : t("Сохранить") }}
      </button>
      <button class="button" :disabled="busy" @click="back">
        {{ t("К просмотру") }}
      </button>
      <button
        class="icon-button"
        :aria-label="t('Отменить действие')"
        :disabled="!canUndo"
        @click="command(undo)"
      >
        <i aria-hidden="true" class="ri-arrow-go-back-line"></i>
      </button>
      <button
        class="icon-button"
        :aria-label="t('Повторить действие')"
        :disabled="!canRedo"
        @click="command(redo)"
      >
        <i aria-hidden="true" class="ri-arrow-go-forward-line"></i>
      </button>
      <button class="button" @click="command(openSearchPanel)">
        <i aria-hidden="true" class="ri-search-line"></i
        >{{ t("Поиск и замена") }}
      </button>
      <button
        class="icon-button"
        :aria-label="t('Перейти к строке')"
        @click="command(gotoLine)"
      >
        <i aria-hidden="true" class="ri-list-ordered-2"></i>
      </button>
      <label
        ><input v-model="wrap" type="checkbox" />{{ t("Перенос строк") }}</label
      >
      <label
        >{{ t("Размер текста")
        }}<select v-model.number="fontSize" :aria-label="t('Размер текста')">
          <option
            v-for="size in [12, 14, 16, 18, 20, 24]"
            :key="size"
            :value="size"
          >
            {{ size }} px
          </option>
        </select></label
      >
      <button
        v-if="markdown"
        class="button preview-toggle"
        :aria-pressed="preview"
        @click="preview = !preview"
      >
        <i aria-hidden="true" class="ri-layout-column-line"></i
        >{{ t("Предпросмотр") }}
      </button>
    </div>
    <div
      v-if="markdown"
      class="document-toolbar markdown-tools"
      :inert="confirming"
    >
      <button
        class="icon-button"
        :aria-label="t('Жирный текст')"
        @click="surround('**')"
      >
        <i aria-hidden="true" class="ri-bold"></i></button
      ><button
        class="icon-button"
        :aria-label="t('Курсив')"
        @click="surround('*')"
      >
        <i aria-hidden="true" class="ri-italic"></i></button
      ><button
        class="icon-button"
        :aria-label="t('Заголовок')"
        @click="prefix('## ')"
      >
        <i aria-hidden="true" class="ri-h-2"></i></button
      ><button
        class="icon-button"
        :aria-label="t('Список')"
        @click="prefix('- ')"
      >
        <i aria-hidden="true" class="ri-list-unordered"></i></button
      ><button
        class="icon-button"
        :aria-label="t('Цитата')"
        @click="prefix('> ')"
      >
        <i aria-hidden="true" class="ri-double-quotes-l"></i></button
      ><button
        class="icon-button"
        :aria-label="t('Код')"
        @click="surround('`')"
      >
        <i aria-hidden="true" class="ri-code-line"></i></button
      ><button
        class="icon-button"
        :aria-label="t('Блок кода')"
        @click="surround('```\n', '\n```')"
      >
        <i aria-hidden="true" class="ri-code-box-line"></i></button
      ><button
        class="icon-button"
        :aria-label="t('Ссылка')"
        @click="surround('[', '](https://example.com)')"
      >
        <i aria-hidden="true" class="ri-link"></i>
      </button>
    </div>
    <div
      class="text-editor-body"
      :class="{ 'preview-enabled': markdown && preview }"
      :inert="confirming"
    >
      <div ref="host" class="code-editor-host"></div>
      <div
        v-if="markdown && preview"
        class="text-editor-preview text-content"
        :aria-label="t('Предпросмотр Markdown')"
        tabindex="0"
      >
        <MarkdownPreview :text="previewText" />
      </div>
    </div>
    <div class="text-editor-status" role="status">
      <span>{{
        t("Строка {0}, столбец {1}", { "0": line, "1": column })
      }}</span><span>{{
        dirty ? t("Есть изменения") : t("Все изменения сохранены")
      }}</span
      ><span>{{ t("Сохранение в UTF-8") }} · Ctrl/Cmd+S</span>
    </div>
    <p
      v-if="error && !confirming"
      class="text-editor-message error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-else-if="message && !confirming"
      class="text-editor-message"
      role="status"
    >
      {{ message }}
    </p>
    <div v-if="confirming" class="document-discard-backdrop">
      <div
        ref="dialog"
        class="document-discard-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('Несохранённые изменения')"
      >
        <h2>{{ t("Несохранённые изменения") }}</h2>
        <p>{{ t("Сохранить изменения перед выходом?") }}</p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div>
          <button class="button primary" :disabled="busy" @click="saveAndLeave">
            {{
              busy ? t("Сохранение…") : t("Сохранить и выйти")
            }}</button><button
            class="button"
            :disabled="busy"
            @click="resolveLeave(true)"
          >
            {{ t("Не сохранять") }}</button
          ><button
            ref="cancelButton"
            class="button"
            :disabled="busy"
            @click="resolveLeave(false)"
          >
            {{ t("Продолжить редактирование") }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
