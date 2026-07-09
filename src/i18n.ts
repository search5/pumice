import { ko } from "./locales/ko";
import { en } from "./locales/en";

// Our own translation resources — no longer references core's window.i18next. The active language
// is picked from document.documentElement.lang (Obsidian's UI language setting); if the language
// isn't supported or that table has no entry for the key, the fallback (the original Korean text)
// passed at the call site is used as-is.
const locales: Record<string, Record<string, string>> = { ko, en };

// Generic dispatch over whatever locales are registered above — adding a new locale file to the
// `locales` map is enough on its own; nothing here needs to change.
function detectLanguage(): string {
  const lang = document.documentElement.lang?.toLowerCase() ?? "";
  for (const code of Object.keys(locales)) {
    if (lang.startsWith(code)) return code;
  }
  return "en";
}

function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_match, name: string) =>
    params[name] !== undefined ? String(params[name]) : ""
  );
}

export function t(key: string, fallback: string, params?: Record<string, string | number>): string {
  const table = locales[detectLanguage()];
  const text = table?.[key] ?? fallback;
  return interpolate(text, params);
}
