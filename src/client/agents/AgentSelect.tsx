import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentId, AgentInfo } from "../../shared/agentProtocol";
import { AgentIcon } from "./AgentIcon";

export function AgentSelect({ agents, value, onChange, disabled = false }: {
  agents: readonly AgentInfo[];
  value: AgentId | "";
  onChange: (id: AgentId) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = agents.find((agent) => agent.id === value);
  const unavailable = disabled || agents.length === 0;
  useEffect(() => { if (unavailable) setOpen(false); }, [unavailable]);

  return <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
    <DropdownMenu.Trigger asChild>
      <button ref={trigger} type="button" className="agent-select-trigger" disabled={unavailable}
        aria-label={selected ? `${t("agents.agent")}: ${selected.label}` : t("agents.agent")}>
        {selected && <AgentIcon agent={selected.id} size={16} />}
        <span>{selected?.label ?? t("agents.agent")}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal container={trigger.current?.closest<HTMLElement>('[role="dialog"]')}>
      <DropdownMenu.Content className="agent-select-options" side="top" align="start" sideOffset={5} collisionPadding={8}>
        <DropdownMenu.RadioGroup value={value} aria-label={t("agents.agent")} onValueChange={(next) => {
          const agent = agents.find((entry) => entry.id === next);
          if (!unavailable && agent?.installed && agent.enabled) onChange(agent.id);
        }}>
          {agents.map((agent) => <DropdownMenu.RadioItem key={agent.id} value={agent.id} textValue={agent.label}
            className="agent-select-option" disabled={unavailable || !agent.installed || !agent.enabled}>
            <AgentIcon agent={agent.id} size={16} />
            <span className="agent-select-label">{agent.label}
              {(!agent.installed || !agent.enabled) && <small>{t(!agent.installed ? "agents.notInstalled" : "agents.disabled")}</small>}
            </span>
            <DropdownMenu.ItemIndicator className="agent-select-check"><Check size={14} aria-hidden="true" /></DropdownMenu.ItemIndicator>
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
