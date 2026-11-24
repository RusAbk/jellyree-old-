<script setup lang="ts">
import { localeCode, t } from "./i18n";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import FileThumb from "./FileThumb.vue";
import VideoPlayer from "./VideoPlayer.vue";
import DocumentViewer from "./DocumentViewer.vue";
import { documentKind } from "../electron/document-preview.mjs";
import { managedMediaUrl, thumbnailRevision } from "./thumbnail";
import PhotoEditor from "./PhotoEditor.vue";
import TagEditor from "./TagEditor.vue";
import { isImageFile } from "../electron/image-formats.mjs";
import { isPhotoPreview, usePhotoPreview } from "./use-photo-preview";
import { usePhotoZoom } from "./use-photo-zoom";
import SettingsPanel from "./SettingsPanel.vue";
import MediaFeed from "./MediaFeed.vue";
import TimelineScale from "./TimelineScale.vue";
import ContextMenu, { type MenuItem } from "./ContextMenu.vue";
import UploadConflictDialog from "./UploadConflictDialog.vue";
import UploadPanel from "./UploadPanel.vue";
import { useUploadJobs, uploadPercent } from "./use-upload-jobs";
import { useSelectionBox } from "./use-selection-box";
import LanguageSelect from "./LanguageSelect.vue";
import { syncLanguage } from "./i18n";
import { bytes, date, icon } from "./format";
import { api } from "./api";
import { useGalleryLayout } from "./use-gallery-layout";
import { galleryGap } from "./gallery-layout";
import { monthIndex, monthStart } from "./timeline-dates";
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
  TimelineBounds,
  ListInput,
} from "./types";

const settings = ref<Settings>({ configured: false, persisted: false });
const mobile = document.documentElement.classList.contains("mobile-app");
const mobileMenuOpen = ref(false);
const documentViewer = ref<InstanceType<typeof DocumentViewer>>(),
  documentVersion = ref(0);
let previewNavigation = 0;
const settingsOpen = ref(false),
  switchingProfile = ref(false),
  ready = ref(false),
  section = ref("drive"),
  folderId = ref<string | null>(null);
const files = ref<DriveFile[]>([]),
  folders = ref<Folder[]>([]),
  stats = ref<Stats>({ files: 0, bytes: 0, trashed: 0, tags: [] });
const tagsAlphabetical = computed(() => {
  const collator = new Intl.Collator(localeCode(), {
    sensitivity: "base",
    numeric: true,
  });
  return [...stats.value.tags].sort(collator.compare);
});
const tagClipboard = shallowRef<string[]>([]);
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
  loadingMore = ref(false),
  busy = ref(false),
  hasMore = ref(false),
  page = ref(1);
const isTimeline = computed(() => section.value === "timeline");
const mediaFeed = ref<InstanceType<typeof MediaFeed>>();
const timelineBefore = ref<string>();
const timelineBounds = shallowRef<TimelineBounds>();
const timelineBoundsState = ref<"loading" | "ready" | "failed">("loading");
const timelineDay = ref<number>();
const timelineNewer = shallowRef<DriveFile[]>([]);
const newerPage = ref(0);
const hasNewer = ref(false);
const loadingNewer = ref(false);
const newerFailed = ref(false);
let newerRequest = 0;
let boundsRequest = 0;
const knownTimelineBounds = computed(() => {
  if (!isTimeline.value) return null;
  let oldest: string | undefined, newest: string | undefined;
  let min = Infinity,
    max = -Infinity;
  function include(date: string | null | undefined) {
    if (!date) return;
    const time = Date.parse(date);
    if (!Number.isFinite(time)) return;
    if (time < min) {
      min = time;
      oldest = date;
    }
    if (time > max) {
      max = time;
      newest = date;
    }
  }
  include(timelineBounds.value?.oldest);
  include(timelineBounds.value?.newest);
  for (const file of files.value) include(file.created_at);
  return oldest && newest ? { oldest, newest } : null;
});
const listing = computed(() => ({
  section: section.value,
  folderId: folderId.value,
  search: search.value,
  tag: tag.value,
  sort: isTimeline.value ? "date" : sort.value,
  ...(isTimeline.value && timelineBefore.value
    ? { timelineBefore: timelineBefore.value }
    : {}),
}));
const loadedListing = shallowRef<typeof listing.value>();
const currentListing = computed(() => loadedListing.value === listing.value);
const filesScroll = ref<HTMLElement>(),
  fileListElement = ref<HTMLElement>(),
  loadMoreButton = ref<HTMLButtonElement>(),
  pageFailed = ref(false);
const canLoadMore = computed(
  () =>
    currentListing.value &&
    hasMore.value &&
    !loading.value &&
    !loadingNewer.value &&
    !busy.value,
);
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
  retry: retryUpload,
  retrying: retryingUploads,
  reset: resetUploads,
} = useUploadJobs(api, () => requestUploadRefresh("folders"));
let uploadRefreshPending = false;
let uploadFoldersPending = false;
let foldersGeneration = 0,
  usageGeneration = 0,
  usageRequestedAt = 0,
  usageTimer: ReturnType<typeof setTimeout> | undefined;
const usageRefreshInterval = 30_000;
let catalogPoll: ReturnType<typeof setInterval> | undefined;
const checkingCatalog = ref(false);
const error = ref(""),
  notice = ref(""),
  catalogError = ref(""),
  progress = ref<Progress | null>(null),
  dragging = ref(false);
const draggedItems = ref<DragItems | null>(null);
const dropTarget = ref<string | null | undefined>(undefined);
const dragSession = crypto.randomUUID();
const preview = ref<DriveFile | null>(null),
  previewUrl = ref(""),
  previewError = ref(""),
  previewLoading = ref(false),
  previewPageLoading = ref(false),
  editing = ref(false);
const previewTagsOpen = ref(false);
const previewTagsButton = ref<HTMLButtonElement>();
const previewIndex = computed(() =>
  files.value.findIndex((file) => file.id === preview.value?.id),
);
let previewLocation:
  { listing: typeof listing.value; index: number } | undefined;
watch(previewIndex, (index) => {
  if (index >= 0 && currentListing.value)
    previewLocation = { listing: listing.value, index };
});
const photo = computed(() =>
  preview.value && isPhotoPreview(preview.value) ? preview.value : null,
);
const {
  stage: photoStage,
  displayed: photoFrame,
  loading: photoLoading,
  error: photoError,
  retry: retryPhoto,
  clear: clearPhotos,
} = usePhotoPreview(photo, files, editing, releasePreviewMedia);
const photoZoom = usePhotoZoom(photoStage);
const {
  viewport: photoViewport,
  scale: photoScale,
  transform: photoTransform,
  dragging: photoPanning,
} = photoZoom;
watch(
  [() => photo.value?.id, () => photo.value?.object_key, editing],
  photoZoom.reset,
);
const expanded = ref(new Set<string>());
const modal = ref<{
  kind: string;
  title: string;
  input: string;
  ids: string[];
  tags: string[];
  target: string;
  folder?: Folder;
  parentId?: string | null;
} | null>(null);
const tagEditor = ref<InstanceType<typeof TagEditor>>();
let generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  previewGeneration = 0,
  unsubscribe: (() => void) | undefined;
let unsubscribeConflict: (() => void) | undefined;

