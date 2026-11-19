import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type puppeteer from "puppeteer-core";
import type { Browser, ConnectionTransport } from "puppeteer-core";
import { afterProcessStop, spawnOwnedCommand, stopProcessTree } from "./processTree.js";

/** Chrome's DevTools pipe carries NUL-terminated UTF-8 JSON, not a TCP endpoint. */
class DevToolsPipe implements ConnectionTransport {
  onmessage?: (message: string) => void;
  onclose?: () => void;
  private pending = "";
  private closed = false;

  constructor(private readonly input: Writable, private readonly output: Readable) {
    output.setEncoding("utf8").on("data", (chunk: string) => {
      this.pending += chunk;
      let start = 0;
      for (let end = this.pending.indexOf("\0"); end !== -1; end = this.pending.indexOf("\0", start)) {
        const message = this.pending.slice(start, end);
        setImmediate(() => { if (!this.closed) this.onmessage?.(message); });
        start = end + 1;
      }
      this.pending = this.pending.slice(start);
    });
    output.once("close", () => this.close());
    output.on("error", () => this.close());
    input.on("error", () => this.close());
  }

  send(message: string): void {
    if (this.closed) throw new Error("DevTools pipe is closed");
    this.input.write(message + "\0");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = "";
    this.input.destroy();
    this.output.destroy();
    this.onclose?.();
  }
}

type PuppeteerConnection = Pick<typeof puppeteer, "defaultArgs" | "connect">;

/** Launch Chrome through the Windows job gate, retaining Puppeteer's defaults and sandbox. */
export async function launchOwnedDrawioBrowser(
  api: PuppeteerConnection, executable: string, signal: AbortSignal
): Promise<{ browser: Browser; close: () => Promise<void> }> {
  signal.throwIfAborted();
  // A unique non-default profile prevents reuse of the user's running browser.
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "texlite-drawio-"));
  let child: ChildProcess | undefined;
  let transport: DevToolsPipe | undefined;
  let closed: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let launchFailure: Error | undefined;
  const release = () => cleanup ??= (async () => {
    signal.removeEventListener("abort", abort);
    transport?.close();
    // Do not remove a profile still held by browser processes, or release
    // this job's renderer slot before the process tree has been stopped.
    if (child) await Promise.all([stopProcessTree(child), closed]);
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  })();
  const abort = () => { void release().catch(() => undefined); };

  try {
    const args = await api.defaultArgs({ headless: true, userDataDir: profile });
    signal.throwIfAborted();
    const launched = spawnOwnedCommand(executable, [...args, "--remote-debugging-pipe"], { devtoolsPipe: true });
    child = launched;
    closed = new Promise<void>((resolve) => launched.once("close", () => {
      // Keep the launcher diagnosis (for example, Windows policy denying
      // job assignment) instead of reporting only a broken DevTools pipe.
      afterProcessStop(launched, resolve, (error) => { launchFailure = error; resolve(); });
    }));
    launched.on("error", (error) => { launchFailure = error; transport?.close(); });
    launched.stdout.resume();
    launched.stderr.resume();
    transport = new DevToolsPipe(launched.stdio[3] as Writable, launched.stdio[4] as Readable);
    signal.addEventListener("abort", abort, { once: true });
    const launchTimeout = AbortSignal.timeout(10_000);
    launchTimeout.addEventListener("abort", abort, { once: true });
    let browser: Browser;
    try {
      browser = await api.connect({ transport, protocolTimeout: 10_000 });
      signal.throwIfAborted();
      launchTimeout.throwIfAborted();
    } finally {
      launchTimeout.removeEventListener("abort", abort);
    }
    return {
      browser,
      close: async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          if (!signal.aborted) await Promise.race([
            browser.close(),
            new Promise<void>((resolve) => { timeout = setTimeout(resolve, 2_000); timeout.unref(); })
          ]);
        } catch {
          // A dead or unresponsive browser is handled by the job below.
        } finally {
          clearTimeout(timeout);
          await release();
        }
      }
    };
  } catch (error) {
    try { await release(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Could not clean up failed draw.io browser launch");
    }
    throw launchFailure ?? error;
  }
}
