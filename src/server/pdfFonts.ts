import { spawn } from "node:child_process";
import type { PdfFont } from "../shared/pdfFonts.js";
import { httpError } from "./http.js";
import { afterProcessStop, detachedProcessGroup, stopProcessTree } from "./processTree.js";

const timeoutMs = 15_000;
const maxOutputBytes = 1024 * 1024;

/** Poppler's columns contain spaces in font names and types; read the fixed trailing fields. */
export function parsePdfFonts(output: string): PdfFont[] {
  const lines = output.trim().split(/\r?\n/);
  if (!/^name\s+type\s+encoding\s+emb\s+sub\s+uni\s+object ID\s*$/.test(lines[0] ?? "")
    || !/^-+(?:\s+-+)+\s*$/.test(lines[1] ?? "")) throw httpError(422, "PDF_FONTS_FAILED");
  return lines.slice(2).filter((line) => line.trim()).map((line) => {
    const match = /^(.+?)\s+((?:CID )?(?:Type [013]C?|TrueType)(?: \(OT\))?|unknown)\s+(\S+)\s+(yes|no)\s+(yes|no)\s+(yes|no)\s+\d+\s+\d+\s*$/.exec(line);
    if (!match) throw httpError(422, "PDF_FONTS_FAILED");
    return { name: match[1].trim(), type: match[2], encoding: match[3],
      embedded: match[4] === "yes", subset: match[5] === "yes", unicode: match[6] === "yes" };
  });
}

/** Read-only, optional host tool. Never invoked at startup or as part of compilation. */
export function inspectPdfFonts(pdfPath: string, signal?: AbortSignal): Promise<{ fonts: PdfFont[]; hasWarnings: boolean }> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const child = spawn("pdffonts", [pdfPath], {
      shell: false, detached: detachedProcessGroup(), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", LANG: "C" }
    });
    const stdout: Buffer[] = [];
    let bytes = 0, hasWarnings = false, limited = false, settled = false;
    const abort = () => { void stopProcessTree(child).catch(() => finish(httpError(422, "PDF_FONTS_FAILED"))); };
    const timer = setTimeout(() => { limited = true; abort(); }, timeoutMs);
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) { reject(error); return; }
      try { resolve({ fonts: parsePdfFonts(Buffer.concat(stdout).toString("utf8")), hasWarnings }); }
      catch (reason) { reject(reason); }
    };
    const collect = (chunk: Buffer, keep: boolean) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        if (!limited) { limited = true; abort(); }
        return;
      }
      if (keep) stdout.push(chunk);
      else if (chunk.toString("utf8").trim()) hasWarnings = true;
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.once("error", () => finish(signal?.aborted
      ? new DOMException("Aborted", "AbortError")
      : httpError(503, "PDF_FONTS_UNAVAILABLE")));
    child.once("close", (code) => {
      clearTimeout(timer);
      afterProcessStop(child, () => finish(signal?.aborted ? new DOMException("Aborted", "AbortError")
        : limited || code !== 0 ? httpError(422, "PDF_FONTS_FAILED") : undefined), () => finish(httpError(422, "PDF_FONTS_FAILED")));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
