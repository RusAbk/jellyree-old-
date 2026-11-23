<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import FileThumb from "./FileThumb.vue";
import SettingsPanel from "./SettingsPanel.vue";
import { bytes, date, icon, imageStyle } from "./format";
import type {
  Adjustments,
  DriveFile,
  FilePatch,
  Folder,
  Progress,
  Settings,
  Stats,
  UploadResult,
} from "./types";

const api = window.jellyree;
const settings = ref<Settings>({ configured: false, persisted: false });
const settingsOpen = ref(false),
  ready = ref(false),
  section = ref("drive"),
  folderId = ref<string | null>(null);
const files = ref<DriveFile[]>([]),
  folders = ref<Folder[]>([]),
  stats = ref<Stats>({ files: 0, bytes: 0, trashed: 0, tags: [] });
const search = ref(""),
  tag = ref(""),
  sort = ref("date"),
  view = ref(localStorage.getItem("jellyree-desktop-view") || "grid");
const selection = ref<string[]>([]),
  loading = ref(false),
  busy = ref(false),
  total = ref(0),
  hasMore = ref(false),
  page = ref(1);
const error = ref(""),
  notice = ref(""),
  progress = ref<Progress | null>(null),
  dragging = ref(false);
const preview = ref<DriveFile | null>(null),
  previewUrl = ref(""),
  previewError = ref(""),
  previewLoading = ref(false),
  editing = ref(false);
const adjustments = reactive({
  brightness: 100,
  contrast: 100,
  saturation: 100,
  rotate: 0,
});
const expanded = ref(new Set<string>());
const modal = ref<{
  kind: string;
  title: string;
  input: string;
  ids: string[];
  target: string;
  folder?: Folder;
} | null>(null);
let generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  previewGeneration = 0,
  unsubscribe: (() => void) | undefined;

const nav = [
  { id: "drive", label: "Мой диск", icon: "ri-hard-drive-3-line" },
  { id: "all", label: "Все файлы", icon: "ri-stack-line" },
  { id: "photos", label: "Фото и видео", icon: "ri-image-2-line" },
  { id: "favorites", label: "Избранное", icon: "ri-star-line" },
  { id: "trash", label: "Корзина", icon: "ri-delete-bin-6-line" },
];
const currentFolder = computed(() =>
  folders.value.find((f) => f.id === folderId.value),
);
const title = computed(() =>
  tag.value
    ? `#${tag.value}`
    : currentFolder.value && section.value === "drive"
      ? currentFolder.value.name
      : nav.find((n) => n.id === section.value)?.label || "Мой диск",
);
const childFolders = computed(() =>
  section.value === "drive" && !tag.value
    ? folders.value.filter((f) =>
        search.value
          ? f.name
              .toLocaleLowerCase()
              .includes(search.value.toLocaleLowerCase())
          : f.parent_id === folderId.value,
      )
    : [],
);
const breadcrumbs = computed(() => {
  const list: Folder[] = [],
    seen = new Set<string>();
  let current = currentFolder.value;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    list.unshift(current);
    current = folders.value.find((f) => f.id === current?.parent_id);
  }
  return list;
});
const folderTree = computed(() => {
  const result: { folder: Folder; depth: number; hasChildren: boolean }[] = [],
    seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const folder of folders.value.filter((f) => f.parent_id === parent)) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      const hasChildren = folders.value.some((f) => f.parent_id === folder.id);
      result.push({ folder, depth, hasChildren });
      if (expanded.value.has(folder.id)) walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return result;
});
const folderOptions = computed(() =>
  folders.value
    .map((folder) => {
      const parts = [folder.name],
        seen = new Set([folder.id]);
      let parent = folder.parent_id;
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        const f = folders.value.find((f) => f.id === parent);
        if (!f) break;
        parts.unshift(f.name);
        parent = f.parent_id;
      }
      return { id: folder.id, name: parts.join(" / ") };
    })
    .sort((a, b) => a.name.localeCompare(b.name)),
);
const inspectorOpen = ref(false);
const selectedFile = computed(() =>
  selection.value.length === 1
    ? files.value.find((f) => f.id === selection.value[0])
    : null,
);
const allSelected = computed(
  () =>
    files.value.length > 0 &&
    files.value.every((f) => selection.value.includes(f.id)),
);
const uploadFolder = computed(() =>
  section.value === "drive" ? folderId.value : null,
);
const progressPercent = computed(() =>
  progress.value?.totalBytes
    ? Math.min(
        100,
        Math.round(
          ((progress.value.loaded || 0) * 100) / progress.value.totalBytes,
        ),
      )
    : progress.value?.total
      ? Math.round((progress.value.done * 100) / progress.value.total)
      : 0,
);
const scope = computed(
  () =>
    `${settings.value.accountId}/${settings.value.bucket}/${settings.value.prefix}`,
);

