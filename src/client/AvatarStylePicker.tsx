import { useEffect, useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AVATAR_STYLES } from "../shared/avatars";

const styleName = (value: string) => value.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");

/** A single preview remains in the dialog; this list never requests avatar images. */
export function AvatarStylePicker({ value, disabled, onChange }: {
  value: string | null; disabled: boolean; onChange: (value: string | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const options = [{ value: null, name: t("account.avatarDefault") }, ...AVATAR_STYLES.map((style) => ({ value: style, name: styleName(style) }))];
  const search = query.trim().toLowerCase().replace(/-/g, " ");
  const filtered = options.filter((option) => option.name.toLowerCase().includes(search));
  const selected = options.find((option) => option.value === value)?.name ?? t("account.avatarDefault");
  const changeOpen = (next: boolean) => {
    setOpen(next && !disabled);
    if (next) {
      setQuery("");
      setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    }
  };
  const choose = (index: number) => {
    const option = filtered[index];
    if (!option || disabled) return;
    onChange(option.value);
    setOpen(false);
  };
  const scrollActiveIntoView = () => listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, query]);

  return <div className="avatar-style-picker">
    <span id={`${id}-label`} className="avatar-style-label">{t("account.avatarStyle")}</span>
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger asChild>
        <button ref={triggerRef} type="button" className="avatar-style-trigger" disabled={disabled}
          aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="dialog"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); changeOpen(true); }
          }}>
          <span id={`${id}-value`}>{selected}</span><ChevronDown size={14} aria-hidden />
        </button>
      </Popover.Trigger>
      {/* Keep keyboard focus inside the owning dialog's focus trap. */}
      <Popover.Portal container={triggerRef.current?.closest<HTMLElement>('[role="dialog"]')}>
        <Popover.Content className="avatar-style-popover" align="start" side="bottom" sideOffset={6} collisionPadding={12}
          aria-labelledby={`${id}-label`}
          onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus({ preventScroll: true }); scrollActiveIntoView(); }}>
          <div className="avatar-style-search"><Search size={14} aria-hidden />
            <input ref={inputRef} role="combobox" aria-label={t("account.avatarSearch")} placeholder={t("account.avatarSearch")}
              autoComplete="off" spellCheck={false} value={query} aria-autocomplete="list" aria-expanded={open}
              aria-controls={`${id}-list`} aria-activedescendant={filtered[active] ? `${id}-option-${active}` : undefined}
              onChange={(event) => { setQuery(event.target.value); setActive(0); }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setActive((index) => filtered.length ? (index + step + filtered.length) % filtered.length : 0);
                } else if (event.key === "Enter") { event.preventDefault(); choose(active); }
              }} />
          </div>
          <div ref={listRef} id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`} className="avatar-style-options">
            {filtered.map((option, index) => <button key={option.value ?? "initial"} type="button" role="option" tabIndex={-1}
              id={`${id}-option-${index}`} data-index={index} data-active={index === active || undefined}
              aria-selected={option.value === value} onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setActive(index)} onClick={() => choose(index)}>
              <span>{option.name}</span>{option.value === value && <Check size={14} aria-hidden />}
            </button>)}
          </div>
          {filtered.length === 0 && <p className="avatar-style-empty" role="status">{t("account.avatarNoMatches")}</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>;
}
