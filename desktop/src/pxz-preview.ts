import { readPxz, type ReadPxzEntry } from "../electron/pxz-archive.mjs";
import { PXZ_MIME } from "../electron/image-formats.mjs";
import { api } from "./api";
import { t } from "./i18n";
import type { DriveFile } from "./types";

type Rect = { x: number; y: number; w: number; h: number; r?: number };
type Fill = {
  type: string;
  value:
    | string
    | {
        type?: string;
        direction?: number;
        stops?: { position: number; color: string }[];
        svg?: string;
      };
};
type Layer = {
  type: string;
  rect?: Rect;
  visible?: boolean;
  opacity?: number;
  blendmode?: GlobalCompositeOperation;
  content?: string;
  mask?: string;
  frame?: { clip?: string; trim?: Rect };
  format?: {
    variant?: string;
    radii?: number;
    font?: { name?: string; content?: string };
    size?: number;
    align?: CanvasTextAlign;
    linespace?: number;
    letterspace?: number;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    uppercase?: boolean;
    fill?: Fill;
  };
  style?: {
    outline?: { size?: number; color?: string };
    shadow?: {
      blur?: number;
      color?: string;
      distance?: number;
      direction?: number;
    };
  };
};

const maxPixels = 48_000_000;
const invalid = () => new Error("pxz-invalid");
function number(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function supportedSize(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  )
    throw invalid();
  if (width * height > maxPixels || Math.max(width, height) > 16384)
    throw new Error("pxz-too-large");
}
function context(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw invalid();
  return ctx;
}
async function withImage<T>(
  data: Uint8Array<ArrayBuffer>,
  mimeType: string,
  signal: AbortSignal,
  draw: (image: HTMLImageElement) => T,
) {
  signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
  const image = new Image();
  const cancel = () => image.removeAttribute("src");
  signal.addEventListener("abort", cancel, { once: true });
  try {
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    supportedSize(image.naturalWidth, image.naturalHeight);
    return draw(image);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    URL.revokeObjectURL(url);
  }
}
const assetTypes: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
};
async function withAsset<T>(
  read: ReadPxzEntry,
  name: string,
  signal: AbortSignal,
  draw: (image: HTMLImageElement) => T,
) {
  const extension = name.split(".").pop()!.toLowerCase();
  if (!Object.hasOwn(assetTypes, extension)) throw invalid();
  const mime = assetTypes[extension];
  const data = await read(
    name,
    mime === "image/svg+xml" ? 2 * 1024 * 1024 : undefined,
  );
  if (!data) throw invalid();
  return withImage(data, mime, signal, draw);
}
function box(rect: Rect, xScale: number, yScale: number): Rect {
  const result = {
    x: number(rect.x) * xScale,
    y: number(rect.y) * yScale,
    w: number(rect.w) * xScale,
    h: number(rect.h) * yScale,
    r: number(rect.r) % 360,
  };
  if (Math.max(...Object.values(result).map(Math.abs)) > 100000)
    throw invalid();
  return result;
}
function pathInBox(content: string, w: number, h: number) {
  if (content.length > 100000) throw invalid();
  const path = new Path2D();
  path.addPath(new Path2D(content), new DOMMatrix().scale(w / 100, h / 100));
  return path;
}
function shapePath(layer: Layer, w: number, h: number) {
  const path = new Path2D();
  switch (layer.format?.variant) {
    case "path":
      return pathInBox(layer.content ?? "", w, h);
    case "rounded":
      path.roundRect(0, 0, w, h, Math.max(0, number(layer.format.radii)));
      break;
    case "ellipse":
      path.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI);
      break;
    case "triangle":
      path.moveTo(w / 2, 0);
      path.lineTo(w, h);
      path.lineTo(0, h);
      break;
    case "star":
      for (let point = 0; point < 10; point++) {
        const angle = (point * Math.PI) / 5 - Math.PI / 2;
        const radius = point % 2 ? 0.4 : 1;
        path.lineTo(
          (w * (1 + Math.cos(angle) * radius)) / 2,
          (h * (1 + Math.sin(angle) * radius)) / 2,
        );
      }
      break;
    case "heart":
      return pathInBox(
        "M50 100 C20 75 0 53 0 28 C0 -4 34 -9 50 15 C66 -9 100 -4 100 28 C100 53 80 75 50 100Z",
        w,
        h,
      );
    case "line":
      path.moveTo(0, 0);
      path.lineTo(w, h);
      return path;
    default:
      path.rect(0, 0, w, h);
  }
  path.closePath();
  return path;
}
async function paint(
  ctx: CanvasRenderingContext2D,
  fill: Fill | undefined,
  w: number,
  h: number,
  read: ReadPxzEntry,
  signal: AbortSignal,
) {
  if (!fill) return;
  const { type, value } = fill;
  if (type === "color" && typeof value === "string") ctx.fillStyle = value;
  if (typeof value !== "object" || !value) return;
  if (type === "gradient" && Array.isArray(value.stops)) {
    const angle = ((number(value.direction) - 90) * Math.PI) / 180;
    const x = Math.cos(angle),
      y = Math.sin(angle);
    const radius = (Math.abs(w * x) + Math.abs(h * y)) / 2;
    const gradient =
      value.type === "radial"
        ? ctx.createRadialGradient(
            w / 2,
            h / 2,
            0,
            w / 2,
            h / 2,
            Math.max(w, h) / 2,
          )
        : ctx.createLinearGradient(
            w / 2 - radius * x,
            h / 2 - radius * y,
            w / 2 + radius * x,
            h / 2 + radius * y,
          );
    for (const stop of value.stops.slice(0, 128)) {
      if (typeof stop.color === "string" && CSS.supports("color", stop.color))
        gradient.addColorStop(
          Math.min(1, Math.max(0, number(stop.position))),
          stop.color,
        );
    }
    ctx.fillStyle = gradient;
  }
  if (type === "pattern" && typeof value.svg === "string") {
    const pattern = await withAsset(read, value.svg, signal, (image) =>
      ctx.createPattern(image, "repeat"),
    );
    if (pattern) ctx.fillStyle = pattern;
  }
}
async function renderedProject(
  data: Uint8Array,
  maxSize: number,
  signal: AbortSignal,
) {
  return readPxz(
    data,
    async (read) => {
      const bytes = await read("manifest.json", 2 * 1024 * 1024);
      if (!bytes) throw invalid();
      const manifest = JSON.parse(new TextDecoder().decode(bytes));
      let width = number(manifest?.width),
        height = number(manifest?.height);
      const stack: Layer[] = manifest?.stack;
      if (
        !Array.isArray(stack) ||
        stack.length > 512 ||
        width <= 0 ||
        height <= 0
      )
        throw invalid();
      const relative = !!manifest.unit && manifest.unit !== "pixel";
      if (relative) {
        const factor = 1600 / Math.max(width, height);
        width = Math.max(1, Math.round(width * factor));
        height = Math.max(1, Math.round(height * factor));
      }
      supportedSize(width, height);
      const scale = maxSize
        ? Math.min(1, maxSize / Math.max(width, height))
        : 1;
      const ctx = context(
        Math.max(1, Math.round(width * scale)),
        Math.max(1, Math.round(height * scale)),
      );
      const xScale = relative ? width : 1,
        yScale = relative ? height : 1;
      if (
        typeof manifest.background === "string" &&
        CSS.supports("color", manifest.background)
      ) {
        ctx.fillStyle = manifest.background;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      }
      ctx.scale(scale, scale);
      ctx.fillStyle = "#000";
      const fonts = new Map<string, FontFace>();
      try {
        for (const [index, layer] of stack.entries()) {
          if (index > 0 && index % 16 === 0)
            await new Promise((resolve) => setTimeout(resolve, 0));
          signal.throwIfAborted();
          if (!layer?.rect || layer.visible === false || layer.type === "group")
            continue;
          const { x, y, w, h, r } = box(layer.rect, xScale, yScale);
          if (w <= 0 || h <= 0) continue;
          ctx.save();
          try {
            ctx.translate(x + w / 2, y + h / 2);
            ctx.rotate((number(r) * Math.PI) / 180);
            ctx.translate(-w / 2, -h / 2);
            ctx.globalAlpha = Math.max(
              0,
              Math.min(1, number(layer.opacity, 1)),
            );
            ctx.globalCompositeOperation = layer.blendmode || "source-over";
            const shadow = layer.style?.shadow;
            if (shadow?.color) {
              const angle = (number(shadow.direction) * Math.PI) / 180;
              ctx.shadowColor = shadow.color;
              ctx.shadowBlur = Math.min(200, Math.max(0, number(shadow.blur)));
              ctx.shadowOffsetX =
                number(shadow.distance) * Math.cos(angle) * scale;
              ctx.shadowOffsetY =
                number(shadow.distance) * Math.sin(angle) * scale;
            }
            const content =
              typeof layer.content === "string" ? layer.content : "";
            const format = layer.format;
            const outline = layer.style?.outline;
            if (outline?.color) {
              ctx.strokeStyle = outline.color;
              ctx.lineWidth = Math.max(1, number(outline.size, 1));
            }
            if (
              (layer.type === "image" ||
                layer.type === "element" ||
                layer.type === "frame") &&
              content
            ) {
              const frame = layer.frame;
              if (frame?.clip) ctx.clip(pathInBox(frame.clip, w, h));
              const trim = frame?.trim
                ? box(frame.trim, xScale, yScale)
                : { x: 0, y: 0, w, h };
              if (layer.mask) {
                const mw = Math.max(1, Math.round(w * scale)),
                  mh = Math.max(1, Math.round(h * scale));
                supportedSize(mw, mh);
                const masked = context(mw, mh);
                try {
                  await withAsset(read, content, signal, (image) =>
                    masked.drawImage(image, 0, 0, mw, mh),
                  );
                  masked.globalCompositeOperation = "destination-in";
                  await withAsset(read, layer.mask, signal, (image) =>
                    masked.drawImage(image, 0, 0, mw, mh),
                  );
                  ctx.drawImage(masked.canvas, trim.x, trim.y, trim.w, trim.h);
                } finally {
                  masked.canvas.width = 0;
                }
              } else {
                await withAsset(read, content, signal, (image) =>
                  ctx.drawImage(image, trim.x, trim.y, trim.w, trim.h),
                );
              }
            } else if (layer.type === "shape") {
              if ((!format || format.variant === "svg") && content) {
                await withAsset(read, content, signal, (image) =>
                  ctx.drawImage(image, 0, 0, w, h),
                );
              } else {
                const path = shapePath(layer, w, h);
                await paint(ctx, format?.fill, w, h, read, signal);
                if (format?.variant === "line" && !outline?.color)
                  ctx.strokeStyle = ctx.fillStyle;
                if (format?.variant !== "line") ctx.fill(path);
                if (outline?.color || format?.variant === "line")
                  ctx.stroke(path);
              }
            } else if (layer.type === "text" && content && format) {
              let family = format.font?.name || "sans-serif";
              const fontPath = format.font?.content;
              if (
                fontPath &&
                /\.(woff2?|ttf|otf)$/i.test(fontPath) &&
                !fonts.has(fontPath)
              ) {
                const data = await read(fontPath, 10 * 1024 * 1024);
                if (data) {
                  try {
                    const face = await new FontFace(
                      `pxz-${fonts.size}-${crypto.randomUUID()}`,
                      data,
                    ).load();
                    document.fonts.add(face);
                    fonts.set(fontPath, face);
                  } catch {
                    /* Use the matching system font or a fallback. */
                  }
                }
              }
              if (fontPath) family = fonts.get(fontPath)?.family || family;
              const size = Math.max(
                1,
                Math.min(20000, number(format.size, 16) * yScale),
              );
              ctx.font = `${format.italic ? "italic " : ""}${format.bold ? "bold " : ""}${size}px "${family.replace(/["\\]/g, "")}", sans-serif`;
              ctx.textBaseline = "top";
              ctx.textAlign = format.align || "left";
              ctx.letterSpacing = `${number(format.letterspace)}px`;
              await paint(ctx, format.fill, w, h, read, signal);
              const tx =
                ctx.textAlign === "center"
                  ? w / 2
                  : ctx.textAlign === "right" || ctx.textAlign === "end"
                    ? w
                    : 0;
              const lines = (format.uppercase ? content.toUpperCase() : content)
                .slice(0, 50000)
                .split(/\r?\n/)
                .slice(0, 512);
              const leading =
                size * Math.max(0.1, 1.2 + number(format.linespace));
              for (const [index, line] of lines.entries()) {
                if (outline?.color) ctx.strokeText(line, tx, index * leading);
                ctx.fillText(line, tx, index * leading);
                if (format.underline) {
                  const measure = ctx.measureText(line).width;
                  const start =
                    tx === 0
                      ? 0
                      : tx - measure * (ctx.textAlign === "center" ? 0.5 : 1);
                  ctx.fillRect(
                    start,
                    index * leading + size,
                    measure,
                    Math.max(1, size / 16),
                  );
                }
              }
            }
          } finally {
            ctx.restore();
          }
        }
      } finally {
        for (const font of fonts.values()) document.fonts.delete(font);
      }
      return { canvas: ctx.canvas, width, height };
    },
    signal,
  );
}

