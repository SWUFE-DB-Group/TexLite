import i18n from "./i18n";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string | null = null) {
    super(message);
  }
}

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
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
    const key = ({ AUTH_REQUIRED: "auth.sessionExpired", ADMIN_REQUIRED: "users.adminRequired" } as Record<string, string>)[code] ?? `errors.codes.${code}`;
    if (i18n.exists(key)) return i18n.t(key, { status, ...(typeof body === "object" && body !== null ? body : {}) });
  }
  if (i18n.resolvedLanguage?.startsWith("zh") && serverMessage) return serverMessage;
  return i18n.t(fallbackKey, { status });
}

export function responseErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("code" in body) || typeof body.code !== "string") return null;
  return body.code;
}