const nav = computed(() => [
  { id: "drive", label: t("Мой диск"), icon: "ri-hard-drive-3-line" },
  { id: "all", label: t("Все файлы"), icon: "ri-stack-line" },
  { id: "photos", label: t("Фото и видео"), icon: "ri-image-2-line" },
  { id: "timeline", label: t("Медиалента"), icon: "ri-timeline-view" },
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
const listingSummary = computed(() => {
  if (!currentListing.value) return "";
  const counts = {
    "0": files.value.length,
    "1": childFolders.value.length
      ? t(" · {0} папок", { "0": childFolders.value.length })
      : "",
  };
  return hasMore.value
    ? t("Показано {0} файлов{1}", counts)
    : t("{0} файлов{1}", counts);
});
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
    `${settings.value.activeProfileId}/${settings.value.accountId}/${settings.value.databaseId}/${settings.value.bucket}/${settings.value.prefix}`,
);
const galleryActive = computed(
  () => currentListing.value && !isTimeline.value && view.value === "gallery",
);
const {
  rows: galleryRows,
  pending: galleryPending,
  remember: rememberGalleryDimensions,
} = useGalleryLayout(
  fileListElement,
  galleryActive,
  files,
  previewSize,
  scope,
  listing,
);
const fileGroups = computed<
  {
    key: string;
    height?: number;
    tiles: { file: DriveFile; width?: number }[];
  }[]
>(() => {
  if (view.value !== "gallery")
    return [{ key: "catalog", tiles: files.value.map((file) => ({ file })) }];
  const byId = new Map(files.value.map((file) => [file.id, file]));
  return galleryRows.value.map((row) => ({
    key: row.tiles[0]!.id,
    height: row.height,
    tiles: row.tiles.flatMap(({ id, width }) => {
      const file = byId.get(id);
      return file ? [{ file, width }] : [];
    }),
  }));
});
const selectedIds = computed(() => new Set(selection.value));
let selectionAnchor: string | undefined;
const {
  box: selectionBox,
  draft: selectionDraft,
  start: startSelectionBox,
  move: moveSelectionBox,
  end: endSelectionBox,
  interrupted: interruptSelectionBox,
  cancel: cancelSelectionBox,
} = useSelectionBox(
  selection,
  () =>
    currentListing.value &&
    files.value.length > 0 &&
    !busy.value &&
    !settingsOpen.value &&
    !modal.value &&
    !preview.value &&
    !uploadConflictOpen.value,
  () => {
    if (!selectionAnchor || !selectedIds.value.has(selectionAnchor))
      selectionAnchor = selection.value[0];
  },
);
// Keep the inspector and toolbar stable until the mouse gesture commits.
const highlightedIds = computed(
  () => selectionDraft.value ?? selectedIds.value,
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
            ...(isImageFile(files.value.find((f) => f.id === menu.ids[0]))
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
  if (!selectedIds.value.has(file.id)) selectOnly(file.id);
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
  if (id === "refresh") void refreshCatalog();
  if (id === "selectAll") selection.value = files.value.map((f) => f.id);
}

function toggleExpanded(id: string) {
  const set = new Set(expanded.value);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  expanded.value = set;
}
function navigate(next: string, id: string | null = null, nextTag = "") {
  mobileMenuOpen.value = false;
  closeContextMenu();
  if (
    (isTimeline.value && next !== "timeline") ||
    (!isTimeline.value && next === "timeline")
  )
    files.value = [];
  timelineBefore.value = undefined;
  timelineDay.value = undefined;
  section.value = next;
  folderId.value = id;
  tag.value = nextTag;
  selection.value = [];
  search.value = "";
  for (const f of breadcrumbs.value) expanded.value.add(f.id);
  void reload();
  if (next === "timeline") void refreshTimelineBounds();
}
async function refreshTimelineBounds() {
  if (!settings.value.configured) return;
  const id = ++boundsRequest;
  timelineBoundsState.value = "loading";
  try {
    const result = await api.timelineBounds();
    if (id !== boundsRequest) return;
    timelineBounds.value = result;
    timelineBoundsState.value = "ready";
  } catch {
    if (id === boundsRequest) timelineBoundsState.value = "failed";
  }
}
function jumpTimeline(month: number) {
  if (!isTimeline.value || !settings.value.configured || busy.value) return;
  const newest = knownTimelineBounds.value?.newest;
  const before =
    newest && month >= monthIndex(new Date(newest))
      ? undefined
      : monthStart(month + 1).toISOString();
  if (
    currentListing.value &&
    before &&
    mediaFeed.value?.scrollToMonth(month, before === timelineBefore.value)
  )
    return;
  if (before === timelineBefore.value && currentListing.value) {
    filesScroll.value?.scrollTo(0, 0);
    return;
  }
  closeContextMenu();
  selection.value = [];
  timelineDay.value = monthStart(month).getTime();
  timelineBefore.value = before;
  void reload();
}
function fetchNewer(input: ListInput, firstPage: number, throughPage: number) {
  return api.list({
    ...input,
    timelineSince: input.timelineBefore,
    timelineBefore: undefined,
    page: firstPage,
    throughPage,
    includeTotal: false,
  });
}
async function loadNewerTimeline() {
  const requested = listing.value;
  if (
    !requested.timelineBefore ||
    !currentListing.value ||
    !hasNewer.value ||
    loadingNewer.value ||
    loading.value ||
    busy.value
  )
    return;
  const request = ++newerRequest;
  const root = filesScroll.value;
  const anchor = root?.querySelector(".media-card");
  const top = anchor?.getBoundingClientRect().top;
  const nextPage = newerPage.value + 1;
  loadingNewer.value = true;
  if (newerFailed.value) error.value = "";
  newerFailed.value = false;
  try {
    const result = await fetchNewer(requested, nextPage, nextPage);
    if (request !== newerRequest || requested !== listing.value) return;
    const added = result.items.slice().reverse();
    timelineNewer.value = [
      ...new Map(
        [...added, ...timelineNewer.value].map((file) => [file.id, file]),
      ).values(),
    ];
    files.value = [
      ...new Map(
        [...added, ...files.value].map((file) => [file.id, file]),
      ).values(),
    ];
    newerPage.value = nextPage;
    hasNewer.value = result.hasMore;
    await nextTick();
    if (
      root &&
      anchor?.isConnected &&
      top !== undefined &&
      requested === listing.value
    )
      root.scrollTop += anchor.getBoundingClientRect().top - top;
  } catch (e) {
    if (request === newerRequest) {
      newerFailed.value = true;
      error.value = (e as Error).message;
    }
  } finally {
    if (request === newerRequest) loadingNewer.value = false;
  }
}
function scrollTimelineNewer(event: WheelEvent) {
  if (
    isTimeline.value &&
    event.deltaY < 0 &&
    (filesScroll.value?.scrollTop ?? 0) < 16 &&
    !newerFailed.value
  )
    void loadNewerTimeline();
}
async function refreshFolders() {
  const id = ++foldersGeneration;
  try {
    const tree = await api.folders();
    if (id === foldersGeneration) folders.value = tree;
  } catch (e) {
    if (id === foldersGeneration) catalogError.value = (e as Error).message;
  }
}
function refreshUsage(immediate = false) {
  if (!settings.value.configured) return;
  if (immediate) {
    clearTimeout(usageTimer);
    usageTimer = undefined;
  } else if (usageTimer !== undefined) return;
  const wait = usageRequestedAt + usageRefreshInterval - Date.now();
  if (!immediate && wait > 0) {
    usageTimer = setTimeout(() => {
      usageTimer = undefined;
      refreshUsage();
    }, wait);
    return;
  }
  usageRequestedAt = Date.now();
  const id = ++usageGeneration;
  void api.stats().then(
    (usage) => {
      if (id === usageGeneration) stats.value = usage;
    },
    (e: Error) => {
      if (id === usageGeneration) catalogError.value = e.message;
    },
  );
}
function resetCatalog() {
  ++foldersGeneration;
  ++usageGeneration;
  clearTimeout(usageTimer);
  usageTimer = undefined;
  usageRequestedAt = 0;
  ++boundsRequest;
  timelineBounds.value = undefined;
  timelineBoundsState.value = "loading";
  uploadRefreshPending = uploadFoldersPending = false;
  catalogError.value = "";
  stats.value = { files: 0, bytes: 0, trashed: 0, tags: [] };
  resetUploads();
}
async function refreshCatalog() {
  if (!settings.value.configured) return;
  catalogError.value = "";
  const refresh = Promise.all([reload(false, false, true), refreshFolders()]);
  if (isTimeline.value) void refreshTimelineBounds();
  refreshUsage(true);
  await refresh;
}
async function pollCatalog() {
  if (
    !settings.value.configured ||
    switchingProfile.value ||
    settingsOpen.value ||
    document.visibilityState !== "visible" ||
    !currentListing.value ||
    busy.value ||
    loading.value ||
    loadingNewer.value
  )
    return;
  checkingCatalog.value = true;
  try {
    await reload(false, true);
    if (isTimeline.value) void refreshTimelineBounds();
  } finally {
    checkingCatalog.value = false;
  }
}
function requestUploadRefresh(
  refresh: "files" | "usage" | "folders" = "files",
) {
  uploadRefreshPending = true;
  uploadFoldersPending ||= refresh === "folders";
  if (refresh !== "files") refreshUsage();
  flushUploadRefresh();
}
function flushUploadRefresh() {
  if (
    !uploadRefreshPending ||
    busy.value ||
    loading.value ||
    loadingNewer.value ||
    !currentListing.value ||
    !settings.value.configured
  )
    return;
  uploadRefreshPending = false;
  if (uploadFoldersPending) {
    uploadFoldersPending = false;
    void refreshFolders();
  }
  void reload(false, true);
}
watch([busy, loading, currentListing], flushUploadRefresh);
const refreshPages = 5;
let nextPageRequest:
  { listing: typeof listing.value; done: Promise<void> } | undefined;
function loadNextPage() {
  if (nextPageRequest?.listing === listing.value) return nextPageRequest.done;
  if (!canLoadMore.value) return;
  const request = { listing: listing.value, done: reload(true) };
  nextPageRequest = request;
  void request.done.finally(() => {
    if (nextPageRequest === request) nextPageRequest = undefined;
  });
  return request.done;
}
async function reload(more = false, background = false, refresh = false) {
  if (!settings.value.configured || (more && !canLoadMore.value)) return;
  if (!more && !background) clearTimeout(timer);
  const requestedListing = listing.value,
    id = ++generation,
    nextPage = more ? page.value + 1 : background ? page.value : 1;
  loading.value = true;
  loadingMore.value = more;
  if (!background) {
    error.value = "";
    pageFailed.value = false;
  }
  try {
    const firstPage = more ? nextPage : 1;
    const pages = Array.from(
      { length: Math.ceil((nextPage - firstPage + 1) / refreshPages) },
      (_, index) => firstPage + index * refreshPages,
    );
    const older = Promise.all(
      pages.map((requestedPage) =>
        api.list({
          ...requestedListing,
          page: requestedPage,
          throughPage: Math.min(requestedPage + refreshPages - 1, nextPage),
          includeTotal: false,
          refresh: refresh && requestedPage === 1,
        }),
      ),
    );
    const loadedNewerPages = newerPage.value;
    const newer =
      !more && requestedListing.timelineBefore && loadedNewerPages
        ? Promise.all(
            Array.from(
              { length: Math.ceil(loadedNewerPages / refreshPages) },
              (_, index) =>
                fetchNewer(
                  requestedListing,
                  index * refreshPages + 1,
                  Math.min((index + 1) * refreshPages, loadedNewerPages),
                ),
            ),
          ).catch(() => undefined)
        : Promise.resolve(undefined);
    const [results, newerResults] = await Promise.all([older, newer]);
    if (id !== generation || requestedListing !== listing.value) return;
    const result = {
      ...results[results.length - 1]!,
      items: results.flatMap((result) => result.items),
    };
    if (newerResults?.length && loadedNewerPages === newerPage.value) {
      timelineNewer.value = newerResults
        .flatMap((item) => item.items)
        .reverse();
      hasNewer.value = newerResults.at(-1)!.hasMore;
    }
    const items = more
      ? [...files.value, ...result.items]
      : requestedListing.timelineBefore
        ? [...timelineNewer.value, ...result.items]
        : result.items;
    const byId = new Map(items.map((file) => [file.id, file]));
    files.value = [...byId.values()];
    hasMore.value = result.hasMore;
    page.value = nextPage;
    loadedListing.value = requestedListing;
    selection.value = selection.value.filter((s) => byId.has(s));
    if (preview.value) {
      const updated = byId.get(preview.value.id);
      if (
        updated &&
        updated.object_key !== preview.value.object_key &&
        !editing.value
      ) {
        if (!documentViewer.value?.isEditing) void openPreview(updated);
      } else if (updated && !editing.value) preview.value = updated;
    }
  } catch (e) {
    if (
      id === generation &&
      requestedListing === listing.value &&
      !background
    ) {
      error.value = (e as Error).message;
      pageFailed.value = more;
    }
  } finally {
    if (id === generation) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}
async function action(
  fn: () => Promise<unknown>,
  message = "",
  refresh: "files" | "folders" | "usage" | "none" = "files",
) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  progress.value = null;
  try {
    await fn();
    if (message) notice.value = message;
    const operationError = error.value;
    if (refresh === "folders") await refreshFolders();
    if (refresh === "usage") refreshUsage(true);
    if (refresh !== "none") await reload();
    if (operationError) error.value = operationError;
    return true;
  } catch (e) {
    const message = (e as Error).message;
    if (refresh === "folders") await refreshFolders();
    if (refresh === "usage") refreshUsage(true);
    if (refresh !== "none") await reload();
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
  if (!selectedIds.value.has(file.id)) selectOnly(file.id);
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
      "folders",
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
function selectOnly(id: string) {
  selection.value = [id];
  selectionAnchor = id;
}
function select(
  file: DriveFile,
  event: MouseEvent | KeyboardEvent,
  toggle = false,
) {
  const additive = event.metaKey || event.ctrlKey;
  if (event.shiftKey) {
    const anchor = selection.value.length
      ? files.value.findIndex(({ id }) => id === selectionAnchor)
      : -1;
    const target = files.value.findIndex(({ id }) => id === file.id);
    if (anchor >= 0 && target >= 0) {
      const start = Math.min(anchor, target);
      const end = Math.max(anchor, target);
      const range = files.value.slice(start, end + 1).map(({ id }) => id);
      selection.value = additive
        ? [...new Set([...selection.value, ...range])]
        : range;
      return;
    }
    selectOnly(file.id);
  } else if (toggle || additive) {
    selection.value = selectedIds.value.has(file.id)
      ? selection.value.filter((id) => id !== file.id)
      : [...selection.value, file.id];
    selectionAnchor = file.id;
  } else selectOnly(file.id);
}
function tapFile(
  file: DriveFile,
  event: MouseEvent | KeyboardEvent,
  toggle = false,
) {
  if (mobile && !toggle && !selection.value.length) void openPreview(file);
  else select(file, event, toggle || mobile);
}
let touchHold: ReturnType<typeof setTimeout> | undefined;
let heldAt: { x: number; y: number } | undefined;
let swallowTapUntil = 0;
function stopTouchHold() {
  clearTimeout(touchHold);
  touchHold = undefined;
  heldAt = undefined;
}
function startTouchHold(event: PointerEvent) {
  if (!mobile || event.pointerType !== "touch" || !event.isPrimary) return;
  const target = (event.target as HTMLElement).closest(
    ".file-card, .folder-card, .tree-row",
  );
  if (
    !target ||
    (event.target as HTMLElement).closest(
      ".file-checkbox, .file-open, .file-star, .tree-chevron",
    )
  )
    return;
  stopTouchHold();
  const { clientX, clientY } = event;
  heldAt = { x: clientX, y: clientY };
  touchHold = setTimeout(() => {
    if (!target.isConnected) return;
    swallowTapUntil = Date.now() + 700;
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
      }),
    );
  }, 470);
}
function moveTouchHold(event: PointerEvent) {
  if (
    heldAt &&
    Math.hypot(heldAt.x - event.clientX, heldAt.y - event.clientY) > 9
  )
    stopTouchHold();
}
function swallowLongPressTap(event: MouseEvent) {
  if (!mobile || Date.now() >= swallowTapUntil) return;
  swallowTapUntil = 0;
  event.preventDefault();
  event.stopPropagation();
}
function patch(ids: string[], input: FilePatch, message = "") {
  return action(
    () => api.update(ids, input),
    message,
    input.trashed !== undefined || input.tags !== undefined ? "usage" : "files",
  );
}
async function upload(
  folders = false,
  dropped?: File[],
  targetFolderId = uploadFolder.value,
) {
  mobileMenuOpen.value = false;
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
        : kind === "renameFolder"
          ? folder?.name || ""
          : "",
    ids: [...ids],
    tags: kind === "tags" ? [...(file?.tags || [])] : [],
    target: "",
    folder,
    parentId,
  };
}
function updateDraftTags(tags: string[]) {
  if (modal.value?.kind !== "tags") return false;
  modal.value.tags = tags;
  return true;
}
function rememberTags(tags: string[]) {
  stats.value = {
    ...stats.value,
    tags: [...new Set([...stats.value.tags, ...tags])],
  };
}
async function submitModal() {
  const value = modal.value;
  if (!value) return;
  if (
    value.kind === "delete" &&
    photo.value &&
    value.ids.length === 1 &&
    value.ids[0] === photo.value.id
  ) {
    await deletePreviewPhoto(true);
    return;
  }
  const refresh = [
    "createFolder",
    "renameFolder",
    "moveFolder",
    "deleteFolder",
  ].includes(value.kind)
    ? "folders"
    : ["delete", "import", "tags"].includes(value.kind)
      ? "usage"
      : "files";
  const success = await action(
    async () => {
      if (value.kind === "createFolder")
        await api.createFolder(value.input, value.parentId ?? null);
      if (value.kind === "rename")
        await api.update(value.ids, { name: value.input });
      if (value.kind === "tags") {
        const tags = tagEditor.value?.pendingTags() ?? value.tags;
        await api.update(value.ids, { tags });
        rememberTags(tags);
      }
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
        if (preview.value && value.ids.includes(preview.value.id))
          closePreview();
      }
      if (value.kind === "import") {
        const result = await api.importBucket();
        notice.value = t("Проверено объектов: {0}", { "0": result.scanned });
      }
    },
    "",
    refresh,
  );
  if (success) modal.value = null;
}
async function openPreview(file: DriveFile) {
  const navigation = ++previewNavigation;
  if (documentViewer.value && !(await documentViewer.value.requestLeave()))
    return;
  if (navigation !== previewNavigation) return;
  const id = ++previewGeneration;
  documentVersion.value++;
  releasePreviewMedia(previewUrl.value);
  preview.value = file;
  const index = previewIndex.value;
  if (index >= 0) previewLocation = { listing: listing.value, index };
  if (!isPhotoPreview(file)) previewTagsOpen.value = false;
  previewUrl.value = "";
  previewError.value = "";
  previewLoading.value = true;
  editing.value = false;
  try {
    if (isPhotoPreview(file) || documentKind(file)) return;
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
    else releasePreviewMedia(url);
  } catch (e) {
    if (id === previewGeneration) previewError.value = (e as Error).message;
  } finally {
    if (id === previewGeneration) previewLoading.value = false;
  }
}
async function closePreview() {
  const navigation = ++previewNavigation;
  if (documentViewer.value && !(await documentViewer.value.requestLeave()))
    return;
  if (navigation !== previewNavigation) return;
  previewGeneration++;
  releasePreviewMedia(previewUrl.value);
  preview.value = null;
  previewLocation = undefined;
  previewTagsOpen.value = false;
  previewUrl.value = "";
  editing.value = false;
}
function releasePreviewMedia(url: string) {
  if (
    managedMediaUrl(url) &&
    typeof window.jellyree.releaseMedia === "function"
  )
    void api.releaseMedia(url).catch(() => {});
}
function fileSaved(file: DriveFile) {
  if (preview.value?.id === file.id) preview.value = file;
  files.value = files.value.map((current) =>
    current.id === file.id ? file : current,
  );
  timelineNewer.value = timelineNewer.value.map((current) =>
    current.id === file.id ? file : current,
  );
  requestUploadRefresh("usage");
}
async function nextPreview(direction: number) {
  if (
    busy.value ||
    editing.value ||
    previewPageLoading.value ||
    !preview.value ||
    !currentListing.value
  )
    return;
  const fileId = preview.value.id;
  const index = previewIndex.value;
  const position =
    previewLocation?.listing === listing.value ? previewLocation.index : 0;
  const next =
    files.value[
      index < 0 ? position + Math.min(0, direction) : index + direction
    ];
  if (next) {
    await openPreview(next);
    return;
  }
  if (direction < 0) return;
  const pending = loadNextPage();
  if (!pending) return;
  const navigation = previewNavigation;
  const requestedListing = listing.value;
  previewPageLoading.value = true;
  try {
    await pending;
    if (
      navigation !== previewNavigation ||
      preview.value?.id !== fileId ||
      requestedListing !== listing.value ||
      editing.value
    )
      return;
    const current = files.value.findIndex((f) => f.id === fileId);
    const following = files.value[current < 0 ? position : current + 1];
    if (following) void openPreview(following);
  } finally {
    previewPageLoading.value = false;
  }
}
function closePreviewTags() {
  previewTagsOpen.value = false;
  previewTagsButton.value?.focus();
}
async function savePreviewTags(tags: string[]) {
  const file = preview.value;
  if (!file) return;
  const saved = await action(
    async () => {
      await api.update([file.id], { tags });
      rememberTags(tags);
      if (preview.value?.id === file.id)
        preview.value = { ...preview.value, tags };
      files.value = files.value.map((current) =>
        current.id === file.id ? { ...current, tags } : current,
      );
      timelineNewer.value = timelineNewer.value.map((current) =>
        current.id === file.id ? { ...current, tags } : current,
      );
    },
    "",
    "none",
  );
  if (saved) requestUploadRefresh("usage");
  return saved;
}
async function duplicatePreviewPhoto() {
  const source = photo.value;
  if (!source || source.trashed_at) return;
  const navigation = previewNavigation;
  const requestedListing = listing.value;
  const saved = await action(
    async () => {
      const copy = await api.duplicatePhoto(source.id, source.object_key);
      const index = files.value.findIndex((file) => file.id === source.id);
      if (requestedListing === listing.value && index >= 0)
        files.value = [
          ...files.value.slice(0, index + 1),
          copy,
          ...files.value.slice(index + 1),
        ];
      if (navigation === previewNavigation) await openPreview(copy);
    },
    t("Дубликат создан."),
    "none",
  );
  if (saved) {
    requestUploadRefresh("usage");
    if (isTimeline.value) void refreshTimelineBounds();
  }
}
async function deletePreviewPhoto(permanent = false) {
  const target = photo.value;
  if (!target || busy.value || previewPageLoading.value) return;
  if (!permanent && target.trashed_at) {
    openModal("delete", [target.id]);
    return;
  }
  const navigation = previewNavigation;
  const requestedListing = listing.value;
  const index = previewIndex.value;
  const position =
    index >= 0
      ? index
      : previewLocation?.listing === requestedListing
        ? previewLocation.index
        : 0;
  const previous = files.value
    .slice(0, position)
    .reverse()
    .find(isPhotoPreview);
  let neighbor =
    previous ??
    files.value.slice(position + Number(index >= 0)).find(isPhotoPreview);
  const saved = await action(
    async () => {
      if (permanent) await api.remove([target.id]);
      else await api.update([target.id], { trashed: true });
      files.value = files.value.filter((file) => file.id !== target.id);
      timelineNewer.value = timelineNewer.value.filter(
        (file) => file.id !== target.id,
      );
      selection.value = selection.value.filter((id) => id !== target.id);
    },
    permanent ? "" : t("Файлы перемещены в корзину."),
    "none",
  );
  if (!saved) return;
  if (permanent) modal.value = null;
  if (navigation === previewNavigation && requestedListing === listing.value) {
    if (!neighbor && hasMore.value) {
      previewPageLoading.value = true;
      try {
        // Refresh the loaded pages so deleting a row cannot skip the first
        // item on the next page of the Cloudflare listing.
        await reload(false, true);
        neighbor = files.value.find(isPhotoPreview);
        while (
          !neighbor &&
          navigation === previewNavigation &&
          requestedListing === listing.value
        ) {
          const pending = loadNextPage();
          if (!pending) break;
          const previousPage = page.value;
          await pending;
          if (page.value === previousPage) break;
          neighbor = files.value.find(isPhotoPreview);
        }
      } finally {
        previewPageLoading.value = false;
      }
    }
    if (navigation === previewNavigation) {
      if (neighbor) await openPreview(neighbor);
      else await closePreview();
    }
  }
  requestUploadRefresh("usage");
  if (isTimeline.value) void refreshTimelineBounds();
}
async function saveVideoFrame(file: DriveFile, frame: CapturedVideoFrame) {
  const saved = await api.saveVideoFrame(
    file.id,
    file.object_key,
    frame.timestamp,
    frame.data,
  );
  requestUploadRefresh("usage");
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
async function saveEditedImage(source: DriveFile, data: Uint8Array) {
  const result = await api.saveEditedImage(source.id, source.object_key, data);
  fileSaved(result.file);
  return result;
}
async function download(ids = selection.value) {
  await action(
    async () => {
      const result = await api.download(ids);
      notice.value = t("Скачано файлов: {0}", { "0": result.done });
    },
    "",
    "none",
  );
}
async function share(id: string) {
  await action(
    () => api.share(id),
    t("Ссылка скопирована. Действует 1 час; доступна всем, у кого она есть."),
    "none",
  );
}
async function applyConnection(value: Settings, message: string) {
  ++generation;
  resetCatalog();
  loadedListing.value = undefined;
  loading.value = loadingMore.value = false;
  await closePreview();
  clearPhotos();
  closeContextMenu();
  finishDrag();
  settings.value = value;
  settingsOpen.value = false;
  files.value = [];
  folders.value = [];
  expanded.value = new Set();
  selection.value = [];
  selectionAnchor = undefined;
  inspectorOpen.value = false;
  modal.value = null;
  folderId.value = null;
  section.value = "drive";
  timelineBefore.value = undefined;
  timelineDay.value = undefined;
  tag.value = "";
  search.value = "";
  error.value = "";
  notice.value = message;
  await refreshCatalog();
}
function saved(value: Settings) {
  return applyConnection(
    value,
    value.persisted
      ? t("Подключение сохранено на этом устройстве.")
      : t(
          "Системное хранилище ключей недоступно. Реквизиты будут забыты при закрытии.",
        ),
  );
}
function selectedConnection(value: Settings) {
  return applyConnection(
    value,
    t("Открыто подключение «{0}».", { "0": value.name || value.bucket }),
  );
}
async function removedConnection(value: Settings) {
  const message = t("Подключение удалено с устройства.");
  if (
    value.configured &&
    value.activeProfileId === settings.value.activeProfileId
  ) {
    settings.value = value;
    notice.value = message;
  } else {
    await applyConnection(value, message);
  }
}
async function switchConnection(event: Event) {
  const select = event.currentTarget as HTMLSelectElement;
  const id = select.value;
  if (
    id !== settings.value.activeProfileId &&
    !switchingProfile.value &&
    !busy.value &&
    !pendingUploads.value
  ) {
    switchingProfile.value = true;
    try {
      await selectedConnection(await api.settings.select(id));
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      switchingProfile.value = false;
    }
  }
  select.value = settings.value.activeProfileId ?? "";
}
function keydown(event: KeyboardEvent) {
  if (switchingProfile.value) return;
  if (event.key === "Escape" && cancelSelectionBox()) {
    event.preventDefault();
    return;
  }
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
    else if (previewTagsOpen.value) closePreviewTags();
    else if (preview.value) {
      void closePreview();
      return;
    } else selection.value = [];
  }
  if (settingsOpen.value || modal.value) return;
  if (preview.value) {
    if (event.key === "ArrowRight") nextPreview(1);
    if (event.key === "ArrowLeft") nextPreview(-1);
    if (
      photo.value &&
      !photoLoading.value &&
      !photoError.value &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      if (["+", "=", "-", "0"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "0") photoZoom.reset();
        else photoZoom.zoomBy(event.key === "-" ? -1 : 1);
      }
    }
    if (
      photo.value &&
      !previewTagsOpen.value &&
      event.key === "Delete" &&
      !event.repeat
    ) {
      event.preventDefault();
      void deletePreviewPhoto();
    }
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
watch(
  search,
  () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      selection.value = [];
      void reload();
    }, 300);
  },
  { flush: "sync" },
);
watch(sort, () => {
  if (!isTimeline.value) void reload();
});
watch(
  listing,
  (entry) => {
    ++newerRequest;
    timelineNewer.value = [];
    newerPage.value = 0;
    hasNewer.value = !!entry.timelineBefore;
    loadingNewer.value = false;
    newerFailed.value = false;
  },
  { flush: "sync" },
);
watch(
  listing,
  () => {
    selectionAnchor = undefined;
    cancelSelectionBox();
    filesScroll.value?.scrollTo(0, 0);
  },
  { flush: "post" },
);
watch(scope, () => {
  selectionAnchor = undefined;
  cancelSelectionBox();
  filesScroll.value?.scrollTo(0, 0);
});
const autoLoadMore = computed(
  () =>
    canLoadMore.value &&
    !galleryPending.value &&
    !pageFailed.value &&
    !preview.value &&
    !settingsOpen.value &&
    !modal.value,
);
watch(
  [filesScroll, loadMoreButton, autoLoadMore],
  ([root, button, enabled], _, onCleanup) => {
    if (!root || !button || !enabled) return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          active &&
          autoLoadMore.value &&
          entries.some((entry) => entry.isIntersecting)
        )
          void loadNextPage();
      },
      { root, rootMargin: "0px 0px 320px 0px" },
    );
    observer.observe(button);
    onCleanup(() => {
      active = false;
      observer.disconnect();
    });
  },
  { flush: "post" },
);
watch(view, (value) => {
  cancelSelectionBox();
  localStorage.setItem("jellyree-desktop-view", value);
});
watch(previewSize, (value) =>
  localStorage.setItem("jellyree-desktop-preview-size", String(value)),
);
const mobileWindow = window as Window & { jellyreeMobileBack?: () => boolean };
function mobileBack() {
  if (uploadConflictOpen.value) uploadConflictOpen.value = false;
  else if (contextMenu.value) closeContextMenu();
  else if (modal.value && !busy.value) modal.value = null;
  else if (modal.value) return true;
  else if (editing.value)
    document
      .querySelector(".photo-editor")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
  else if (previewTagsOpen.value) closePreviewTags();
  else if (preview.value) void closePreview();
  else if (settingsOpen.value) settingsOpen.value = false;
  else if (mobileMenuOpen.value) mobileMenuOpen.value = false;
  else if (uploadsOpen.value) uploadsOpen.value = false;
  else if (inspectorOpen.value) inspectorOpen.value = false;
  else if (selection.value.length) selection.value = [];
  else if (currentFolder.value)
    navigate("drive", currentFolder.value.parent_id);
  else if (section.value !== "drive") navigate("drive");
  else return false;
  return true;
}
onMounted(async () => {
  if (mobile) mobileWindow.jellyreeMobileBack = mobileBack;
  document.addEventListener("keydown", keydown);
  if (!window.jellyree) {
    error.value = t(
      "Откройте приложение через Electron: npm run dev или npm start.",
    );
    ready.value = true;
    return;
  }
  await syncLanguage();
  catalogPoll = setInterval(() => void pollCatalog(), 60_000);
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
    if (settings.value.configured) await refreshCatalog();
    else settingsOpen.value = true;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    ready.value = true;
  }
});
onBeforeUnmount(() => {
  if (mobile) delete mobileWindow.jellyreeMobileBack;
  stopTouchHold();
  unsubscribe?.();
  unsubscribeConflict?.();
  clearTimeout(timer);
  clearInterval(catalogPoll);
  resetCatalog();
  document.removeEventListener("keydown", keydown);
});
</script>

