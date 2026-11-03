import { EditorView } from "@codemirror/view";

/** The real citation form editor, shared by its controller integration tests. */
export function citationEditor(host: ParentNode): EditorView {
  const element = host.querySelector<HTMLElement>(".citation-bibtex-editor .cm-editor");
  const view = element && EditorView.findFromDOM(element);
  if (!view) throw new Error("Citation BibTeX editor has not mounted");
  return view;
}

export function replaceCitationBibtex(host: ParentNode, value: string): void {
  const view = citationEditor(host);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
}
