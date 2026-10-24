export const supportedLocales = ["en", "zh", "zh-Hant"] as const;
export type AppLocale = typeof supportedLocales[number];

/** Preserve the existing `zh` preference while distinguishing Chinese scripts. */
export function supportedLocale(language: string | undefined): AppLocale | null {
  const parts = language?.trim().toLowerCase().replaceAll("_", "-").split("-") ?? [];
  if (parts[0] === "en") return "en";
  if (parts[0] !== "zh") return null;
  if (parts.includes("hant")) return "zh-Hant";
  if (parts.includes("hans")) return "zh";
  return parts.some((part) => part === "tw" || part === "hk" || part === "mo") ? "zh-Hant" : "zh";
}

export function appLocale(language: string | undefined): AppLocale {
  return supportedLocale(language) ?? "en";
}

export function documentLocale(language: string | undefined): string {
  const locale = appLocale(language);
  return locale === "zh" ? "zh-CN" : locale;
}
