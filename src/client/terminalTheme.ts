import type { ITheme } from "@xterm/xterm";
import type { CSSProperties } from "react";

/** Fixed, Catppuccin-inspired terminal colors, independent of the application theme. */
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

/** Share the same palette with padding, empty states and the font preview. */
export const terminalThemeStyle = {
  "--terminal-bg": terminalTheme.background,
  "--terminal-fg": terminalTheme.foreground,
  "--terminal-border": terminalTheme.black,
  "--terminal-muted": terminalTheme.brightBlack,
  "--terminal-green": terminalTheme.green,
  "--terminal-blue": terminalTheme.blue,
  "--terminal-purple": terminalTheme.magenta
} as CSSProperties;
