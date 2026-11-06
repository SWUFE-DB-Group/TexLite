import { useRef, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Info, type LucideIcon } from "lucide-react";

/** Persistent, selectable help text. Unlike hover hints, this is an explicit toggle. */
type InfoPopoverProps = { className?: string; icon?: LucideIcon; size?: number } & (
  { content: string; label?: string } | { content: ReactNode; label: string }
);

export function InfoPopover({ content, label = typeof content === "string" ? content : undefined, className = "", icon: Icon = Info, size = 14 }: InfoPopoverProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = trigger.current?.closest<HTMLElement>('[role="dialog"]') ?? null;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button ref={trigger} type="button" className={`info-popover-trigger ${className}`} aria-label={label}>
        <Icon size={size} aria-hidden="true" />
      </button>
    </Popover.Trigger>
    <Popover.Portal container={dialog ?? undefined}>
      <Popover.Content className="info-popover-content" side="top" sideOffset={7} collisionPadding={10} collisionBoundary={dialog} aria-label={label}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}>
        {typeof content === "string" ? <p>{content}</p> : content}
        <Popover.Arrow className="info-popover-arrow" width={10} height={5} />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
