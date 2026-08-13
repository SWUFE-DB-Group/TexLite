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
