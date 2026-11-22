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
    expect(document.querySelector(".quick-open-input-bar .lucide-chevron-right")).toBeNull();
    expect(commandsButton.textContent).not.toContain(">");
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

  it("tracks selected command by id and clears selection instead of executing the next command when it disappears", async () => {
    const onCompile = vi.fn();
    const onFormat = vi.fn();
    const onSearch = vi.fn();
    const allCommands: QuickOpenCommand[] = [
      { id: "compile", label: "Save and compile", onSelect: onCompile },
      { id: "format", label: "Format document", onSelect: onFormat },
      { id: "search", label: "Search project", onSelect: onSearch }
    ];
    const render = (commands: QuickOpenCommand[]) => act(async () => {
      root.render(createElement(QuickOpenDialog, {
        open: true, files, commands, initialMode: "commands", requestNonce: 1, onOpenChange: vi.fn(), onOpenFile: vi.fn()
      }));
    });

    await render(allCommands);
    const input = document.querySelector<HTMLInputElement>(".quick-open-dialog input")!;
    expect(document.querySelector(".quick-open-results button.active")?.textContent).toContain("Save and compile");

    // Collaborator starts compiling -> "compile" disappears while it was highlighted.
    await render(allCommands.slice(1));
    expect(document.querySelector(".quick-open-results button.active")).toBeNull();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onFormat).not.toHaveBeenCalled();
    expect(onCompile).not.toHaveBeenCalled();

    // Navigating explicitly with ArrowDown selects "format", and it stays selected even if another item is removed.
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.querySelector(".quick-open-results button.active")?.textContent).toContain("Format document");
    await render([allCommands[0], allCommands[1]]);
    expect(document.querySelector(".quick-open-results button.active")?.textContent).toContain("Format document");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onFormat).toHaveBeenCalledTimes(1);
  });

  it("re-enters command mode when requestNonce increments after clicking the Files button", async () => {
    const commands: QuickOpenCommand[] = [
      { id: "compile", label: "Save and compile", onSelect: vi.fn() }
    ];
    const render = (requestNonce: number) => act(async () => {
      root.render(createElement(QuickOpenDialog, {
        open: true, files, commands, initialMode: "commands", requestNonce, onOpenChange: vi.fn(), onOpenFile: vi.fn()
      }));
    });

    await render(1);
    const [filesButton, commandsButton] = [...document.querySelectorAll<HTMLButtonElement>(".quick-open-mode-switch button")];
    expect(commandsButton.getAttribute("aria-pressed")).toBe("true");
    await act(async () => filesButton.click());
    expect(filesButton.getAttribute("aria-pressed")).toBe("true");

    // Pressing Ctrl/Cmd+K again increments requestNonce even though initialMode is still "commands".
    await render(2);
    expect(commandsButton.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<HTMLInputElement>(".quick-open-dialog input")!.value).toBe("> ");
  });
});
