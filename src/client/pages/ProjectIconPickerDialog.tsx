import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Modal } from "../Dialog";
import { errorMessage } from "../errors";
import { ProjectIconGlyph, projectIconEntries, projectInitial } from "../projectIcons";
import { isProjectIconName, normalizeLucideIconName } from "../../shared/projectIcons.js";
import type { Project } from "../types";

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/** Select from a concise, searchable icon collection without an external icon service. */
export function ProjectIconPickerDialog({
  project,
  open,
  onOpenChange,
  onSave
}: {
  project: Project | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (projectId: string, icon: string | null) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const [selectedIcon, setSelectedIcon] = useState<string | null>(null);
  const [advancedIconName, setAdvancedIconName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIcon(project?.icon ?? null);
    setAdvancedIconName(project?.icon && !isProjectIconName(project.icon) ? project.icon : "");
    setSaving(false);
    setError("");
  }, [open, project?.id, project?.icon]);

  const matches = useMemo(() => {
    const needle = normalized(query);
    if (!needle) return projectIconEntries;
    return projectIconEntries.filter(({ name }) => [
      name,
      t(`projectIcons.icons.${name}.name`),
      t(`projectIcons.icons.${name}.keywords`)
    ].some((value) => normalized(value).includes(needle)));
  }, [i18n.resolvedLanguage, query, t]);

  const save = async () => {
    if (!project || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(project.id, selectedIcon);
      onOpenChange(false);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSaving(false);
    }
  };

  const changed = selectedIcon !== (project?.icon ?? null);
  const chooseCuratedIcon = (icon: string | null) => {
    setSelectedIcon(icon);
    setAdvancedIconName("");
  };
  const updateAdvancedIcon = (value: string) => {
    setAdvancedIconName(value);
    const raw = value.trim();
    setSelectedIcon(raw ? normalizeLucideIconName(raw) ?? raw : null);
  };
  return <Modal
    open={open}
    wide
    className="project-icon-picker-modal"
    title={t("projectIcons.title")}
    description={project ? t("projectIcons.description", { project: project.name }) : undefined}
    onOpenChange={(next) => { if (!saving) onOpenChange(next); }}
    footer={<>
      <button type="button" disabled={saving} onClick={() => onOpenChange(false)}>{t("common.cancel")}</button>
      <button type="button" className="primary" disabled={saving || !changed} aria-busy={saving} onClick={() => void save()}>{t("projectIcons.save")}</button>
    </>}
  >
    <div className="project-icon-picker">
      {error && <p className="error dialog-error" role="alert">{error}</p>}
      <label className="project-icon-search">
        <Search aria-hidden="true" size={16} />
        <span className="sr-only">{t("projectIcons.search")}</span>
        <input autoFocus value={query} placeholder={t("projectIcons.search")} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="project-icon-options" aria-label={t("projectIcons.title")}>
        <button
          type="button"
          aria-pressed={selectedIcon === null}
          className={`project-icon-option project-icon-reset${selectedIcon === null ? " selected" : ""}`}
          title={t("projectIcons.useInitial")}
          onClick={() => chooseCuratedIcon(null)}
        >
          <span className="project-icon-option-glyph"><ProjectIconGlyph fallback={projectInitial(project?.name ?? "")} /></span>
          <span>{t("projectIcons.useInitial")}</span>
        </button>
        {matches.map(({ name }) => <button
          key={name}
          type="button"
          aria-pressed={selectedIcon === name}
          className={`project-icon-option${selectedIcon === name ? " selected" : ""}`}
          title={t(`projectIcons.icons.${name}.name`)}
          onClick={() => chooseCuratedIcon(name)}
        >
          <span className="project-icon-option-glyph"><ProjectIconGlyph icon={name} fallback="?" /></span>
          <span>{t(`projectIcons.icons.${name}.name`)}</span>
        </button>)}
      </div>
      {matches.length === 0 && <p className="project-icon-picker-empty">{t("projectIcons.noMatches", { query })}</p>}
      <div className="project-icon-advanced">
        <label htmlFor="project-icon-advanced-name">{t("projectIcons.advancedName")}</label>
        <div className="project-icon-advanced-input">
          <input
            id="project-icon-advanced-name"
            value={advancedIconName}
            placeholder={t("projectIcons.advancedNamePlaceholder")}
            onChange={(event) => updateAdvancedIcon(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          {advancedIconName.trim() && <span className="project-icon-advanced-preview" aria-label={t("projectIcons.advancedPreview")}>
            <ProjectIconGlyph icon={selectedIcon} fallback="?" />
          </span>}
        </div>
        <p>{t("projectIcons.advancedNameDescription")} <a href="https://icon-sets.iconify.design/lucide/" target="_blank" rel="noreferrer">{t("projectIcons.browse")}</a></p>
      </div>
    </div>
  </Modal>;
}
