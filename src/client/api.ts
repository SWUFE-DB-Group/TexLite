import i18n from "./i18n";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
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
  if (!response.ok) throw new ApiError(localizedResponseError(body, response.status), response.status);
  return body as T;
}

export function localizedResponseError(body: unknown, status: number, fallbackKey = "errors.request"): string {
  const serverMessage = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
    ? body.error : "";
  if (i18n.resolvedLanguage?.startsWith("zh") && serverMessage) return serverMessage;
  return i18n.t(fallbackKey, { status });
}
