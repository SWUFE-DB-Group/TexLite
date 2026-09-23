import { useEffect, useRef, useState } from "react";
import type { SpellCheckIssue } from "../spellCheck";

interface UseChktexOptions {
  active: boolean;
  projectId: string;
  activeFile: string;
  content: string;
}

/** Run the optional host ChkTeX checker only after a quiet two-second edit. */
export function useChktex({ active, projectId, activeFile, content }: UseChktexOptions) {
  const [issues, setIssues] = useState<SpellCheckIssue[]>([]);
  const [checkedSource, setCheckedSource] = useState("");
  const [checkedFile, setCheckedFile] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const request = useRef(0);
  const contentRef = useRef(content);
  const fileRef = useRef(activeFile);
  contentRef.current = content;
  fileRef.current = activeFile;

  useEffect(() => {
    setIssues([]);
    setCheckedSource("");
    setCheckedFile("");
    setError(null);
    setDismissed(false);
  }, [projectId, activeFile]);

  useEffect(() => {
    const currentRequest = ++request.current;
    if (!active || !activeFile) {
      setIssues([]);
      setCheckedSource("");
      setCheckedFile("");
      return;
    }
    const source = content;
    const file = activeFile;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const { lintChktex, isChktexLintSupersededError } = await import("../chktex");
          if (cancelled || currentRequest !== request.current || contentRef.current !== source || fileRef.current !== file) return;
          let nextIssues: SpellCheckIssue[];
          try {
            nextIssues = await lintChktex(projectId, file, source);
          } catch (requestError) {
            if (isChktexLintSupersededError(requestError)) return;
            throw requestError;
          }
          if (cancelled || currentRequest !== request.current || contentRef.current !== source || fileRef.current !== file) return;
          setIssues(nextIssues);
          setCheckedSource(source);
          setCheckedFile(file);
          setError(null);
          setDismissed(false);
        } catch (requestError) {
          if (cancelled || currentRequest !== request.current || contentRef.current !== source || fileRef.current !== file) return;
          setIssues([]);
          setCheckedSource("");
          setCheckedFile("");
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      })();
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, projectId, activeFile, content, retryToken]);

  const visible = active && checkedFile === activeFile && checkedSource === content;
  return {
    issues: visible ? issues : [],
    checked: visible,
    error: active && !dismissed ? error : null,
    retry: () => { setError(null); setDismissed(false); setRetryToken((value) => value + 1); },
    dismissError: () => setDismissed(true)
  };
}
