import { Facet, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";

interface VimHistoryCommands {
  undo: () => boolean;
  redo: () => boolean;
}

const noVimHistoryCommands: VimHistoryCommands = { undo: () => false, redo: () => false };
const vimHistoryCommands = Facet.define<VimHistoryCommands, VimHistoryCommands>({
  combine: (values) => values.at(-1) ?? noVimHistoryCommands
});

// Module initialization runs once. Each editor supplies its own history
// commands through a facet, never through mutable global user/project state.
Vim.defineAction("texliteUndo", (cm) => {
  if (!cm.cm6.state.facet(vimHistoryCommands).undo()) cm.execCommand("undo");
});
Vim.defineAction("texliteRedo", (cm) => {
  if (!cm.cm6.state.facet(vimHistoryCommands).redo()) cm.execCommand("redo");
});
Vim.mapCommand("u", "action", "texliteUndo", {}, { context: "normal" });
Vim.mapCommand("<C-r>", "action", "texliteRedo", {}, { context: "normal" });

export function createVimExtension(historyCommands?: VimHistoryCommands): Extension {
  return [historyCommands ? vimHistoryCommands.of(historyCommands) : [], vim()];
}

export function watchVimStatus(editor: EditorView, onChange: (mode: string) => void): () => void {
  const cm = getCM(editor);
  if (!cm) return () => {};
  const update = () => {
    const mode = cm.state.vim?.mode ?? (cm.state.vim?.insertMode ? "insert" : "normal");
    onChange(mode.toUpperCase());
  };
  update();
  cm.on("vim-mode-change", update);
  return () => cm.off("vim-mode-change", update);
}
