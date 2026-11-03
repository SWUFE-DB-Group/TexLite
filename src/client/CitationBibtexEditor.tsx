import { useEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers, placeholder as editorPlaceholder } from "@codemirror/view";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bibtexHighlightStyle, parser as bibtexLanguage } from "./bibtex/parser";
import { editorColorScheme, editorGenericHighlightStyle } from "./editorThemeExtension";
import { useTheme } from "./theme";

const externalValue = Annotation.define<boolean>();
// One style gives BibTeX's command/protected-group rules deterministic priority
// over generic tags, independent of other editors' stylesheet load order.
const highlightStyle = HighlightStyle.define([...editorGenericHighlightStyle.specs, ...bibtexHighlightStyle.specs]);

/** Local form input only: no collaboration, requests, lint or writing checks. */
export default function CitationBibtexEditor({ value, onChange, disabled = false, autoFocus = false, active = true, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  active?: boolean;
  placeholder: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const appearance = useRef(new Compartment());
  const input = useRef(new Compartment());
  const changed = useRef(onChange); changed.current = onChange;
  const theme = useTheme();

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: value, extensions: [
      bibtexLanguage, syntaxHighlighting(highlightStyle),
      bracketMatching(), indentOnInput(), lineNumbers(), drawSelection(), history(),
      keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
      appearance.current.of(editorColorScheme(theme)), input.current.of(inputOptions(disabled, placeholder)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalValue))) {
          changed.current(update.state.doc.toString());
        }
      })
    ] }) });
    editor.current = view;
    if (autoFocus && active) view.focus();
    return () => { editor.current = null; view.destroy(); };
  }, []);

  useEffect(() => {
    const view = editor.current;
    if (view && value !== view.state.doc.toString()) view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: [externalValue.of(true), Transaction.addToHistory.of(false)]
    });
  }, [value]);
  useEffect(() => { editor.current?.dispatch({ effects: appearance.current.reconfigure(editorColorScheme(theme)) }); }, [theme]);
  useEffect(() => { editor.current?.dispatch({ effects: input.current.reconfigure(inputOptions(disabled, placeholder)) }); }, [disabled, placeholder]);
  useEffect(() => { if (active) editor.current?.requestMeasure(); }, [active]);

  return <div className="citation-bibtex-editor editor-host" data-editor-theme={theme} ref={host} />;
}

function inputOptions(disabled: boolean, placeholder: string) {
  return [EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled), editorPlaceholder(placeholder),
    EditorView.contentAttributes.of({ "aria-label": "BibTeX", spellcheck: "false", autocorrect: "off", autocapitalize: "off", autocomplete: "off" })];
}
