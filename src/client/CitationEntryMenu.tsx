import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Copy, Edit3, LoaderCircle, MoreHorizontal, Tags, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Also support trusted LAN deployments where the Clipboard API is unavailable. */
async function copyBibtex(text: string, container: () => HTMLElement | null): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* A denied Clipboard API may still allow a user-initiated copy. */ }
  const parent = container();
  if (!parent?.isConnected || typeof document.execCommand !== "function") throw new Error("Clipboard unavailable");
  const active = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  input.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  // Keep fallback focus inside the list item (and any containing dialog).
  parent.append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    if (!document.execCommand("copy")) throw new Error("Copy rejected");
  } finally {
    input.remove();
    if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}

export function CitationEntryMenu({ citationKey, bibtex, onTags, onEdit, onDelete, deleting = false }: {
  citationKey: string;
  bibtex: string;
  onTags?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const content = useRef<HTMLSpanElement>(null);
  const selecting = useRef(false);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setCopyState("idle");
    return () => { request.current++; clearTimeout(timer.current); };
  }, [bibtex]);
  const copy = async () => {
    const current = ++request.current;
    clearTimeout(timer.current);
    setCopyState("copying");
    try {
      await copyBibtex(bibtex, () => content.current);
      if (current !== request.current) return;
      setCopyState("copied");
    } catch {
      if (current !== request.current) return;
      setCopyState("error");
    }
    timer.current = setTimeout(() => setCopyState("idle"), 2000);
  };
  return <span ref={content} className="citation-entry-controls">
    <button type="button" className={`citation-copy-button${copyState === "copied" ? " is-copied" : copyState === "error" ? " is-error" : ""}`}
      disabled={copyState === "copying"} onClick={() => void copy()}>
      {copyState === "copying" ? <LoaderCircle className="spin" size={13} aria-hidden /> : copyState === "copied" ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      <span role="status" aria-live="polite">{t(`citationLibraryActions.${copyState === "idle" ? "copyBibtex" : copyState === "error" ? "copyFailed" : copyState}`)}</span>
    </button>
    {(onTags || onEdit || onDelete) && <DropdownMenu.Root modal={false}>
    <DropdownMenu.Trigger asChild>
      <button type="button" className="citation-entry-menu-trigger" disabled={deleting}
        aria-label={t("citationLibraryActions.entryActions", { key: citationKey })}><MoreHorizontal size={17} aria-hidden /></button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="citation-entry-menu" align="end" sideOffset={5} collisionPadding={8}
        onCloseAutoFocus={(event) => { if (selecting.current) event.preventDefault(); selecting.current = false; }}>
        {onTags && <DropdownMenu.Item onSelect={() => { selecting.current = true; onTags(); }}><Tags size={14} aria-hidden />{t("citationLibrary.tags")}</DropdownMenu.Item>}
        {onEdit && <DropdownMenu.Item onSelect={() => { selecting.current = true; onEdit(); }}><Edit3 size={14} aria-hidden />{t("common.edit")}</DropdownMenu.Item>}
        {onDelete && <><DropdownMenu.Separator className="citation-entry-menu-separator" />
          <DropdownMenu.Item className="danger-text" onSelect={() => { selecting.current = true; onDelete(); }}><Trash2 size={14} aria-hidden />{t("common.delete")}</DropdownMenu.Item>
        </>}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
    </DropdownMenu.Root>}
  </span>;
}
