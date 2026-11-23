export type Language = "en" | "ru" | "es";
export const messages: Record<string, { en: string; es: string }>;
export const languages: string[];
export function normalizeLanguage(value: unknown): Language;
export function translate(
  language: Language,
  key: string,
  params?: Record<string, unknown>,
): string;
export function setLanguage(value: unknown): void;
export function t(key: string, params?: Record<string, unknown>): string;
