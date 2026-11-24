import { t } from "./i18n";
import type { Adjustments } from "./types";
import { localeCode } from "./i18n";
import { isHeicFile, isPxzFile } from "../electron/image-formats.mjs";
export function bytes(value: number) {
  if (value === 0) return t("0 Б");
  const i = Math.min(
    4,
    Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)),
  );
  return `${(value / 1024 ** i).toLocaleString(localeCode(), { maximumFractionDigits: i ? 1 : 0 })} ${[t("Б"), t("КБ"), t("МБ"), t("ГБ"), t("ТБ")][i]}`;
}
export const date = (value: string) =>
  new Date(value).toLocaleDateString(localeCode(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
export function icon(mime: string, name = "") {
  if (isPxzFile({ name, mime_type: mime })) return "ri-image-2-line";
  if (mime.startsWith("image/") || isHeicFile({ name, mime_type: mime }))
    return "ri-image-line";
  if (mime.startsWith("video/")) return "ri-film-line";
  if (mime.startsWith("audio/")) return "ri-music-2-line";
  if (mime === "application/pdf") return "ri-file-pdf-2-line";
  if (/zip|compressed|tar/.test(mime)) return "ri-file-zip-line";
  if (/text|json|javascript/.test(mime)) return "ri-file-text-line";
  return "ri-file-line";
}
const extensionHue = new Map([
  ["PXZ", 282],
  ["PSD", 220],
  ["JPG", 177],
  ["JPEG", 193],
  ["PNG", 237],
  ["WEBP", 143],
  ["HEIC", 30],
  ["HEIF", 19],
  ["GIF", 325],
  ["SVG", 43],
  ["PDF", 357],
  ["MP4", 260],
  ["MOV", 205],
  ["TXT", 212],
  ["MD", 162],
  ["ZIP", 54],
]);
export function fileExtensionBadge(name: string) {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) return;
  const label = name.slice(lastDot + 1).toUpperCase();
  if (!/^[\p{L}\p{N}_+-]+$/u.test(label)) return;
  let hash = 0;
  for (const letter of label) hash = (hash * 41 + letter.codePointAt(0)!) % 360;
  const hue = extensionHue.get(label) ?? hash;
  return { label, color: `hsl(${hue} 58% 34%)` };
}
export const imageStyle = (a: Adjustments = {}) => ({
  filter: `brightness(${a.brightness ?? 100}%) contrast(${a.contrast ?? 100}%) saturate(${a.saturation ?? 100}%)`,
  transform: `rotate(${a.rotate ?? 0}deg)`,
});
