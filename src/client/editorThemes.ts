/** Syntax and editor controls, selected by the browser-wide theme preference. */
export type EditorTheme = "light" | "dark";

// Keep the existing light colors, including CodeMirror's BibTeX/BST colors.
const light = {
  ink: "#1F2328", "editor-bg": "#FFFFFF", cmd: "#1F55C4",
  structure: "#0B7A5E", env: "#0B7A5E", math: "#6D28D9", key: "#9A5B00",
  task: "#9A5B00", special: "#B0307A", comment: "#6B7280", "literal-bg": "#F4F5F6",
  gutter: "#9CA3AF", "gutter-active": "#4B5563", "active-line": "#69A5D71A",
  "match-bg": "#BDE5D8", "match-fg": "#075940", "selection-bg": "#C8DCF0", "selection-inactive-bg": "#C8DCF0",
  "search-bg": "#FFE9A8", "search-outline": "#D9A91C88",
  error: "#D92D20", warning: "#C77700", hint: "#5B7C99", cursor: "#1F2328",
  "code-meta": "#404740", "code-keyword": "#708", "code-atom": "#219",
  "code-literal": "#164", "code-string": "#A11", "code-escape": "#E40",
  "code-definition": "#00F", "code-local": "#30A", "code-type": "#085",
  "code-class": "#167", "code-macro": "#256", "code-property": "#00C",
  "code-comment": "#940", "code-invalid": "#F00",
  "bib-command": "#176B8F", "bib-protected": "#8A5A16",
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

// Inspired by One Dark's neutral blue-gray surfaces, with brighter prose and
// comments and TexLite's existing semantic color families (not inverted light colors).
const dark: EditorPalette = {
  ink: "#D7DAE0", "editor-bg": "#282C34", cmd: "#9CC6F4",
  structure: "#92CEB9", env: "#92CEB9", math: "#D5B5F7", key: "#E5C07B",
  task: "#E5C07B", special: "#EDB1D1", comment: "#BCC3CF", "literal-bg": "#303640",
  gutter: "#7D8799", "gutter-active": "#D7DAE0", "active-line": "#6699FF1C",
  "match-bg": "#294D44", "match-fg": "#BDEED8", "selection-bg": "#3B506D", "selection-inactive-bg": "#39414E",
  "search-bg": "#433C2A", "search-outline": "#C9A45E99",
  error: "#F28B82", warning: "#E5B06C", hint: "#8FB5D6", cursor: "#BDD6FF",
  "code-meta": "#BDC2CC", "code-keyword": "#D5B5F7", "code-atom": "#A2C4FB",
  "code-literal": "#A6D189", "code-string": "#A6D189", "code-escape": "#E7BA87",
  "code-definition": "#9CC6F4", "code-local": "#CAB9F5", "code-type": "#92CEB9",
  "code-class": "#87CDD9", "code-macro": "#9CC6F4", "code-property": "#9CC6F4",
  "code-comment": "#BCC3CF", "code-invalid": "#F8B0AA",
  "bib-command": "#87CDD9", "bib-protected": "#E5C07B",
  "panel-bg": "#242831", "panel-fg": "#D7DAE0", "panel-muted": "#ABB5C5",
  border: "#444C5A", "input-bg": "#303640", "input-fg": "#E0E4EC",
  "input-border": "#566174", "control-border": "#566174", "control-fg": "#C5D9CE",
  "hover-border": "#7BAF9A", "hover-bg": "#35463F", "hover-fg": "#D4F0E1",
  focus: "#82C7AF", "focus-ring": "#82C7AF30", accent: "#82C7AF",
  "muted-fg": "#ABB5C5", "close-hover-bg": "#3B4250", "secondary-fg": "#B7C3D3",
  "vim-bg": "#242B30", "vim-fg": "#A9D6C1", "vim-border": "#444C5A",
  "spell-active-bg": "#E5C07B", "spell-active-border": "#F2D9A0", "spell-active-fg": "#282C34", "spell-active-line": "#6A4512",
  "tooltip-bg": "#303640", "tooltip-fg": "#E0E4EC", "tooltip-border": "#566174",
  "tooltip-muted": "#ABB5C5", "tooltip-detail": "#BAC5D3", "tooltip-separator": "#485160",
  "tooltip-example-bg": "#262B33", "tooltip-shadow": "#00000040",
  "tooltip-action": "#A9D6C1", "tooltip-hover-border": "#7BAF9A", "tooltip-hover-bg": "#35463F", "tooltip-disabled": "#929EAE",
  "completion-bg": "#303640", "completion-border": "#566174", "completion-active-bg": "#3A4D69", "completion-active-fg": "#EDF3FF",
  "comment-bg": "#E5C07B1F", "comment-border": "#E5C07B", "comment-hover-bg": "#57482C", "comment-hover-fg": "#FFE2A3",
  "selection-action-bg": "#2C483E", "selection-action-fg": "#BDEED8", "selection-action-hover-bg": "#365B4C", "selection-action-hover-fg": "#E2FFF0",
  "history-action-bg": "#2E405A", "history-action-fg": "#B6D3FA", "history-action-hover-bg": "#3B5272", "history-action-hover-fg": "#E0EDFF",
  "reference-bg": "#282C34"
};

export const editorPalettes: Readonly<Record<EditorTheme, EditorPalette>> = { light, dark };

function variables(palette: EditorPalette): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(palette).map(([name, value]) => [`--tl-${name}`, value]));
}

const paletteVariables = { light: variables(light), dark: variables(dark) };

export function editorThemeVariables(theme: EditorTheme): Readonly<Record<string, string>> {
  return paletteVariables[theme];
}
