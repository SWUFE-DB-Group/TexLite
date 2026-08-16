import { useEffect, useMemo, useRef, useState } from "react";
import type { SpellCheckJump } from "../LatexEditor";
import type { SpellCheckIssue } from "../spellCheck";

interface UseSpellCheckOptions {
  active: boolean;
  activeFile: string;
  content: string;
  dictionaryWords: string[];
}

export function useSpellCheck({ active, activeFile, content, dictionaryWords }: UseSpellCheckOptions) {
  const [issues, setIssues] = useState<SpellCheckIssue[]>([]);
  const [checkedSource, setCheckedSource] = useState("");
  const [checkedFile, setCheckedFile] = useState("");
  const [index, setIndex] = useState(0);
  const [jump, setJump] = useState<SpellCheckJump | null>(null);
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
    const source = content;
    const file = activeFile;
    const timer = window.setTimeout(() => {
      void import("../spellCheck").then(({ lintLatex }) => {
        if (currentRequest !== request.current || contentRef.current !== source || activeFileRef.current !== file) return;
        return lintLatex(source, dictionaryWords).then((nextIssues) => {
          if (currentRequest !== request.current || contentRef.current !== source || activeFileRef.current !== file) return;
          setIssues(nextIssues);
          setCheckedSource(source);
          setCheckedFile(file);
          setIndex(0);
          setJump(null);
        });
      }).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [active, activeFile, content, dictionaryWords]);

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
    jumpToIssue
  };
}
