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

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

/** Normalize raw fetch failures for the few endpoints that stream non-JSON. */
export function normalizeNetworkError(error: unknown): Error {
  if (isAbortError(error) || error instanceof ApiError) return error;
  return new ApiError(i18n.t("network.requestFailed"), 0, "NETWORK_ERROR");
}

function isFormData(body: BodyInit | null | undefined): boolean {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

export async function api<T>(url: string, options: ApiRequestInit = {}): Promise<T> {
  const { suppressSessionExpired = false, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);
  if (!headers.has("Accept-Language")) {
    headers.set("Accept-Language", i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en");
  }
  if (requestOptions.body && !isFormData(requestOptions.body) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(url, {
      ...requestOptions,
      headers
    });
  } catch (error) {
    // Route changes intentionally abort outstanding requests. Preserve that
    // signal for callers; every other transport exception becomes a friendly,
    // localized API error instead of exposing raw browser text.
    throw normalizeNetworkError(error);
  }
  const contentType = response.headers.get("content-type") ?? "";
  let body: unknown = null;
  if (contentType.includes("application/json")) {
    try {
      body = await response.json();
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ApiError(i18n.t("network.invalidResponse"), response.status, "INVALID_RESPONSE");
    }
  } else if (response.ok) {
    // Every endpoint routed through api<T> is JSON. Treat an HTML proxy page
    // or truncated text response as a recoverable transport failure here,
    // rather than letting a later property access leak a raw TypeError.
    throw new ApiError(i18n.t("network.invalidResponse"), response.status, "INVALID_RESPONSE");
  }
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
