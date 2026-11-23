import { ref } from "vue";
import {
  normalizeLanguage,
  translate,
  type Language,
} from "../electron/locales.mjs";
export const language = ref<Language>(
  normalizeLanguage(localStorage.getItem("jellyree-desktop-language")),
);
export const localeCode = () =>
  ({ en: "en-US", ru: "ru-RU", es: "es-ES" })[language.value];
export const t = (key: string, params?: Record<string, unknown>) =>
  translate(language.value, key, params);
document.documentElement.lang = language.value;
export async function changeLanguage(value: string) {
  language.value = normalizeLanguage(value);
  localStorage.setItem("jellyree-desktop-language", language.value);
  document.documentElement.lang = language.value;
  if (window.jellyree?.setLocale)
    await window.jellyree.setLocale(language.value);
}
export async function syncLanguage() {
  if (window.jellyree?.setLocale)
    await window.jellyree.setLocale(language.value);
}
