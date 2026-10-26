// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTerminalSurface } from "../src/client/agents/AgentTerminalSurface";
import { ProjectSettings } from "../src/client/workspace/ProjectSettings";
import { currentTerminalPreferences, defaultTerminalPreferences, saveTerminalPreferences } from "../src/client/terminalPreferences";
import { defaultEditorPreferences } from "../src/client/editorPreferences";
import type { AgentTask } from "../src/shared/agentProtocol";
import type { Project, SiteConfig } from "../src/client/types";

const mocks = vi.hoisted(() => ({ terms: [] as MockTerminal[], fits: [] as Array<{ fit: ReturnType<typeof vi.fn> }> }));
class MockTerminal {
  options: Record<string, unknown>;
  cols = 80; rows = 24;
  refresh = vi.fn(); reset = vi.fn(); write = vi.fn(); dispose = vi.fn(); focus = vi.fn();
  constructor(options: Record<string, unknown>) { this.options = options; mocks.terms.push(this); }
  loadAddon() {} open() {} attachCustomKeyEventHandler() {}
  onData() { return { dispose: vi.fn() }; }
  onResize() { return { dispose: vi.fn() }; }
}
vi.mock("@xterm/xterm", () => ({ Terminal: class { constructor(options: Record<string, unknown>) { return new MockTerminal(options); } } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); constructor() { mocks.fits.push(this); } } }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: "en" } })
}));
vi.mock("../src/client/theme", () => ({ useTheme: () => "light" }));
vi.mock("../src/client/api", () => ({ api: vi.fn(async () => ({ available: false, mainFiles: ["main.tex"] })) }));
vi.mock("../src/client/latexFormatter", () => ({ preloadTexFmt: vi.fn(async () => undefined), reloadTexFmt: vi.fn(async () => undefined) }));

class MockSocket {
  static OPEN = 1;
  static instances: MockSocket[] = [];
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  send = vi.fn(); close = vi.fn();
  constructor() { MockSocket.instances.push(this); }
}
const task: AgentTask = { id: "task", projectId: "paper", projectName: "Paper", userId: "writer", userName: "Writer",
  agentId: "codex", title: "Revise", state: "running", cleanupState: "none", errorCode: null, createdAt: "2026-10-26", updatedAt: "2026-10-26",
  startedAt: null, endedAt: null, exitCode: null, nativeSessionId: null, canResume: false };
let root: Root;
let container: HTMLDivElement;
let fontDescriptor: PropertyDescriptor | undefined;
let loadFont: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", MockSocket);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  saveTerminalPreferences(defaultTerminalPreferences);
  mocks.terms = []; mocks.fits = []; MockSocket.instances = [];
  loadFont = vi.fn(async () => []);
  fontDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: loadFont } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  if (fontDescriptor) Object.defineProperty(document, "fonts", fontDescriptor);
  else Reflect.deleteProperty(document, "fonts");
  vi.unstubAllGlobals();
});
const renderTerminal = () => act(async () => root.render(createElement(AgentTerminalSurface, { task, onTask: vi.fn() })));
function deferred() {
  let resolve!: (value: never[]) => void;
  const promise = new Promise<never[]>((yes) => { resolve = yes; });
  return { promise, resolve: () => resolve([]) };
}

