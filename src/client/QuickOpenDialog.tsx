import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Search } from "lucide-react";
import { Modal } from "./Dialog";
import { FileTypeIcon } from "./fileIcons";
import { formatShortcutKey } from "./shortcuts";
import type { FileEntry } from "./types";

export type QuickOpenMode = "files" | "commands";

export interface QuickOpenCommand {
  id: string;
  label: string;
  keywords?: string;
  shortcut?: string;
  icon?: ReactNode;
  onSelect: () => void;
}

export function QuickOpenDialog({ open, files, commands = [], initialMode = "files", onOpenChange, onOpenFile }: {
  open: boolean;
  files: FileEntry[];
  commands?: QuickOpenCommand[];
  initialMode?: QuickOpenMode;
  onOpenChange: (open: boolean) => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const selectedResult = useRef<HTMLButtonElement>(null);
  const hasCommands = commands.length > 0;
  const isCommandMode = hasCommands && query.trimStart().startsWith(">");
  const commandQuery = isCommandMode ? query.trimStart().slice(1).trim() : "";

  const fileChoices = useMemo(() => {
    if (isCommandMode) return [];
    return files.filter((entry) => entry.type === "file")
      .map((entry) => ({ entry, score: fuzzyScore(entry.path, query) }))
      .filter((item) => item.score >= 0)
      .sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path))
      .slice(0, 100);
  }, [files, isCommandMode, query]);

  const commandChoices = useMemo(() => {
    if (!isCommandMode) return [];
    return commands
      .map((command, index) => {
        const labelScore = fuzzyScore(command.label, commandQuery);
        const keywordScore = command.keywords ? fuzzyScore(command.keywords, commandQuery) : -1;
        const score = Math.max(labelScore, keywordScore >= 0 ? keywordScore * 0.9 : -1);
        return { command, score, index };
      })
      .filter((item) => item.score >= 0)
      .sort((left, right) => right.score - left.score || left.index - right.index);
  }, [commands, commandQuery, isCommandMode]);

  const resultCount = isCommandMode ? commandChoices.length : fileChoices.length;

  useEffect(() => {
    if (!open) return;
    const nextQuery = initialMode === "commands" && hasCommands ? "> " : "";
    setQuery(nextQuery);
    setSelected(0);
    window.setTimeout(() => {
      const element = input.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(nextQuery.length, nextQuery.length);
    }, 0);
  }, [open, initialMode, hasCommands]);
  useEffect(() => setSelected((current) => Math.min(current, Math.max(0, resultCount - 1))), [resultCount]);
  useEffect(() => {
    if (!open) return;
    selectedResult.current?.scrollIntoView({ block: "nearest" });
  }, [open, selected, isCommandMode]);

  const chooseFile = (path: string) => { onOpenFile(path); onOpenChange(false); };
  const chooseCommand = (command: QuickOpenCommand) => { onOpenChange(false); command.onSelect(); };
  const switchMode = (mode: QuickOpenMode) => {
    setQuery((current) => {
      const trimmed = current.trimStart();
      if (mode === "files") return trimmed.startsWith(">") ? trimmed.slice(1).trimStart() : current;
      return trimmed.startsWith(">") ? current : `> ${trimmed}`;
    });
    setSelected(0);
    window.setTimeout(() => {
      const element = input.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    }, 0);
  };

  const fileShortcut = formatShortcutKey("P");
  const commandShortcut = formatShortcutKey("K");
  const modalTitle = isCommandMode ? t("navigation.commandPalette") : t("navigation.quickOpen");
  const modalDescription = !hasCommands
    ? t("navigation.quickOpenDescription")
    : isCommandMode
      ? t("navigation.quickOpenCommandsHint", { shortcut: commandShortcut, fileShortcut })
      : t("navigation.quickOpenFilesHint", { shortcut: fileShortcut, commandShortcut });

  return <Modal open={open} wide title={modalTitle} description={modalDescription} onOpenChange={onOpenChange}>
    <div className="quick-open-dialog">
      <div className="quick-open-input-bar">
        <label>
          {isCommandMode ? <ChevronRight size={16} aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
          <input ref={input} value={query} placeholder={t(isCommandMode ? "navigation.commandPlaceholder" : "navigation.filePlaceholder")} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setSelected((current) => Math.min(Math.max(0, resultCount - 1), current + 1)); }
            if (event.key === "ArrowUp") { event.preventDefault(); setSelected((current) => Math.max(0, current - 1)); }
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              if (isCommandMode && commandChoices[selected]) { event.preventDefault(); chooseCommand(commandChoices[selected].command); }
              else if (!isCommandMode && fileChoices[selected]) { event.preventDefault(); chooseFile(fileChoices[selected].entry.path); }
            }
          }} />
        </label>
        {hasCommands && (
          <div className="quick-open-mode-switch" role="group" aria-label={t("navigation.quickOpen")}>
            <button type="button" className={!isCommandMode ? "active" : ""} aria-pressed={!isCommandMode} title={t("common.files")} data-shortcut={fileShortcut} onMouseDown={(event) => event.preventDefault()} onClick={() => switchMode("files")}>
              <span>{t("common.files")}</span>
              <kbd className="ui-kbd quick-open-mode-kbd">{fileShortcut}</kbd>
            </button>
            <button type="button" className={isCommandMode ? "active" : ""} aria-pressed={isCommandMode} title={t("navigation.commandPalette")} data-shortcut={commandShortcut} onMouseDown={(event) => event.preventDefault()} onClick={() => switchMode("commands")}>
              <span className="quick-open-mode-prefix" aria-hidden="true">&gt;</span>
              <span>{t("navigation.commands")}</span>
              <kbd className="ui-kbd quick-open-mode-kbd">{commandShortcut}</kbd>
            </button>
          </div>
        )}
      </div>
      <div className="quick-open-results">
        {isCommandMode ? (
          <>
            {commandChoices.map(({ command }, index) => (
              <button ref={index === selected ? selectedResult : undefined} className={`quick-open-command${index === selected ? " active" : ""}`} key={command.id} onMouseEnter={() => setSelected(index)} onClick={() => chooseCommand(command)}>
                <span className="quick-open-item-icon" aria-hidden="true">{command.icon ?? <ChevronRight size={14} />}</span>
                <span className="quick-open-command-label">{command.label}</span>
                {command.shortcut && <kbd className="ui-kbd">{command.shortcut}</kbd>}
                <span className="quick-open-item-check" aria-hidden="true">{index === selected && <Check size={13} />}</span>
              </button>
            ))}
            {commandChoices.length === 0 && <p className="muted padded">{t("navigation.noCommands")}</p>}
          </>
        ) : (
          <>
            {fileChoices.map(({ entry }, index) => (
              <button ref={index === selected ? selectedResult : undefined} className={index === selected ? "active" : ""} key={entry.path} onMouseEnter={() => setSelected(index)} onClick={() => chooseFile(entry.path)}>
                <FileTypeIcon path={entry.path} size={14} />
                <span>{entry.path}</span>
                {index === selected && <Check size={13} />}
              </button>
            ))}
            {fileChoices.length === 0 && <p className="muted padded">{t("navigation.noFiles")}</p>}
          </>
        )}
      </div>
    </div>
  </Modal>;
}

function fuzzyScore(value: string, query: string): number {
  const target = value.toLocaleLowerCase();
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 1;
  const direct = target.indexOf(needle);
  if (direct >= 0) return 10_000 - direct - target.length;
  let cursor = 0;
  let score = 0;
  for (const character of needle) {
    const index = target.indexOf(character, cursor);
    if (index < 0) return -1;
    score += index === cursor ? 5 : 1;
    cursor = index + 1;
  }
  return score - target.length / 100;
}
