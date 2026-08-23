import { calculateLatexTextEdits, formatTexSource, LatexFormatterWorkerError } from "./latexFormatterWorkerCore";
import type { LatexFormatterWorkerRequest, LatexFormatterWorkerResponse } from "./latexFormatterProtocol";

interface FormatterWorkerScope {
  onmessage: ((event: MessageEvent<LatexFormatterWorkerRequest>) => void) | null;
  postMessage: (message: LatexFormatterWorkerResponse) => void;
}

const workerScope = self as unknown as FormatterWorkerScope;

workerScope.onmessage = (event) => {
  const request = event.data;
  try {
    let response: LatexFormatterWorkerResponse;
    if (request.action === "probe") {
      // Calling the formatter verifies that the package and its WASM runtime
      // have both initialized; merely constructing the Worker is insufficient.
      formatTexSource("", "");
      response = { id: request.id, ok: true, action: "probe", result: true };
    } else if (request.action === "format") {
      response = { id: request.id, ok: true, action: "format", result: formatTexSource(request.source, request.config) };
    } else {
      response = { id: request.id, ok: true, action: "diff", result: calculateLatexTextEdits(request.source, request.formatted, request.baseOffset) };
    }
    workerScope.postMessage(response);
  } catch (error) {
    const failure = error instanceof LatexFormatterWorkerError
      ? error
      : new LatexFormatterWorkerError("result", error instanceof Error ? error.message : "The formatter worker failed.");
    workerScope.postMessage({ id: request.id, ok: false, kind: failure.kind, message: failure.message });
  }
};

// The tex-fmt bundle initializes WASM with top-level await. Announce readiness
// only after that initialization and the message handler are both complete so
// the main thread never sends a request into the startup window.
workerScope.postMessage({ type: "ready" });
