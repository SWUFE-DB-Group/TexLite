import { parentPort } from "node:worker_threads";
import { collectHarperLints, createHarperLinter } from "./harperRuntime.js";

type Request = { id: number; source: string };
type Response =
  | { type: "ready" }
  | { type: "load-error"; message: string }
  | { id: number; ok: true; lints: Awaited<ReturnType<typeof collectHarperLints>> }
  | { id: number; ok: false; message: string };

if (!parentPort) throw new Error("Harper worker requires a parent port.");
const port = parentPort;

try {
  const linter = await createHarperLinter();
  port.on("message", (request: Request) => {
    void collectHarperLints(linter, request.source).then(
      (lints) => port.postMessage({ id: request.id, ok: true, lints } satisfies Response),
      (error) => port.postMessage({ id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) } satisfies Response)
    );
  });
  port.postMessage({ type: "ready" } satisfies Response);
} catch (error) {
  port.postMessage({ type: "load-error", message: error instanceof Error ? error.message : String(error) } satisfies Response);
}
