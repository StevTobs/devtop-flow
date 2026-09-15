export type Theme = "dark" | "light";
export type Locale = "en" | "th";

const THEME_KEY = "devtopflow.theme";
const LOCALE_KEY = "devtopflow.locale";

export function loadTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
}

export function saveTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
}

export function loadLocale(): Locale {
  return localStorage.getItem(LOCALE_KEY) === "th" ? "th" : "en";
}

export function saveLocale(locale: Locale): void {
  localStorage.setItem(LOCALE_KEY, locale);
}
