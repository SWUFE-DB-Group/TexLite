import type { TFunction } from "i18next";
import { Eye } from "lucide-react";
import type { Project } from "../types";

export function ProjectPermissionBadge({ permission, t, className = "" }: {
  permission: Project["permission"];
  t: TFunction;
  className?: string;
}) {
  if (permission !== "read") return null;
  const label = t("common.readOnly");
  return <span
    className={`project-permission-badge is-readonly${className ? ` ${className}` : ""}`}
    title={`${t("common.permission")}: ${label}`}
  >
    <Eye size={11} aria-hidden="true" />
    <span>{label}</span>
  </span>;
}
