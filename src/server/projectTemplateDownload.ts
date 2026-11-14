import http from "node:http";
import https from "node:https";
import { httpError, HttpError } from "./http.js";

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

export function templateUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 4096) throw httpError(400, "TEMPLATE_URL_INVALID");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw httpError(400, "TEMPLATE_URL_INVALID"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw httpError(400, "TEMPLATE_URL_INVALID");
  url.hash = "";
  return url;
}

/** Network access follows host policy; no browser cookies or host credentials are forwarded. */
export async function downloadProjectTemplate(value: unknown, maxBytes: number, cancellation?: AbortSignal): Promise<Buffer> {
  let url = templateUrl(value);
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const signal = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout;
  const tooLarge = () => httpError(400, "TEMPLATE_DOWNLOAD_TOO_LARGE", { size: Math.floor(maxBytes / 1024 / 1024) });
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      signal.throwIfAborted();
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const request = (url.protocol === "https:" ? https : http).request(url, {
          signal,
          headers: { Accept: "application/zip, application/octet-stream;q=0.9, */*;q=0.1", "User-Agent": "TexLite" }
        }, resolve);
        request.on("error", reject);
        request.end();
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        const location = response.headers.location;
        response.destroy();
        if (!location || redirects === MAX_REDIRECTS) throw httpError(400, "TEMPLATE_DOWNLOAD_FAILED");
        url = templateUrl(new URL(location, url).href);
        continue;
      }
      if (response.statusCode !== 200) { response.destroy(); throw httpError(400, "TEMPLATE_DOWNLOAD_FAILED"); }
      if (Number(response.headers["content-length"]) > maxBytes) { response.destroy(); throw tooLarge(); }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response) {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(); throw tooLarge(); }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks, bytes);
    }
    throw httpError(400, "TEMPLATE_DOWNLOAD_FAILED");
  } catch (error) {
    if (timeout.aborted) throw httpError(408, "TEMPLATE_DOWNLOAD_TIMEOUT");
    if (error instanceof HttpError) throw error;
    throw httpError(400, "TEMPLATE_DOWNLOAD_FAILED");
  }
}