export async function renderPxzPreview(
  file: DriveFile,
  maxSize: number,
  signal: AbortSignal,
) {
  const request = crypto.randomUUID();
  const cancel = () => void api.cancelPreview(request).catch(() => {});
  const load = async (thumbnail: boolean) => {
    signal.throwIfAborted();
    const source = await api.imageSource(file.id, request, {
      objectKey: file.object_key,
      thumbnail,
    });
    signal.throwIfAborted();
    return source;
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    let source = await load(maxSize > 0);
    if (maxSize && source.mimeType === "image/webp") {
      try {
        return await withImage(
          new Uint8Array(source.data),
          "image/webp",
          signal,
          (image) => {
            const width = image.naturalWidth,
              height = image.naturalHeight;
            const scale = Math.min(1, maxSize / Math.max(width, height));
            const ctx = context(
              Math.max(1, Math.round(width * scale)),
              Math.max(1, Math.round(height * scale)),
            );
            ctx.drawImage(image, 0, 0, ctx.canvas.width, ctx.canvas.height);
            return { canvas: ctx.canvas, width, height };
          },
        );
      } catch {
        // The ZIP member can be intact while the embedded image is unreadable.
        source = await load(false);
      }
    }
    try {
      if (source.mimeType !== PXZ_MIME) throw invalid();
      return await renderedProject(source.data, maxSize, signal);
    } catch (error) {
      signal.throwIfAborted();
      if ((error as Error).message === "pxz-too-large")
        throw new Error(
          t("Для просмотра PXZ доступны проекты до 128 МБ и 48 мегапикселей."),
        );
      throw new Error(
        t(
          "Не удалось открыть проект PXZ. Проверьте файл или скачайте оригинал.",
        ),
      );
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
