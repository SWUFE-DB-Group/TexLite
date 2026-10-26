import type { ITheme } from "@xterm/xterm";
import type { CSSProperties } from "react";

/** Original TexLite palette, kept unchanged as the browser's default. */
export const terminalTheme = {
  background: "#1e1e2e", foreground: "#cdd6f4",
  cursor: "#f5e0dc", cursorAccent: "#1e1e2e",
  selectionBackground: "#45475a", selectionForeground: "#cdd6f4", selectionInactiveBackground: "#313244",
  scrollbarSliderBackground: "#45475a", scrollbarSliderHoverBackground: "#585b70", scrollbarSliderActiveBackground: "#6c7086",
  black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
  blue: "#89b4fa", magenta: "#cba6f7", cyan: "#94e2d5", white: "#bac2de",
  brightBlack: "#9399b2", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af",
  brightBlue: "#89b4fa", brightMagenta: "#cba6f7", brightCyan: "#94e2d5", brightWhite: "#cdd6f4"
} satisfies ITheme;

// ANSI values follow the upstream terminal palettes; see THIRD_PARTY_NOTICES.md.
const catppuccinLatte = {
  background: "#eff1f5", foreground: "#4c4f69",
  cursor: "#4c4f69", cursorAccent: "#eff1f5",
  selectionBackground: "#ccd0da", selectionForeground: "#4c4f69", selectionInactiveBackground: "#e6e9ef",
  scrollbarSliderBackground: "#bcc0cc", scrollbarSliderHoverBackground: "#9ca0b0", scrollbarSliderActiveBackground: "#8c8fa1",
  black: "#5c5f77", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d",
  blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299", white: "#acb0be",
  brightBlack: "#acb0be", brightRed: "#d20f39", brightGreen: "#40a02b", brightYellow: "#df8e1d",
  brightBlue: "#1e66f5", brightMagenta: "#ea76cb", brightCyan: "#179299", brightWhite: "#bcc0cc"
} satisfies ITheme;

const gruvboxDark = {
  background: "#282828", foreground: "#ebdbb2",
  cursor: "#ebdbb2", cursorAccent: "#282828",
  selectionBackground: "#504945", selectionForeground: "#fbf1c7", selectionInactiveBackground: "#3c3836",
  scrollbarSliderBackground: "#504945", scrollbarSliderHoverBackground: "#665c54", scrollbarSliderActiveBackground: "#7c6f64",
  black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921",
  blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#a89984",
  brightBlack: "#928374", brightRed: "#fb4934", brightGreen: "#b8bb26", brightYellow: "#fabd2f",
  brightBlue: "#83a598", brightMagenta: "#d3869b", brightCyan: "#8ec07c", brightWhite: "#ebdbb2"
} satisfies ITheme;

export const terminalThemes = {
  default: {
    labelKey: "projectSettings.terminalThemeDefault", colorScheme: "dark", colors: terminalTheme, muted: terminalTheme.brightBlack,
    preview: { green: terminalTheme.brightGreen, blue: terminalTheme.brightBlue, purple: terminalTheme.brightMagenta }
  },
  "catppuccin-latte": {
    labelKey: "projectSettings.terminalThemeCatppuccin", colorScheme: "light", colors: catppuccinLatte, muted: "#5c5f77",
    // Slightly darker preview accents keep small text readable on Latte's pale base.
    preview: { green: "#2d7b20", blue: "#1b60e8", purple: "#8839ef" }
  },
  "gruvbox-dark": {
    labelKey: "projectSettings.terminalThemeGruvbox", colorScheme: "dark", colors: gruvboxDark, muted: "#a89984",
    preview: { green: gruvboxDark.brightGreen, blue: gruvboxDark.brightBlue, purple: gruvboxDark.brightMagenta }
  }
} as const;
export type TerminalThemeId = keyof typeof terminalThemes;

/** Share the selected palette with padding, empty states and the settings preview. */
export function terminalThemeStyle(theme: TerminalThemeId): CSSProperties {
  const { colors, muted, colorScheme, preview } = terminalThemes[theme];
  return {
    colorScheme,
    "--terminal-bg": colors.background,
    "--terminal-fg": colors.foreground,
    "--terminal-border": colors.scrollbarSliderBackground,
    // Classic ANSI bright-black can be deliberately dim; UI hints remain legible.
    "--terminal-muted": muted,
    "--terminal-green": preview.green,
    "--terminal-blue": preview.blue,
    "--terminal-purple": preview.purple
  } as CSSProperties;
}
