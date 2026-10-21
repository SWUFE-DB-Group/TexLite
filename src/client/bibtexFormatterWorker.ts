import { BibtexFormatError, formatBibtex } from "./citationLibrary";
import { calculateLatexTextEdits } from "./formatterTextEdits";
import type { BibtexFormatterWorkerRequest, BibtexFormatterWorkerResponse } from "./bibtexFormatterProtocol";

interface BibtexFormatterWorkerScope {
  onmessage: ((event: MessageEvent<BibtexFormatterWorkerRequest>) => void) | null;
  postMessage: (message: BibtexFormatterWorkerResponse) => void;
}

const workerScope = self as unknown as BibtexFormatterWorkerScope;

workerScope.onmessage = ({ data: request }) => {
  let response: BibtexFormatterWorkerResponse;
  try {
    response = request.action === "format"
      ? { id: request.id, ok: true, action: "format", result: formatBibtex(request.source, request.maxBytes) }
      : { id: request.id, ok: true, action: "diff", result: calculateLatexTextEdits(request.source, request.formatted, request.baseOffset) };
  } catch (error) {
    response = { id: request.id, ok: false, kind: error instanceof BibtexFormatError ? error.kind : "unavailable" };
  }
  workerScope.postMessage(response);
};
