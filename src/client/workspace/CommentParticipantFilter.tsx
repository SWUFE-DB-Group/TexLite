import { useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Users, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CommentParticipant } from "./commentNavigation";

interface CommentParticipantFilterProps {
  participants: readonly CommentParticipant[];
  selectedIds: ReadonlySet<string | null>;
  topLevelOnly: boolean;
  onToggle: (id: string | null) => void;
  onClear: () => void;
  onTopLevelOnlyChange: (value: boolean) => void;
}

/** Presentation only: the review drawer owns the actual filter state. */
export function CommentParticipantFilter({
  participants, selectedIds, topLevelOnly, onToggle, onClear, onTopLevelOnlyChange
}: CommentParticipantFilterProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasSelection = selectedIds.size > 0;
  const firstSelected = participants.find((participant) => selectedIds.has(participant.authorId));
  const authorName = (participant: CommentParticipant) =>
    participant.authorDisplayName ?? participant.authorUsername ?? t("editor.deletedUser");
  const summary = !hasSelection
    ? t("editor.commentParticipantsAll")
    : firstSelected
      ? selectedIds.size === 1
        ? authorName(firstSelected)
        : t("editor.commentParticipantsSelected", { name: authorName(firstSelected), count: selectedIds.size - 1 })
      // A file/scope switch may temporarily load a resource without that author.
      // Keep the filter clearable rather than presenting it as "All participants".
      : t("editor.commentParticipantsCount", { count: selectedIds.size });

  return <div className="comment-participant-filter">
    <div className={`comment-participants-trigger-group${hasSelection ? " active" : ""}`}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button type="button" className="comment-participants-toggle" aria-label={`${t("editor.commentParticipants")}: ${summary}`}>
            <Users size={13} aria-hidden />
            <span className="comment-participants-summary">{hasSelection && firstSelected ? authorName(firstSelected) : summary}</span>
            {hasSelection && firstSelected && selectedIds.size > 1 && <span className="comment-participants-extra-count">+{selectedIds.size - 1}</span>}
            <ChevronDown size={12} aria-hidden className={open ? "expanded" : ""} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content ref={contentRef} className="comment-participants-popover" side="bottom" align="end" sideOffset={6} collisionPadding={10}
            aria-label={t("editor.commentParticipants")}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              // Start at a participant, not the destructive-to-filter clear action.
              const firstCheckbox = contentRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)');
              if (firstCheckbox) firstCheckbox.focus();
              else contentRef.current?.focus();
            }}>
            <div className="comment-participants-heading">
              <Popover.Title>{t("editor.commentParticipants")}</Popover.Title>
              {hasSelection && <button type="button" onClick={onClear}>{t("editor.commentParticipantsClear")}</button>}
            </div>
            <div className="comment-participants-list">
              {participants.map((participant) => {
                const name = authorName(participant);
                const selected = selectedIds.has(participant.authorId);
                return <label className={`comment-participant-option${selected ? " selected" : ""}`} key={participant.authorId ?? "deleted"}>
                  <input type="checkbox" checked={selected} onChange={() => onToggle(participant.authorId)} />
                  <span className="comment-participant-avatar" aria-hidden>{Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?"}</span>
                  <span className="comment-participant-identity"><strong>{name}</strong>{participant.authorUsername && <small>@{participant.authorUsername}</small>}</span>
                </label>;
              })}
              {participants.length === 0 && <p className="comment-participants-empty">{t("editor.commentNoParticipants")}</p>}
            </div>
            <label className="comment-participants-root-only">
              <input type="checkbox" checked={topLevelOnly} disabled={!hasSelection} onChange={(event) => onTopLevelOnlyChange(event.target.checked)} />
              {t("editor.commentTopLevelOnly")}
            </label>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {hasSelection && <button type="button" className="comment-participants-clear" aria-label={t("editor.commentParticipantsClear")} onClick={onClear}><X size={12} aria-hidden /></button>}
    </div>
    {hasSelection && topLevelOnly && <span className="comment-participants-scope">{t("editor.commentTopLevelOnly")}</span>}
  </div>;
}
