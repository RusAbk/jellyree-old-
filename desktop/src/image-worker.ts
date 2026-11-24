import {
  normalizeImageAdjustments,
  imageBounds,
  cropRectangle,
} from "../electron/image-adjustments.mjs";
import { adjustPixels, warpPixels, imageHistogram } from "./image-pixels.mjs";
import type { ImageRenderRequest } from "./image-service";
import { isHeicFile, HEIC_MAX_PIXELS } from "../electron/image-formats.mjs";
const images = new Map<string, ImageBitmap>();
const channel = self as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage(value: unknown, transfer?: Transferable[]): void;
};
channel.onmessage = async ({
  data,
}: MessageEvent<
  ImageRenderRequest & {
    id: number;
    key: string;
    source?: ArrayBuffer;
    mimeType?: string;
    fileName?: string;
  }
>) => {
  try {
    let image = images.get(data.key);
    if (!image) {
      if (!data.source) throw new Error("image-source-missing");
      const heic = isHeicFile({
        name: data.fileName || "",
        mime_type: data.mimeType || "",
      });
      image = heic
        ? await (await import("./heic-decoder")).decodeHeicImage(data.source)
        : await createImageBitmap(
            new Blob([data.source], { type: data.mimeType }),
          );
      if (
        image.width * image.height > (heic ? HEIC_MAX_PIXELS : 48_000_000) ||
        Math.max(image.width, image.height) > 20000
      ) {
        image.close();
        throw new Error(heic ? "heic-too-large" : "image-too-large");
      }
      images.set(data.key, image);
      if (images.size > 2) {
        const oldest = images.keys().next().value!;
        images.get(oldest)!.close();
        images.delete(oldest);
      }
    }
    const a = normalizeImageAdjustments(data.adjustments);
    const nativeBounds = imageBounds(
      image.width,
      image.height,
      a,
      data.uncropped,
    );
    if (
      data.export &&
      !data.maxSize &&
      nativeBounds.fullWidth * nativeBounds.fullHeight > 24_000_000
    )
      throw new Error("export-too-large");
    const scale = data.export
      ? data.maxSize
        ? Math.min(
            1,
            data.maxSize / Math.max(nativeBounds.width, nativeBounds.height),
            Math.sqrt(
              24_000_000 / (nativeBounds.fullWidth * nativeBounds.fullHeight),
            ),
          )
        : 1
      : Math.min(1, data.maxSize / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale)),
      height = Math.max(1, Math.round(image.height * scale));
    const source = new OffscreenCanvas(width, height),
      ctx = source.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height);
    pixels.data.set(adjustPixels(pixels.data, width, height, a));
    ctx.putImageData(pixels, 0, 0);
    const bounds = imageBounds(width, height, a, data.uncropped);
    const rotated = new OffscreenCanvas(bounds.fullWidth, bounds.fullHeight),
      rotatedCtx = rotated.getContext("2d", { willReadFrequently: true })!;
    rotatedCtx.translate(rotated.width / 2, rotated.height / 2);
    rotatedCtx.rotate((a.rotate * Math.PI) / 180);
    rotatedCtx.scale(a.flipX ? -1 : 1, a.flipY ? -1 : 1);
    rotatedCtx.drawImage(source, -width / 2, -height / 2);
    if (a.strokes.length || a.stretchAmount) {
      const warped = rotatedCtx.getImageData(
        0,
        0,
        rotated.width,
        rotated.height,
      );
      warped.data.set(
        warpPixels(warped.data, rotated.width, rotated.height, a),
      );
      rotatedCtx.putImageData(warped, 0, 0);
    }
    const output = new OffscreenCanvas(bounds.width, bounds.height),
      outputCtx = output.getContext("2d", { willReadFrequently: true })!;
    const crop = data.uncropped
      ? { x: 0, y: 0, width: 1, height: 1 }
      : cropRectangle(a);
    if (data.export === "jpeg") {
      outputCtx.fillStyle = "#ffffff";
      outputCtx.fillRect(0, 0, output.width, output.height);
    }
    outputCtx.drawImage(
      rotated,
      crop.x * rotated.width,
      crop.y * rotated.height,
      crop.width * rotated.width,
      crop.height * rotated.height,
      0,
      0,
      output.width,
      output.height,
    );
    const final = outputCtx.getImageData(0, 0, output.width, output.height),
      histogram = imageHistogram(final.data);
    if (data.clipping) {
      for (let i = 0; i < final.data.length; i += 4) {
        if (!final.data[i + 3]) continue;
        if (Math.min(final.data[i], final.data[i + 1], final.data[i + 2]) < 4) {
          final.data[i] = 50;
          final.data[i + 1] = 90;
          final.data[i + 2] = 255;
        } else if (
          Math.max(final.data[i], final.data[i + 1], final.data[i + 2]) > 251
        ) {
          final.data[i] = 255;
          final.data[i + 1] = 55;
          final.data[i + 2] = 70;
        }
      }
      outputCtx.putImageData(final, 0, 0);
    }
    const common = {
      id: data.id,
      width: nativeBounds.width,
      height: nativeBounds.height,
      sourceWidth: image.width,
      sourceHeight: image.height,
      histogram,
      cached: [...images.keys()],
    };
    if (data.export) {
      const blob = await output.convertToBlob({
          type: `image/${data.export}`,
          quality: (data.quality ?? 92) / 100,
        }),
        bytes = await blob.arrayBuffer();
      channel.postMessage({ ...common, bytes }, [bytes]);
    } else {
      const bitmap = output.transferToImageBitmap();
      channel.postMessage({ ...common, bitmap }, [bitmap]);
    }
  } catch (error) {
    channel.postMessage({
      id: data.id,
      error: (error as Error).message,
      cached: [...images.keys()],
    });
  }
};
