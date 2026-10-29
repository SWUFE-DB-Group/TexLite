import { useEffect, useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface ShareUser {
  id: string;
  username: string;
  displayName?: string;
}

const userLabel = (user: ShareUser) => `${user.displayName?.trim() || user.username} (@${user.username})`;

/** One bounded combobox for browsing and filtering; typing never grants access. */
export function ShareUserPicker({ users, value, onChange, disabled = false }: {
  users: ShareUser[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = users.find((user) => user.id === value);
  const search = selected ? "" : query.trim().replace(/^@/, "").toLowerCase();
  const filtered = search ? users.filter((user) =>
    user.username.toLowerCase().includes(search) || (user.displayName ?? "").toLowerCase().includes(search)
  ) : users;
  const activeIndex = Math.min(active, Math.max(0, filtered.length - 1));
  const expanded = open && !disabled;

  useEffect(() => {
    if (expanded) listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, expanded, query]);

  const choose = (index: number) => {
    const user = filtered[index];
    if (!user || disabled) return;
    onChange(user.id);
    setQuery(""); setOpen(false);
  };
  const showOptions = () => {
    setActive(Math.max(0, filtered.findIndex((user) => user.id === value)));
    setOpen(true);
  };
  const controlId = `${id}-user`;
  return <div className="share-user-picker">
    <label htmlFor={controlId}>{t("common.user")}</label>
    <Popover.Root open={expanded} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div className="share-user-search" ref={anchorRef} onClick={() => {
          if (!disabled) { inputRef.current?.focus(); showOptions(); }
        }}>
          <input id={controlId} ref={inputRef} role="combobox" value={selected ? userLabel(selected) : query} disabled={disabled}
            placeholder={t("projectSettings.searchUsersPlaceholder")} autoComplete="off" spellCheck={false}
            aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? `${id}-list` : undefined}
            aria-activedescendant={expanded && filtered[activeIndex] ? `${id}-user-${filtered[activeIndex].id}` : undefined}
            onClick={(event) => { if (selected) event.currentTarget.select(); }}
            onFocus={(event) => {
              showOptions();
              if (selected) event.currentTarget.select();
            }}
            onChange={(event) => { setQuery(event.target.value); onChange(""); setActive(0); setOpen(true); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault(); setOpen(true);
                const step = event.key === "ArrowDown" ? 1 : -1;
                if (!expanded) {
                  const selectedIndex = filtered.findIndex((user) => user.id === value);
                  setActive(selectedIndex >= 0 ? selectedIndex : step === 1 ? 0 : Math.max(0, filtered.length - 1));
                } else setActive((index) => filtered.length ? (index + step + filtered.length) % filtered.length : 0);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (expanded) choose(activeIndex);
              } else if (event.key === "Escape" && expanded) {
                event.preventDefault(); event.stopPropagation(); setOpen(false);
              }
            }} />
          <ChevronDown className="share-user-chevron" size={14} aria-hidden />
        </div>
      </Popover.Anchor>
      {/* Keep focus inside the share dialog while letting Popper avoid clipping. */}
      <Popover.Portal container={inputRef.current?.closest<HTMLElement>('[role="dialog"]')}>
        <Popover.Content className="share-user-popover" aria-label={t("projectSettings.chooseUser")} align="start" side="bottom" sideOffset={5} collisionPadding={12}
          avoidCollisions={false}
          collisionBoundary={inputRef.current?.closest<HTMLElement>('[role="dialog"]') ?? undefined}
          onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => { if (anchorRef.current?.contains(event.target as Node)) event.preventDefault(); }}
          onEscapeKeyDown={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(false); }}>
          <div id={`${id}-list`} ref={listRef} role="listbox" aria-label={t("projectSettings.chooseUser")}>
            {filtered.map((user, index) => <button type="button" role="option" tabIndex={-1} id={`${id}-user-${user.id}`}
              key={user.id} data-index={index} data-active={index === activeIndex || undefined} aria-selected={user.id === value}
              onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(index)}>
              <span><strong>{user.displayName?.trim() || user.username}</strong><small>@{user.username}</small></span>
              {user.id === value && <Check size={14} aria-hidden />}
            </button>)}
          </div>
          {filtered.length === 0 && <p className="share-user-no-results" role="status">{t(users.length ? "projectSettings.noMatchingUsers" : "projectSettings.noAvailableUsers")}</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>;
}
