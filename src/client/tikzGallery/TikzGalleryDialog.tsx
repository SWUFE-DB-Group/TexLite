import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./tikzGallery.css";
import { Modal } from "../Dialog";
import { isAbortError } from "../api";
import { errorMessage } from "../errors";
import { filterTikzGallery, loadTikzGallery, loadTikzGallerySource, localizedText, tikzCategoryLabel, tikzGalleryAsset, tikzGalleryDestination, type TikzGalleryCatalog, type TikzGalleryItem, type TikzGalleryType } from "./catalog";

const TYPES: TikzGalleryType[] = ["template", "example", "icon", "plot"];

interface TikzGalleryDialogProps {
  folder: string | null;
  onClose: () => void;
  /** Creates the file and opens it; rejects with a displayable error. */
  onImport: (path: string, content: string) => Promise<void>;
}

/** Browses the add-on's figures and copies one into the project as an ordinary source file. */
export function TikzGalleryDialog({ folder, onClose, onImport }: TikzGalleryDialogProps) {
  const { t, i18n } = useTranslation();
  const [catalog, setCatalog] = useState<TikzGalleryCatalog | null>(null);
  const items = catalog?.items ?? null;
  const categories = catalog?.categories ?? [];
  const attribution = catalog?.attribution?.url.startsWith("https://") ? catalog.attribution : null;
  const [loadError, setLoadError] = useState("");
  const [type, setType] = useState<TikzGalleryType>("template");
  const [chosenCategory, setChosenCategory] = useState<string | null>(null);
  const iconCategory = chosenCategory ?? categories[0]?.id ?? "";
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const [selected, setSelected] = useState<TikzGalleryItem | null>(null);
  const [destination, setDestination] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    loadTikzGallery(controller.signal).then(setCatalog).catch((error: unknown) => { if (!isAbortError(error)) setLoadError(errorMessage(error)); });
    return () => controller.abort();
  }, []);
  const visible = useMemo(() => filterTikzGallery(items ?? [], type, iconCategory, query), [items, type, iconCategory, query]);

  const select = (item: TikzGalleryItem) => {
    setSelected(item);
    setDestination(tikzGalleryDestination(item, folder));
    setImportError("");
  };
  const path = destination.trim();
  const canImport = Boolean(selected) && /[^/]\.tex$/i.test(path) && !importing;
  const importSelected = async () => {
    if (!selected || !canImport) return;
    setImporting(true);
    setImportError("");
    try {
      await onImport(path, await loadTikzGallerySource(selected));
      onClose();
    } catch (error) {
      setImportError(errorMessage(error));
      setImporting(false);
    }
  };

  return <Modal open extraWide title={t("gallery.title")} description={t("gallery.description")} onOpenChange={(open) => { if (!open) onClose(); }}
    footer={<form className="tikz-gallery-import" onSubmit={(event) => { event.preventDefault(); void importSelected(); }}>
      <label><span>{t("gallery.destination")}</span><input value={destination} disabled={!selected} spellCheck={false} onChange={(event) => { setDestination(event.target.value); setImportError(""); }} /></label>
      <button type="submit" className="primary" disabled={!canImport}>{importing && <LoaderCircle className="spin" size={14} aria-hidden />}{t("gallery.import")}</button>
    </form>}>
    <div className="tikz-gallery">
      <div className="tikz-gallery-toolbar">
        <div className="tikz-gallery-types tikz-gallery-tabs" role="group" aria-label={t("gallery.typeLabel")}>
          {TYPES.map((item) => <button key={item} type="button" aria-pressed={type === item} onClick={() => setType(item)}>{t(`gallery.types.${item}`)}</button>)}
        </div>
        {type === "icon" && <div className="tikz-gallery-types tikz-gallery-categories" role="group" aria-label={t("gallery.categoryLabel")}>
          {categories.map((item) => <button key={item.id} type="button" aria-pressed={!searching && iconCategory === item.id} onClick={() => { setChosenCategory(item.id); setQuery(""); }}>{tikzCategoryLabel(item, i18n.resolvedLanguage)}</button>)}
        </div>}
        <label className="tikz-gallery-search"><Search size={14} aria-hidden /><input value={query} autoFocus placeholder={t("gallery.search")} aria-label={t("gallery.search")} onChange={(event) => setQuery(event.target.value)} /></label>
      </div>
      <div className="tikz-gallery-main">
        <div className={`tikz-gallery-grid${type === "icon" ? " tikz-gallery-grid-icons" : ""}`}>
          {loadError ? <p className="tikz-gallery-state" role="alert">{loadError}</p>
            : !items ? <p className="tikz-gallery-state" role="status"><LoaderCircle className="spin" size={16} aria-hidden />{t("common.loading")}</p>
              : !visible.length ? <p className="tikz-gallery-state">{t("gallery.empty")}</p>
                : visible.map((item) => <button key={item.tex} type="button" className="tikz-gallery-card" aria-pressed={selected?.tex === item.tex} title={item.name} onClick={() => select(item)}>
                  <span className="tikz-gallery-preview"><img src={tikzGalleryAsset(item.preview)} alt="" loading="lazy" /></span>
                  <span className="tikz-gallery-name">{item.name}</span>
                </button>)}
        </div>
        <aside className="tikz-gallery-detail">
          {selected ? <>
            <h3>{selected.name}</h3>
            {selected.description && <p>{selected.description}</p>}
            {selected.requires.length > 0 && <><h4>{t("gallery.requires")}</h4><p className="tikz-gallery-requires">{selected.requires.join(", ")}</p></>}
            {categories.find(({ id }) => id === selected.category)?.trademark && <p className="tikz-gallery-note">{t("gallery.brandNotice")}</p>}
          </> : <p className="tikz-gallery-hint">{t("gallery.selectHint")}</p>}
          {importError && <p className="tikz-gallery-error" role="alert">{importError}</p>}
          {attribution && <p className="tikz-gallery-attribution"><a href={attribution.url} target="_blank" rel="noreferrer">{localizedText(attribution.text, i18n.resolvedLanguage)}</a></p>}
        </aside>
      </div>
    </div>
  </Modal>;
}
