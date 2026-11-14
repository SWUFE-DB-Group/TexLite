import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadProjectTemplate } from "../src/server/projectTemplateDownload.js";

interface Reply { status?: number; headers?: http.IncomingHttpHeaders; chunks?: Buffer[]; error?: boolean }
let replies: Reply[];
let requests: Array<{ url: URL; options: http.RequestOptions }>;

beforeEach(() => {
  replies = []; requests = [];
  const request = ((url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    requests.push({ url, options });
    const result = new EventEmitter() as http.ClientRequest;
    result.end = (() => {
      queueMicrotask(() => {
        const reply = replies.shift();
        if (!reply) { result.emit("error", new Error("unexpected request")); return; }
        if (reply.error) { result.emit("error", new Error("connection failed")); return; }
        const response = Object.assign(Readable.from(reply.chunks ?? []), { statusCode: reply.status ?? 200, headers: reply.headers ?? {} });
        callback(response as http.IncomingMessage);
      });
      return result;
    }) as typeof result.end;
    return result;
  }) as typeof http.request;
  vi.spyOn(http, "request").mockImplementation(request);
  vi.spyOn(https, "request").mockImplementation(request);
});
afterEach(() => vi.restoreAllMocks());

describe("template URL downloads", () => {
  it("follows redirects without requiring a ZIP suffix and sends no browser credentials", async () => {
    replies.push({ status: 302, headers: { location: "https://cdn.example.org/download?file=1" } }, { chunks: [Buffer.from("archive")] });
    expect(await downloadProjectTemplate("https://example.org/template#ignored", 100)).toEqual(Buffer.from("archive"));
    expect(requests.map(({ url }) => url.href)).toEqual(["https://example.org/template", "https://cdn.example.org/download?file=1"]);
    expect(requests[1].options.lookup).toBeUndefined();
    expect(Object.keys(requests[1].options.headers!)).not.toContain("Authorization");
    expect(Object.keys(requests[1].options.headers!)).not.toContain("Cookie");
  });

  it("rejects invalid schemes and embedded credentials before opening a socket", async () => {
    for (const value of [null, "", "not a URL", "file:///tmp/template.zip", "ftp://example.org/file", "https://user:pass@example.org/file"]) {
      await expect(downloadProjectTemplate(value, 100)).rejects.toMatchObject({ code: "TEMPLATE_URL_INVALID" });
    }
    expect(requests).toHaveLength(0);
  });

  it("leaves private, local and Fake-IP destinations to host policy, including redirects", async () => {
    for (const host of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "198.18.0.55", "[::1]"]) {
      replies.push({ chunks: [Buffer.from("archive")] });
      expect(await downloadProjectTemplate(`http://${host}/file`, 100)).toEqual(Buffer.from("archive"));
    }
    replies.push({ status: 302, headers: { location: "http://192.168.0.1/template" } }, { chunks: [Buffer.from("archive")] });
    expect(await downloadProjectTemplate("https://example.org/file", 100)).toEqual(Buffer.from("archive"));
    expect(requests.at(-1)?.url.hostname).toBe("192.168.0.1");
    replies.push({ status: 302, headers: { location: "file:///tmp/template.zip" } });
    await expect(downloadProjectTemplate("https://example.org/file", 100)).rejects.toMatchObject({ code: "TEMPLATE_URL_INVALID" });
  });

  it("limits actual streamed bytes, declared size and redirect loops, and reports remote failures", async () => {
    replies.push({ chunks: [Buffer.alloc(6), Buffer.alloc(5)] });
    await expect(downloadProjectTemplate("https://example.org/file", 10)).rejects.toMatchObject({ code: "TEMPLATE_DOWNLOAD_TOO_LARGE" });
    replies.push({ headers: { "content-length": "11" } });
    await expect(downloadProjectTemplate("https://example.org/file", 10)).rejects.toMatchObject({ code: "TEMPLATE_DOWNLOAD_TOO_LARGE" });
    replies.push({ status: 403 }, { error: true });
    for (let i = 0; i < 2; i++) await expect(downloadProjectTemplate("https://example.org/file", 100)).rejects.toMatchObject({ code: "TEMPLATE_DOWNLOAD_FAILED" });
    replies.push(...Array.from({ length: 6 }, () => ({ status: 302, headers: { location: "/loop" } })));
    await expect(downloadProjectTemplate("https://example.org/file", 100)).rejects.toMatchObject({ code: "TEMPLATE_DOWNLOAD_FAILED" });
    expect(replies).toHaveLength(0);
  });

  it("aborts a stalled request on timeout or client cancellation", async () => {
    vi.mocked(https.request).mockImplementation(((_url: URL, options: http.RequestOptions) => {
      const request = new EventEmitter() as http.ClientRequest;
      request.end = (() => {
        options.signal!.addEventListener("abort", () => request.emit("error", new Error("aborted")), { once: true });
        return request;
      }) as typeof request.end;
      return request;
    }) as typeof https.request);
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const first = expect(downloadProjectTemplate("https://example.org/file", 100)).rejects.toMatchObject({ code: "TEMPLATE_DOWNLOAD_TIMEOUT" });
    timeout.abort(); await first;
    const freshTimeout = new AbortController();
    vi.mocked(AbortSignal.timeout).mockReturnValue(freshTimeout.signal);
    const cancelled = new AbortController();
    const second = expect(downloadProjectTemplate("https://example.org/file", 100, cancelled.signal)).rejects.toMatchObject({ code: "TEMPLATE_DOWNLOAD_FAILED" });
    cancelled.abort(); await second;
    expect(https.request).toHaveBeenCalledTimes(2);
  });
});
