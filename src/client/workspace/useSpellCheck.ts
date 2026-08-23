import { useEffect, useMemo, useRef, useState } from "react";
import type { SpellCheckJump } from "../LatexEditor";
import type { SpellCheckIssue } from "../spellCheck";

interface UseSpellCheckOptions {
  active: boolean;
  projectId: string;
  activeFile: string;
  content: string;
  dictionaryWords: string[];
}

export function useSpellCheck({ active, projectId, activeFile, content, dictionaryWords }: UseSpellCheckOptions) {
  const [issues, setIssues] = useState<SpellCheckIssue[]>([]);
  const [checkedSource, setCheckedSource] = useState("");
  const [checkedFile, setCheckedFile] = useState("");
  const [index, setIndex] = useState(0);
  const [jump, setJump] = useState<SpellCheckJump | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [failureDismissed, setFailureDismissed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const request = useRef(0);
  const contentRef = useRef(content);
  const activeFileRef = useRef(activeFile);
  const jumpNonce = useRef(0);
  contentRef.current = content;
  activeFileRef.current = activeFile;

  useEffect(() => {
    setIssues([]);
    setCheckedSource("");
    setCheckedFile("");
    setJump(null);
  }, [activeFile, dictionaryWords]);

  useEffect(() => {
    setFailure(null);
    setFailureDismissed(false);
  }, [projectId]);

  useEffect(() => {
    setIndex((current) => issues.length ? Math.min(current, issues.length - 1) : 0);
  }, [issues]);

  useEffect(() => {
    const currentRequest = ++request.current;
    if (!active || !activeFile) {
      setIssues([]);
      setCheckedSource("");
      setCheckedFile("");
      setJump(null);
      return;
    }
    if (failure) {
      setIssues([]);
      setCheckedSource("");
      setCheckedFile("");
      return;
    }
    const source = content;
    const file = activeFile;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setFailure(null);
      void (async () => {
        try {
          const { lintLatex, isHarperLintSupersededError } = await import("../spellCheck");
          if (cancelled || currentRequest !== request.current || contentRef.current !== source || activeFileRef.current !== file) return;
          let nextIssues: SpellCheckIssue[];
          try {
            nextIssues = await lintLatex(projectId, file, source, dictionaryWords);
          } catch (error) {
            if (isHarperLintSupersededError(error)) return;
            throw error;
          }
          if (cancelled || currentRequest !== request.current || contentRef.current !== source || activeFileRef.current !== file) return;
          setIssues(nextIssues);
          setCheckedSource(source);
          setCheckedFile(file);
          setIndex(0);
          setJump(null);
        } catch (error) {
          if (cancelled || currentRequest !== request.current || contentRef.current !== source || activeFileRef.current !== file) return;
          setIssues([]);
          setCheckedSource("");
          setCheckedFile("");
          setFailure(error instanceof Error ? error.message : String(error));
          setFailureDismissed(false);
        }
      })();
    }, 700);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, projectId, activeFile, content, dictionaryWords, retryToken, failure]);

  const visible = checkedFile === activeFile && checkedSource === content;
  const summary = useMemo(() => visible ? {
    total: issues.length,
    unique: new Set(issues.map((issue) => `${issue.kind}:${issue.word.toLocaleLowerCase("en-US")}`)).size
  } : null, [visible, issues]);

  const jumpToIssue = (requestedIndex: number) => {
    if (!issues.length) return;
    const nextIndex = Math.max(0, Math.min(requestedIndex, issues.length - 1));
    const issue = issues[nextIndex];
    setIndex(nextIndex);
    setJump({ from: issue.from, to: issue.to, nonce: ++jumpNonce.current });
  };

  return {
    issues: visible ? issues : [],
    jump: visible ? jump : null,
    index,
    summary,
    jumpToIssue,
    error: failureDismissed ? null : failure,
    nativeFallback: active && Boolean(failure),
    retry: () => {
      setFailure(null);
      setFailureDismissed(false);
      setRetryToken((current) => current + 1);
    },
    dismissError: () => setFailureDismissed(true)
  };
}
