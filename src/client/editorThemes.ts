/** Syntax and editor controls, selected by the browser-wide theme preference. */
export type EditorTheme = "light" | "dark";

// Keep the existing light colors, including CodeMirror's BibTeX/BST colors.
const light = {
  ink: "#1F2328", "editor-bg": "#FFFFFF", cmd: "#1F55C4",
  structure: "#0B7A5E", env: "#0B7A5E", math: "#6D28D9", key: "#096B75",
  "key-highlight": "#0B5E68",
  task: "#9A5B00", special: "#B0307A", comment: "#6B7280", bracket: "#6B7280", "comment-selected": "#6B7280", "literal-bg": "#F4F5F6",
  gutter: "#9CA3AF", "gutter-active": "#4B5563", "active-line": "#69A5D71A",
  "match-bg": "#BDE5D8", "match-fg": "#075940", "selection-bg": "#C8DCF0", "selection-inactive-bg": "#C8DCF0",
  "search-bg": "#F4C5534D", "search-fg": "#4A3106", "search-active-bg": "#F4C152", "search-active-fg": "#3B2502", "search-outline": "#C27D0E",
  error: "#D92D20", warning: "#C77700", hint: "#5B7C99", cursor: "#1F2328",
  "code-meta": "#404740", "code-keyword": "#708", "code-atom": "#219",
  "code-literal": "#164", "code-string": "#A11", "code-escape": "#E40",
  "code-definition": "#00F", "code-local": "#30A", "code-type": "#085",
  "code-class": "#167", "code-macro": "#256", "code-property": "#00C",
  "code-comment": "#940", "code-invalid": "#F00",
  "bib-command": "#176B8F", "bib-protected": "#8A5A16",
  "agent-change": "#7C4DCC",
  "panel-bg": "#F7F9F7", "panel-fg": "#35443A", "panel-muted": "#59665D",
  border: "#CCD5CF", "input-bg": "#FFFFFF", "input-fg": "#202B24",
  "input-border": "#BCC8C0", "control-border": "#BDC8C0", "control-fg": "#31513D",
  "hover-border": "#7C9F89", "hover-bg": "#E9F1EC", "hover-fg": "#244D36",
  focus: "#3D8A60", "focus-ring": "#3D8A6025", accent: "#176B44",
  "muted-fg": "#647069", "close-hover-bg": "#E3E9E5", "secondary-fg": "#506057",
  "vim-bg": "#F1F6F2", "vim-fg": "#31523E", "vim-border": "#CBD8CE",
  "spell-active-bg": "#F6D66F", "spell-active-border": "#C99324", "spell-active-fg": "#3F3010", "spell-active-line": "#9B6715",
  "tooltip-bg": "#FFFFFF", "tooltip-fg": "#1D3025", "tooltip-border": "#BFD0C3",
  "tooltip-muted": "#607067", "tooltip-detail": "#58685E", "tooltip-separator": "#E2E8E3",
  "tooltip-example-bg": "#F3F7F4", "tooltip-shadow": "#1B34261F",
  "tooltip-action": "#214F37", "tooltip-hover-border": "#A9C9B3", "tooltip-hover-bg": "#EDF6EF", "tooltip-disabled": "#78847D",
  "completion-bg": "#F5F5F5", "completion-border": "#BBBBBB", "completion-active-bg": "#17C", "completion-active-fg": "#FFFFFF",
  "comment-bg": "#FFE49B99", "comment-border": "#D68B00", "comment-hover-bg": "#FFE49B", "comment-hover-fg": "#965E00",
  "selection-action-bg": "#E1F2E7", "selection-action-fg": "#12653D", "selection-action-hover-bg": "#CDEBD6", "selection-action-hover-fg": "#0B532F",
  "history-action-bg": "#E7EDF6", "history-action-fg": "#385F89", "history-action-hover-bg": "#D4E2F2", "history-action-hover-fg": "#274D75",
  "reference-bg": "#FFFFFF"
} as const;

export type EditorPalette = { readonly [Key in keyof typeof light]: string };

