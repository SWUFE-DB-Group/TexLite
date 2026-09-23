import { useEffect, useMemo, useRef, useState } from "react";
import type { SpellCheckJump } from "../LatexEditor";
import type { SpellCheckIssue } from "../spellCheck";

interface UseSpellCheckOptions {
  active: boolean;
  /** Keep Harper independently switchable from other writing diagnostics. */
  harperEnabled?: boolean;
  projectId: string;
  activeFile: string;
  content: string;
  dictionaryWords: string[];
  additionalIssues?: SpellCheckIssue[];
  additionalIssuesReady?: boolean;
}

export function useSpellCheck({ active, harperEnabled = true, projectId, activeFile, content, dictionaryWords, additionalIssues = [], additionalIssuesReady = true }: UseSpellCheckOptions) {
  const [issues, setIssues] = useState<SpellCheckIssue[]>([]);
  const [checkedSource, setCheckedSource] = useState("");
  const [checkedFile, setCheckedFile] = useState("");
  const [index, setIndex] = useState(0);
  const [jump, setJump] = useState<SpellCheckJump | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [failureDismissed, setFailureDismissed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const request = useRef(0);
  const autoRetryRef = useRef(false);
  const failureDismissedRef = useRef(false);
  const contentRef = useRef(content);
  const activeFileRef = useRef(activeFile);
  const jumpNonce = useRef(0);
  contentRef.current = content;
  activeFileRef.current = activeFile;
  failureDismissedRef.current = failureDismissed;

  useEffect(() => {
    setIssues([]);
    setCheckedSource("");
    setCheckedFile("");
    setJump(null);
    // A failure is scoped to one file/dictionary request. Do not carry a
    // transient Harper/network failure into the next file or dictionary
    // revision, where it would otherwise suppress checking indefinitely.
    setFailure(null);
    setFailureDismissed(false);
  }, [activeFile, dictionaryWords, harperEnabled]);

  useEffect(() => {
    setFailure(null);
    setFailureDismissed(false);
  }, [projectId]);

  useEffect(() => {
    const currentRequest = ++request.current;
    if (!active || !activeFile) {
      setIssues([]);
      setCheckedSource("");
      setCheckedFile("");
      setJump(null);
      return;
    }
    if (!harperEnabled) {
      setIssues([]);
      setCheckedSource("");
      setCheckedFile("");
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
          autoRetryRef.current = false;
          setFailureDismissed(false);
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
          const wasAutoRetry = autoRetryRef.current;
          autoRetryRef.current = false;
          // Keep a deliberately dismissed banner closed across background
          // retries. A manual retry or a new file/dictionary revision resets
          // the dismissal state explicitly.
          setFailureDismissed(wasAutoRetry ? failureDismissedRef.current : false);
        }
      })();
    }, 700);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, harperEnabled, projectId, activeFile, content, dictionaryWords, retryToken, failure]);

  useEffect(() => {
    if (!failure || !active || !harperEnabled) return;
    // Host Harper is a best-effort service. Keep the browser spellchecker fallback
    // active immediately, but retry in the background so one temporary
    // network/worker failure does not become a permanent state. Going back
    // online retries at once; the timer is deliberately long enough not to
    // create a request loop while a server is unavailable.
    let retried = false;
    const retry = () => {
      if (retried) return;
      retried = true;
      autoRetryRef.current = true;
      setFailure(null);
      setRetryToken((current) => current + 1);
    };
    const timer = window.setTimeout(retry, 15_000);
    window.addEventListener("online", retry, { once: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", retry);
    };
  }, [failure, active, harperEnabled]);

  const harperVisible = harperEnabled && active && checkedFile === activeFile && checkedSource === content;
  const visibleIssues = useMemo(() => {
    if (!active) return [];
    const merged = [...(harperVisible ? issues : []), ...additionalIssues]
      .sort((left, right) => left.from - right.from || left.to - right.to);
    const seen = new Set<string>();
    return merged.filter((issue) => {
      const key = `${issue.from}:${issue.to}:${issue.kind}:${issue.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [active, additionalIssues, harperVisible, issues]);
  const summary = useMemo(() => active && (!harperEnabled || harperVisible) && additionalIssuesReady ? {
    total: visibleIssues.length,
    unique: new Set(visibleIssues.map((issue) => `${issue.kind}:${issue.word.toLocaleLowerCase("en-US")}`)).size
  } : null, [active, additionalIssuesReady, harperEnabled, harperVisible, visibleIssues]);
  useEffect(() => {
    setIndex((current) => visibleIssues.length ? Math.min(current, visibleIssues.length - 1) : 0);
  }, [visibleIssues]);

  const jumpToIssue = (requestedIndex: number) => {
    if (!visibleIssues.length) return;
    const nextIndex = Math.max(0, Math.min(requestedIndex, visibleIssues.length - 1));
    const issue = visibleIssues[nextIndex];
    setIndex(nextIndex);
    setJump({ from: issue.from, to: issue.to, nonce: ++jumpNonce.current });
  };

  return {
    issues: visibleIssues,
    jump: active ? jump : null,
    index,
    summary,
    jumpToIssue,
    error: active && harperEnabled && !failureDismissed ? failure : null,
    nativeFallback: active && harperEnabled && Boolean(failure),
    retry: () => {
      autoRetryRef.current = false;
      setFailure(null);
      setFailureDismissed(false);
      setRetryToken((current) => current + 1);
    },
    dismissError: () => {
      autoRetryRef.current = false;
      setFailureDismissed(true);
    }
  };
}
