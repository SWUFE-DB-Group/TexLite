import { useTranslation } from "react-i18next";

export function GitTokenGuidance() {
  const { t } = useTranslation();
  return <div className="git-token-guidance">
    <strong>{t("git.recommendedAccessTitle")}</strong>
    <span>{t("git.recommendedAccessBeforeAll")}<em className="git-token-highlight">All repositories</em>{t("git.recommendedAccessBeforeAdministration")}<em className="git-token-highlight">Administration</em>{t("git.recommendedAccessBetweenPermissions")}<em className="git-token-highlight">Contents</em>{t("git.recommendedAccessAfterPermissions")}</span>
  </div>;
}
