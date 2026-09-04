import { useMemo, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import { AtSign } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import type { MentionableUser } from "../types";

interface MentionContext {
  start: number;
  end: number;
  query: string;
}

function mentionContext(value: string, caret: number): MentionContext | null {
  const prefix = value.slice(0, caret);
  // Do not turn the @ in an e-mail address into an editor interaction. This
  // merely controls the picker: it never alters literal @ text on its own.
  const match = /(^|[^\p{L}\p{N}_.-])@([\p{L}\p{N}_.-]*)$/u.exec(prefix);
  if (!match) return null;
  return { start: caret - match[2].length - 1, end: caret, query: match[2] };
}

export interface MentionTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> {
  projectId: string;
  value: string;
  onChange: (value: string) => void;
}

/**
 * A deliberately non-invasive mention composer.  Choosing a candidate writes
 * a normal `@username` token; ignoring the menu leaves every ordinary `@`
 * character untouched.
 */
export function MentionTextarea({ projectId, value, onChange, onKeyDown, onFocus, ...props }: MentionTextareaProps) {
  const { t } = useTranslation();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [candidates, setCandidates] = useState<MentionableUser[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [context, setContext] = useState<MentionContext | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const visibleCandidates = useMemo(() => {
    if (!context || !candidates) return [];
    const query = context.query.toLocaleLowerCase();
    const result = !query ? candidates : candidates.filter((candidate) =>
      candidate.username.toLocaleLowerCase().includes(query)
      || candidate.displayName.toLocaleLowerCase().includes(query)
    );
    return result.slice(0, 8);
  }, [candidates, context]);
  const menuOpen = Boolean(context && visibleCandidates.length);

  const loadCandidates = async () => {
    if (candidates || loading) return;
    setLoading(true);
    try {
      const result = await api<{ users: MentionableUser[] }>(`/api/projects/${projectId}/mention-candidates`);
      setCandidates(result.users);
    } catch {
      // Mentioning is an enhancement. A temporary request failure must never
      // prevent the user from entering ordinary comment text.
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  };

  const updateContext = (next: string, caret: number) => {
    const nextContext = mentionContext(next, caret);
    setContext(nextContext);
    setActiveIndex(0);
    if (nextContext) void loadCandidates();
  };

  const choose = (candidate: MentionableUser) => {
    if (!context) return;
    const replacement = `@${candidate.username} `;
    const next = `${value.slice(0, context.start)}${replacement}${value.slice(context.end)}`;
    const nextCaret = context.start + replacement.length;
    onChange(next);
    setContext(null);
    setActiveIndex(0);
    window.requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!event.nativeEvent.isComposing && menuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % visibleCandidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => (current - 1 + visibleCandidates.length) % visibleCandidates.length);
        return;
      }
      if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        choose(visibleCandidates[activeIndex] ?? visibleCandidates[0]);
        return;
      }
      if (event.key === "Escape") {
        setContext(null);
        return;
      }
    }
    onKeyDown?.(event);
  };

  return <span className="mention-textarea">
    <textarea
      {...props}
      ref={textarea}
      value={value}
      onFocus={(event) => {
        onFocus?.(event);
        updateContext(value, event.currentTarget.selectionStart ?? value.length);
      }}
      onClick={(event) => updateContext(value, event.currentTarget.selectionStart ?? value.length)}
      onChange={(event) => {
        const next = event.currentTarget.value;
        onChange(next);
        updateContext(next, event.currentTarget.selectionStart ?? next.length);
      }}
      onKeyDown={handleKeyDown}
    />
    {menuOpen && <span className="mention-menu" role="listbox" aria-label={t("editor.mentionUsers")}>
      {visibleCandidates.map((candidate, index) => <button
        type="button"
        key={candidate.id}
        role="option"
        aria-selected={index === activeIndex}
        className={index === activeIndex ? "active" : ""}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(candidate)}
      ><AtSign aria-hidden size={13} /><span><strong>{candidate.displayName}</strong><small>({candidate.username})</small></span></button>)}
    </span>}
  </span>;
}
