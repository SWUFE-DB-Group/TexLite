import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { scopedStorageKey } from "../basePath";
import { readStorage, writeStorage } from "../browserStorage";
import { errorMessage } from "../errors";

const SAVED_FEEDBACK_MS = 2500;
const ALL_ENGINES = ["pdflatex", "xelatex", "lualatex"] as const;

export type LatexEngine = (typeof ALL_ENGINES)[number];
export type TikzFigurePdfState = { path: string; status: "compiling" } | { path: string; status: "saved"; file: string } | null;

interface UseTikzFigurePdfOptions {
  projectId: string;
  userId: string;
  projectEngine?: LatexEngine;
  allowedEngines?: LatexEngine[];
  compile: (engine: LatexEngine) => Promise<{ ok: boolean; cancelled?: boolean; mainFile: string } | null>;
  onError: (message: string) => void;
}

/**
 * Compiles the open figure with an engine chosen for figures, which leaves the
 * project's own engine alone, and when that succeeds saves the PDF beside the
 * source. The choice is kept per project in this browser.
 */
export function useTikzFigurePdf({ projectId, userId, projectEngine, allowedEngines, compile, onError }: UseTikzFigurePdfOptions) {
  const storageKey = scopedStorageKey(`texlite.tikzPdfEngine:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`);
  const [stored, setStored] = useState(() => readStorage(storageKey));
  useEffect(() => setStored(readStorage(storageKey)), [storageKey]);
  const engines = allowedEngines?.length ? allowedEngines : [...ALL_ENGINES];
  const engine = engines.find((item) => item === stored) ?? (projectEngine && engines.includes(projectEngine) ? projectEngine : engines[0]!);
  const setEngine = (next: LatexEngine) => { setStored(next); writeStorage(storageKey, next); };

  const [state, setState] = useState<TikzFigurePdfState>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const run = async (path: string) => {
    window.clearTimeout(timer.current);
    setState({ path, status: "compiling" });
    try {
      const result = await compile(engine);
      if (!result?.ok || result.cancelled || result.mainFile !== path) { setState(null); return; }
      const saved = await api<{ path: string }>(`/api/projects/${projectId}/compile/export-pdf`, { method: "POST", body: JSON.stringify({ mainFile: path }) });
      setState({ path, status: "saved", file: saved.path.split("/").at(-1) ?? saved.path });
      timer.current = window.setTimeout(() => setState(null), SAVED_FEEDBACK_MS);
    } catch (error) {
      setState(null);
      onError(errorMessage(error));
    }
  };
  return { state, run, engine, engines, setEngine };
}
