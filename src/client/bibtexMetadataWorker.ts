import { bibtexEntrySummaries } from "./bibtex/entryMetadata";
import type { BibtexMetadataWorkerRequest, BibtexMetadataWorkerResponse } from "./bibtexMetadataProtocol";

interface BibtexMetadataWorkerScope {
  onmessage: ((event: MessageEvent<BibtexMetadataWorkerRequest>) => void) | null;
  postMessage: (message: BibtexMetadataWorkerResponse) => void;
}

const workerScope = self as unknown as BibtexMetadataWorkerScope;

workerScope.onmessage = ({ data: request }) => {
  if (!request || typeof request.id !== "number" || typeof request.source !== "string") return;
  let response: BibtexMetadataWorkerResponse;
  try {
    response = {
      id: request.id,
      ok: true,
      entries: [...bibtexEntrySummaries(request.source).values()]
    };
  } catch {
    response = { id: request.id, ok: false, kind: "invalid" };
  }
  workerScope.postMessage(response);
};
