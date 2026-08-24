import i18n from "./i18n";

export interface ApiRequestInit extends RequestInit {
  /**
   * Requests used to discover the initial route must not redirect an
   * unauthenticated deep link to the dashboard. The caller can retry them
   * after login instead.
   */
  suppressSessionExpired?: boolean;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string | null = null) {
    super(message);
  }
}

export async function api<T>(url: string, options: ApiRequestInit = {}): Promise<T> {
  const { suppressSessionExpired = false, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);
  if (!headers.has("Accept-Language")) {
    headers.set("Accept-Language", i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en");
  }
  if (requestOptions.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    ...requestOptions,
    headers
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401 && !suppressSessionExpired && typeof window !== "undefined") {
      window.dispatchEvent(new Event("texlite:session-expired"));
    }
    throw new ApiError(localizedResponseError(body, response.status), response.status, responseErrorCode(body));
  }
  return body as T;
}

export function localizedResponseError(body: unknown, status: number, fallbackKey = "errors.request"): string {
  const serverMessage = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
    ? body.error : "";
  const code = responseErrorCode(body);
  if (code) {
    const key = ({
      AUTH_REQUIRED: "auth.sessionExpired",
      ADMIN_REQUIRED: "users.adminRequired",
      HISTORY_VERSION_NOT_FOUND: "apiErrors.historyVersionNotFound",
      HISTORY_FILE_NOT_FOUND: "apiErrors.historyFileNotFound",
      HISTORY_TARGET_CONFLICT: "apiErrors.historyTargetConflict",
      HISTORY_FILE_PREVIEW_UNSUPPORTED: "apiErrors.historyPreviewUnsupported",
      SEARCH_QUERY_INVALID: "apiErrors.searchInvalid",
      GIT_UNAVAILABLE: "apiErrors.gitUnavailable",
      FORMAT_FAILED: "apiErrors.formatFailed",
      PROJECT_TRANSFER_FORBIDDEN: "projects.transferForbidden",
      PROJECT_TRANSFER_TARGET_INVALID: "projects.transferTargetInvalid",
      PROJECT_TRANSFER_SELF: "projects.transferSelf",
      MAIN_DOCUMENT_INVALID: "apiErrors.mainDocumentInvalid",
      COMPILE_SNAPSHOT_BUSY: "apiErrors.compileSnapshotBusy",
      COMPILE_CLEAN_BUSY: "editor.cleanBusy",
      CITATION_INVALID: "citationErrors.invalid",
      CITATION_TOO_LARGE: "citationErrors.tooLarge",
      CITATION_NOT_FOUND: "citationErrors.notFound",
      CITATION_KEY_EXISTS: "citationErrors.keyExists",
      CITATION_TAG_NOT_FOUND: "citationErrors.tagNotFound",
      CITATION_CONFLICT: "citationErrors.conflict",
    } as Record<string, string>)[code] ?? `errors.codes.${code}`;
    if (i18n.exists(key)) return i18n.t(key, { status, ...(typeof body === "object" && body !== null ? body : {}) });
  }
  if (serverMessage) return serverMessage;
  return i18n.t(fallbackKey, { status });
}

export function responseErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("code" in body) || typeof body.code !== "string") return null;
  return body.code;
}