describe("terminal appearance", () => {
  it("updates a running terminal without reconnecting or clearing its output", async () => {
    await renderTerminal();
    const term = mocks.terms[0];
    const ws = MockSocket.instances[0];
    await act(async () => { ws.onopen?.(); ws.onmessage?.({ data: JSON.stringify({ type: "output", data: "Existing output" }) }); });
    const resets = term.reset.mock.calls.length;
    await act(async () => saveTerminalPreferences({ font: "iosevka", fontSize: 16, lineHeight: 1.4 }));
    expect(term.options).toMatchObject({ fontSize: 16, lineHeight: 1.4 });
    expect(term.options.fontFamily).toContain("Iosevka");
    expect(mocks.terms).toHaveLength(1); expect(MockSocket.instances).toHaveLength(1);
    expect(term.reset).toHaveBeenCalledTimes(resets);
    expect(ws.close).not.toHaveBeenCalled();
    expect(term.write).toHaveBeenCalledWith("Existing output");
    expect(mocks.fits[0].fit).toHaveBeenCalled();
  });

  it("ignores obsolete font loads and delayed completion after unmount", async () => {
    await renderTerminal();
    const old = deferred(); const latest = deferred();
    loadFont.mockImplementation((font: string) => font.includes("Iosevka") ? old.promise : latest.promise);
    await act(async () => saveTerminalPreferences({ font: "iosevka", fontSize: 14, lineHeight: 1 }));
    await act(async () => saveTerminalPreferences({ font: "ibm-plex", fontSize: 15, lineHeight: 1.2 }));
    await act(async () => old.resolve());
    expect(mocks.terms[0].options.fontFamily).toContain("JetBrains");
    await act(async () => latest.resolve());
    expect(mocks.terms[0].options.fontFamily).toContain("IBM Plex");
    const pending = deferred(); loadFont.mockReturnValue(pending.promise);
    await act(async () => saveTerminalPreferences({ font: "fira-code", fontSize: 18, lineHeight: 1.4 }));
    await act(async () => root.unmount());
    const calls = mocks.fits[0].fit.mock.calls.length;
    await act(async () => pending.resolve());
    expect(mocks.fits[0].fit).toHaveBeenCalledTimes(calls);
    expect(mocks.terms[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("uses the normal font fallback when web-font loading fails", async () => {
    loadFont.mockRejectedValue(new Error("Offline"));
    await renderTerminal();
    expect(mocks.terms[0].options.fontFamily).toContain("monospace");
    expect(mocks.terms[0].options.fontSize).toBe(13);
    expect(MockSocket.instances).toHaveLength(1);
  });

  it("offers a separate settings tab and saves through the header without touching editor/compiler settings", async () => {
    const onEditorPreferences = vi.fn(); const onProject = vi.fn();
    const project: Project = { id: "paper", ownerId: "owner", lastModifiedBy: null, name: "Paper", mainFile: "main.tex", latexmkrc: null,
      engine: "xelatex", icon: null, chktexEnabled: false, permission: "read", tags: [], createdAt: "2026-10-26", updatedAt: "2026-10-26" };
    const site: SiteConfig = { siteName: "TexLite", adminEmail: "", basePath: "/", minPasswordLength: 8, maxCitationBibtexBytes: 10000,
      maxUploadSizeMB: 50, maxCollaborativeFileSizeMB: 3 };
    await act(async () => root.render(createElement(ProjectSettings, { project, projectId: "paper", site, files: [], dictionaryWords: [],
      editorPreferences: defaultEditorPreferences, onEditorPreferences, onDictionaryChange: vi.fn(), onProject, onClose: vi.fn(),
      spellCheckCount: null, spellCheckUniqueCount: null, spellCheckIndex: 0, onSpellCheckNavigate: vi.fn() })));
    await act(async () => container.querySelector<HTMLButtonElement>("#settings-tab-terminal")!.click());
    const panel = container.querySelector("#settings-panel-terminal")!;
    expect(panel).not.toBeNull();
    const selects = panel.querySelectorAll("select");
    expect(selects[0].options).toHaveLength(6);
    await act(async () => { selects[1].value = "18"; selects[1].dispatchEvent(new Event("change", { bubbles: true })); });
    expect(currentTerminalPreferences().fontSize).toBe(13);
    expect((panel.querySelector("pre") as HTMLElement).style.fontSize).toBe("18px");
    await act(async () => container.querySelector<HTMLButtonElement>(".drawer-settings-save")!.click());
    expect(currentTerminalPreferences().fontSize).toBe(18);
    expect(onEditorPreferences).not.toHaveBeenCalled(); expect(onProject).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>("#settings-tab-appearance")!.click());
    expect(container.querySelector("#settings-panel-appearance")).not.toBeNull();
  });
});
