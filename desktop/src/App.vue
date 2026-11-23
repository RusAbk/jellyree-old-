<script setup lang="ts">
import { t } from "./i18n";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import FileThumb from "./FileThumb.vue";
import VideoPlayer from "./VideoPlayer.vue";
import { thumbnailRevision } from "./thumbnail";
import PhotoEditor from "./PhotoEditor.vue";
import ProcessedImage from "./ProcessedImage.vue";
import { needsImageProcessing } from "../electron/image-adjustments.mjs";
import SettingsPanel from "./SettingsPanel.vue";
import ContextMenu, { type MenuItem } from "./ContextMenu.vue";
import UploadConflictDialog from "./UploadConflictDialog.vue";
import UploadPanel from "./UploadPanel.vue";
import { useUploadJobs, uploadPercent } from "./use-upload-jobs";
import LanguageSelect from "./LanguageSelect.vue";
import { syncLanguage } from "./i18n";
import { bytes, date, icon, imageStyle } from "./format";
import { api } from "./api";
import {
  INTERNAL_DRAG_TYPE,
  canMoveFolder,
  type DragItems,
} from "./drag-items";
import type {
  Adjustments,
  CapturedVideoFrame,
  DriveFile,
  FilePatch,
  Folder,
  Progress,
  Settings,
  Stats,
} from "./types";

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
  view = ref(
    ["grid", "list", "gallery"].includes(
      localStorage.getItem("jellyree-desktop-view") || "",
    )
      ? localStorage.getItem("jellyree-desktop-view")!
      : "grid",
  );
const savedPreviewSize = Number(
  localStorage.getItem("jellyree-desktop-preview-size") || 220,
);
const previewSize = ref(
  Number.isFinite(savedPreviewSize)
    ? Math.max(120, Math.min(420, savedPreviewSize))
    : 220,
);
const contextMenu = ref<{
  serial: number;
  x: number;
  y: number;
  kind: "files" | "folder" | "empty";
  ids: string[];
  folder?: Folder;
} | null>(null);
let contextSerial = 0;
const selection = ref<string[]>([]),
  loading = ref(false),
  busy = ref(false),
  total = ref(0),
  hasMore = ref(false),
  page = ref(1);
const {
  jobs: uploadJobs,
  panelOpen: uploadsOpen,
  pending: pendingUploads,
  issues: uploadIssues,
  running: runningUpload,
  hasFinished: hasFinishedUploads,
  conflict: uploadConflict,
  conflictOpen: uploadConflictOpen,
  start: startUpload,
  onProgress: uploadProgress,
  onConflict: uploadConflictReceived,
  resolveConflict: resolveUploadConflict,
  clearFinished: clearFinishedUploads,
} = useUploadJobs(api, requestUploadRefresh);
let uploadRefreshPending = false;
const error = ref(""),
  notice = ref(""),
  progress = ref<Progress | null>(null),
  dragging = ref(false);
const draggedItems = ref<DragItems | null>(null);
const dropTarget = ref<string | null | undefined>(undefined);
const dragSession = crypto.randomUUID();
const preview = ref<DriveFile | null>(null),
  previewUrl = ref(""),
  previewError = ref(""),
  previewLoading = ref(false),
  editing = ref(false);
const expanded = ref(new Set<string>());
const modal = ref<{
  kind: string;
  title: string;
  input: string;
  ids: string[];
  target: string;
  folder?: Folder;
  parentId?: string | null;
} | null>(null);
let generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  previewGeneration = 0,
  unsubscribe: (() => void) | undefined;
let unsubscribeConflict: (() => void) | undefined;

