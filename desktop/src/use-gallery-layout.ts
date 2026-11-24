import { ref, shallowRef, watch, type Ref } from "vue";
import { api } from "./api";
import {
  appendGalleryRows,
  fallbackGalleryRatio,
  type GalleryRow,
} from "./gallery-layout";
import { thumbnailGeometry, thumbnailRevision } from "./thumbnail";
import type { DriveFile, ThumbnailDimensions } from "./types";
import { isImageFile, isPxzFile } from "../electron/image-formats.mjs";

const batchSize = 160;
const maxRemembered = 8000;
const revisionKey = (file: DriveFile) =>
  JSON.stringify(thumbnailRevision(file));
const canMeasure = (file: DriveFile) =>
  isImageFile(file) || isPxzFile(file) || file.mime_type.startsWith("video/");

export function useGalleryLayout(
  element: Ref<HTMLElement | undefined>,
  enabled: Ref<boolean>,
  files: Ref<DriveFile[]>,
  previewSize: Ref<number>,
  scope: Ref<string>,
  listing: Ref<object>,
) {
  const rows = shallowRef<GalleryRow[]>([]);
  const pending = ref(false);
  const width = ref(0);
  const ratios = new Map<string, number>();
  let committed:
    | {
        width: number;
        size: number;
        scope: string;
        listing: object;
        ids: string[];
      }
    | undefined;

  watch(
    element,
    (root, _, cleanup) => {
      if (!root) {
        width.value = 0;
        return;
      }
      const measure = () => {
        width.value = root.clientWidth;
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(root);
      cleanup(() => observer.disconnect());
    },
    { flush: "post" },
  );
  watch(scope, () => ratios.clear(), { flush: "sync" });

  function remember(file: DriveFile, size: ThumbnailDimensions) {
    const bounds = thumbnailGeometry(file, size);
    if (!bounds.boundsWidth || !bounds.boundsHeight) return;
    const ratio = bounds.boundsWidth / bounds.boundsHeight;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    const key = revisionKey(file);
    if (!ratios.has(key) && ratios.size >= maxRemembered)
      ratios.delete(ratios.keys().next().value!);
    ratios.set(key, ratio);
  }
  watch(
    [enabled, width, previewSize, scope, listing, files],
    async (
      [active, available, size, connection, query, entries],
      _,
      cleanup,
    ) => {
      let current = true;
      cleanup(() => {
        current = false;
      });
      if (!active || !available) {
        committed = undefined;
        rows.value = [];
        pending.value = false;
        return;
      }

      const previous = committed;
      const append =
        previous?.width === available &&
        previous.size === size &&
        previous.scope === connection &&
        previous.listing === query &&
        previous.ids.length <= entries.length &&
        previous.ids.every((id, index) => entries[index]?.id === id);
      const incoming = entries.slice(append ? previous.ids.length : 0);
      if (append && !incoming.length) {
        pending.value = false;
        return;
      }
      const missing = incoming
        .filter((file) => canMeasure(file) && !ratios.has(revisionKey(file)))
        .slice(0, batchSize);
      if (
        missing.length &&
        typeof window.jellyree?.thumbnails?.dimensions === "function"
      ) {
        pending.value = true;
        try {
          const sizes = await api.thumbnails.dimensions(
            missing.map(thumbnailRevision),
          );
          if (!current) return;
          for (const [index, file] of missing.entries()) {
            const dimensions = sizes[index];
            if (dimensions) remember(file, dimensions);
          }
        } catch {
          // Unknown dimensions get their own stable frame for this layout.
        }
      }
      if (!current) return;
      rows.value = appendGalleryRows(
        append ? rows.value : [],
        incoming.map((file) => ({
          id: file.id,
          ratio: ratios.get(revisionKey(file)) ?? fallbackGalleryRatio,
        })),
        available,
        size * 0.74,
      );
      committed = {
        width: available,
        size,
        scope: connection,
        listing: query,
        ids: entries.map(({ id }) => id),
      };
      pending.value = false;
    },
    { flush: "post" },
  );

  return { rows, pending, remember };
}
