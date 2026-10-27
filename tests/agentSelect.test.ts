// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSelect } from "../src/client/agents/AgentSelect";
import { AGENT_IDS, AGENT_LABELS, type AgentId, type AgentInfo } from "../src/shared/agentProtocol";
import i18n from "../src/client/i18n";

let root: Root, host: HTMLDivElement, agents: AgentInfo[];
const onChange = vi.fn(), onSubmit = vi.fn();

function Form({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState<AgentId>("codex");
  return createElement("form", { onSubmit: (event) => { event.preventDefault(); onSubmit(); } },
    createElement(AgentSelect, { agents, value, disabled, onChange: (id) => { setValue(id); onChange(id); } }));
}
const key = (element: Element, value: string) => act(async () => {
  element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
});
const settleFocus = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  agents = AGENT_IDS.map((id) => ({ id, label: AGENT_LABELS[id], installed: true, enabled: true, version: "1.0.0" }));
  onChange.mockClear(); onSubmit.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("project terminal agent selection", () => {
  it("shows brand icons on the trigger and every option and selects by keyboard without submitting the form", async () => {
    await act(async () => root.render(createElement(Form)));
    const trigger = host.querySelector<HTMLButtonElement>(".agent-select-trigger")!;
    const firstIcon = trigger.querySelector(".agent-identity-icon path")!.getAttribute("d");
    expect(trigger.textContent).toBe("Codex");
    expect(trigger.getAttribute("aria-label")).toBe("Agent: Codex");
    await key(trigger, "ArrowDown"); await settleFocus();
    const options = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(options.map((option) => option.textContent)).toEqual(AGENT_IDS.map((id) => AGENT_LABELS[id]));
    expect(options.every((option) => option.querySelector('.agent-identity-icon[aria-hidden="true"]'))).toBe(true);
    expect(options.some((option) => option.hasAttribute("data-tooltip"))).toBe(false);
    expect(trigger.hasAttribute("data-tooltip")).toBe(false);
    expect(options[0].getAttribute("aria-checked")).toBe("true");
    // The portal escapes the terminal's clipped panel without trapping focus.
    expect(host.contains(document.querySelector(".agent-select-options"))).toBe(false);
    await key(document.activeElement!, "End"); await settleFocus();
    await key(document.activeElement!, "Enter"); await settleFocus();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("claude");
    expect(trigger.textContent).toBe("Claude Code");
    expect(trigger.querySelector(".agent-identity-icon path")!.getAttribute("d")).not.toBe(firstIcon);
    expect(trigger.getAttribute("aria-label")).toBe("Agent: Claude Code");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps missing and administrator-disabled agents visible but not selectable", async () => {
    agents[1].enabled = false;
    agents[2].installed = false;
    await act(async () => root.render(createElement(Form)));
    await key(host.querySelector(".agent-select-trigger")!, "ArrowDown"); await settleFocus();
    const options = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(options[1].getAttribute("aria-disabled")).toBe("true");
    expect(options[1].textContent).toContain(i18n.t("agents.disabled"));
    expect(options[2].getAttribute("aria-disabled")).toBe("true");
    expect(options[2].textContent).toContain(i18n.t("agents.notInstalled"));
    await act(async () => { options[1].click(); options[2].click(); });
    expect(onChange).not.toHaveBeenCalled();
    await key(document.activeElement!, "End"); await settleFocus();
    expect(document.activeElement).toBe(options[0]);
    expect(host.querySelector(".agent-select-trigger")?.textContent).toBe("Codex");
  });

  it("dismisses outside clicks and closes an open menu when the form becomes busy or read-only", async () => {
    await act(async () => root.render(createElement(Form)));
    const trigger = host.querySelector<HTMLButtonElement>(".agent-select-trigger")!;
    await key(trigger, "ArrowDown"); await settleFocus();
    await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await key(trigger, "ArrowDown"); await settleFocus();
    await act(async () => root.render(createElement(Form, { disabled: true })));
    expect(trigger.disabled).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled(); expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables the empty catalog rather than showing an empty menu", async () => {
    agents = [];
    await act(async () => root.render(createElement(Form)));
    const trigger = host.querySelector<HTMLButtonElement>(".agent-select-trigger")!;
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toBe("Agent");
    expect(trigger.querySelector(".agent-identity-icon")).toBeNull();
    await act(async () => trigger.click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