// Harmonized pine-charcoal dark surfaces with clear prose/comments and
// TexLite's semantic color families (not inverted light colors).
const dark: EditorPalette = {
  ink: "#DDE2DF", "editor-bg": "#222827", cmd: "#9CC6F4",
  structure: "#90D5B2", env: "#90D5B2", math: "#D5B5F7", key: "#5BC5CC",
  "key-highlight": "#8EE2E8",
  task: "#E8C27D", special: "#EDB1D1", comment: "#8D9A95", bracket: "#BCC7C2", "comment-selected": "#C4CFCA", "literal-bg": "#2A3130",
  gutter: "#6D7A75", "gutter-active": "#DDE2DF", "active-line": "#82C7AF16",
  "match-bg": "#274B40", "match-fg": "#BDEED8", "selection-bg": "#364F65", "selection-inactive-bg": "#343E3C",
  "search-bg": "#E5B45448", "search-fg": "#FBF0D9", "search-active-bg": "#E5B454", "search-active-fg": "#261904", "search-outline": "#F2CF7E",
  error: "#F4ACA2", warning: "#E8B66E", hint: "#8FB8D9", cursor: "#B8E3CE",
  "code-meta": "#BFC9C4", "code-keyword": "#D5B5F7", "code-atom": "#A2C4FB",
  "code-literal": "#A6D189", "code-string": "#A6D189", "code-escape": "#E7BA87",
  "code-definition": "#9CC6F4", "code-local": "#CAB9F5", "code-type": "#90D5B2",
  "code-class": "#87CDD9", "code-macro": "#9CC6F4", "code-property": "#9CC6F4",
  "code-comment": "#8D9A95", "code-invalid": "#F8B0AA",
  "bib-command": "#87CDD9", "bib-protected": "#E8C27D",
  "agent-change": "#C3A6F5",
  "panel-bg": "#1E2423", "panel-fg": "#DDE2DF", "panel-muted": "#ABB7B1",
  border: "#3F4B49", "input-bg": "#2A3130", "input-fg": "#E4EAE7",
  "input-border": "#52615E", "control-border": "#52615E", "control-fg": "#C6DCD0",
  "hover-border": "#7BAF9A", "hover-bg": "#2F433C", "hover-fg": "#D7F3E4",
  focus: "#82C7AF", "focus-ring": "#82C7AF30", accent: "#90D5B2",
  "muted-fg": "#ABB7B1", "close-hover-bg": "#36413F", "secondary-fg": "#B8C4BE",
  "vim-bg": "#1F2826", "vim-fg": "#A9D6C1", "vim-border": "#3F4B49",
  "spell-active-bg": "#E8C27D", "spell-active-border": "#F2D9A0", "spell-active-fg": "#222827", "spell-active-line": "#6A4512",
  "tooltip-bg": "#2A3130", "tooltip-fg": "#E4EAE7", "tooltip-border": "#52615E",
  "tooltip-muted": "#ABB7B1", "tooltip-detail": "#BAC6C0", "tooltip-separator": "#434F4D",
  "tooltip-example-bg": "#202625", "tooltip-shadow": "#00000048",
  "tooltip-action": "#A9D6C1", "tooltip-hover-border": "#7BAF9A", "tooltip-hover-bg": "#2F433C", "tooltip-disabled": "#93A19B",
  "completion-bg": "#2A3130", "completion-border": "#52615E", "completion-active-bg": "#2F4B40", "completion-active-fg": "#ECF7F1",
  "comment-bg": "#E8C27D1F", "comment-border": "#E8C27D", "comment-hover-bg": "#55472B", "comment-hover-fg": "#FFE2A3",
  "selection-action-bg": "#29463C", "selection-action-fg": "#BDEED8", "selection-action-hover-bg": "#33584A", "selection-action-hover-fg": "#E2FFF0",
  "history-action-bg": "#2B3E56", "history-action-fg": "#B6D3FA", "history-action-hover-bg": "#38506E", "history-action-hover-fg": "#E0EDFF",
  "reference-bg": "#222827"
};

export const editorPalettes: Readonly<Record<EditorTheme, EditorPalette>> = { light, dark };

function variables(palette: EditorPalette): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(palette).map(([name, value]) => [`--tl-${name}`, value]));
}

const paletteVariables = { light: variables(light), dark: variables(dark) };

export function editorThemeVariables(theme: EditorTheme): Readonly<Record<string, string>> {
  return paletteVariables[theme];
}