<template>
  <div
    class="app-shell"
    :inert="switchingProfile || undefined"
    @dragover="dragover"
    @dragleave="dragleave"
    @drop="drop"
    @dragend="finishDrag"
    @pointerdown="startTouchHold"
    @pointermove="moveTouchHold"
    @pointerup="stopTouchHold"
    @pointercancel="stopTouchHold"
    @click.capture="swallowLongPressTap"
  >
    <button
      v-if="mobile && mobileMenuOpen"
      class="mobile-menu-backdrop"
      :aria-label="t('Закрыть меню')"
      @click="mobileMenuOpen = false"
    ></button>
    <aside class="sidebar" :class="{ 'mobile-sidebar-open': mobileMenuOpen }">
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
      <template v-if="tagsAlphabetical.length"
        ><div class="sidebar-label">{{ t("ТЕГИ") }}</div>
        <div class="sidebar-tags">
          <button
            v-for="name in tagsAlphabetical"
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
        ><small :title="settings.bucket">{{
          settings.name || settings.bucket || t("Подключите своё хранилище")
        }}</small
        ><small
          v-if="settings.configured && !settings.persisted"
          class="session-only"
          >{{ t("Ключи только на эту сессию") }}</small
        >
      </div>
      <button
        class="settings-link"
        :disabled="busy || switchingProfile"
        @click="settingsOpen = true"
      >
        <i aria-hidden="true" class="ri-settings-3-line"></i
        >{{ t("Настройки подключения")
        }}<i aria-hidden="true" class="ri-arrow-right-s-line"></i>
      </button>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <button
          v-if="mobile"
          class="icon-button mobile-open-menu"
          :aria-label="t('Открыть меню')"
          :aria-expanded="mobileMenuOpen"
          @click="mobileMenuOpen = !mobileMenuOpen"
        >
          <i class="ri-menu-line" aria-hidden="true"></i>
        </button>
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
            <i aria-hidden="true" class="ri-close-line"></i>
          </button>
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
        <div
          v-if="(settings.profiles?.length ?? 0) > 1"
          class="quick-connection"
          :aria-busy="switchingProfile"
        >
          <i
            aria-hidden="true"
            :class="
              switchingProfile ? 'ri-loader-4-line spinning' : 'ri-cloud-line'
            "
          ></i>
          <select
            :value="settings.activeProfileId"
            :title="settings.name"
            :aria-label="t('Активное подключение')"
            :disabled="busy || switchingProfile || pendingUploads > 0"
            @change="switchConnection"
          >
            <option
              v-for="profile in settings.profiles"
              :key="profile.id"
              :value="profile.id"
            >
              {{ profile.name }}
            </option>
          </select>
        </div>
        <span v-else class="direct-badge"
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
          @click="refreshCatalog()"
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
          :disabled="busy || switchingProfile"
          @click="settingsOpen = true"
        >
          J
        </button>
      </header>
      <div v-if="error || catalogError" class="banner error" role="alert">
        <i aria-hidden="true" class="ri-error-warning-line"></i
        ><span>{{ error || catalogError }}</span
        ><button
          class="icon-button small"
          :aria-label="t('Закрыть сообщение')"
          @click="error ? (error = '') : (catalogError = '')"
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
      <section
        class="content"
        :class="{ 'timeline-content': isTimeline }"
        @contextmenu="emptyContext"
      >
        <div class="catalog-header">
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
              <h1>{{ title }}</h1>
              <p v-if="settings.configured && listingSummary">
                {{ listingSummary }}
              </p>
            </div>
            <div v-if="!isTimeline" class="page-actions">
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
        </div>
        <div
          v-if="settings.configured && (!isTimeline || selection.length)"
          class="file-controls"
        >
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
                  ></i>
                </button>
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
          <div v-if="!isTimeline" class="preview-settings">
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
        </div>
        <div
          ref="filesScroll"
          class="files-scroll"
          :class="{
            'selecting-files': !!selectionBox,
            'timeline-scroll': isTimeline,
            'gallery-scroll': !isTimeline && view === 'gallery',
          }"
          :tabindex="isTimeline ? 0 : undefined"
          :aria-label="isTimeline ? t('Медиалента') : undefined"
          @wheel.passive="scrollTimelineNewer"
          @pointerdown="!mobile && startSelectionBox($event)"
          @pointermove="moveSelectionBox"
          @pointerup="endSelectionBox"
          @pointercancel="interruptSelectionBox"
          @lostpointercapture="interruptSelectionBox"
        >
          <div
            v-if="selectionBox"
            class="selection-box"
            aria-hidden="true"
            :style="{
              left: `${selectionBox.left}px`,
              top: `${selectionBox.top}px`,
              width: `${selectionBox.width}px`,
              height: `${selectionBox.height}px`,
            }"
          ></div>
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
            <div
              v-if="!isTimeline && view === 'list' && files.length"
              class="list-heading"
            >
              <span>{{ t("Название") }}</span><span>{{ t("Размер") }}</span
              ><span>{{ t("Дата добавления") }}</span
              ><span></span>
            </div>
            <template v-if="isTimeline">
              <button
                v-if="currentListing && hasNewer"
                class="button timeline-newer"
                :disabled="loadingNewer || loading || busy"
                @click="loadNewerTimeline"
              >
                <i
                  aria-hidden="true"
                  :class="
                    loadingNewer
                      ? 'ri-loader-4-line spinning'
                      : 'ri-arrow-up-line'
                  "
                ></i>
                {{ newerFailed ? t("Повторить") : t("Более новые медиафайлы") }}
              </button>
              <MediaFeed
                :files="currentListing ? files : []"
                :scroll-root="filesScroll"
                :selected="highlightedIds"
                :selection="selectedIds"
                :dragged-ids="
                  draggedItems?.kind === 'files' ? draggedItems.ids : []
                "
                :preview-size="previewSize"
                :busy="busy"
                @day="timelineDay = $event"
                @select="tapFile"
                @open="openPreview"
                @context="fileContext"
                @drag="fileDragStart"
                ref="mediaFeed"
              />
            </template>
            <div
              v-else
              ref="fileListElement"
              :key="scope"
              class="files"
              :class="view"
              :style="{
                '--preview-size': `${previewSize}px`,
                '--gallery-gap': `${galleryGap}px`,
              }"
              :aria-busy="loading || galleryPending"
            >
              <div
                v-for="group in fileGroups"
                :key="group.key"
                :class="group.height ? 'gallery-row' : 'catalog-file-group'"
                :style="
                  group.height
                    ? { '--gallery-thumb-height': `${group.height}px` }
                    : undefined
                "
              >
                <article
                  v-for="{ file, width } in group.tiles"
                  :key="file.id"
                  class="file-card"
                  :data-file-id="file.id"
                  :style="
                    width === undefined ? undefined : { width: `${width}px` }
                  "
                  :class="{
                    selected: highlightedIds.has(file.id),
                    'drag-source':
                      draggedItems?.kind === 'files' &&
                      draggedItems.ids.includes(file.id),
                  }"
                  :draggable="!busy && !file.trashed_at"
                  @dragstart.stop="fileDragStart($event, file)"
                  tabindex="0"
                  @click="tapFile(file, $event)"
                  @dblclick="!mobile && openPreview(file)"
                  @contextmenu="fileContext($event, file)"
                  @keydown.enter="openPreview(file)"
                  @keydown.space.self.prevent="select(file, $event, true)"
                >
                  <div class="thumb-wrap">
                    <FileThumb
                      :file="file"
                      :compact="view === 'list'"
                      :contained="view === 'gallery'"
                      @dimensions="rememberGalleryDimensions(file, $event)"
                    /><button
                      class="file-checkbox"
                      :class="{ checked: highlightedIds.has(file.id) }"
                      :aria-label="t('Выбрать {0}', { '0': file.name })"
                      :aria-pressed="selectedIds.has(file.id)"
                      @click.stop="select(file, $event, true)"
                    >
                      <i
                        aria-hidden="true"
                        :class="
                          highlightedIds.has(file.id)
                            ? 'ri-checkbox-fill'
                            : 'ri-checkbox-blank-line'
                        "
                      ></i></button
                    ><button
                      class="favorite-button"
                      :class="{ starred: file.favorite }"
                      :disabled="busy"
                      :aria-label="
                        file.favorite
                          ? t('Убрать из избранного')
                          : t('В избранное')
                      "
                      @click.stop="
                        patch([file.id], { favorite: !file.favorite })
                      "
                    >
                      <i
                        aria-hidden="true"
                        :class="file.favorite ? 'ri-star-fill' : 'ri-star-line'"
                      ></i>
                    </button>
                  </div>
                  <div class="file-info">
                    <div class="file-name" :title="file.name">
                      <i
                        aria-hidden="true"
                        :class="icon(file.mime_type, file.name)"
                      ></i
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
                      : isTimeline
                        ? knownTimelineBounds
                          ? t("Нет медиафайлов на эту дату")
                          : t("Здесь будут ваши медиафайлы")
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
                      : isTimeline
                        ? knownTimelineBounds
                          ? t("Выберите другой месяц на временной шкале.")
                          : t("Загрузите фото, видео или аудио.")
                        : section === "favorites"
                          ? t("Нажмите на звёздочку рядом с нужным файлом.")
                          : t(
                              "Перетащите файлы сюда или загрузите целую папку.",
                            )
                }}
              </p>
              <button
                v-if="
                  !search &&
                  !tag &&
                  ['drive', 'all', 'photos', 'timeline'].includes(section)
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
            <div
              v-if="loading && !loadingMore && !checkingCatalog"
              class="loading-state"
            >
              <i aria-hidden="true" class="ri-loader-4-line spinning"></i
              >{{ t("Загрузка каталога…") }}
            </div>
            <button
              v-if="currentListing && hasMore"
              ref="loadMoreButton"
              class="button load-more"
              :disabled="!canLoadMore"
              @click="loadNextPage()"
            >
              <i
                v-if="loadingMore"
                aria-hidden="true"
                class="ri-loader-4-line spinning"
              ></i>
              {{
                loadingMore
                  ? t("Загрузка каталога…")
                  : pageFailed
                    ? t("Повторить")
                    : t("Показать ещё · {0} загружено", {
                        "0": files.length,
                      })
              }}
            </button>
          </template>
        </div>
        <TimelineScale
          v-if="isTimeline && settings.configured"
          :bounds="knownTimelineBounds"
          :active-day="timelineDay"
          :loading="timelineBoundsState === 'loading' || loading"
          :failed="timelineBoundsState === 'failed'"
          @jump="jumpTimeline"
          @retry="refreshTimelineBounds"
        />
      </section>
      <nav v-if="mobile" class="mobile-tab-bar" :aria-label="t('Библиотека')">
        <button
          v-for="item in nav.filter((item) =>
            ['drive', 'timeline', 'favorites'].includes(item.id),
          )"
          :key="item.id"
          :class="{ active: section === item.id && !tag }"
          :aria-current="section === item.id ? 'page' : undefined"
          @click="navigate(item.id)"
        >
          <i :class="item.icon" aria-hidden="true"></i>{{ item.label }}
        </button>
        <button :disabled="busy || !ready" @click="upload()">
          <i class="ri-add-circle-line" aria-hidden="true"></i
          >{{ t("Загрузить") }}
        </button>
      </nav>
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
    :inert="switchingProfile || undefined"
    :class="{
      'upload-panel-next-to-timeline': isTimeline && settings.configured,
      'upload-panel-next-to-inspector':
        isTimeline && selectedFile && inspectorOpen,
    }"
    :jobs="uploadJobs"
    :pending="pendingUploads"
    :has-finished="hasFinishedUploads"
    :retrying="retryingUploads"
    @close="uploadsOpen = false"
    @clear="clearFinishedUploads"
    @conflict="uploadConflictOpen = true"
    @retry="retryUpload"
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
    @selected="selectedConnection"
    @removed="removedConnection"
  />
  <div v-if="modal" class="overlay" @click.self="!busy && (modal = null)">
    <form
      class="dialog action-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      @submit.prevent="submitModal"
      @keydown.esc.stop="!busy && (modal = null)"
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
      <p v-if="modal.kind === 'tags' && modal.ids.length > 1" class="muted">
        {{ t("Этот набор заменит теги всех выбранных файлов.") }}
      </p>
      <TagEditor
        v-if="modal.kind === 'tags'"
        ref="tagEditor"
        v-model:clipboard="tagClipboard"
        :tags="modal.tags"
        :known="tagsAlphabetical"
        :busy="busy"
        :save="updateDraftTags"
        comma-separated
      />
      <label
        v-if="['createFolder', 'rename', 'renameFolder'].includes(modal.kind)"
        >{{ t("Название")
        }}<input
          v-model="modal.input"
          autofocus
          required
          maxlength="255"
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
    :inert="editing || !!modal || undefined"
    role="dialog"
    aria-modal="true"
    :aria-label="t('Просмотр файла')"
  >
    <header class="preview-header">
      <div>
        <i aria-hidden="true" :class="icon(preview.mime_type, preview.name)"></i
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
          v-if="isImageFile(preview)"
          class="button"
          :disabled="busy || previewPageLoading"
          @click="editing = !editing"
        >
          <i aria-hidden="true" class="ri-equalizer-line"></i
          >{{ t("Коррекция") }}</button
        ><button
          v-if="photo"
          ref="previewTagsButton"
          class="icon-button"
          :aria-expanded="previewTagsOpen"
          :aria-label="t('Теги')"
          :title="t('Теги')"
          @click="previewTagsOpen = !previewTagsOpen"
        >
          <i aria-hidden="true" class="ri-price-tag-3-line"></i></button
        ><button
          v-if="photo && !preview.trashed_at"
          class="icon-button"
          :disabled="busy || previewPageLoading"
          :aria-label="t('Создать дубликат')"
          :title="t('Создать дубликат')"
          @click="duplicatePreviewPhoto"
        >
          <i aria-hidden="true" class="ri-file-copy-line"></i></button
        ><button
          v-if="photo"
          class="icon-button preview-delete"
          :disabled="busy || previewPageLoading"
          :aria-label="t(preview.trashed_at ? 'Удалить навсегда' : 'В корзину')"
          :title="t(preview.trashed_at ? 'Удалить навсегда' : 'В корзину')"
          @click="deletePreviewPhoto()"
        >
          <i aria-hidden="true" class="ri-delete-bin-6-line"></i></button
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
        :disabled="busy || previewPageLoading"
        :aria-label="t('Предыдущий файл')"
        @click="nextPreview(-1)"
      >
        <i aria-hidden="true" class="ri-arrow-left-s-line"></i>
      </button>
      <div class="preview-stage">
        <div
          v-if="previewLoading || (photoLoading && !photoFrame)"
          class="loading-state"
        >
          <i aria-hidden="true" class="ri-loader-4-line spinning"></i
          >{{ t("Получение файла…") }}
        </div>
        <div v-else-if="previewError || photoError" class="preview-fallback">
          <i aria-hidden="true" class="ri-error-warning-line"></i>
          <p>{{ previewError || photoError }}</p>
          <button
            class="button"
            @click="photo ? retryPhoto() : openPreview(preview)"
          >
            {{ t("Повторить") }}
          </button>
        </div>
        <template v-else-if="photo">
          <div
            ref="photoViewport"
            class="photo-viewport"
            :class="{
              'photo-zoomed': photoScale > 1,
              'photo-panning': photoPanning,
            }"
            :aria-hidden="photoLoading || undefined"
            @wheel.prevent="!photoLoading && photoZoom.wheel($event)"
            @dblclick="!photoLoading && photoZoom.toggle($event)"
            @pointerdown="!photoLoading && photoZoom.start($event)"
            @pointermove="photoZoom.move"
            @pointerup="photoZoom.stop"
            @pointercancel="photoZoom.stop"
            @lostpointercapture="photoZoom.stop"
            @touchstart.passive="!photoLoading && photoZoom.touchStart($event)"
            @touchmove.passive="!photoLoading && photoZoom.touchMove($event)"
            @touchend.passive="
              ((direction) => direction && nextPreview(direction))(
                photoZoom.touchEnd($event),
              )
            "
            @touchcancel.passive="photoZoom.touchEnd($event)"
            @dragstart.prevent
          >
            <div
              ref="photoStage"
              class="photo-frame"
              :style="{ transform: photoTransform }"
            ></div>
          </div>
          <div
            v-if="photoLoading"
            class="loading-state photo-loading"
            role="status"
          >
            <i aria-hidden="true" class="ri-loader-4-line spinning"></i
            >{{ t("Получение файла…") }}
          </div>
        </template>
        <DocumentViewer
          v-else-if="documentKind(preview)"
          ref="documentViewer"
          :key="`${preview.id}:${documentVersion}`"
          :file="preview"
          @error="previewError = $event"
          @close="closePreview"
          @saved="fileSaved"
        />
        <template v-else-if="previewUrl">
          <VideoPlayer
            v-if="preview.mime_type.startsWith('video/')"
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
        :aria-busy="previewPageLoading"
        :disabled="busy || previewPageLoading"
        @click="nextPreview(1)"
      >
        <i
          aria-hidden="true"
          :class="
            previewPageLoading
              ? 'ri-loader-4-line spinning'
              : 'ri-arrow-right-s-line'
          "
        ></i>
      </button>
      <aside
        v-if="photo && previewTagsOpen"
        class="preview-tags"
        :aria-label="t('Теги')"
        @keydown.esc.stop="closePreviewTags"
      >
        <header>
          <strong>{{ t("Теги") }}</strong>
          <button
            type="button"
            class="icon-button small"
            :aria-label="t('Закрыть')"
            @click="closePreviewTags"
          >
            <i class="ri-close-line" aria-hidden="true"></i>
          </button>
        </header>
        <TagEditor
          :key="preview.id"
          v-model:clipboard="tagClipboard"
          :tags="preview.tags"
          :known="tagsAlphabetical"
          :busy="busy || previewPageLoading"
          :save="savePreviewTags"
        />
      </aside>
    </div>
    <footer class="preview-footer">
      <span v-if="previewIndex >= 0"
        >{{ previewIndex + 1 }} /
        {{ t("{0} загруженных файлов", { "0": files.length }) }}</span
      ><span v-if="notice" role="status">{{ notice }}</span
      ><span v-if="error" class="error" role="alert">{{ error }}</span>
      <div
        v-if="photo"
        class="photo-zoom"
        role="group"
        :aria-label="t('Масштаб фото')"
      >
        <button
          class="icon-button small"
          :disabled="photoScale <= 1 || photoLoading"
          :title="t('Уменьшить фото')"
          :aria-label="t('Уменьшить фото')"
          @click="photoZoom.zoomBy(-1)"
        >
          <i aria-hidden="true" class="ri-subtract-line"></i>
        </button>
        <button
          class="photo-zoom-reset"
          :title="t('Сбросить масштаб')"
          :aria-label="t('Сбросить масштаб')"
          :disabled="photoScale <= 1"
          @click="photoZoom.reset"
        >
          {{ Math.round(photoScale * 100) }}%
        </button>
        <button
          class="icon-button small"
          :disabled="
            photoScale >= photoZoom.maxScale ||
            !photoFrame ||
            photoLoading ||
            !!photoError
          "
          :title="t('Увеличить фото')"
          :aria-label="t('Увеличить фото')"
          @click="photoZoom.zoomBy(1)"
        >
          <i aria-hidden="true" class="ri-add-line"></i>
        </button>
      </div>
      <span>{{
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
    :replace="saveEditedImage"
    @close="editing = false"
  />
</template>
