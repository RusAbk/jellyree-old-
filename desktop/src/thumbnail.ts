import type { DriveFile, ThumbnailRevision } from "./types";
import { normalizeImageAdjustments } from "../electron/image-adjustments.mjs";
export function thumbnailRevision(file: DriveFile): ThumbnailRevision {
  return {
    id: file.id,
    objectKey: file.object_key || "",
    sizeBytes: file.size_bytes,
    mimeType: file.mime_type,
    adjustments: file.mime_type.startsWith("image/")
      ? normalizeImageAdjustments(file.adjustments)
      : {},
  };
}
export function thumbnailBytes(
  canvas: HTMLCanvasElement,
): Promise<Uint8Array | null> {
  const scale = Math.min(1, 640 / Math.max(canvas.width, canvas.height));
  if (scale < 1) {
    const resized = document.createElement("canvas");
    resized.width = Math.max(1, Math.round(canvas.width * scale));
    resized.height = Math.max(1, Math.round(canvas.height * scale));
    resized
      .getContext("2d")
      ?.drawImage(canvas, 0, 0, resized.width, resized.height);
    canvas = resized;
  }
  return new Promise((resolve) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (!blob) resolve(null);
          else
            void blob.arrayBuffer().then(
              (buffer) => resolve(new Uint8Array(buffer)),
              () => resolve(null),
            );
        },
        "image/webp",
        0.82,
      );
    } catch {
      resolve(null);
    }
  });
}
