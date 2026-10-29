import { useTranslation } from "react-i18next";
import type { ProjectCatalogCounts, ProjectOwnershipScope } from "../types";

const scopes = ["all", "owned", "shared"] as const;
const labels = { all: "projects.allProjects", owned: "projects.ownedByMe", shared: "projects.sharedWithMe" } as const;

export function ProjectOwnershipTabs({ value, counts, onChange }: {
  value: ProjectOwnershipScope;
  counts: ProjectCatalogCounts;
  onChange: (value: ProjectOwnershipScope) => void;
}) {
  const { t } = useTranslation();
  return <div className="project-ownership-tabs" role="tablist" aria-label={t("projects.ownership")}>
    {scopes.map((scope, index) => <button key={scope} id={`project-tab-${scope}`} type="button" role="tab"
      aria-selected={value === scope} aria-controls="project-catalog-panel" tabIndex={value === scope ? 0 : -1}
      onClick={() => onChange(scope)} onKeyDown={(event) => {
        let next: number;
        if (event.key === "ArrowRight") next = (index + 1) % scopes.length;
        else if (event.key === "ArrowLeft") next = (index + scopes.length - 1) % scopes.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = scopes.length - 1;
        else return;
        event.preventDefault();
        onChange(scopes[next]);
        event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#project-tab-${scopes[next]}`)?.focus();
      }}>
      <span>{t(labels[scope])}</span>{counts[scope] > 0 && <sup>{counts[scope]}</sup>}
    </button>)}
  </div>;
}
