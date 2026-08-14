export type EditorFont = "jetbrains" | "source-code" | "ibm-plex" | "fira-code" | "iosevka";

export interface EditorPreferences {
  font: EditorFont;
  fontSize: number;
  lineHeight: number;
  lineWrapping: boolean;
  spellCheck: boolean;
  vimMode: boolean;
  formatOnCompile: boolean;
}

export const editorFonts: Array<{ id: EditorFont; labelKey: string; stack: string }> = [
  { id: "jetbrains", labelKey: "projectSettings.fontJetBrains", stack: '"JetBrains Mono", ui-monospace, monospace' },
  { id: "source-code", labelKey: "projectSettings.fontSourceCode", stack: '"Source Code Pro", ui-monospace, monospace' },
  { id: "ibm-plex", labelKey: "projectSettings.fontIbmPlex", stack: '"IBM Plex Mono", ui-monospace, monospace' },
  { id: "fira-code", labelKey: "projectSettings.fontFiraCode", stack: '"Fira Code", ui-monospace, monospace' },
  { id: "iosevka", labelKey: "projectSettings.fontIosevka", stack: '"Iosevka", ui-monospace, monospace' }
];

export const defaultEditorPreferences: EditorPreferences = {
  font: "jetbrains",
  fontSize: 14,
  lineHeight: 1.65,
  lineWrapping: true,
  spellCheck: true,
  vimMode: false,
  formatOnCompile: false
};

const storageKeyPrefix = "texlite-editor-preferences";

function storageKey(userId: string, projectId: string): string {
  return `${storageKeyPrefix}:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`;
}

export function editorFontStack(font: EditorFont): string {
  return editorFonts.find((option) => option.id === font)?.stack ?? editorFonts[0].stack;
}

export function loadEditorPreferences(userId: string, projectId: string): EditorPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey(userId, projectId)) ?? "{}") as Partial<EditorPreferences>;
    return {
      font: editorFonts.some((option) => option.id === stored.font) ? stored.font! : defaultEditorPreferences.font,
      fontSize: [12, 13, 14, 15, 16, 18, 20].includes(Number(stored.fontSize)) ? Number(stored.fontSize) : defaultEditorPreferences.fontSize,
      lineHeight: [1.45, 1.65, 1.85].includes(Number(stored.lineHeight)) ? Number(stored.lineHeight) : defaultEditorPreferences.lineHeight,
      lineWrapping: typeof stored.lineWrapping === "boolean" ? stored.lineWrapping : defaultEditorPreferences.lineWrapping,
      spellCheck: typeof stored.spellCheck === "boolean" ? stored.spellCheck : defaultEditorPreferences.spellCheck,
      vimMode: typeof stored.vimMode === "boolean" ? stored.vimMode : defaultEditorPreferences.vimMode,
      formatOnCompile: typeof stored.formatOnCompile === "boolean" ? stored.formatOnCompile : defaultEditorPreferences.formatOnCompile
    };
  } catch {
    return defaultEditorPreferences;
  }
}

export function saveEditorPreferences(userId: string, projectId: string, preferences: EditorPreferences): void {
  localStorage.setItem(storageKey(userId, projectId), JSON.stringify(preferences));
}