function toggleExpanded(id: string) {
  const set = new Set(expanded.value);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  expanded.value = set;
}
function navigate(next: string, id: string | null = null, nextTag = "") {
  section.value = next;
  folderId.value = id;
  tag.value = nextTag;
  selection.value = [];
  search.value = "";
  for (const f of breadcrumbs.value) expanded.value.add(f.id);
  void reload();
}
async function reload(more = false) {
  if (!settings.value.configured) return;
  const id = ++generation,
    nextPage = more ? page.value + 1 : 1;
  loading.value = true;
  error.value = "";
  try {
    const [result, tree, usage] = await Promise.all([
      api.list({
        section: section.value,
        folderId: folderId.value,
        search: search.value,
        tag: tag.value,
        sort: sort.value,
        page: nextPage,
      }),
      more ? Promise.resolve(folders.value) : api.folders(),
      more ? Promise.resolve(stats.value) : api.stats(),
    ]);
    if (id !== generation) return;
    files.value = more ? [...files.value, ...result.items] : result.items;
    folders.value = tree;
    stats.value = usage;
    total.value = result.total;
    hasMore.value = result.hasMore;
    page.value = nextPage;
    selection.value = selection.value.filter((s) =>
      files.value.some((f) => f.id === s),
    );
    if (preview.value)
      preview.value =
        files.value.find((f) => f.id === preview.value?.id) || preview.value;
  } catch (e) {
    if (id === generation) error.value = (e as Error).message;
  } finally {
    if (id === generation) loading.value = false;
  }
}
async function action(fn: () => Promise<unknown>, message = "") {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  progress.value = null;
  try {
    await fn();
    if (message) notice.value = message;
    const operationError = error.value;
    await reload();
    if (operationError) error.value = operationError;
    return true;
  } catch (e) {
    const message = (e as Error).message;
    await reload();
    error.value = message;
    return false;
  } finally {
    busy.value = false;
    progress.value = null;
  }
}
function dragleave(event: DragEvent) {
  if (!event.relatedTarget) dragging.value = false;
}
function dragover(event: DragEvent) {
  event.preventDefault();
  if (event.dataTransfer?.types.includes("Files")) dragging.value = true;
}
function select(file: DriveFile, event?: MouseEvent) {
  if (event?.metaKey || event?.ctrlKey || event?.shiftKey) {
    selection.value = selection.value.includes(file.id)
      ? selection.value.filter((id) => id !== file.id)
      : [...selection.value, file.id];
  } else selection.value = [file.id];
}
function toggleSelect(id: string) {
  selection.value = selection.value.includes(id)
    ? selection.value.filter((i) => i !== id)
    : [...selection.value, id];
}
function patch(ids: string[], input: FilePatch, message = "") {
  return action(() => api.update(ids, input), message);
}
async function upload(folders = false, dropped?: File[]) {
  if (!settings.value.configured) {
    settingsOpen.value = true;
    return;
  }
  await action(async () => {
    const result: UploadResult = dropped
      ? await api.dropUpload(dropped, uploadFolder.value)
      : await api.pickUpload(uploadFolder.value, folders);
    if (result.failures.length) {
      error.value = `Загружено: ${result.done}. Ошибок: ${result.failures.length}. ${result.failures.map((f) => `${f.name}: ${f.message}`).join("; ")}`;
    }
    notice.value = `Загружено файлов: ${result.done}`;
  });
}
async function drop(event: DragEvent) {
  event.preventDefault();
  dragging.value = false;
  if (!busy.value && event.dataTransfer?.files.length)
    await upload(false, Array.from(event.dataTransfer.files));
}
function openModal(kind: string, ids = selection.value, folder?: Folder) {
  const titles: Record<string, string> = {
    createFolder: "Новая папка",
    rename: "Переименовать файл",
    tags: "Теги",
    move: "Переместить файлы",
    renameFolder: "Переименовать папку",
    moveFolder: "Переместить папку",
    deleteFolder: "Удалить пустую папку?",
    delete: "Удалить навсегда?",
    import: "Добавить существующие объекты R2?",
  };
  const file = files.value.find((f) => f.id === ids[0]);
  modal.value = {
    kind,
    title: titles[kind] || kind,
    input:
      kind === "rename"
        ? file?.name || ""
        : kind === "tags"
          ? file?.tags.join(", ") || ""
          : kind === "renameFolder"
            ? folder?.name || ""
            : "",
    ids: [...ids],
    target: "",
    folder,
  };
}
async function submitModal() {
  const value = modal.value;
  if (!value) return;
  const success = await action(async () => {
    if (value.kind === "createFolder")
      await api.createFolder(value.input, uploadFolder.value);
    if (value.kind === "rename")
      await api.update(value.ids, { name: value.input });
    if (value.kind === "tags")
      await api.update(value.ids, {
        tags: value.input
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
    if (value.kind === "move")
      await api.update(value.ids, { folderId: value.target || null });
    if (value.kind === "renameFolder" && value.folder)
      await api.updateFolder(value.folder.id, { name: value.input });
    if (value.kind === "moveFolder" && value.folder)
      await api.updateFolder(value.folder.id, {
        parentId: value.target || null,
      });
    if (value.kind === "deleteFolder" && value.folder) {
      await api.deleteFolder(value.folder.id);
      folderId.value = value.folder.parent_id || null;
    }
    if (value.kind === "delete") {
      await api.remove(value.ids);
      if (preview.value && value.ids.includes(preview.value.id)) closePreview();
    }
    if (value.kind === "import") {
      const result = await api.importBucket();
      notice.value = `Проверено объектов: ${result.scanned}`;
    }
  });
  if (success) modal.value = null;
}
async function openPreview(file: DriveFile) {
  const id = ++previewGeneration;
  preview.value = file;
  previewUrl.value = "";
  previewError.value = "";
  previewLoading.value = true;
  editing.value = false;
  Object.assign(
    adjustments,
    { brightness: 100, contrast: 100, saturation: 100, rotate: 0 },
    file.adjustments,
  );
  try {
    const url = await api.url(file.id);
    if (id === previewGeneration) previewUrl.value = url;
  } catch (e) {
    if (id === previewGeneration) previewError.value = (e as Error).message;
  } finally {
    if (id === previewGeneration) previewLoading.value = false;
  }
}
function closePreview() {
  previewGeneration++;
  preview.value = null;
  previewUrl.value = "";
  editing.value = false;
}
function nextPreview(direction: number) {
  const index = files.value.findIndex((f) => f.id === preview.value?.id),
    next = files.value[index + direction];
  if (next) void openPreview(next);
}
async function saveEdits() {
  if (!preview.value) return;
  if (
    await patch(
      [preview.value.id],
      { adjustments: { ...adjustments } },
      "Коррекция сохранена. Оригинал сохранён в R2.",
    )
  )
    editing.value = false;
}
async function download(ids = selection.value) {
  await action(async () => {
    const result = await api.download(ids);
    notice.value = `Скачано файлов: ${result.done}`;
  });
}
async function share(id: string) {
  await action(
    () => api.share(id),
    "Ссылка скопирована. Действует 1 час; доступна всем, у кого она есть.",
  );
}
async function saved(value: Settings) {
  ++generation;
  closePreview();
  settings.value = value;
  settingsOpen.value = false;
  files.value = [];
  folders.value = [];
  selection.value = [];
  folderId.value = null;
  section.value = "drive";
  tag.value = "";
  search.value = "";
  notice.value = value.persisted
    ? "Подключение сохранено на этом устройстве."
    : "Системное хранилище ключей недоступно. Реквизиты будут забыты при закрытии.";
  await reload();
}
function disconnected() {
  ++generation;
  closePreview();
  settings.value = { configured: false, persisted: false };
  settingsOpen.value = false;
  files.value = [];
  folders.value = [];
  selection.value = [];
  stats.value = { files: 0, bytes: 0, trashed: 0, tags: [] };
  folderId.value = null;
  search.value = "";
  tag.value = "";
  total.value = 0;
  error.value = "";
  notice.value = "Подключение удалено с устройства.";
}
function keydown(event: KeyboardEvent) {
  if (settingsOpen.value) return;
  if (
    event.target instanceof HTMLElement &&
    (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) ||
      event.target.isContentEditable)
  )
    return;
  if (event.key === "Escape") {
    if (busy.value) return;
    if (modal.value) modal.value = null;
    else if (preview.value) closePreview();
    else selection.value = [];
  }
  if (settingsOpen.value || modal.value) return;
  if (preview.value) {
    if (event.key === "ArrowRight") nextPreview(1);
    if (event.key === "ArrowLeft") nextPreview(-1);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "a") {
    event.preventDefault();
    selection.value = files.value.map((f) => f.id);
  }
  if (event.key === "Delete" && selection.value.length && !busy.value) {
    if (section.value === "trash") openModal("delete");
    else
      void patch(
        selection.value,
        { trashed: true },
        "Файлы перемещены в корзину.",
      );
  }
}
watch(search, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    selection.value = [];
    void reload();
  }, 300);
});
watch(sort, () => {
  void reload();
});
watch(view, (value) => localStorage.setItem("jellyree-desktop-view", value));
onMounted(async () => {
  document.addEventListener("keydown", keydown);
  if (!api) {
    error.value =
      "Откройте приложение через Electron: npm run dev или npm start.";
    ready.value = true;
    return;
  }
  unsubscribe = api.onProgress((p) => {
    progress.value = p;
  });
  try {
    settings.value = await api.settings.get();
    if (settings.value.startupError) error.value = settings.value.startupError;
    if (settings.value.configured) await reload();
    else settingsOpen.value = true;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    ready.value = true;
  }
});
onBeforeUnmount(() => {
  unsubscribe?.();
  clearTimeout(timer);
  document.removeEventListener("keydown", keydown);
});
</script>