const nav = computed(() => [
  { id: "drive", label: t("Мой диск"), icon: "ri-hard-drive-3-line" },
  { id: "all", label: t("Все файлы"), icon: "ri-stack-line" },
  { id: "photos", label: t("Фото и видео"), icon: "ri-image-2-line" },
  { id: "favorites", label: t("Избранное"), icon: "ri-star-line" },
  { id: "trash", label: t("Корзина"), icon: "ri-delete-bin-6-line" },
]);
const currentFolder = computed(() =>
  folders.value.find((f) => f.id === folderId.value),
);
const title = computed(() =>
  tag.value
    ? `#${tag.value}`
    : currentFolder.value && section.value === "drive"
      ? currentFolder.value.name
      : nav.value.find((n) => n.id === section.value)?.label || t("Мой диск"),
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

const contextItems = computed<MenuItem[]>(() => {
  const menu = contextMenu.value;
  if (!menu) return [];
  const item = (
    id: string,
    label: string,
    icon: string,
    extra: Partial<MenuItem> = {},
  ): MenuItem => ({ id, label, icon, disabled: busy.value, ...extra });
  if (menu.kind === "files") {
    const single = menu.ids.length === 1;
    const starred = menu.ids.every(
      (id) => files.value.find((f) => f.id === id)?.favorite,
    );
    return [
      ...(single
        ? [
            item("open", t("Открыть"), "ri-eye-line"),
            item("info", t("Информация"), "ri-information-line"),
            ...(files.value
              .find((f) => f.id === menu.ids[0])
              ?.mime_type.startsWith("image/")
              ? [item("editPhoto", t("Коррекция фото"), "ri-equalizer-line")]
              : []),
          ]
        : []),
      item(
        "download",
        single ? t("Скачать оригинал") : t("Скачать оригиналы"),
        "ri-download-2-line",
      ),
      ...(single
        ? [
            item("share", t("Скопировать ссылку на 1 час"), "ri-link"),
            item("rename", t("Переименовать"), "ri-edit-line", {
              separator: true,
            }),
          ]
        : []),
      ...(section.value === "trash"
        ? [
            item("restore", t("Восстановить"), "ri-arrow-go-back-line", {
              separator: true,
            }),
            item("delete", t("Удалить навсегда"), "ri-delete-bin-line", {
              danger: true,
            }),
          ]
        : [
            item("move", t("Переместить"), "ri-folder-transfer-line", {
              separator: !single,
            }),
            item("tags", t("Изменить теги"), "ri-price-tag-3-line"),
            item(
              "favorite",
              starred ? t("Убрать из избранного") : t("В избранное"),
              starred ? "ri-star-fill" : "ri-star-line",
            ),
            item("trash", t("В корзину"), "ri-delete-bin-line", {
              separator: true,
              danger: true,
            }),
          ]),
    ];
  }
  if (menu.kind === "folder")
    return [
      item("openFolder", t("Открыть папку"), "ri-folder-open-line"),
      item("uploadHere", t("Загрузить файлы сюда"), "ri-upload-cloud-2-line", {
        separator: true,
      }),
      item(
        "uploadFolderHere",
        t("Загрузить папку сюда"),
        "ri-folder-upload-line",
      ),
      item("createChild", t("Новая вложенная папка"), "ri-folder-add-line"),
      item("renameFolder", t("Переименовать папку"), "ri-edit-line", {
        separator: true,
      }),
      item("moveFolder", t("Переместить папку"), "ri-folder-transfer-line"),
      item("deleteFolder", t("Удалить пустую папку"), "ri-delete-bin-line", {
        separator: true,
        danger: true,
      }),
    ];
  return [
    item("upload", t("Загрузить файлы"), "ri-upload-cloud-2-line"),
    item("uploadFolder", t("Загрузить папку"), "ri-folder-upload-line"),
    item("createFolder", t("Новая папка"), "ri-folder-add-line"),
    item("refresh", t("Обновить"), "ri-refresh-line", { separator: true }),
    item(
      "selectAll",
      t("Выбрать загруженные файлы"),
      "ri-checkbox-multiple-line",
      { disabled: busy.value || !files.value.length },
    ),
    ...(
      [
        ["gallery", t("Галерея без обрезки"), "ri-layout-masonry-line"],
        ["grid", t("Сетка"), "ri-grid-line"],
        ["list", t("Список"), "ri-list-check"],
      ] as const
    ).map(([id, label, icon], index) =>
      item(`view:${id}`, label, view.value === id ? "ri-check-line" : icon, {
        separator: index === 0,
      }),
    ),
  ];
});
function closeContextMenu() {
  contextMenu.value = null;
}
function showContext(
  event: MouseEvent,
  kind: "files" | "folder" | "empty",
  ids: string[] = [],
  folder?: Folder,
) {
  event.preventDefault();
  event.stopPropagation();
  contextMenu.value = {
    serial: ++contextSerial,
    x: event.clientX,
    y: event.clientY,
    kind,
    ids: [...ids],
    folder,
  };
}
function fileContext(event: MouseEvent, file: DriveFile) {
  if (!selection.value.includes(file.id)) selection.value = [file.id];
  showContext(event, "files", selection.value);
}
function folderContext(event: MouseEvent, folder: Folder) {
  selection.value = [];
  showContext(event, "folder", [], folder);
}
function emptyContext(event: MouseEvent) {
  if (
    !settings.value.configured ||
    (event.target as HTMLElement).closest(
      "button, a, input, select, textarea, .toolbar-area, .preview-settings",
    )
  )
    return;
  selection.value = [];
  showContext(event, "empty");
}
function chooseContext(id: string) {
  const menu = contextMenu.value;
  closeContextMenu();
  if (!menu || busy.value) return;
  if (id.startsWith("view:")) {
    view.value = id.slice(5);
    return;
  }
  if (id === "open" || id === "editPhoto") {
    const file = files.value.find((f) => f.id === menu.ids[0]);
    if (file)
      void openPreview(file).then(() => {
        if (id === "editPhoto" && preview.value?.id === file.id)
          editing.value = true;
      });
  }
  if (id === "info") inspectorOpen.value = true;
  if (id === "download") void download(menu.ids);
  if (id === "share") void share(menu.ids[0]!);
  if (["rename", "tags", "move", "delete"].includes(id))
    openModal(id, menu.ids);
  if (id === "favorite")
    void patch(menu.ids, {
      favorite: !menu.ids.every(
        (id) => files.value.find((f) => f.id === id)?.favorite,
      ),
    });
  if (id === "trash" || id === "restore")
    void patch(
      menu.ids,
      { trashed: id === "trash" },
      id === "trash"
        ? t("Файлы перемещены в корзину.")
        : t("Файлы восстановлены."),
    );
  if (menu.folder) {
    if (id === "openFolder") navigate("drive", menu.folder.id);
    if (id === "uploadHere") void upload(false, undefined, menu.folder.id);
    if (id === "uploadFolderHere") void upload(true, undefined, menu.folder.id);
    if (id === "createChild")
      openModal("createFolder", [], undefined, menu.folder.id);
    if (["renameFolder", "moveFolder", "deleteFolder"].includes(id))
      openModal(id, [], menu.folder);
  }
  if (id === "upload") void upload();
  if (id === "uploadFolder") void upload(true);
  if (id === "createFolder") openModal("createFolder");
  if (id === "refresh") void reload();
  if (id === "selectAll") selection.value = files.value.map((f) => f.id);
}

function toggleExpanded(id: string) {
  const set = new Set(expanded.value);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  expanded.value = set;
}
function navigate(next: string, id: string | null = null, nextTag = "") {
  closeContextMenu();
  section.value = next;
  folderId.value = id;
  tag.value = nextTag;
  selection.value = [];
  search.value = "";
  for (const f of breadcrumbs.value) expanded.value.add(f.id);
  void reload();
}
function requestUploadRefresh() {
  uploadRefreshPending = true;
  flushUploadRefresh();
}
function flushUploadRefresh() {
  if (
    !uploadRefreshPending ||
    busy.value ||
    loading.value ||
    !settings.value.configured
  )
    return;
  uploadRefreshPending = false;
  void reload(false, true);
}
watch([busy, loading], flushUploadRefresh);
async function reload(more = false, background = false) {
  if (!settings.value.configured) return;
  const id = ++generation,
    nextPage = more ? page.value + 1 : background ? page.value : 1;
  loading.value = true;
  if (!background) error.value = "";
  try {
    const pages = background
      ? Array.from({ length: nextPage }, (_, index) => index + 1)
      : [nextPage];
    const [results, tree, usage] = await Promise.all([
      Promise.all(
        pages.map((requestedPage) =>
          api.list({
            section: section.value,
            folderId: folderId.value,
            search: search.value,
            tag: tag.value,
            sort: sort.value,
            page: requestedPage,
          }),
        ),
      ),
      more ? Promise.resolve(folders.value) : api.folders(),
      more ? Promise.resolve(stats.value) : api.stats(),
    ]);
    if (id !== generation) return;
    const result = {
      ...results[results.length - 1]!,
      items: results.flatMap((result) => result.items),
    };
    files.value = more ? [...files.value, ...result.items] : result.items;
    folders.value = tree;
    stats.value = usage;
    total.value = result.total;
    hasMore.value = result.hasMore;
    page.value = nextPage;
    selection.value = selection.value.filter((s) =>
      files.value.some((f) => f.id === s),
    );
    if (preview.value) {
      const updated = files.value.find((f) => f.id === preview.value?.id);
      if (
        updated &&
        updated.object_key !== preview.value.object_key &&
        !editing.value
      )
        void openPreview(updated);
      else if (updated && !editing.value) preview.value = updated;
    }
  } catch (e) {
    if (id === generation && !background) error.value = (e as Error).message;
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
  if (!event.relatedTarget) {
    dragging.value = false;
    dropTarget.value = undefined;
  }
}
function dragover(event: DragEvent) {
  if (busy.value || !settings.value.configured) return;
  dropTarget.value = undefined;
  if (isInternalDrag(event)) {
    dragging.value = false;
    if (section.value === "drive" && acceptsFolderDrop(event, folderId.value)) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    }
  } else if (event.dataTransfer?.types.includes("Files")) {
    event.preventDefault();
    dragging.value = true;
    event.dataTransfer.dropEffect = "copy";
  }
}
function isInternalDrag(event: DragEvent) {
  return (
    !!draggedItems.value &&
    !!event.dataTransfer?.types.includes(INTERNAL_DRAG_TYPE)
  );
}
function finishDrag() {
  draggedItems.value = null;
  dropTarget.value = undefined;
  dragging.value = false;
}
function fileDragStart(event: DragEvent, file: DriveFile) {
  if (busy.value || file.trashed_at || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  closeContextMenu();
  if (!selection.value.includes(file.id)) selection.value = [file.id];
  draggedItems.value = { kind: "files", ids: [...selection.value] };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(INTERNAL_DRAG_TYPE, dragSession);
  event.dataTransfer.setData("text/plain", file.name);
}
function folderDragStart(event: DragEvent, folder: Folder) {
  if (busy.value || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  closeContextMenu();
  selection.value = [];
  draggedItems.value = { kind: "folder", id: folder.id };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(INTERNAL_DRAG_TYPE, dragSession);
  event.dataTransfer.setData("text/plain", folder.name);
}
function acceptsFolderDrop(event: DragEvent, target: string | null) {
  if (
    busy.value ||
    !settings.value.configured ||
    (target !== null && !folders.value.some((folder) => folder.id === target))
  )
    return false;
  if (isInternalDrag(event)) {
    const items = draggedItems.value!;
    return (
      items.kind === "files" || canMoveFolder(folders.value, items.id, target)
    );
  }
  return !!event.dataTransfer?.types.includes("Files");
}
function folderDragOver(event: DragEvent, target: string | null) {
  event.stopPropagation();
  dragging.value = false;
  if (!acceptsFolderDrop(event, target)) {
    dropTarget.value = undefined;
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    return;
  }
  event.preventDefault();
  dropTarget.value = target;
  if (event.dataTransfer)
    event.dataTransfer.dropEffect = isInternalDrag(event) ? "move" : "copy";
}
function folderDragLeave(event: DragEvent, target: string | null) {
  const next = event.relatedTarget;
  if (
    !(next instanceof Node) ||
    !(event.currentTarget as HTMLElement).contains(next)
  ) {
    if (dropTarget.value === target) dropTarget.value = undefined;
  }
}
async function moveDropped(event: DragEvent, target: string | null) {
  const items = draggedItems.value;
  const trusted =
    event.dataTransfer?.getData(INTERNAL_DRAG_TYPE) === dragSession;
  finishDrag();
  if (!items || !trusted || busy.value) return;
  if (items.kind === "folder") {
    if (!canMoveFolder(folders.value, items.id, target)) return;
    await action(
      () => api.updateFolder(items.id, { parentId: target }),
      t("Папка перемещена."),
    );
  } else {
    const ids = items.ids.filter((id) =>
      files.value.some(
        (file) =>
          file.id === id && !file.trashed_at && file.folder_id !== target,
      ),
    );
    if (!ids.length) {
      notice.value = t("Файлы уже находятся в этой папке.");
      return;
    }
    await patch(
      ids,
      { folderId: target },
      t("Перемещено файлов: {0}", { "0": ids.length }),
    );
  }
}
async function folderDrop(event: DragEvent, target: string | null) {
  event.preventDefault();
  event.stopPropagation();
  const accepted = acceptsFolderDrop(event, target);
  dropTarget.value = undefined;
  dragging.value = false;
  if (!accepted) {
    finishDrag();
    return;
  }
  if (isInternalDrag(event)) await moveDropped(event, target);
  else if (event.dataTransfer?.files.length) {
    const files = Array.from(event.dataTransfer.files);
    finishDrag();
    await upload(false, files, target);
  }
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
async function upload(
  folders = false,
  dropped?: File[],
  targetFolderId = uploadFolder.value,
) {
  if (typeof window.jellyree?.onUploadConflict !== "function") {
    error.value = t(
      "Перезапустите приложение, чтобы обновить обработку загрузки.",
    );
    return;
  }
  if (!settings.value.configured) {
    settingsOpen.value = true;
    return;
  }
  const destination =
    folderOptions.value.find((folder) => folder.id === targetFolderId)?.name ||
    "";
  await startUpload(folders, dropped, targetFolderId, destination);
}
async function drop(event: DragEvent) {
  dragging.value = false;
  dropTarget.value = undefined;
  if (isInternalDrag(event)) {
    event.preventDefault();
    if (section.value === "drive") await moveDropped(event, folderId.value);
    else finishDrag();
    return;
  }
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  if (!busy.value && event.dataTransfer?.files.length)
    await upload(false, Array.from(event.dataTransfer.files));
}
function openModal(
  kind: string,
  ids = selection.value,
  folder?: Folder,
  parentId = uploadFolder.value,
) {
  const titles: Record<string, string> = {
    createFolder: t("Новая папка"),
    rename: t("Переименовать файл"),
    tags: t("Теги"),
    move: t("Переместить файлы"),
    renameFolder: t("Переименовать папку"),
    moveFolder: t("Переместить папку"),
    deleteFolder: t("Удалить пустую папку?"),
    delete: t("Удалить навсегда?"),
    import: t("Добавить существующие объекты R2?"),
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
    parentId,
  };
}
async function submitModal() {
  const value = modal.value;
  if (!value) return;
  const success = await action(async () => {
    if (value.kind === "createFolder")
      await api.createFolder(value.input, value.parentId ?? null);
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
      if (folderId.value === value.folder.id)
        folderId.value = value.folder.parent_id || null;
    }
    if (value.kind === "delete") {
      await api.remove(value.ids);
      if (preview.value && value.ids.includes(preview.value.id)) closePreview();
    }
    if (value.kind === "import") {
      const result = await api.importBucket();
      notice.value = t("Проверено объектов: {0}", { "0": result.scanned });
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
  try {
    if (
      file.mime_type.startsWith("video/") &&
      typeof window.jellyree.videoSource !== "function"
    )
      throw new Error(
        t("Для обновления видеоплеера полностью перезапустите приложение."),
      );
    const url = file.mime_type.startsWith("video/")
      ? await api.videoSource(thumbnailRevision(file))
      : await api.url(file.id);
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
  if (editing.value) return;
  const index = files.value.findIndex((f) => f.id === preview.value?.id),
    next = files.value[index + direction];
  if (next) void openPreview(next);
}
async function saveVideoFrame(file: DriveFile, frame: CapturedVideoFrame) {
  const saved = await api.saveVideoFrame(
    file.id,
    file.object_key,
    frame.timestamp,
    frame.data,
  );
  requestUploadRefresh();
  return saved;
}
function downloadVideoFrame(file: DriveFile, frame: CapturedVideoFrame) {
  return api.downloadVideoFrame(
    file.id,
    file.object_key,
    frame.timestamp,
    frame.data,
  );
}
async function saveImageEdits(adjustments: Adjustments) {
  if (!preview.value) return false;
  const file = preview.value;
  await api.update([file.id], {
    adjustments,
    expectedObjectKey: file.object_key,
  });
  preview.value = { ...file, adjustments };
  notice.value = t("Коррекция сохранена. Оригинал сохранён в R2.");
  requestUploadRefresh();
  return true;
}
async function download(ids = selection.value) {
  await action(async () => {
    const result = await api.download(ids);
    notice.value = t("Скачано файлов: {0}", { "0": result.done });
  });
}
async function share(id: string) {
  await action(
    () => api.share(id),
    t("Ссылка скопирована. Действует 1 час; доступна всем, у кого она есть."),
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
    ? t("Подключение сохранено на этом устройстве.")
    : t(
        "Системное хранилище ключей недоступно. Реквизиты будут забыты при закрытии.",
      );
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
  notice.value = t("Подключение удалено с устройства.");
}
function keydown(event: KeyboardEvent) {
  if (contextMenu.value) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeContextMenu();
    }
    return;
  }
  if (
    settingsOpen.value ||
    editing.value ||
    (uploadConflict.value && uploadConflictOpen.value)
  )
    return;
  if (
    event.target instanceof HTMLElement &&
    (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) ||
      event.target.isContentEditable)
  )
    return;
  if (
    !modal.value &&
    !preview.value &&
    (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
  ) {
    event.preventDefault();
    const target =
      (event.target as HTMLElement).closest<HTMLElement>(
        ".file-card, .folder-card, .tree-row",
      ) || document.querySelector<HTMLElement>(".content");
    if (target) {
      const bounds = target.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: bounds.left + 12,
          clientY: bounds.top + 12,
        }),
      );
    }
    return;
  }
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
        t("Файлы перемещены в корзину."),
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
watch(previewSize, (value) =>
  localStorage.setItem("jellyree-desktop-preview-size", String(value)),
);
onMounted(async () => {
  document.addEventListener("keydown", keydown);
  if (!window.jellyree) {
    error.value = t(
      "Откройте приложение через Electron: npm run dev или npm start.",
    );
    ready.value = true;
    return;
  }
  await syncLanguage();
  unsubscribe = api.onProgress((p) => {
    if (p.kind === "upload") uploadProgress(p);
    else progress.value = p;
  });
  if (typeof window.jellyree.onUploadConflict === "function")
    unsubscribeConflict = api.onUploadConflict((conflict) => {
      uploadConflictReceived(conflict);
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
  unsubscribeConflict?.();
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
    @dragend="finishDrag"
  >
    <aside class="sidebar">
      <a class="brand" href="#" @click.prevent="navigate('drive')"
        ><span class="brand-mark"
          ><i aria-hidden="true" class="ri-bubble-chart-fill"></i></span
        ><span
          >jellyree<small>{{ t("ВАШ ЛИЧНЫЙ ДИСК") }}</small></span
        ></a
      >
      <button
        class="button primary upload-button"
        :disabled="busy || !ready"
        @click="upload()"
      >
        <i aria-hidden="true" class="ri-add-line"></i>{{ t("Загрузить файлы") }}
      </button>
      <nav class="main-nav" :aria-label="t('Библиотека')">
        <button
          v-for="item in nav"
          :key="item.id"
          :class="{
            active: section === item.id && !folderId && !tag,
            'drop-target': item.id === 'drive' && dropTarget === null,
          }"
          @click="navigate(item.id)"
          @dragover="item.id === 'drive' && folderDragOver($event, null)"
          @dragleave="item.id === 'drive' && folderDragLeave($event, null)"
          @drop="item.id === 'drive' && folderDrop($event, null)"
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
        <span>{{ t("ПАПКИ") }}</span><button
          class="icon-button small"
          :title="t('Новая папка')"
          :aria-label="t('Новая папка')"
          :disabled="busy || !settings.configured"
          @click="openModal('createFolder')"
        >
          <i aria-hidden="true" class="ri-add-line"></i>
        </button>
      </div>
      <div class="folder-tree">
        <p v-if="!folders.length" class="sidebar-hint">
          {{ t("Ваши папки появятся здесь") }}
        </p>
        <div
          v-for="node in folderTree"
          :key="node.folder.id"
          class="tree-row"
          :class="{
            active: folderId === node.folder.id && section === 'drive',
            'drop-target': dropTarget === node.folder.id,
            'drag-source':
              draggedItems?.kind === 'folder' &&
              draggedItems.id === node.folder.id,
          }"
          :style="{ paddingLeft: `${8 + node.depth * 14}px` }"
          @contextmenu="folderContext($event, node.folder)"
          :draggable="!busy"
          @dragstart.stop="folderDragStart($event, node.folder)"
          @dragover="folderDragOver($event, node.folder.id)"
          @dragleave="folderDragLeave($event, node.folder.id)"
          @drop="folderDrop($event, node.folder.id)"
        >
          <button
            class="tree-chevron"
            :aria-label="
              expanded.has(node.folder.id) ? t('Свернуть') : t('Развернуть')
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
        ><div class="sidebar-label">{{ t("ТЕГИ") }}</div>
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
            settings.configured ? "Cloudflare R2" : t("Облако не подключено")
          }}</span
          ><span
            class="status-dot"
            :class="{ connected: settings.configured }"
          ></span>
        </div>
        <strong
          >{{ bytes(stats.bytes) }}
          <span>· {{ t("{0} файлов", { "0": stats.files }) }}</span></strong
        ><small>{{ settings.bucket || t("Подключите своё хранилище") }}</small
        ><small
          v-if="settings.configured && !settings.persisted"
          class="session-only"
          >{{ t("Ключи только на эту сессию") }}</small
        >
      </div>
      <button
        class="settings-link"
        :disabled="busy"
        @click="settingsOpen = true"
      >
        <i aria-hidden="true" class="ri-settings-3-line"></i
        >{{ t("Настройки подключения")
        }}<i aria-hidden="true" class="ri-arrow-right-s-line"></i>
      </button>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <div class="search-box">
          <i aria-hidden="true" class="ri-search-line"></i
          ><input
            v-model="search"
            :aria-label="t('Поиск файлов и тегов')"
            :placeholder="t('Поиск файлов и тегов')"
          /><button
            v-if="search"
            class="icon-button small"
            :aria-label="t('Очистить поиск')"
            @click="search = ''"
          >
            <i aria-hidden="true" class="ri-close-line"></i></button
          ><kbd>Ctrl A</kbd>
        </div>
        <LanguageSelect :disabled="busy" />
        <button
          class="uploads-toggle"
          :class="{ attention: !!uploadConflict || uploadIssues > 0 }"
          :aria-label="t('Загрузки')"
          :title="
            uploadConflict
              ? t('Нужно решить совпадение имён')
              : uploadIssues
                ? t('Завершено с замечаниями')
                : t('Загрузки')
          "
          :aria-expanded="uploadsOpen"
          aria-controls="upload-panel"
          @click="uploadsOpen = !uploadsOpen"
        >
          <i
            aria-hidden="true"
            :class="
              uploadConflict || uploadIssues
                ? 'ri-error-warning-line'
                : 'ri-upload-cloud-2-line'
            "
          ></i
          ><span>{{ t("Загрузки") }}</span
          ><strong v-if="pendingUploads">{{ pendingUploads }}</strong>
          <small v-if="runningUpload?.progress" class="upload-compact-percent"
            >{{ uploadPercent(runningUpload.progress) }}%</small
          >
        </button>
        <span class="direct-badge"
          ><span
            class="status-dot"
            :class="{ connected: settings.configured }"
          ></span
          >R2 + D1</span
        ><button
          class="icon-button"
          :title="t('Обновить')"
          :aria-label="t('Обновить')"
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
          :title="t('Настройки подключения')"
          :aria-label="t('Настройки подключения')"
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
          :aria-label="t('Закрыть сообщение')"
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
          :aria-label="t('Закрыть сообщение')"
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
                    upload: t("Загрузка"),
                    download: t("Скачивание"),
                    import: t("Индексация R2"),
                  }[progress.kind]
                : t("Выполняется операция…")
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
      <section class="content" @contextmenu="emptyContext">
        <div v-if="section === 'drive' && folderId" class="breadcrumbs">
          <button
            @click="navigate('drive')"
            :class="{ 'drop-target': dropTarget === null }"
            @dragover="folderDragOver($event, null)"
            @dragleave="folderDragLeave($event, null)"
            @drop="folderDrop($event, null)"
          >
            {{ t("Мой диск") }}</button><template
            v-for="crumb in breadcrumbs"
            :key="crumb.id"
            ><i aria-hidden="true" class="ri-arrow-right-s-line"></i
            ><button
              @click="navigate('drive', crumb.id)"
              :class="{ 'drop-target': dropTarget === crumb.id }"
              @dragover="folderDragOver($event, crumb.id)"
              @dragleave="folderDragLeave($event, crumb.id)"
              @drop="folderDrop($event, crumb.id)"
            >
              {{ crumb.name }}
            </button></template
          >
        </div>
        <header class="page-header">
          <div>
            <span class="eyebrow">{{
              section === "trash"
                ? t("МОЖНО ВОССТАНОВИТЬ")
                : t("ВСЁ НА СВОИХ МЕСТАХ")
            }}</span>
            <h1>{{ title }}</h1>
            <p>
              {{
                settings.configured
                  ? t("{0} файлов{1}", {
                      "0": total,
                      "1": childFolders.length
                        ? t(" · {0} папок", { "0": childFolders.length })
                        : "",
                    })
                  : t("Пространство для ваших файлов, фотографий и идей")
              }}
            </p>
          </div>
          <div class="page-actions">
            <template v-if="currentFolder && section === 'drive'"
              ><button
                class="icon-button"
                :title="t('Переименовать папку')"
                :aria-label="t('Переименовать папку')"
                :disabled="busy"
                @click="openModal('renameFolder', [], currentFolder)"
              >
                <i aria-hidden="true" class="ri-edit-line"></i></button
              ><button
                class="icon-button"
                :title="t('Переместить папку')"
                :aria-label="t('Переместить папку')"
                :disabled="busy"
                @click="openModal('moveFolder', [], currentFolder)"
              >
                <i
                  aria-hidden="true"
                  class="ri-folder-transfer-line"
                ></i></button
              ><button
                class="icon-button"
                :title="t('Удалить пустую папку')"
                :aria-label="t('Удалить пустую папку')"
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
              <i aria-hidden="true" class="ri-folder-add-line"></i
              >{{ t("Новая папка") }}</button
            ><button
              class="button"
              :disabled="busy || !settings.configured"
              @click="upload(true)"
            >
              <i aria-hidden="true" class="ri-folder-upload-line"></i
              >{{ t("Загрузить папку") }}
            </button>
          </div>
        </header>

        <div v-if="!settings.configured" class="welcome-state">
          <div class="welcome-illustration">
            <i aria-hidden="true" class="ri-cloud-line"></i
            ><span><i aria-hidden="true" class="ri-folder-3-fill"></i></span>
          </div>
          <h2>{{ t("Ваши файлы. Ваше облако.") }}</h2>
          <p>
            {{ t("Подключите R2 и D1, чтобы собрать всё в одном месте.")
            }}<br />{{
              t("Без собственного сервера и промежуточных сервисов.")
            }}
          </p>
          <button class="button primary" @click="settingsOpen = true">
            <i aria-hidden="true" class="ri-plug-line"></i
            >{{ t("Подключить Cloudflare") }}
          </button>
        </div>
        <template v-else>
          <div v-if="childFolders.length" class="folder-grid">
            <button
              v-for="folder in childFolders"
              :key="folder.id"
              class="folder-card"
              :class="{
                'drop-target': dropTarget === folder.id,
                'drag-source':
                  draggedItems?.kind === 'folder' &&
                  draggedItems.id === folder.id,
              }"
              :title="folder.name"
              @click="navigate('drive', folder.id)"
              @contextmenu="folderContext($event, folder)"
              :draggable="!busy"
              @dragstart.stop="folderDragStart($event, folder)"
              @dragover="folderDragOver($event, folder.id)"
              @dragleave="folderDragLeave($event, folder.id)"
              @drop="folderDrop($event, folder.id)"
            >
              <span class="folder-card-icon"
                ><i aria-hidden="true" class="ri-folder-3-fill"></i></span
              ><span
                >{{ folder.name
                }}<small>{{
                  t("{0} вложенных папок", {
                    "0": folders.filter((f) => f.parent_id === folder.id)
                      .length,
                  })
                }}</small></span
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
                      ? t('Снять выделение')
                      : t('Выбрать загруженные файлы')
                  "
                  :aria-label="
                    allSelected
                      ? t('Снять выделение')
                      : t('Выбрать загруженные файлы')
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
                  selection.length
                    ? t("Выбрано: {0}", { "0": selection.length })
                    : t("Файлы")
                }}</span>
              </div>
              <div>
                <select v-model="sort" :aria-label="t('Сортировка')">
                  <option value="date">{{ t("Сначала новые") }}</option>
                  <option value="name">{{ t("По имени") }}</option>
                  <option value="size">{{ t("По размеру") }}</option>
                </select>
              </div>
            </div>
            <div v-if="selection.length" class="selection-toolbar">
              <span>{{
                t("Выбрано: {0}", { "0": selection.length })
              }}</span><button
                v-if="selection.length === 1"
                class="icon-button small"
                :disabled="busy"
                :title="t('Переименовать')"
                :aria-label="t('Переименовать')"
                @click="openModal('rename')"
              >
                <i aria-hidden="true" class="ri-edit-line"></i></button
              ><button
                v-if="selection.length === 1"
                class="icon-button small"
                :title="t('Информация')"
                :aria-label="t('Информация')"
                @click="inspectorOpen = !inspectorOpen"
              >
                <i aria-hidden="true" class="ri-information-line"></i></button
              ><button :disabled="busy" @click="download()">
                <i aria-hidden="true" class="ri-download-2-line"></i
                >{{ t("Скачать") }}</button
              ><template v-if="section !== 'trash'"
                ><button :disabled="busy" @click="openModal('move')">
                  <i aria-hidden="true" class="ri-folder-transfer-line"></i
                  >{{ t("Переместить") }}</button
                ><button :disabled="busy" @click="openModal('tags')">
                  <i aria-hidden="true" class="ri-price-tag-3-line"></i
                  >{{ t("Теги") }}</button
                ><button
                  :disabled="busy"
                  @click="
                    patch(
                      selection,
                      { favorite: true },
                      t('Добавлено в избранное.'),
                    )
                  "
                >
                  <i aria-hidden="true" class="ri-star-line"></i
                  >{{ t("В избранное") }}</button
                ><button
                  :disabled="busy"
                  @click="
                    patch(
                      selection,
                      { trashed: true },
                      t('Файлы перемещены в корзину.'),
                    )
                  "
                >
                  <i aria-hidden="true" class="ri-delete-bin-line"></i
                  >{{ t("В корзину") }}
                </button></template
              ><template v-else
                ><button
                  :disabled="busy"
                  @click="
                    patch(
                      selection,
                      { trashed: false },
                      t('Файлы восстановлены.'),
                    )
                  "
                >
                  <i aria-hidden="true" class="ri-arrow-go-back-line"></i
                  >{{ t("Восстановить") }}</button
                ><button
                  class="danger"
                  :disabled="busy"
                  @click="openModal('delete')"
                >
                  {{ t("Удалить навсегда") }}
                </button></template
              ><button
                class="icon-button small"
                :aria-label="t('Снять выделение')"
                @click="selection = []"
              >
                <i aria-hidden="true" class="ri-close-line"></i>
              </button>
            </div>
          </div>
          <div class="preview-settings">
            <div class="view-switch">
              <button
                :class="{ active: view === 'gallery' }"
                :aria-pressed="view === 'gallery'"
                :title="t('Галерея без обрезки')"
                :aria-label="t('Галерея')"
                @click="view = 'gallery'"
              >
                <i aria-hidden="true" class="ri-layout-masonry-line"></i>
              </button>
              <button
                :class="{ active: view === 'grid' }"
                :aria-pressed="view === 'grid'"
                :aria-label="t('Сетка')"
                @click="view = 'grid'"
              >
                <i aria-hidden="true" class="ri-grid-line"></i></button
              ><button
                :class="{ active: view === 'list' }"
                :aria-pressed="view === 'list'"
                :aria-label="t('Список')"
                @click="view = 'list'"
              >
                <i aria-hidden="true" class="ri-list-check"></i>
              </button>
            </div>
            <span v-if="view === 'gallery'"
              ><i aria-hidden="true" class="ri-aspect-ratio-line"></i
              >{{ t("Исходные пропорции · без обрезки") }}</span
            >
            <span v-else>{{
              view === "list" ? t("Файлы списком") : t("Превью файлов")
            }}</span>
            <label v-if="view !== 'list'"
              >{{ t("Размер превью")
              }}<input
                v-model.number="previewSize"
                type="range"
                min="120"
                max="420"
                step="20"
                :aria-label="t('Размер превью')"
              /><output>{{ previewSize }} px</output></label
            >
          </div>
          <div v-if="view === 'list' && files.length" class="list-heading">
            <span>{{ t("Название") }}</span><span>{{ t("Размер") }}</span
            ><span>{{ t("Дата добавления") }}</span
            ><span></span>
          </div>
          <div
            :key="scope"
            class="files"
            :class="view"
            :style="{ '--preview-size': `${previewSize}px` }"
            :aria-busy="loading"
          >
            <article
              v-for="file in files"
              :key="file.id"
              class="file-card"
              :class="{
                selected: selection.includes(file.id),
                'drag-source':
                  draggedItems?.kind === 'files' &&
                  draggedItems.ids.includes(file.id),
              }"
              :draggable="!busy && !file.trashed_at"
              @dragstart.stop="fileDragStart($event, file)"
              tabindex="0"
              @click="select(file, $event)"
              @dblclick="openPreview(file)"
              @contextmenu="fileContext($event, file)"
              @keydown.enter="openPreview(file)"
              @keydown.space.prevent="toggleSelect(file.id)"
            >
              <div class="thumb-wrap">
                <FileThumb
                  :file="file"
                  :compact="view === 'list'"
                  :natural="view === 'gallery'"
                /><button
                  class="file-checkbox"
                  :class="{ checked: selection.includes(file.id) }"
                  :aria-label="t('Выбрать {0}', { '0': file.name })"
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
                    file.favorite ? t('Убрать из избранного') : t('В избранное')
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
                <small v-if="view !== 'list'"
                  >{{ bytes(file.size_bytes) }}<span>·</span
                  >{{ date(file.created_at) }}</small
                >
                <div
                  v-if="file.tags.length && view !== 'list'"
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
                :title="t('Открыть')"
                :aria-label="t('Открыть файл')"
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
                  ? t("Ничего не найдено")
                  : section === "trash"
                    ? t("Корзина пуста")
                    : section === "favorites"
                      ? t("Здесь будет избранное")
                      : t("Здесь пока свободно")
              }}
            </h2>
            <p>
              {{
                search || tag
                  ? t("Попробуйте другое имя или тег.")
                  : section === "trash"
                    ? t(
                        "Удалённые файлы остаются здесь до окончательного удаления.",
                      )
                    : section === "favorites"
                      ? t("Нажмите на звёздочку рядом с нужным файлом.")
                      : t("Перетащите файлы сюда или загрузите целую папку.")
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
              <i aria-hidden="true" class="ri-upload-cloud-2-line"></i
              >{{ t("Загрузить файлы") }}</button
            ><button
              v-if="section === 'drive' && !folderId && !search"
              class="text-button"
              :disabled="busy"
              @click="openModal('import')"
            >
              {{ t("В R2 уже есть файлы? Добавить в каталог") }}
            </button>
          </div>
          <div v-if="loading" class="loading-state">
            <i aria-hidden="true" class="ri-loader-4-line spinning"></i
            >{{ t("Загрузка каталога…") }}
          </div>
          <button
            v-if="hasMore"
            class="button load-more"
            :disabled="loading"
            @click="reload(true)"
          >
            {{
              t("Показать ещё · {0} из {1}", { "0": files.length, "1": total })
            }}
          </button>
        </template>
      </section>
      <footer class="workspace-footer">
        <span
          ><i aria-hidden="true" class="ri-shield-check-line"></i
          >{{ t("Прямое подключение к вашему Cloudflare") }}</span
        ><button
          v-if="settings.configured"
          class="text-button"
          :disabled="busy || pendingUploads > 0"
          @click="openModal('import')"
        >
          {{ t("Индексировать R2") }}</button
        ><span>Jellyree Desktop</span>
      </footer>
    </main>

    <aside v-if="selectedFile && inspectorOpen" class="inspector">
      <header>
        <strong>{{ t("Информация") }}</strong><button
          class="icon-button small"
          :aria-label="t('Закрыть информацию')"
          @click="inspectorOpen = false"
        >
          <i aria-hidden="true" class="ri-close-line"></i>
        </button>
      </header>
      <FileThumb :key="scope + selectedFile.id" :file="selectedFile" />
      <h3>{{ selectedFile.name }}</h3>
      <button class="button" @click="openPreview(selectedFile)">
        <i aria-hidden="true" class="ri-eye-line"></i
        >{{ t("Открыть просмотр") }}
      </button>
      <dl>
        <dt>{{ t("Тип") }}</dt>
        <dd>{{ selectedFile.mime_type }}</dd>
        <dt>{{ t("Размер") }}</dt>
        <dd>{{ bytes(selectedFile.size_bytes) }}</dd>
        <dt>{{ t("Добавлен") }}</dt>
        <dd>{{ date(selectedFile.created_at) }}</dd>
        <dt>{{ t("Расположение") }}</dt>
        <dd>
          {{
            folders.find((f) => f.id === selectedFile?.folder_id)?.name ||
            t("Мой диск")
          }}
        </dd>
      </dl>
      <div class="inspector-tags">
        <strong>{{ t("Теги") }}</strong><button
          class="icon-button small"
          :disabled="busy"
          :aria-label="t('Изменить теги')"
          @click="openModal('tags')"
        >
          <i aria-hidden="true" class="ri-edit-line"></i>
        </button>
      </div>
      <div class="tag-chips">
        <span v-for="name in selectedFile.tags" :key="name">{{
          name
        }}</span><small v-if="!selectedFile.tags.length" class="muted">{{
          t("Теги ещё не добавлены")
        }}</small>
      </div>
      <div class="inspector-actions">
        <button class="button" :disabled="busy" @click="openModal('rename')">
          <i aria-hidden="true" class="ri-edit-line"></i
          >{{ t("Переименовать") }}</button
        ><button
          class="button"
          :disabled="busy"
          @click="share(selectedFile.id)"
        >
          <i aria-hidden="true" class="ri-link"></i
          >{{ t("Ссылка на 1 час") }}</button
        ><button class="button" :disabled="busy" @click="download()">
          <i aria-hidden="true" class="ri-download-2-line"></i
          >{{ t("Скачать оригинал") }}
        </button>
      </div>
    </aside>
    <div v-if="dragging" class="drop-overlay">
      <i aria-hidden="true" class="ri-upload-cloud-2-line"></i>
      <h2>{{ t("Отпустите, чтобы загрузить") }}</h2>
      <p>{{ uploadFolder ? currentFolder?.name : t("Мой диск") }}</p>
    </div>
    <div v-if="draggedItems" class="drag-summary" role="status">
      <i aria-hidden="true" class="ri-folder-transfer-line"></i
      >{{
        draggedItems.kind === "files"
          ? t("Перенос файлов: {0}", { "0": draggedItems.ids.length })
          : t("Перенос папки")
      }}
    </div>
  </div>

  <UploadPanel
    v-if="uploadsOpen"
    :jobs="uploadJobs"
    :pending="pendingUploads"
    :has-finished="hasFinishedUploads"
    @close="uploadsOpen = false"
    @clear="clearFinishedUploads"
    @conflict="uploadConflictOpen = true"
  />
  <UploadConflictDialog
    v-if="uploadConflict && uploadConflictOpen"
    :key="uploadConflict.id"
    :conflict="uploadConflict"
    @resolved="resolveUploadConflict"
    @close="uploadConflictOpen = false"
  />
  <ContextMenu
    v-if="contextMenu"
    :key="contextMenu.serial"
    :x="contextMenu.x"
    :y="contextMenu.y"
    :label="
      contextMenu.kind === 'files'
        ? t('Действия с файлами')
        : contextMenu.kind === 'folder'
          ? t('Действия с папкой')
          : t('Действия в папке')
    "
    :items="contextItems"
    @choose="chooseContext"
    @close="closeContextMenu"
  />
  <SettingsPanel
    v-if="settingsOpen"
    :settings="settings"
    :locked="pendingUploads > 0"
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
          :aria-label="t('Закрыть')"
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
            ? t("Теги через запятую (заменят текущие)")
            : t("Название")
        }}<input
          v-model="modal.input"
          autofocus
          :required="modal.kind !== 'tags'"
          :maxlength="modal.kind === 'tags' ? 3000 : 255"
          :disabled="busy" /></label
      ><label v-if="['move', 'moveFolder'].includes(modal.kind)"
        >{{ t("Папка назначения")
        }}<select v-model="modal.target" :disabled="busy">
          <option value="">{{ t("Мой диск") }}</option>
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
        {{
          t(
            "Будут удалены выбранные файлы ({0}) из R2 и каталога D1. Восстановить их будет нельзя.",
            { "0": modal.ids.length },
          )
        }}
      </p>
      <p v-if="modal.kind === 'deleteFolder'" class="muted">
        {{
          t(
            "Папку «{0}» можно удалить, если в ней нет вложенных папок и файлов, в том числе в корзине.",
            { "0": modal.folder?.name },
          )
        }}
      </p>
      <p v-if="modal.kind === 'import'" class="muted">
        {{
          t(
            "Объекты bucket «{0}» под префиксом «{1}» будут добавлены в корень каталога. Существующие записи не изменятся. При пустом префиксе будут учтены все объекты, включая технические файлы.",
            { "0": settings.bucket, "1": settings.prefix || "/" },
          )
        }}
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <footer class="dialog-footer">
        <button
          type="button"
          class="button"
          :disabled="busy"
          @click="modal = null"
        >
          {{ t("Отмена") }}</button><button
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
              ? t("Выполняется…")
              : ["delete", "deleteFolder"].includes(modal.kind)
                ? t("Удалить")
                : modal.kind === "import"
                  ? t("Добавить объекты")
                  : t("Сохранить")
          }}
        </button>
      </footer>
    </form>
  </div>

  <div
    v-if="preview"
    class="preview-overlay"
    :inert="editing || undefined"
    role="dialog"
    aria-modal="true"
    :aria-label="t('Просмотр файла')"
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
          :aria-label="t('Избранное')"
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
          <i aria-hidden="true" class="ri-equalizer-line"></i
          >{{ t("Коррекция") }}</button
        ><button
          class="icon-button"
          :disabled="busy"
          :aria-label="t('Скопировать ссылку')"
          @click="share(preview.id)"
        >
          <i aria-hidden="true" class="ri-link"></i></button
        ><button
          class="icon-button"
          :disabled="busy"
          :aria-label="t('Скачать оригинал')"
          @click="download([preview.id])"
        >
          <i aria-hidden="true" class="ri-download-2-line"></i></button
        ><button
          class="icon-button"
          :aria-label="t('Закрыть просмотр')"
          @click="closePreview"
        >
          <i aria-hidden="true" class="ri-close-line"></i>
        </button>
      </div>
    </header>
    <div class="preview-body">
      <button
        class="preview-arrow previous"
        :aria-label="t('Предыдущий файл')"
        @click="nextPreview(-1)"
      >
        <i aria-hidden="true" class="ri-arrow-left-s-line"></i>
      </button>
      <div class="preview-stage">
        <div v-if="previewLoading" class="loading-state">
          <i aria-hidden="true" class="ri-loader-4-line spinning"></i
          >{{ t("Получение файла…") }}
        </div>
        <div v-else-if="previewError" class="preview-fallback">
          <i aria-hidden="true" class="ri-error-warning-line"></i>
          <p>{{ previewError }}</p>
          <button class="button" @click="openPreview(preview)">
            {{ t("Повторить") }}
          </button>
        </div>
        <template v-else-if="previewUrl"
          ><ProcessedImage
            v-if="
              preview.mime_type.startsWith('image/') &&
              needsImageProcessing(preview.adjustments)
            "
            :file="preview"
            @error="previewError = $event.message"
          />
          <img
            v-else-if="preview.mime_type.startsWith('image/')"
            :src="previewUrl"
            :alt="preview.name"
            :style="imageStyle(preview.adjustments)"
            @error="
              previewError = t(
                'Формат не поддерживается встроенным просмотром. Скачайте оригинал.',
              )
            "
          /><VideoPlayer
            v-else-if="preview.mime_type.startsWith('video/')"
            :key="`${preview.id}:${preview.object_key}`"
            :file="preview"
            :src="previewUrl"
            :save-frame="saveVideoFrame"
            :download-frame="downloadVideoFrame"
            @error="previewError = $event"
          />
          <audio
            v-else-if="preview.mime_type.startsWith('audio/')"
            :src="previewUrl"
            controls
            @error="
              previewError = t(
                'Аудиокодек не поддерживается. Скачайте оригинал.',
              )
            "
          ></audio>
          <div v-else class="preview-fallback">
            <i aria-hidden="true" :class="icon(preview.mime_type)"></i>
            <h2>{{ preview.name }}</h2>
            <p>{{ t("Для этого формата доступно скачивание.") }}</p>
            <button
              class="button primary"
              :disabled="busy"
              @click="download([preview.id])"
            >
              <i aria-hidden="true" class="ri-download-2-line"></i
              >{{ t("Скачать оригинал") }}
            </button>
          </div></template
        >
      </div>
      <button
        class="preview-arrow next"
        :aria-label="t('Следующий файл')"
        @click="nextPreview(1)"
      >
        <i aria-hidden="true" class="ri-arrow-right-s-line"></i>
      </button>
    </div>
    <footer class="preview-footer">
      <span
        >{{ files.findIndex((f) => f.id === preview?.id) + 1 }} /
        {{ t("{0} загруженных файлов", { "0": files.length }) }}</span
      ><span v-if="notice">{{ notice }}</span
      ><span v-if="error" class="error">{{ error }}</span
      ><span>{{
        preview.mime_type.startsWith("video/")
          ? t("Пробел: пауза · ← →: перемотка · Shift+S: кадр · Esc: выход")
          : t("← → для переключения · Esc для выхода")
      }}</span>
    </footer>
  </div>
  <PhotoEditor
    v-if="editing && preview"
    :file="preview"
    :save="saveImageEdits"
    @close="editing = false"
  />
</template>
