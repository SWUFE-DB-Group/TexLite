import { serverErrorMessage, serverLocale, type ServerErrorCode } from "./i18n.js";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ServerErrorCode,
    readonly details: Record<string, unknown> = {}
  ) {
    // Keep a useful, locale-neutral message for internal callers and logs.
    // HTTP responses are still rendered using the request's actual locale.
    super(serverErrorMessage("en", code, details));
    this.name = "HttpError";
  }
}

/**
 * Create a user-correctable error without putting a locale-specific string in
 * service or route code. `apiError` resolves the code using the request locale.
 */
export function httpError(
  statusCode: number,
  code: ServerErrorCode,
  details: Record<string, unknown> = {}
): HttpError {
  return new HttpError(statusCode, code, details);
}

export class ValidationError extends HttpError {
  constructor(code: ServerErrorCode = "REQUEST_INVALID", details: Record<string, unknown> = {}) {
    super(400, code, details);
    this.name = "ValidationError";
  }
}

/**
 * A collaborative draft could not be made durable on disk.  Mutations that
 * replace or remove source files must stop at this boundary instead of
 * continuing with a stale filesystem snapshot.
 */
export class SourceFlushError extends HttpError {
  readonly failedPaths: string[];

  constructor(failedPaths: readonly string[] = []) {
    const paths = [...new Set(failedPaths)].slice(0, 100);
    super(409, "SOURCE_FLUSH_FAILED", { failedPaths: paths });
    this.name = "SourceFlushError";
    this.failedPaths = paths;
  }
}

export function apiError(
  reply: {
    code: (status: number) => { send: (payload: unknown) => unknown };
    request?: { headers?: Record<string, string | string[] | undefined> };
  },
  status: number,
  code: string,
  details: Record<string, unknown> = {}
): unknown {
  return reply.code(status).send({
    code,
    error: serverErrorMessage(serverLocale(reply.request?.headers), code, details),
    ...details
  });
}

export function contentDisposition(filename: string, mode: "inline" | "attachment"): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