<template>
  <div
    class="app-shell"
    @dragover="dragover"
    @dragleave="dragleave"
    @drop="drop"
  >
    <aside class="sidebar">
      <a class="brand" href="#" @click.prevent="navigate('drive')"
        ><span class="brand-mark"
          ><i aria-hidden="true" class="ri-bubble-chart-fill"></i></span
        ><span>jellyree<small>ВАШ ЛИЧНЫЙ ДИСК</small></span></a
      >
      <button
        class="button primary upload-button"
        :disabled="busy || !ready"
        @click="upload()"
      >
        <i aria-hidden="true" class="ri-add-line"></i> Загрузить файлы
      </button>
      <nav class="main-nav" aria-label="Библиотека">
        <button
          v-for="item in nav"
          :key="item.id"
          :class="{ active: section === item.id && !folderId && !tag }"
          @click="navigate(item.id)"
        >
          <i aria-hidden="true" :class="item.icon"></i>{{ item.label
          }}<span
            v-if="item.id === 'trash' && stats.trashed"
            class="nav-count"
            >{{ stats.trashed }}</span
          >
        </button>
      </nav>
      <div class="sidebar-label">
        <span>ПАПКИ</span
        ><button
          class="icon-button small"
          title="Новая папка"
          aria-label="Новая папка"
          :disabled="busy || !settings.configured"
          @click="openModal('createFolder')"
        >
          <i aria-hidden="true" class="ri-add-line"></i>
        </button>
      </div>
      <div class="folder-tree">
        <p v-if="!folders.length" class="sidebar-hint">
          Ваши папки появятся здесь
        </p>
        <div
          v-for="node in folderTree"
          :key="node.folder.id"
          class="tree-row"
          :class="{
            active: folderId === node.folder.id && section === 'drive',
          }"
          :style="{ paddingLeft: `${8 + node.depth * 14}px` }"
        >
          <button
            class="tree-chevron"
            :aria-label="
              expanded.has(node.folder.id) ? 'Свернуть' : 'Развернуть'
            "
            @click="toggleExpanded(node.folder.id)"
          >
            <i
              aria-hidden="true"
              v-if="node.hasChildren"
              :class="
                expanded.has(node.folder.id)
                  ? 'ri-arrow-down-s-line'
                  : 'ri-arrow-right-s-line'
              "
            ></i></button
          ><button
            class="tree-folder"
            :title="node.folder.name"
            @click="navigate('drive', node.folder.id)"
          >
            <i aria-hidden="true" class="ri-folder-3-line"></i
            ><span>{{ node.folder.name }}</span>
          </button>
        </div>
      </div>
      <template v-if="stats.tags.length"
        ><div class="sidebar-label">ТЕГИ</div>
        <div class="sidebar-tags">
          <button
            v-for="name in stats.tags"
            :key="name"
            :class="{ active: tag === name }"
            @click="navigate('all', null, name)"
          >
            # {{ name }}
          </button>
        </div></template
      >
      <div class="cloud-status">
        <div class="cloud-status-top">
          <i aria-hidden="true" class="ri-cloud-line"></i
          ><span>{{
            settings.configured ? "Cloudflare R2" : "Облако не подключено"
          }}</span
          ><span
            class="status-dot"
            :class="{ connected: settings.configured }"
          ></span>
        </div>
        <strong
          >{{ bytes(stats.bytes) }}
          <span>· {{ stats.files }} файлов</span></strong
        ><small>{{ settings.bucket || "Подключите своё хранилище" }}</small
        ><small
          v-if="settings.configured && !settings.persisted"
          class="session-only"
          >Ключи только на эту сессию</small
        >
      </div>
      <button
        class="settings-link"
        :disabled="busy"
        @click="settingsOpen = true"
      >
        <i aria-hidden="true" class="ri-settings-3-line"></i>Настройки
        подключения<i aria-hidden="true" class="ri-arrow-right-s-line"></i>
      </button>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <div class="search-box">
          <i aria-hidden="true" class="ri-search-line"></i
          ><input
            v-model="search"
            aria-label="Поиск файлов и тегов"
            placeholder="Поиск файлов и тегов"
          /><button
            v-if="search"
            class="icon-button small"
            aria-label="Очистить поиск"
            @click="search = ''"
          >
            <i aria-hidden="true" class="ri-close-line"></i></button
          ><kbd>Ctrl A</kbd>
        </div>
        <span class="direct-badge"
          ><span
            class="status-dot"
            :class="{ connected: settings.configured }"
          ></span
          >R2 + D1</span
        ><button
          class="icon-button"
          title="Обновить"
          aria-label="Обновить"
          :disabled="loading || busy"
          @click="reload()"
        >
          <i
            aria-hidden="true"
            class="ri-refresh-line"
            :class="{ spinning: loading }"
          ></i></button
        ><button
          class="avatar"
          title="Настройки подключения"
          aria-label="Настройки подключения"
          :disabled="busy"
          @click="settingsOpen = true"
        >
          J
        </button>
      </header>
      <div v-if="error" class="banner error" role="alert">
        <i aria-hidden="true" class="ri-error-warning-line"></i
        ><span>{{ error }}</span
        ><button
          class="icon-button small"
          aria-label="Закрыть сообщение"
          @click="error = ''"
        >
          <i aria-hidden="true" class="ri-close-line"></i>
        </button>
      </div>
      <div v-if="notice" class="banner info" role="status">
        <i aria-hidden="true" class="ri-information-line"></i
        ><span>{{ notice }}</span
        ><button
          class="icon-button small"
          aria-label="Закрыть сообщение"
          @click="notice = ''"
        >
          <i aria-hidden="true" class="ri-close-line"></i>
        </button>
      </div>
      <div v-if="busy" class="transfer-bar" role="status">
        <div>
          <i aria-hidden="true" class="ri-loader-4-line spinning"></i
          ><span
            >{{
              progress
                ? {
                    upload: "Загрузка",
                    download: "Скачивание",
                    import: "Индексация R2",
                  }[progress.kind]
                : "Выполняется операция…"
            }}<template v-if="progress">
              · {{ progress.name }} · {{ progress.done
              }}<template v-if="progress.total">
                / {{ progress.total }}</template
              ></template
            ></span
          ><strong v-if="progress?.totalBytes">{{ progressPercent }}%</strong>
        </div>
        <progress v-if="progress" :value="progressPercent" max="100"></progress>
      </div>
      <section class="content">
        <div v-if="section === 'drive' && folderId" class="breadcrumbs">
          <button @click="navigate('drive')">Мой диск</button
          ><template v-for="crumb in breadcrumbs" :key="crumb.id"
            ><i aria-hidden="true" class="ri-arrow-right-s-line"></i
            ><button @click="navigate('drive', crumb.id)">
              {{ crumb.name }}
            </button></template
          >
        </div>
        <header class="page-header">
          <div>
            <span class="eyebrow">{{
              section === "trash" ? "МОЖНО ВОССТАНОВИТЬ" : "ВСЁ НА СВОИХ МЕСТАХ"
            }}</span>
            <h1>{{ title }}</h1>
            <p>
              {{
                settings.configured
                  ? `${total} файлов${childFolders.length ? ` · ${childFolders.length} папок` : ""}`
                  : "Пространство для ваших файлов, фотографий и идей"
              }}
            </p>
          </div>
          <div class="page-actions">
            <template v-if="currentFolder && section === 'drive'"
              ><button
                class="icon-button"
                title="Переименовать папку"
                aria-label="Переименовать папку"
                :disabled="busy"
                @click="openModal('renameFolder', [], currentFolder)"
              >
                <i aria-hidden="true" class="ri-edit-line"></i></button
              ><button
                class="icon-button"
                title="Переместить папку"
                aria-label="Переместить папку"
                :disabled="busy"
                @click="openModal('moveFolder', [], currentFolder)"
              >
                <i
                  aria-hidden="true"
                  class="ri-folder-transfer-line"
                ></i></button
              ><button
                class="icon-button"
                title="Удалить пустую папку"
                aria-label="Удалить пустую папку"
                :disabled="busy"
                @click="openModal('deleteFolder', [], currentFolder)"
              >
                <i
                  aria-hidden="true"
                  class="ri-delete-bin-line"
                ></i></button></template
            ><button
              class="button"
              :disabled="busy || !settings.configured"
              @click="openModal('createFolder')"
            >
              <i aria-hidden="true" class="ri-folder-add-line"></i>Новая папка</button
            ><button
              class="button"
              :disabled="busy || !settings.configured"
              @click="upload(true)"
            >
              <i aria-hidden="true" class="ri-folder-upload-line"></i>Загрузить
              папку
            </button>
          </div>
        </header>

        <div v-if="!settings.configured" class="welcome-state">
          <div class="welcome-illustration">
            <i aria-hidden="true" class="ri-cloud-line"></i
            ><span><i aria-hidden="true" class="ri-folder-3-fill"></i></span>
          </div>
          <h2>Ваши файлы. Ваше облако.</h2>
          <p>
            Подключите R2 и D1, чтобы собрать всё в одном месте.<br />Без
            собственного сервера и промежуточных сервисов.
          </p>
          <button class="button primary" @click="settingsOpen = true">
            <i aria-hidden="true" class="ri-plug-line"></i>Подключить Cloudflare
          </button>
        </div>
        <template v-else>
          <div v-if="childFolders.length" class="folder-grid">
            <button
              v-for="folder in childFolders"
              :key="folder.id"
              class="folder-card"
              :title="folder.name"
              @click="navigate('drive', folder.id)"
            >
              <span class="folder-card-icon"
                ><i aria-hidden="true" class="ri-folder-3-fill"></i></span
              ><span
                >{{ folder.name
                }}<small
                  >{{
                    folders.filter((f) => f.parent_id === folder.id).length
                  }}
                  вложенных папок</small
                ></span
              ><i aria-hidden="true" class="ri-arrow-right-s-line"></i>
            </button>
          </div>
          <div class="toolbar-area">
            <div v-show="!selection.length" class="file-toolbar">
              <div>
                <button
                  class="icon-button small"
                  :title="
                    allSelected
                      ? 'Снять выделение'
                      : 'Выбрать загруженные файлы'
                  "
                  :aria-label="
                    allSelected
                      ? 'Снять выделение'
                      : 'Выбрать загруженные файлы'
                  "
                  @click="selection = allSelected ? [] : files.map((f) => f.id)"
                >
                  <i
                    aria-hidden="true"
                    :class="
                      allSelected
                        ? 'ri-checkbox-fill'
                        : 'ri-checkbox-blank-line'
                    "
                  ></i></button
                ><span>{{
                  selection.length ? `Выбрано: ${selection.length}` : "Файлы"
                }}</span>
              </div>
              <div>
                <select v-model="sort" aria-label="Сортировка">
                  <option value="date">Сначала новые</option>
                  <option value="name">По имени</option>
                  <option value="size">По размеру</option>
                </select>
                <div class="view-switch">
                  <button
                    :class="{ active: view === 'grid' }"
                    aria-label="Сетка"
                    @click="view = 'grid'"
                  >
                    <i aria-hidden="true" class="ri-grid-line"></i></button
                  ><button
                    :class="{ active: view === 'list' }"
                    aria-label="Список"
                    @click="view = 'list'"
                  >
                    <i aria-hidden="true" class="ri-list-check"></i>
                  </button>
                </div>
              </div>
            </div>
            <div v-if="selection.length" class="selection-toolbar">
              <span>{{ selection.length }} выбрано</span
              ><button
                v-if="selection.length === 1"
                class="icon-button small"
                :disabled="busy"
                title="Переименовать"
                aria-label="Переименовать"
                @click="openModal('rename')"
              >
                <i aria-hidden="true" class="ri-edit-line"></i></button
              ><button
                v-if="selection.length === 1"
                class="icon-button small"
                title="Информация"
                aria-label="Информация"
                @click="inspectorOpen = !inspectorOpen"
              >
                <i aria-hidden="true" class="ri-information-line"></i></button
              ><button :disabled="busy" @click="download()">
                <i aria-hidden="true" class="ri-download-2-line"></i
                >Скачать</button
              ><template v-if="section !== 'trash'"
                ><button :disabled="busy" @click="openModal('move')">
                  <i aria-hidden="true" class="ri-folder-transfer-line"></i
                  >Переместить</button
                ><button :disabled="busy" @click="openModal('tags')">
                  <i aria-hidden="true" class="ri-price-tag-3-line"></i
                  >Теги</button
                ><button
                  :disabled="busy"
                  @click="
                    patch(
                      selection,
                      { favorite: true },
                      'Добавлено в избранное.',
                    )
                  "
                >
                  <i aria-hidden="true" class="ri-star-line"></i>В избранное</button
                ><button
                  :disabled="busy"
                  @click="
                    patch(
                      selection,
                      { trashed: true },
                      'Файлы перемещены в корзину.',
                    )
                  "
                >
                  <i aria-hidden="true" class="ri-delete-bin-line"></i>В корзину
                </button></template
              ><template v-else
                ><button
                  :disabled="busy"
                  @click="
                    patch(selection, { trashed: false }, 'Файлы восстановлены.')
                  "
                >
                  <i aria-hidden="true" class="ri-arrow-go-back-line"></i
                  >Восстановить</button
                ><button
                  class="danger"
                  :disabled="busy"
                  @click="openModal('delete')"
                >
                  Удалить навсегда
                </button></template
              ><button
                class="icon-button small"
                aria-label="Снять выделение"
                @click="selection = []"
              >
                <i aria-hidden="true" class="ri-close-line"></i>
              </button>
            </div>
          </div>
          <div v-if="view === 'list' && files.length" class="list-heading">
            <span>Название</span><span>Размер</span><span>Дата добавления</span
            ><span></span>
          </div>
          <div :key="scope" class="files" :class="view" :aria-busy="loading">
            <article
              v-for="file in files"
              :key="file.id"
              class="file-card"
              :class="{ selected: selection.includes(file.id) }"
              tabindex="0"
              @click="select(file, $event)"
              @dblclick="openPreview(file)"
              @keydown.enter="openPreview(file)"
              @keydown.space.prevent="toggleSelect(file.id)"
            >
              <div class="thumb-wrap">
                <FileThumb :file="file" :compact="view === 'list'" /><button
                  class="file-checkbox"
                  :class="{ checked: selection.includes(file.id) }"
                  :aria-label="`Выбрать ${file.name}`"
                  @click.stop="toggleSelect(file.id)"
                >
                  <i
                    aria-hidden="true"
                    :class="
                      selection.includes(file.id)
                        ? 'ri-checkbox-fill'
                        : 'ri-checkbox-blank-line'
                    "
                  ></i></button
                ><button
                  class="favorite-button"
                  :class="{ starred: file.favorite }"
                  :disabled="busy"
                  :aria-label="
                    file.favorite ? 'Убрать из избранного' : 'В избранное'
                  "
                  @click.stop="patch([file.id], { favorite: !file.favorite })"
                >
                  <i
                    aria-hidden="true"
                    :class="file.favorite ? 'ri-star-fill' : 'ri-star-line'"
                  ></i>
                </button>
              </div>
              <div class="file-info">
                <div class="file-name" :title="file.name">
                  <i aria-hidden="true" :class="icon(file.mime_type)"></i
                  ><span>{{ file.name }}</span>
                </div>
                <small v-if="view === 'grid'"
                  >{{ bytes(file.size_bytes) }}<span>·</span
                  >{{ date(file.created_at) }}</small
                >
                <div
                  v-if="file.tags.length && view === 'grid'"
                  class="tag-chips"
                >
                  <span v-for="name in file.tags.slice(0, 3)" :key="name">{{
                    name
                  }}</span>
                </div>
              </div>
              <span v-if="view === 'list'" class="list-meta">{{
                bytes(file.size_bytes)
              }}</span><span v-if="view === 'list'" class="list-meta">{{
                date(file.created_at)
              }}</span
              ><button
                class="file-open icon-button small"
                title="Открыть"
                aria-label="Открыть файл"
                @click.stop="openPreview(file)"
              >
                <i aria-hidden="true" class="ri-arrow-right-up-line"></i>
              </button>
            </article>
          </div>
          <div
            v-if="!files.length && !childFolders.length && !loading"
            class="empty-state"
          >
            <div>
              <i
                aria-hidden="true"
                :class="
                  section === 'trash'
                    ? 'ri-delete-bin-6-line'
                    : search || tag
                      ? 'ri-search-line'
                      : 'ri-folder-open-line'
                "
              ></i>
            </div>
            <h2>
              {{
                search || tag
                  ? "Ничего не найдено"
                  : section === "trash"
                    ? "Корзина пуста"
                    : section === "favorites"
                      ? "Здесь будет избранное"
                      : "Здесь пока свободно"
              }}
            </h2>
            <p>
              {{
                search || tag
                  ? "Попробуйте другое имя или тег."
                  : section === "trash"
                    ? "Удалённые файлы остаются здесь до окончательного удаления."
                    : section === "favorites"
                      ? "Нажмите на звёздочку рядом с нужным файлом."
                      : "Перетащите файлы сюда или загрузите целую папку."
              }}
            </p>
            <button
              v-if="
                !search && !tag && ['drive', 'all', 'photos'].includes(section)
              "
              class="button primary"
              :disabled="busy"
              @click="upload()"
            >
              <i aria-hidden="true" class="ri-upload-cloud-2-line"></i>Загрузить
              файлы</button
            ><button
              v-if="section === 'drive' && !folderId && !search"
              class="text-button"
              :disabled="busy"
              @click="openModal('import')"
            >
              В R2 уже есть файлы? Добавить в каталог
            </button>
          </div>
          <div v-if="loading" class="loading-state">
            <i aria-hidden="true" class="ri-loader-4-line spinning"></i>Загрузка
            каталога…
          </div>
          <button
            v-if="hasMore"
            class="button load-more"
            :disabled="loading"
            @click="reload(true)"
          >
            Показать ещё · {{ files.length }} из {{ total }}
          </button>
        </template>
      </section>
      <footer class="workspace-footer">
        <span
          ><i aria-hidden="true" class="ri-shield-check-line"></i>Прямое
          подключение к вашему Cloudflare</span
        ><button
          v-if="settings.configured"
          class="text-button"
          :disabled="busy"
          @click="openModal('import')"
        >
          Индексировать R2</button
        ><span>Jellyree Desktop</span>
      </footer>
    </main>

    <aside v-if="selectedFile && inspectorOpen" class="inspector">
      <header>
        <strong>Информация</strong
        ><button
          class="icon-button small"
          aria-label="Закрыть информацию"
          @click="inspectorOpen = false"
        >
          <i aria-hidden="true" class="ri-close-line"></i>
        </button>
      </header>
      <FileThumb :key="scope + selectedFile.id" :file="selectedFile" />
      <h3>{{ selectedFile.name }}</h3>
      <button class="button" @click="openPreview(selectedFile)">
        <i aria-hidden="true" class="ri-eye-line"></i>Открыть просмотр
      </button>
      <dl>
        <dt>Тип</dt>
        <dd>{{ selectedFile.mime_type }}</dd>
        <dt>Размер</dt>
        <dd>{{ bytes(selectedFile.size_bytes) }}</dd>
        <dt>Добавлен</dt>
        <dd>{{ date(selectedFile.created_at) }}</dd>
        <dt>Расположение</dt>
        <dd>
          {{
            folders.find((f) => f.id === selectedFile?.folder_id)?.name ||
            "Мой диск"
          }}
        </dd>
      </dl>
      <div class="inspector-tags">
        <strong>Теги</strong
        ><button
          class="icon-button small"
          :disabled="busy"
          aria-label="Изменить теги"
          @click="openModal('tags')"
        >
          <i aria-hidden="true" class="ri-edit-line"></i>
        </button>
      </div>
      <div class="tag-chips">
        <span v-for="name in selectedFile.tags" :key="name">{{
          name
        }}</span><small v-if="!selectedFile.tags.length" class="muted"
          >Теги ещё не добавлены</small
        >
      </div>
      <div class="inspector-actions">
        <button class="button" :disabled="busy" @click="openModal('rename')">
          <i aria-hidden="true" class="ri-edit-line"></i>Переименовать</button
        ><button
          class="button"
          :disabled="busy"
          @click="share(selectedFile.id)"
        >
          <i aria-hidden="true" class="ri-link"></i>Ссылка на 1 час</button
        ><button class="button" :disabled="busy" @click="download()">
          <i aria-hidden="true" class="ri-download-2-line"></i>Скачать оригинал
        </button>
      </div>
    </aside>
    <div v-if="dragging" class="drop-overlay">
      <i aria-hidden="true" class="ri-upload-cloud-2-line"></i>
      <h2>Отпустите, чтобы загрузить</h2>
      <p>{{ uploadFolder ? currentFolder?.name : "Мой диск" }}</p>
    </div>
  </div>

  <SettingsPanel
    v-if="settingsOpen"
    :settings="settings"
    @close="settingsOpen = false"
    @saved="saved"
    @disconnected="disconnected"
  />
  <div v-if="modal" class="overlay" @click.self="!busy && (modal = null)">
    <form
      class="dialog action-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      @submit.prevent="submitModal"
    >
      <header class="dialog-header">
        <h2 id="modal-title">{{ modal.title }}</h2>
        <button
          type="button"
          class="icon-button"
          :disabled="busy"
          aria-label="Закрыть"
          @click="modal = null"
        >
          <i aria-hidden="true" class="ri-close-line"></i>
        </button>
      </header>
      <label
        v-if="
          ['createFolder', 'rename', 'renameFolder', 'tags'].includes(
            modal.kind,
          )
        "
        >{{
          modal.kind === "tags"
            ? "Теги через запятую (заменят текущие)"
            : "Название"
        }}<input
          v-model="modal.input"
          autofocus
          :required="modal.kind !== 'tags'"
          :maxlength="modal.kind === 'tags' ? 3000 : 255"
          :disabled="busy" /></label
      ><label v-if="['move', 'moveFolder'].includes(modal.kind)"
        >Папка назначения<select v-model="modal.target" :disabled="busy">
          <option value="">Мой диск</option>
          <option
            v-for="option in folderOptions.filter(
              (f) => f.id !== modal?.folder?.id,
            )"
            :key="option.id"
            :value="option.id"
          >
            {{ option.name }}
          </option>
        </select></label
      >
      <p v-if="modal.kind === 'delete'" class="muted">
        Будут удалены выбранные файлы ({{ modal.ids.length }}) из R2 и каталога
        D1. Восстановить их будет нельзя.
      </p>
      <p v-if="modal.kind === 'deleteFolder'" class="muted">
        Папку «{{ modal.folder?.name }}» можно удалить, если в ней нет вложенных
        папок и файлов, в том числе в корзине.
      </p>
      <p v-if="modal.kind === 'import'" class="muted">
        Все объекты из bucket «{{ settings.bucket }}» под префиксом «{{
          settings.prefix || "/"
        }}» будут добавлены в корень каталога. Существующие записи не изменятся.
        При пустом префиксе будут учтены все объекты bucket, включая технические
        файлы.
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <footer class="dialog-footer">
        <button
          type="button"
          class="button"
          :disabled="busy"
          @click="modal = null"
        >
          Отмена</button
        ><button
          class="button"
          :class="
            ['delete', 'deleteFolder'].includes(modal.kind)
              ? 'danger-fill'
              : 'primary'
          "
          :disabled="busy"
        >
          {{
            busy
              ? "Выполняется…"
              : ["delete", "deleteFolder"].includes(modal.kind)
                ? "Удалить"
                : modal.kind === "import"
                  ? "Добавить объекты"
                  : "Сохранить"
          }}
        </button>
      </footer>
    </form>
  </div>

  <div
    v-if="preview"
    class="preview-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="Просмотр файла"
  >
    <header class="preview-header">
      <div>
        <i aria-hidden="true" :class="icon(preview.mime_type)"></i
        ><span
          >{{ preview.name
          }}<small
            >{{ bytes(preview.size_bytes) }} ·
            {{ date(preview.created_at) }}</small
          ></span
        >
      </div>
      <div>
        <button
          class="icon-button"
          :disabled="busy"
          aria-label="Избранное"
          @click="patch([preview.id], { favorite: !preview.favorite })"
        >
          <i
            aria-hidden="true"
            :class="preview.favorite ? 'ri-star-fill' : 'ri-star-line'"
          ></i></button
        ><button
          v-if="preview.mime_type.startsWith('image/')"
          class="button"
          @click="editing = !editing"
        >
          <i aria-hidden="true" class="ri-equalizer-line"></i>Коррекция</button
        ><button
          class="icon-button"
          :disabled="busy"
          aria-label="Скопировать ссылку"
          @click="share(preview.id)"
        >
          <i aria-hidden="true" class="ri-link"></i></button
        ><button
          class="icon-button"
          :disabled="busy"
          aria-label="Скачать оригинал"
          @click="download([preview.id])"
        >
          <i aria-hidden="true" class="ri-download-2-line"></i></button
        ><button
          class="icon-button"
          aria-label="Закрыть просмотр"
          @click="closePreview"
        >
          <i aria-hidden="true" class="ri-close-line"></i>
        </button>
      </div>
    </header>
    <div class="preview-body">
      <button
        class="preview-arrow previous"
        aria-label="Предыдущий файл"
        @click="nextPreview(-1)"
      >
        <i aria-hidden="true" class="ri-arrow-left-s-line"></i>
      </button>
      <div class="preview-stage">
        <div v-if="previewLoading" class="loading-state">
          <i aria-hidden="true" class="ri-loader-4-line spinning"></i>Получение
          файла…
        </div>
        <div v-else-if="previewError" class="preview-fallback">
          <i aria-hidden="true" class="ri-error-warning-line"></i>
          <p>{{ previewError }}</p>
          <button class="button" @click="openPreview(preview)">
            Повторить
          </button>
        </div>
        <template v-else-if="previewUrl"
          ><img
            v-if="preview.mime_type.startsWith('image/')"
            :src="previewUrl"
            :alt="preview.name"
            :style="imageStyle(editing ? adjustments : preview.adjustments)"
            @error="
              previewError =
                'Формат не поддерживается встроенным просмотром. Скачайте оригинал.'
            "
          /><video
            v-else-if="preview.mime_type.startsWith('video/')"
            :src="previewUrl"
            controls
            autoplay
            @error="
              previewError = 'Видеокодек не поддерживается. Скачайте оригинал.'
            "
          ></video
          ><audio
            v-else-if="preview.mime_type.startsWith('audio/')"
            :src="previewUrl"
            controls
            @error="
              previewError = 'Аудиокодек не поддерживается. Скачайте оригинал.'
            "
          ></audio>
          <div v-else class="preview-fallback">
            <i aria-hidden="true" :class="icon(preview.mime_type)"></i>
            <h2>{{ preview.name }}</h2>
            <p>Для этого формата доступно скачивание.</p>
            <button
              class="button primary"
              :disabled="busy"
              @click="download([preview.id])"
            >
              <i aria-hidden="true" class="ri-download-2-line"></i>Скачать
              оригинал
            </button>
          </div></template
        >
      </div>
      <button
        class="preview-arrow next"
        aria-label="Следующий файл"
        @click="nextPreview(1)"
      >
        <i aria-hidden="true" class="ri-arrow-right-s-line"></i>
      </button>
      <aside v-if="editing" class="editor-panel">
        <h3>Коррекция фото</h3>
        <p>Настройки хранятся в D1. При скачивании вы получите оригинал.</p>
        <label
          v-for="control in [
            { key: 'brightness', label: 'Яркость', min: 0, max: 200 },
            { key: 'contrast', label: 'Контраст', min: 0, max: 200 },
            { key: 'saturation', label: 'Насыщенность', min: 0, max: 200 },
            { key: 'rotate', label: 'Поворот', min: -180, max: 180 },
          ]"
          :key="control.key"
          >{{ control.label
          }}<span>{{ adjustments[control.key as keyof Adjustments] }}</span
          ><input
            v-model.number="
              adjustments[control.key as keyof typeof adjustments]
            "
            type="range"
            :min="control.min"
            :max="control.max" /></label
        ><button class="button primary" :disabled="busy" @click="saveEdits">
          Сохранить коррекцию</button
        ><button
          class="button"
          :disabled="busy"
          @click="
            Object.assign(adjustments, {
              brightness: 100,
              contrast: 100,
              saturation: 100,
              rotate: 0,
            })
          "
        >
          Сбросить
        </button>
        <p v-if="error" class="error">{{ error }}</p>
      </aside>
    </div>
    <footer class="preview-footer">
      <span
        >{{ files.findIndex((f) => f.id === preview?.id) + 1 }} /
        {{ files.length }} загруженных файлов</span
      ><span v-if="notice">{{ notice }}</span
      ><span v-if="error" class="error">{{ error }}</span
      ><span>← → для переключения · Esc для выхода</span>
    </footer>
  </div>
</template>
