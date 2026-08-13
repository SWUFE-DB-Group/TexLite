import i18n from "./i18n";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : i18n.t("errors.generic");
}
