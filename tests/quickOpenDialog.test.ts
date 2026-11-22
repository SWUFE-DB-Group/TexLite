// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickOpenDialog, type QuickOpenCommand } from "../src/client/QuickOpenDialog";
import i18n from "../src/client/i18n";

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function setInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("QuickOpenDialog command mode", () => {
  const files = [
    { path: "main.tex", type: "file" as const },
    { path: "sections/intro.tex", type: "file" as const }
  ];

  it("opens matching files by default and switches to command mode with '>' or the toggle button", async () => {
    const onOpenFile = vi.fn();
    const onOpenChange = vi.fn();
    const onCompile = vi.fn();
    const onTheme = vi.fn();
    const commands: QuickOpenCommand[] = [
      { id: "compile", label: "Save and compile", keywords: "build pdf", shortcut: "Ctrl+S", onSelect: onCompile },
      { id: "theme", label: "Switch to dark theme", keywords: "appearance", onSelect: onTheme }
    ];

    await act(async () => {
      root.render(createElement(QuickOpenDialog, { open: true, files, commands, onOpenChange, onOpenFile }));
    });

    const input = document.querySelector<HTMLInputElement>(".quick-open-dialog input")!;
    expect(document.querySelectorAll(".quick-open-results button")).toHaveLength(2);

    await act(async () => {
      setInput(input, "> dark");
    });
    const commandButtons = [...document.querySelectorAll<HTMLButtonElement>(".quick-open-results button")];
    expect(commandButtons).toHaveLength(1);
    expect(commandButtons[0].textContent).toContain("Switch to dark theme");

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onTheme).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenFile).not.toHaveBeenCalled();

    // Switching via the segmented mode buttons toggles cleanly between Files and Commands.
    const [filesButton, commandsButton] = [...document.querySelectorAll<HTMLButtonElement>(".quick-open-mode-switch button")];
    expect(filesButton.getAttribute("aria-pressed")).toBe("false");
    expect(commandsButton.getAttribute("aria-pressed")).toBe("true");
    await act(async () => filesButton.click());
    expect(filesButton.getAttribute("aria-pressed")).toBe("true");
    expect(commandsButton.getAttribute("aria-pressed")).toBe("false");
    expect(input.value).toBe("dark");
    await act(async () => commandsButton.click());
    expect(filesButton.getAttribute("aria-pressed")).toBe("false");
    expect(commandsButton.getAttribute("aria-pressed")).toBe("true");
    expect(input.value).toBe("> dark");

    // Shows shortcut kbd badge when command provides one.
    await act(async () => setInput(input, "> compile"));
    expect(document.querySelector(".quick-open-results kbd")?.textContent).toBe("Ctrl+S");
    await act(async () => document.querySelector<HTMLButtonElement>(".quick-open-results button")!.click());
    expect(onCompile).toHaveBeenCalledTimes(1);
  });

  it("opens directly in command mode when initialMode is 'commands' and can switch back to files", async () => {
    const onCompile = vi.fn();
    const commands: QuickOpenCommand[] = [
      { id: "compile", label: "Save and compile", shortcut: "Ctrl+S", onSelect: onCompile }
    ];

    await act(async () => {
      root.render(createElement(QuickOpenDialog, {
        open: true, files, commands, initialMode: "commands", onOpenChange: vi.fn(), onOpenFile: vi.fn()
      }));
    });

    const input = document.querySelector<HTMLInputElement>(".quick-open-dialog input")!;
    const [filesButton, commandsButton] = [...document.querySelectorAll<HTMLButtonElement>(".quick-open-mode-switch button")];
    expect(document.querySelector(".dialog-header h2")?.textContent).toBe("Command palette");
    expect(document.querySelector(".dialog-header p")?.textContent).toContain("Ctrl+K");
    expect(filesButton.querySelector("kbd")?.textContent).toBe("Ctrl+P");
    expect(commandsButton.querySelector("kbd")?.textContent).toBe("Ctrl+K");
    expect(input.value).toBe("> ");
    expect(commandsButton.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll(".quick-open-results button")).toHaveLength(1);
    expect(document.querySelector(".quick-open-results button")?.textContent).toContain("Save and compile");

    await act(async () => filesButton.click());
    expect(document.querySelector(".dialog-header h2")?.textContent).toBe("Quick open");
    expect(document.querySelector(".dialog-header p")?.textContent).toContain("Ctrl+P");
    expect(input.value).toBe("");
    expect(filesButton.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll(".quick-open-results button")).toHaveLength(2);
  });
});
