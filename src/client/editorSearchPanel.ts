import type { TFunction } from "i18next";
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery,
  replaceAll, replaceNext, selectMatches, setSearchQuery
} from "@codemirror/search";
import { countSearchMatches, currentSearchMatch, searchQuerySignature } from "./editorSearch";

// Lucide's official SVG paths (ISC, see THIRD_PARTY_NOTICES.md). This native
// CodeMirror panel must expose its main field synchronously, without a React root.
const iconPaths = {
  down: ["m6 9 6 6 6-6"], up: ["m18 15-6-6-6 6"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  close: ["M18 6 6 18", "m6 6 12 12"],
  replace: ["M14 4a1 1 0 0 1 1-1", "M15 10a1 1 0 0 1-1-1", "M21 4a1 1 0 0 0-1-1", "M21 9a1 1 0 0 1-1 1", "m3 7 3 3 3-3", "M6 10V5a2 2 0 0 1 2-2h2"],
  replaceAll: ["M14 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1", "M19 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1"]
};

function icon(doc: Document, name: keyof typeof iconPaths): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  for (const d of name === "replaceAll" ? [...iconPaths.replace, ...iconPaths.replaceAll] : iconPaths[name]) {
    const path = doc.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  if (name === "replace" || name === "replaceAll") {
    const rect = doc.createElementNS(svg.namespaceURI, "rect");
    for (const [key, value] of Object.entries({ x: "3", y: "14", width: "7", height: "7", rx: "1" })) rect.setAttribute(key, value);
    svg.append(rect);
  }
  return svg;
}

export function createEditorSearchPanel(t: TFunction): (view: EditorView) => Panel {
  return view => new CompactSearchPanel(view, t);
}

class CompactSearchPanel implements Panel {
  readonly dom: HTMLDivElement;
  readonly top = true;
  readonly pos = 80;
  private readonly doc: Document;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly searchBox: HTMLDivElement;
  private readonly status: HTMLSpanElement;
  private readonly replaceRow: HTMLDivElement;
  private readonly toggleReplace: HTMLButtonElement;
  private readonly options: HTMLButtonElement[];
  private readonly actions: HTMLButtonElement[];
  private readonly replaceActions: HTMLButtonElement[];
  private readonly menuButton: HTMLButtonElement;
  private readonly menu: HTMLDivElement;
  private readonly selectAll: HTMLButtonElement;
  private query: SearchQuery;
  private countedDoc: EditorView["state"]["doc"] | null = null;
  private signature = "";
  private count = 0;

  constructor(private readonly view: EditorView, private readonly t: TFunction) {
    this.doc = view.dom.ownerDocument;
    this.query = getSearchQuery(view.state);
    this.dom = this.element("div", "cm-search cm-compact-search");
    const layout = this.element("div", "cm-search-layout");
    this.searchField = this.input("search", "find");
    this.searchField.setAttribute("main-field", "true");
    this.replaceField = this.input("replace", "replace");
    this.searchBox = this.element("div", "cm-search-box");
    const tools = this.element("div", "cm-search-tools");
    this.options = ([ ["caseSensitive", "Aa", "matchCase"], ["regexp", ".*", "regexp"], ["wholeWord", "ab", "wholeWord"] ] as const).map(([option, text, key]) => {
      const button = this.button(option, t(`editor.search.${key}`), () => {
        this.commit({ [option]: !this.query[option] });
      });
      button.textContent = text;
      tools.append(button);
      return button;
    });
    this.status = this.element("span", "cm-search-count");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    tools.append(this.status);
    this.searchBox.append(this.searchField, tools);
    this.toggleReplace = this.button("toggleReplace", "", () => this.showReplace(this.replaceRow.hidden));
    this.toggleReplace.append(icon(this.doc, "down"));
    this.toggleReplace.hidden = view.state.readOnly;
    const navigation = this.element("div", "cm-search-actions");
    this.actions = [
      this.iconButton("prev", t("editor.search.previous"), "up", () => findPrevious(view), "Shift+Enter"),
      this.iconButton("next", t("editor.search.next"), "down", () => findNext(view), "Enter")
    ];
    this.menuButton = this.iconButton("more", t("editor.search.more"), "more", () => this.showMenu(this.menu.hidden));
    this.menuButton.setAttribute("aria-haspopup", "menu");
    this.menu = this.element("div", "cm-search-menu");
    this.menu.hidden = true;
    this.menu.setAttribute("role", "menu");
    this.menuButton.setAttribute("aria-expanded", "false");
    this.selectAll = this.button("select", t("editor.search.all"), () => { this.showMenu(false); selectMatches(view); view.focus(); });
    this.selectAll.textContent = t("editor.search.all");
    this.selectAll.setAttribute("role", "menuitem");
    this.menu.append(this.selectAll);
    const menuAnchor = this.element("div", "cm-search-menu-anchor");
    menuAnchor.append(this.menuButton, this.menu);
    navigation.append(...this.actions, menuAnchor);
    const close = this.iconButton("close", t("common.close"), "close", () => closeSearchPanel(view), "Escape");
    this.replaceRow = this.element("div", "cm-search-replace-row");
    const replacement = this.element("div", "cm-search-box cm-replace-box");
    replacement.append(this.replaceField);
    const replacementActions = this.element("div", "cm-search-actions");
    this.replaceActions = [
      this.iconButton("replace", t("editor.search.replaceNext"), "replace", () => replaceNext(view), "Enter"),
      this.iconButton("replaceAll", t("editor.search.replaceAll"), "replaceAll", () => replaceAll(view))
    ];
    replacementActions.append(...this.replaceActions);
    this.replaceRow.append(replacement, replacementActions);
    layout.append(this.toggleReplace, this.searchBox, navigation, close, this.replaceRow);
    this.dom.append(layout);
    this.showReplace(!view.state.readOnly);
    this.dom.addEventListener("keydown", this.keydown);
    this.doc.addEventListener("pointerdown", this.outsideMenu);
    this.doc.addEventListener("focusin", this.outsideMenu);
    this.refresh();
  }

  mount(): void { this.searchField.focus(); this.searchField.select(); }
  destroy(): void {
    this.doc.removeEventListener("pointerdown", this.outsideMenu);
    this.doc.removeEventListener("focusin", this.outsideMenu);
  }
  update(update: ViewUpdate): void {
    const query = getSearchQuery(update.state);
    if (!query.eq(this.query) || update.docChanged || update.selectionSet) this.refresh();
  }

  private element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
    const element = this.doc.createElement(tag);
    element.className = className;
    return element;
  }
  private input(name: string, key: string): HTMLInputElement {
    const field = this.element("input", "cm-textfield");
    field.name = name;
    field.placeholder = this.t(`editor.search.${key}`);
    field.setAttribute("aria-label", field.placeholder);
    field.setAttribute("form", "");
    field.autocomplete = "off";
    field.spellcheck = false;
    field.addEventListener("input", () => this.commit());
    return field;
  }
  private button(name: string, label: string, click: () => void): HTMLButtonElement {
    const button = this.element("button", "cm-search-icon");
    button.type = "button";
    button.name = name;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", click);
    return button;
  }
  private iconButton(name: string, label: string, glyph: keyof typeof iconPaths, click: () => void, shortcut?: string): HTMLButtonElement {
    const button = this.button(name, label, click);
    if (shortcut) button.title = `${label} (${shortcut})`;
    button.append(icon(this.doc, glyph));
    return button;
  }
  private commit(options: Partial<Pick<SearchQuery, "caseSensitive" | "regexp" | "wholeWord">> = {}): void {
    const { caseSensitive, regexp, wholeWord, literal } = this.query;
    const query = new SearchQuery({ caseSensitive, regexp, wholeWord, literal,
      search: this.searchField.value, replace: this.replaceField.value, ...options });
    if (!query.eq(this.query)) this.view.dispatch({ effects: setSearchQuery.of(query) });
  }
  private refresh(): void {
    this.query = getSearchQuery(this.view.state);
    if (this.searchField.value !== this.query.search) this.searchField.value = this.query.search;
    if (this.replaceField.value !== this.query.replace) this.replaceField.value = this.query.replace;
    this.options.forEach((button, index) => button.setAttribute("aria-pressed", String(this.query[(["caseSensitive", "regexp", "wholeWord"] as const)[index]!])));
    const signature = searchQuerySignature(this.query);
    if (signature !== this.signature || this.countedDoc !== this.view.state.doc) {
      this.signature = signature;
      this.countedDoc = this.view.state.doc;
      this.count = countSearchMatches(this.view.state, this.query);
    }
    const error = !!this.query.search && (!this.query.valid || !this.count);
    this.searchBox.classList.toggle("cm-search-error", error);
    this.searchField.setAttribute("aria-invalid", String(error));
    const current = this.count ? currentSearchMatch(this.view.state, this.query) : 0;
    this.status.textContent = !this.query.search ? "" : !this.query.valid ? this.t("editor.search.invalidQuery")
      : !this.count ? this.t("editor.search.noMatches") : `${current} / ${this.count}`;
    this.status.setAttribute("aria-label", !this.count ? this.status.textContent
      : `${this.t("editor.search.currentMatch")} ${current}, ${this.t("editor.search.matchCount", { count: this.count })}`);
    [...this.actions, this.selectAll].forEach(button => { button.disabled = !this.count; });
    // Literal, case-sensitive identical replacement cannot change the source.
    const unchanged = !this.query.regexp && this.query.caseSensitive && this.query.search === this.query.replace;
    this.replaceActions.forEach(button => { button.disabled = !this.count || unchanged || this.view.state.readOnly; });
  }
  private showReplace(show: boolean): void {
    this.replaceRow.hidden = !show;
    this.toggleReplace.setAttribute("aria-expanded", String(show));
    this.toggleReplace.title = this.t(show ? "editor.search.hideReplace" : "editor.search.showReplace");
    this.toggleReplace.setAttribute("aria-label", this.toggleReplace.title);
    this.view.requestMeasure();
  }
  private showMenu(show: boolean): void {
    this.menu.hidden = !show;
    this.menuButton.setAttribute("aria-expanded", String(show));
    if (show) this.selectAll.focus();
  }
  private outsideMenu = (event: Event): void => {
    if (!this.menu.hidden && !this.menu.parentElement?.contains(event.target as Node)) this.showMenu(false);
  };
  private keydown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (!this.menu.hidden && event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); this.showMenu(false); this.menuButton.focus();
    } else if (event.target === this.menuButton && event.key === "ArrowDown") {
      event.preventDefault(); this.showMenu(true);
    } else if (runScopeHandlers(this.view, event, "search-panel")) event.preventDefault();
    else if (event.key === "Enter" && event.target === this.searchField) {
      event.preventDefault(); (event.shiftKey ? findPrevious : findNext)(this.view);
    } else if (event.key === "Enter" && event.target === this.replaceField) {
      event.preventDefault(); if (!this.replaceActions[0]!.disabled) replaceNext(this.view);
    }
  };
}
