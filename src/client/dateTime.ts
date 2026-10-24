/** Normalize only generated date/time labels, never user-authored content. */
export function spaceDateTimeNumbers(value: string): string {
  return value.replace(/(\p{Script=Han})(\d)/gu, "$1 $2")
    .replace(/(\d)(\p{Script=Han})/gu, "$1 $2");
}

export function formatDateTime(value: string | Date, locale?: string, options?: Intl.DateTimeFormatOptions): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return typeof value === "string" ? value : date.toString();
  return spaceDateTimeNumbers(date.toLocaleString(locale, options));
}
