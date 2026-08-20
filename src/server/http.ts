export class ValidationError extends Error {
  readonly statusCode = 400;
  readonly code = "REQUEST_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * A collaborative draft could not be made durable on disk.  Mutations that
 * replace or remove source files must stop at this boundary instead of
 * continuing with a stale filesystem snapshot.
 */
export class SourceFlushError extends Error {
  readonly statusCode = 409;
  readonly code = "SOURCE_FLUSH_FAILED";
  readonly failedPaths: string[];

  constructor(failedPaths: readonly string[] = []) {
    const paths = [...new Set(failedPaths)].slice(0, 100);
    super(paths.length
      ? `部分源码未能保存至磁盘，无法继续项目操作：${paths.join(", ")}`
      : "部分源码未能保存至磁盘，无法继续项目操作");
    this.name = "SourceFlushError";
    this.failedPaths = paths;
  }
}

export function apiError(
  reply: { code: (status: number) => { send: (payload: unknown) => unknown } },
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {}
): unknown {
  return reply.code(status).send({ code, error: message, ...details });
}

export function contentDisposition(filename: string, mode: "inline" | "attachment"): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
