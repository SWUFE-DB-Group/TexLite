import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, drawSelection, keymap, lineNumbers } from "@codemirror/view";
import { bracketMatching, foldGutter, foldKeymap, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { bibtexHighlightStyle, bibtexLanguage, bstLanguage, latexLanguage } from "../latexLanguage";
import { latexHighlightStyle, latexSemanticHighlighting } from "../latex/highlighting";
import { editorColorScheme, editorGenericHighlightStyle } from "../editorThemeExtension";
import { isLatexEditorFile, loadTextFileLanguage } from "../textLanguages";
import { useTheme } from "../theme";
import { defaultEditorPreferences, editorFontStack } from "../editorPreferences";

/** Reading only: no Yjs, completion requests, diagnostics or writing services. */
export function ReadOnlySource({ path, content, jumpTo, onCursor }: {
  path: string; content: string; jumpTo?: { line: number; nonce: number } | null;
  onCursor?: (line: number, column: number, offset: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const cursorCallback = useRef(onCursor); cursorCallback.current = onCursor;
  const theme = useTheme();
  useEffect(() => {
    if (!host.current) return;
    const language = new Compartment();
    const latex = isLatexEditorFile(path), bib = /\.(?:bib|bibtex)$/i.test(path), bst = /\.bst$/i.test(path);
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: content, extensions: [
      EditorState.readOnly.of(true), EditorView.editable.of(false), editorColorScheme(theme),
      EditorView.contentAttributes.of({ tabindex: "0", "aria-label": path }),
      lineNumbers(), foldGutter(), bracketMatching(), drawSelection(), EditorView.lineWrapping,
      search(), keymap.of([...searchKeymap, ...foldKeymap]),
      language.of(latex ? latexLanguage : bib ? bibtexLanguage : bst ? bstLanguage : []),
      ...(latex ? [syntaxHighlighting(latexHighlightStyle), latexSemanticHighlighting] : [syntaxHighlighting(editorGenericHighlightStyle)]),
      ...(bib ? [syntaxHighlighting(bibtexHighlightStyle)] : []),
      EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto", fontFamily: "inherit", lineHeight: "inherit" }, ".cm-content, .cm-gutters": { fontFamily: "inherit", fontSize: "inherit" } }),
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet) return;
        const offset = update.state.selection.main.head, line = update.state.doc.lineAt(offset);
        cursorCallback.current?.(line.number, offset - line.from + 1, offset);
      })
    ] }) });
    editor.current = view;
    cursorCallback.current?.(1, 1, 0);
    let disposed = false;
    if (!latex && !bib && !bst) void loadTextFileLanguage(path, content.split("\n", 1)[0])
      .then((support) => { if (!disposed) view.dispatch({ effects: language.reconfigure(support) }); })
      .catch(() => { /* Plain text remains readable when a language chunk cannot load. */ });
    return () => { disposed = true; editor.current = null; view.destroy(); };
  }, [path, content, theme]);
  useEffect(() => {
    const view = editor.current;
    if (!view || !jumpTo) return;
    const from = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, jumpTo.line))).from;
    view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
    view.focus();
  }, [jumpTo, path, content, theme]);
  return <div className="editor-shell" data-editor-theme={theme} style={{ fontFamily: editorFontStack(defaultEditorPreferences.font), fontSize: defaultEditorPreferences.fontSize, lineHeight: defaultEditorPreferences.lineHeight }}><div className="editor-host" ref={host} /></div>;
}
