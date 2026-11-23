import { t } from "./i18n";
import type { Adjustments } from "./types";
import { localeCode } from "./i18n";
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
export function icon(mime: string) {
  if (mime.startsWith("image/")) return "ri-image-line";
  if (mime.startsWith("video/")) return "ri-film-line";
  if (mime.startsWith("audio/")) return "ri-music-2-line";
  if (mime === "application/pdf") return "ri-file-pdf-2-line";
  if (/zip|compressed|tar/.test(mime)) return "ri-file-zip-line";
  if (/text|json|javascript/.test(mime)) return "ri-file-text-line";
  return "ri-file-line";
}
export const imageStyle = (a: Adjustments = {}) => ({
  filter: `brightness(${a.brightness ?? 100}%) contrast(${a.contrast ?? 100}%) saturate(${a.saturation ?? 100}%)`,
  transform: `rotate(${a.rotate ?? 0}deg)`,
});
